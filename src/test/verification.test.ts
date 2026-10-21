/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  evaluateVerification,
  initializeVerificationState,
  isAuthoritativeVerified,
  getAuthoritativeVerifiedSavings,
  isValidProductionBaseline,
  isComparableEvent,
  isValidEventData,
  VERIFICATION_CONSTRAINTS,
} from '../engine/verification/comparator';
import { calculateAuthoritativeOutcomeFee, calculateOutcomeFee } from '../engine/billing/outcome';
import { Finding, VerificationState, AIEvent } from '../types/domain';

// Helper to create a valid production finding
function createMockProductionFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'fnd_rs_gpt4o_gpt4omini',
    audit_id: 'aud_prod_123',
    rule_id: 'MODEL_RIGHT_SIZING',
    title: 'Model Right-Sizing: gpt-4o -> gpt-4o-mini',
    summary: 'Candidate prompt classification workload eligible for smaller model.',
    affected_scope: 'gpt-4o → gpt-4o-mini',
    detection_confidence: 'HIGH',
    cost_confidence: 'HIGH',
    savings_confidence: 'HIGH',
    baseline_spend_usd: 1.20,
    candidate_spend_usd: 0.18,
    estimated_savings_usd: 1.02,
    potential_savings_pct: 85.0,
    annualized_projection_usd: 53.04,
    eligible_event_count: 100,
    calculation_method: 'Unit cost delta multiplied by annual volume.',
    assumptions: ['Workload latency tolerance <= 500ms'],
    evidence: {
      affected_event_count: 100,
      sample_events: [
        {
          id: 'evt_sample_1',
          timestamp: '2026-09-01T12:00:00Z',
          model: 'gpt-4o',
          status: 'SUCCESS',
          resolved_cost_usd: 0.012,
        },
      ],
      metrics_comparison: [],
      trace_samples: [],
      mathematical_proof: 'Proof text',
    },
    status: 'DETECTED',
    is_sample_data: false,
    ...overrides,
  };
}

// Helper to generate events
function createEvents(
  count: number,
  params: {
    is_simulated?: boolean;
    cost?: number;
    model?: string;
    status?: 'SUCCESS' | 'ERROR' | 'RATE_LIMITED';
    timestampOffsetMs?: number;
  }
): AIEvent[] {
  const baseTime = Date.now() - 1800_000;
  const events: AIEvent[] = [];

  for (let i = 0; i < count; i++) {
    events.push({
      id: `evt_test_${i}_${Math.random().toString(36).substring(2, 6)}`,
      source: 'custom_logs',
      source_event_id: `src_${i}`,
      timestamp: new Date(baseTime + (params.timestampOffsetMs ?? 0) + i * 10_000).toISOString(),
      provider: 'openai',
      model: params.model ?? 'gpt-4o-mini',
      operation: 'chat',
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      latency_ms: 150,
      status: params.status ?? 'SUCCESS',
      trace_id: `tr_${i}`,
      tool_calls: [],
      source_reported_cost_usd: params.cost ?? 0.0018,
      calculated_cost_usd: params.cost ?? 0.0018,
      resolved_cost_usd: params.cost ?? 0.0018,
      cost_provenance: 'CALCULATED',
      cost_confidence: 'HIGH',
      metadata: {},
      is_simulated: params.is_simulated,
    });
  }

  return events;
}

describe('Verification Integrity Hardening Suite', () => {
  // -------------------------------------------------------------------------
  // Test A — Simulation cannot verify
  // -------------------------------------------------------------------------
  it('Test A: Simulation cannot verify (stage is NOT VERIFIED_RESULT, authoritative savings is $0)', () => {
    const finding = createMockProductionFinding();
    const initialState = initializeVerificationState(finding);

    // Transition to deployed
    const deployedState: VerificationState = {
      ...initialState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(Date.now() - 3600_000).toISOString(),
    };

    // 25 valid simulated events demonstrating 85% unit cost reduction ($0.012 -> $0.0018)
    const simulatedEvents = createEvents(25, {
      is_simulated: true,
      cost: 0.0018,
      model: 'gpt-4o-mini',
    });

    const evaluated = evaluateVerification(deployedState, finding, simulatedEvents);

    // INVARIANT 1: stage must NOT be VERIFIED_RESULT
    assert.notStrictEqual(
      evaluated.stage,
      'VERIFIED_RESULT',
      'Simulated events must NEVER transition stage to VERIFIED_RESULT'
    );
    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');

    // INVARIANT 2: is_simulated must be true
    assert.strictEqual(evaluated.is_simulated, true);

    // INVARIANT 3: No authoritative verified saving
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
    assert.strictEqual(getAuthoritativeVerifiedSavings(evaluated), 0);
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 0);
    assert.strictEqual(evaluated.observed_result?.is_authoritative, false);

    // INVARIANT 4: Simulated demo preview metrics are present for UI demonstration
    assert.ok(evaluated.simulated_result, 'simulated_result should contain demo calculations');
    assert.strictEqual(evaluated.simulated_result.observed_reduction_pct, 85.0);
    assert.ok(evaluated.simulated_result.annualized_realized_savings_usd > 0);
    assert.strictEqual(evaluated.simulated_result.is_authoritative, false);

    // INVARIANT 5: Authoritative billing evaluation returns $0.00 waived fee
    const billingOutcome = calculateAuthoritativeOutcomeFee(evaluated, finding);
    assert.strictEqual(billingOutcome.finalOutcomeFeeUsd, 0);
    assert.strictEqual(billingOutcome.isPayable, false);
    assert.strictEqual(billingOutcome.verifiedAnnualizedSavingsUsd, 0);
  });

  // -------------------------------------------------------------------------
  // Test B — Production telemetry can verify
  // -------------------------------------------------------------------------
  it('Test B: Production telemetry can verify (reaches VERIFIED_RESULT and authoritative savings)', () => {
    const finding = createMockProductionFinding();
    const initialState = initializeVerificationState(finding);

    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...initialState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    // 25 genuine production events (is_simulated: false) with 85% cost reduction
    const productionEvents = createEvents(25, {
      is_simulated: false,
      cost: 0.0018,
      model: 'gpt-4o-mini',
      timestampOffsetMs: 1000,
    });

    const evaluated = evaluateVerification(deployedState, finding, productionEvents);

    // Must reach VERIFIED_RESULT
    assert.strictEqual(evaluated.stage, 'VERIFIED_RESULT');
    assert.strictEqual(evaluated.is_simulated, false);
    assert.strictEqual(isAuthoritativeVerified(evaluated), true);

    // Authoritative savings must be positive and matched
    const authoritativeSavings = getAuthoritativeVerifiedSavings(evaluated);
    assert.ok(authoritativeSavings > 0, 'Authoritative savings should be > 0');
    assert.strictEqual(evaluated.observed_result?.is_authoritative, true);
    assert.strictEqual(evaluated.observed_result?.observed_reduction_pct, 85.0);

    // Billing produces a payable outcome fee
    const billingOutcome = calculateAuthoritativeOutcomeFee(evaluated, finding);
    assert.strictEqual(billingOutcome.isPayable, true);
    assert.ok(billingOutcome.finalOutcomeFeeUsd > 0);
  });

  // -------------------------------------------------------------------------
  // Test C — Mixed simulation + production
  // -------------------------------------------------------------------------
  it('Test C: Mixed simulation + production (simulated events are excluded and do not contaminate)', () => {
    const finding = createMockProductionFinding();
    const initialState = initializeVerificationState(finding);

    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...initialState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    // 20 production events at $0.0018 (85% reduction)
    const productionEvents = createEvents(20, {
      is_simulated: false,
      cost: 0.0018,
      model: 'gpt-4o-mini',
      timestampOffsetMs: 1000,
    });

    // 10 simulated events at an artificially distorted cost ($0.0001)
    const simulatedEvents = createEvents(10, {
      is_simulated: true,
      cost: 0.0001,
      model: 'gpt-4o-mini',
      timestampOffsetMs: 2000,
    });

    const mixedEvents = [...productionEvents, ...simulatedEvents];

    const evaluated = evaluateVerification(deployedState, finding, mixedEvents);

    // Should verify on the 20 production events alone
    assert.strictEqual(evaluated.stage, 'VERIFIED_RESULT');
    assert.strictEqual(evaluated.is_simulated, false);
    assert.strictEqual(isAuthoritativeVerified(evaluated), true);

    // Sample count must reflect only the 20 production events, NOT 30
    assert.strictEqual(evaluated.observation_window?.sample_event_count, 20);

    // Post unit cost must match the production events ($0.0018), not diluted by simulated $0.0001
    assert.strictEqual(evaluated.observed_result?.post_cost_per_call_usd, 0.0018);
    assert.strictEqual(evaluated.observed_result?.observed_reduction_pct, 85.0);
  });

  // -------------------------------------------------------------------------
  // Test D — Unknown provenance
  // -------------------------------------------------------------------------
  it('Test D: Unknown provenance (is_simulated undefined) is strictly rejected from production verification', () => {
    const finding = createMockProductionFinding();
    const initialState = initializeVerificationState(finding);

    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...initialState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    // 25 events with is_simulated: undefined (unknown provenance)
    const unknownEvents = createEvents(25, {
      is_simulated: undefined,
      cost: 0.0018,
      model: 'gpt-4o-mini',
    });

    const evaluated = evaluateVerification(deployedState, finding, unknownEvents);

    // Must NOT verify
    assert.notStrictEqual(evaluated.stage, 'VERIFIED_RESULT');
    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
    assert.strictEqual(getAuthoritativeVerifiedSavings(evaluated), 0);
    assert.strictEqual(evaluated.observation_window?.sample_event_count, 0);
  });

  // -------------------------------------------------------------------------
  // Test E — Insufficient post-deployment evidence
  // -------------------------------------------------------------------------
  it('Test E: Insufficient post-deployment evidence (< 15 events) remains OBSERVATION_ACTIVE', () => {
    const finding = createMockProductionFinding();
    const initialState = initializeVerificationState(finding);

    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...initialState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    // Only 14 events (below MIN_POST_DEPLOYMENT_EVENTS = 15)
    const insufficientEvents = createEvents(14, {
      is_simulated: false,
      cost: 0.0018,
      model: 'gpt-4o-mini',
    });

    const evaluated = evaluateVerification(deployedState, finding, insufficientEvents);

    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(evaluated.observed_result?.verification_confidence, 'INSUFFICIENT_OBSERVATION');
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 0);
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
  });

  // -------------------------------------------------------------------------
  // Test F — No measurable reduction
  // -------------------------------------------------------------------------
  it('Test F: No measurable reduction (< 10% reduction or cost increase) remains OBSERVATION_ACTIVE', () => {
    const finding = createMockProductionFinding();
    const initialState = initializeVerificationState(finding);

    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...initialState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    // Baseline avg unit cost is $0.0120
    // Post unit cost is $0.0115 (only 4.17% reduction, below 10% threshold)
    const smallDeltaEvents = createEvents(20, {
      is_simulated: false,
      cost: 0.0115,
      model: 'gpt-4o-mini',
    });

    const evaluated = evaluateVerification(deployedState, finding, smallDeltaEvents);

    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 0);

    // Post cost is higher than baseline (negative reduction)
    const negativeDeltaEvents = createEvents(20, {
      is_simulated: false,
      cost: 0.0150, // Cost increased!
      model: 'gpt-4o-mini',
    });

    const evaluatedNeg = evaluateVerification(deployedState, finding, negativeDeltaEvents);
    assert.strictEqual(evaluatedNeg.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(isAuthoritativeVerified(evaluatedNeg), false);
    assert.strictEqual(evaluatedNeg.observed_result?.annualized_realized_savings_usd, 0);
  });

  // -------------------------------------------------------------------------
  // Test G — Synthetic sample baseline cannot produce production verification
  // -------------------------------------------------------------------------
  it('Test G: Synthetic sample baseline (is_sample_data: true) is rejected from production verification', () => {
    const syntheticFinding = createMockProductionFinding({ is_sample_data: true });
    const initialState = initializeVerificationState(syntheticFinding);

    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...initialState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    // Even if production events are provided
    const productionEvents = createEvents(25, {
      is_simulated: false,
      cost: 0.0018,
      model: 'gpt-4o-mini',
    });

    const evaluated = evaluateVerification(deployedState, syntheticFinding, productionEvents);

    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
    assert.strictEqual(getAuthoritativeVerifiedSavings(evaluated), 0);
    assert.ok(evaluated.observed_result?.verification_notes.includes('rejected'));
  });

  // -------------------------------------------------------------------------
  // Test H — Scope Comparability & Event Data Quality
  // -------------------------------------------------------------------------
  it('Test H: Unrelated models or corrupt event data are filtered out', () => {
    const finding = createMockProductionFinding();
    const deployTime = Date.now() - 3600_000;

    // Comparable events
    const validCandidateEvent = createEvents(1, { is_simulated: false, model: 'gpt-4o-mini' })[0];
    const validCurrentEvent = createEvents(1, { is_simulated: false, model: 'gpt-4o' })[0];
    assert.strictEqual(isComparableEvent(validCandidateEvent, finding), true);
    assert.strictEqual(isComparableEvent(validCurrentEvent, finding), true);

    // Unrelated model
    const unrelatedModelEvent = createEvents(1, { is_simulated: false, model: 'dall-e-3' })[0];
    assert.strictEqual(isComparableEvent(unrelatedModelEvent, finding), false);

    // Invalid cost data
    const negativeCostEvent = { ...validCandidateEvent, resolved_cost_usd: -0.05 };
    assert.strictEqual(isValidEventData(negativeCostEvent, deployTime), false);

    // Invalid error status
    const errorEvent = { ...validCandidateEvent, status: 'ERROR' as const };
    assert.strictEqual(isValidEventData(errorEvent, deployTime), false);

    // Timestamp before deployment
    const pastEvent = { ...validCandidateEvent, timestamp: new Date(deployTime - 50_000).toISOString() };
    assert.strictEqual(isValidEventData(pastEvent, deployTime), false);
  });

  // -------------------------------------------------------------------------
  // Test I — Existing commercial boundary preservation
  // -------------------------------------------------------------------------
  it('Test I: Preserves exact commercial outcome fee contract and 50% protection clause', () => {
    // 49.999999% / 1000 -> waived ($0.00)
    const waived = calculateOutcomeFee(499.999999, 1000);
    assert.strictEqual(waived.finalOutcomeFeeUsd, 0);
    assert.strictEqual(waived.protectionTriggered, true);
    assert.strictEqual(waived.isPayable, false);

    // 50.00% / 1000 -> payable ($500 cap applies)
    const exact50 = calculateOutcomeFee(500, 1000);
    assert.strictEqual(exact50.finalOutcomeFeeUsd, 500);
    assert.strictEqual(exact50.protectionTriggered, false);
    assert.strictEqual(exact50.isPayable, true);

    // 50.000001% / 1000 -> payable ($500.00 cap applies)
    const above50 = calculateOutcomeFee(500.000001, 1000);
    assert.strictEqual(above50.finalOutcomeFeeUsd, 500.00);
    assert.strictEqual(above50.protectionTriggered, false);
    assert.strictEqual(above50.isPayable, true);

    // Zero verified savings -> $0.00
    const zero = calculateOutcomeFee(0, 1000);
    assert.strictEqual(zero.finalOutcomeFeeUsd, 0);
    assert.strictEqual(zero.isPayable, false);

    // Negative verified savings -> $0.00
    const neg = calculateOutcomeFee(-50, 1000);
    assert.strictEqual(neg.finalOutcomeFeeUsd, 0);
    assert.strictEqual(neg.isPayable, false);
  });
});
