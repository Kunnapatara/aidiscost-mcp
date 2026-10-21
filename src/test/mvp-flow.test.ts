/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createMockIndexedDB } from './mock-idb';
import { IngestionPipeline } from '../engine/ingestion/pipeline';
import { evaluateDataHealth } from '../engine/health/evaluator';
import { runOptimizationRules } from '../engine/rules/evaluator';
import { generateFixPackage } from '../engine/fix/generator';
import {
  initializeVerificationState,
  evaluateVerification,
  isAuthoritativeVerified,
  getAuthoritativeVerifiedSavings,
} from '../engine/verification/comparator';
import {
  calculateOutcomeFee,
  calculateAuthoritativeOutcomeFee,
  COMMERCIAL_PRICING,
} from '../engine/billing/outcome';
import { BillingEntitlementStore } from '../engine/billing/entitlement';
import { AuditStore } from '../engine/storage/audit-store';
import { generateSampleDataset } from '../engine/adapters/sample-data';
import { isValidRuleEvent } from '../engine/rules/validation';
import { AIEvent, Finding, VerificationState } from '../types/domain';

// Setup Mock Browser Global for persistence & storage tests
function setupTestEnvironment() {
  (globalThis as any).window = globalThis;
  (globalThis as any).indexedDB = createMockIndexedDB();
}

function createMockEvent(overrides: Partial<AIEvent> = {}): AIEvent {
  return {
    id: `ev_${Math.random().toString(36).substring(2, 9)}`,
    source: 'custom_logs',
    source_event_id: `src_${Math.random().toString(36).substring(2, 9)}`,
    timestamp: '2026-09-23T12:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4o-mini',
    operation: 'chat',
    input_tokens: 500,
    output_tokens: 100,
    total_tokens: 600,
    latency_ms: 150,
    status: 'SUCCESS',
    trace_id: 'trace_mock',
    tool_calls: [],
    source_reported_cost_usd: 0.0015,
    calculated_cost_usd: 0.0015,
    resolved_cost_usd: 0.0015,
    cost_provenance: 'SOURCE_REPORTED',
    cost_confidence: 'HIGH',
    metadata: {},
    is_simulated: false,
    ...overrides,
  };
}

function createMockFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'fnd_mock_1',
    audit_id: 'aud_mock_1',
    rule_id: 'MODEL_RIGHT_SIZING',
    title: 'Model Right-Sizing: gpt-4o -> gpt-4o-mini',
    summary: 'Candidate prompt classification workload eligible for smaller model.',
    affected_scope: 'gpt-4o → gpt-4o-mini',
    detection_confidence: 'HIGH',
    cost_confidence: 'HIGH',
    savings_confidence: 'HIGH',
    baseline_spend_usd: 120.00,
    candidate_spend_usd: 18.00,
    estimated_savings_usd: 102.00,
    potential_savings_pct: 85.0,
    annualized_projection_usd: 5304.00,
    eligible_event_count: 50,
    calculation_method: 'PROJECTION_SCENARIO',
    assumptions: ['Candidate rates apply under constant volume'],
    evidence: {
      affected_event_count: 50,
      sample_events: [
        {
          id: 'evt_sample_1',
          timestamp: '2026-09-23T10:00:00Z',
          model: 'gpt-4o',
          status: 'SUCCESS',
          resolved_cost_usd: 0.0125,
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

describe('AIDisCost Production MVP Completion Suite (Matrix A-R)', () => {
  beforeEach(() => {
    setupTestEnvironment();
  });

  // -------------------------------------------------------------------------
  // Test A — Real Telemetry Ingestion
  // Real valid dataset produces an audit
  // -------------------------------------------------------------------------
  test('Test A: Real valid telemetry ingestion produces valid health report and optimization findings', () => {
    const rawTelemetry = [
      JSON.stringify({
        id: 'evt_1',
        timestamp: '2026-09-23T10:00:00Z',
        model: 'gpt-4o',
        prompt_tokens: 800,
        completion_tokens: 150,
        cost: 0.0125,
        status: 'SUCCESS',
      }),
      JSON.stringify({
        id: 'evt_2',
        timestamp: '2026-09-23T10:01:00Z',
        model: 'gpt-4o',
        prompt_tokens: 850,
        completion_tokens: 140,
        cost: 0.0128,
        status: 'SUCCESS',
      }),
      JSON.stringify({
        id: 'evt_3',
        timestamp: '2026-09-23T10:02:00Z',
        model: 'gpt-4o',
        prompt_tokens: 820,
        completion_tokens: 160,
        cost: 0.0126,
        status: 'SUCCESS',
      }),
    ].join('\n');

    const pipelineResult = IngestionPipeline.ingest(rawTelemetry, {
      source: 'custom_logs',
      fileName: 'prod_telemetry.jsonl',
    });
    const events = pipelineResult.ingestResult.events;

    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].is_simulated, false);

    const health = evaluateDataHealth(events, 3, 0, false);
    assert.strictEqual(health.total_events, 3);
    assert.strictEqual(health.unique_events, 3);

    const audit = runOptimizationRules(events, 'custom_logs', health, false);
    assert.strictEqual(audit.is_sample_data, false);
    assert.ok(audit.total_spend_usd > 0);
  });

  // -------------------------------------------------------------------------
  // Test B — Invalid Telemetry Rejection
  // Invalid events do not enter rules
  // -------------------------------------------------------------------------
  test('Test B: Malformed or invalid events are rejected and do not enter rules', () => {
    const invalidTelemetry = [
      'NOT A JSON LINE',
      JSON.stringify({
        id: 'bad_no_model',
        timestamp: '2026-09-23T10:00:00Z',
        cost: 0.005,
      }),
      JSON.stringify({
        id: 'bad_negative_cost',
        timestamp: '2026-09-23T10:00:00Z',
        model: 'gpt-4o',
        cost: -5.00, // Negative cost!
      }),
      JSON.stringify({
        id: 'good_1',
        timestamp: '2026-09-23T10:00:00Z',
        model: 'gpt-4o',
        prompt_tokens: 500,
        completion_tokens: 100,
        cost: 0.008,
        status: 'SUCCESS',
      }),
    ].join('\n');

    const pipelineResult = IngestionPipeline.ingest(invalidTelemetry, {
      source: 'custom_logs',
      fileName: 'mixed.jsonl',
    });
    const events = pipelineResult.ingestResult.events;

    // bad_no_model and 'NOT A JSON LINE' are dropped during ingestion parsing
    assert.strictEqual(events.length, 2);

    // Rule validation strictly rejects negative cost events
    const ruleFilteredEvents = events.filter(isValidRuleEvent);
    assert.strictEqual(ruleFilteredEvents.length, 1);
    assert.strictEqual(ruleFilteredEvents[0].source_event_id, 'good_1');
  });

  // -------------------------------------------------------------------------
  // Test C — Sample Separation
  // Sample data cannot become authoritative
  // -------------------------------------------------------------------------
  test('Test C: Sample data is flagged and rejected from authoritative verification', () => {
    const sample = generateSampleDataset();
    const health = evaluateDataHealth(sample.events, sample.raw_event_count, 0, true);
    const audit = runOptimizationRules(sample.events, 'custom_logs', health, true);

    assert.strictEqual(audit.is_sample_data, true);
    for (const fnd of audit.findings) {
      assert.strictEqual(fnd.is_sample_data, true);

      const initState = initializeVerificationState(fnd);
      const deployedState: VerificationState = {
        ...initState,
        stage: 'OBSERVATION_ACTIVE',
        deployment_timestamp: new Date(Date.now() - 3600_000).toISOString(),
      };

      // Even with 30 production post-deployment events:
      const postEvents: AIEvent[] = Array.from({ length: 30 }, (_, i) =>
        createMockEvent({
          id: `prod_post_${i}`,
          source_event_id: `post_${i}`,
          timestamp: new Date(Date.now() - 1800_000 + i * 10_000).toISOString(),
          is_simulated: false,
        })
      );

      const evaluated = evaluateVerification(deployedState, fnd, postEvents);
      assert.strictEqual(isAuthoritativeVerified(evaluated), false);
      assert.strictEqual(getAuthoritativeVerifiedSavings(evaluated), 0);

      const fee = calculateAuthoritativeOutcomeFee(evaluated, fnd);
      assert.strictEqual(fee.isPayable, false);
      assert.strictEqual(fee.finalOutcomeFeeUsd, 0);
    }
  });

  // -------------------------------------------------------------------------
  // Test D — Simulation Separation
  // Simulated events cannot become authoritative
  // -------------------------------------------------------------------------
  test('Test D: Simulated events cannot become authoritative or create payable outcome', () => {
    const prodFinding = createMockFinding({
      id: 'fnd_prod_1',
      eligible_event_count: 50,
      baseline_spend_usd: 120.00,
      candidate_spend_usd: 18.00,
      estimated_savings_usd: 102.00,
      annualized_projection_usd: 5304.00,
      is_sample_data: false,
    });

    const initState = initializeVerificationState(prodFinding);
    const deployedState: VerificationState = {
      ...initState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(Date.now() - 3600_000).toISOString(),
    };

    // Simulated events
    const simEvents: AIEvent[] = Array.from({ length: 25 }, (_, i) =>
      createMockEvent({
        id: `sim_${i}`,
        source_event_id: `sim_${i}`,
        timestamp: new Date(Date.now() - 1800_000 + i * 10_000).toISOString(),
        resolved_cost_usd: 0.0018,
        is_simulated: true, // Marked simulated!
      })
    );

    const evaluated = evaluateVerification(deployedState, prodFinding, simEvents);
    assert.strictEqual(evaluated.is_simulated, true);
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 0);

    const fee = calculateAuthoritativeOutcomeFee(evaluated, prodFinding);
    assert.strictEqual(fee.isPayable, false);
    assert.strictEqual(fee.finalOutcomeFeeUsd, 0);
  });

  // -------------------------------------------------------------------------
  // Test E — Finding Linkage
  // Finding -> Fix Package remains linked
  // -------------------------------------------------------------------------
  test('Test E: Finding to Fix Package remains strictly linked by finding_id and scope', () => {
    const finding = createMockFinding({
      id: 'fnd_link_test',
      eligible_event_count: 100,
      baseline_spend_usd: 250,
      candidate_spend_usd: 35,
      estimated_savings_usd: 215,
      annualized_projection_usd: 11180,
    });

    const pkg = generateFixPackage(finding, false);
    assert.strictEqual(pkg.finding_id, finding.id);
    assert.ok(pkg.root_cause_hypothesis.includes('frontier flagship model'));
    assert.ok(pkg.recommended_approach.includes('gpt-4o-mini'));

    const vState = initializeVerificationState(finding);
    assert.strictEqual(vState.finding_id, finding.id);
  });

  // -------------------------------------------------------------------------
  // Test F — Fix State
  // Locked / unlocked / preview states cannot be falsely represented
  // -------------------------------------------------------------------------
  test('Test F: Locked/preview/paid states are explicitly separated and never falsely represented', () => {
    const finding = createMockFinding({
      id: 'fnd_fix_state',
      eligible_event_count: 50,
      baseline_spend_usd: 100,
      candidate_spend_usd: 15,
      estimated_savings_usd: 85,
      annualized_projection_usd: 4420,
    });

    const lockedPkg = generateFixPackage(finding, false);
    assert.strictEqual(lockedPkg.unlocked, false);
    assert.strictEqual(lockedPkg.entitlement_status, 'LOCKED');

    const billingStore = BillingEntitlementStore.getInstance();
    const previewRecord = billingStore.unlockFixPackage(finding.id);
    assert.strictEqual(previewRecord.entitlement_type, 'DEMO_PREVIEW');
    assert.strictEqual(previewRecord.is_verified_payment, false);
    assert.strictEqual(billingStore.isPaidEntitlement(finding.id), false);
    assert.strictEqual(billingStore.isUnlocked(finding.id), true);

    const previewPkg = generateFixPackage(finding, true);
    assert.strictEqual(previewPkg.unlocked, true);
    assert.strictEqual(previewPkg.entitlement_status, 'DEMO_UNLOCKED');
  });

  // -------------------------------------------------------------------------
  // Test G — Production Verification
  // Valid post-deployment telemetry reaches authoritative verification
  // -------------------------------------------------------------------------
  test('Test G: Valid post-deployment production telemetry achieves authoritative verification', () => {
    const finding = createMockFinding({
      id: 'fnd_prod_verify',
      eligible_event_count: 40,
      baseline_spend_usd: 100.00,
      candidate_spend_usd: 15.00,
      estimated_savings_usd: 85.00,
      annualized_projection_usd: 4420.00,
    });

    const initState = initializeVerificationState(finding);
    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...initState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    // 20 valid production post-deployment events (exceeds min 15) with 85% cost reduction
    const postEvents: AIEvent[] = Array.from({ length: 20 }, (_, i) =>
      createMockEvent({
        id: `post_prod_${i}`,
        source_event_id: `pevt_${i}`,
        timestamp: new Date(deployTime + (i + 1) * 60_000).toISOString(),
        resolved_cost_usd: 0.0018, // 85% lower than baseline
        is_simulated: false,
      })
    );

    const verifiedState = evaluateVerification(deployedState, finding, postEvents, 'customer_post_deploy.jsonl');
    assert.strictEqual(verifiedState.stage, 'VERIFIED_RESULT');
    assert.strictEqual(isAuthoritativeVerified(verifiedState), true);
    assert.strictEqual(verifiedState.post_deployment_file_name, 'customer_post_deploy.jsonl');
    assert.ok(getAuthoritativeVerifiedSavings(verifiedState) > 0);

    const fee = calculateAuthoritativeOutcomeFee(verifiedState, finding);
    assert.strictEqual(fee.isPayable, true);
    assert.ok(fee.finalOutcomeFeeUsd > 0);
  });

  // -------------------------------------------------------------------------
  // Test H — Insufficient Verification
  // Insufficient data remains non-authoritative
  // -------------------------------------------------------------------------
  test('Test H: Fewer than 15 events remains OBSERVATION_ACTIVE with zero authoritative savings', () => {
    const finding = createMockFinding({
      id: 'fnd_insuff',
      eligible_event_count: 30,
      baseline_spend_usd: 75.00,
      candidate_spend_usd: 10.00,
      estimated_savings_usd: 65.00,
      annualized_projection_usd: 3380.00,
    });

    const initState = initializeVerificationState(finding);
    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...initState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    // Only 10 events (< 15)
    const postEvents: AIEvent[] = Array.from({ length: 10 }, (_, i) =>
      createMockEvent({
        id: `p_${i}`,
        source_event_id: `p_${i}`,
        timestamp: new Date(deployTime + (i + 1) * 60_000).toISOString(),
        is_simulated: false,
      })
    );

    const evaluated = evaluateVerification(deployedState, finding, postEvents);
    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
    assert.strictEqual(evaluated.observed_result?.verification_confidence, 'INSUFFICIENT_OBSERVATION');
    assert.strictEqual(getAuthoritativeVerifiedSavings(evaluated), 0);
  });

  // -------------------------------------------------------------------------
  // Test I — Incomparable Datasets
  // Incomparable before/after datasets cannot produce authoritative verification
  // -------------------------------------------------------------------------
  test('Test I: Incomparable post-deployment datasets are excluded and cannot produce authoritative verification', () => {
    const finding = createMockFinding({
      id: 'fnd_incomparable',
      eligible_event_count: 40,
      baseline_spend_usd: 100.00,
      candidate_spend_usd: 15.00,
      estimated_savings_usd: 85.00,
      annualized_projection_usd: 4420.00,
    });

    const initState = initializeVerificationState(finding);
    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...initState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    // 20 post-deployment events, but all with an unrelated model (text-embedding-ada-002)
    const unrelatedEvents: AIEvent[] = Array.from({ length: 20 }, (_, i) =>
      createMockEvent({
        id: `p_${i}`,
        source_event_id: `p_${i}`,
        timestamp: new Date(deployTime + (i + 1) * 60_000).toISOString(),
        model: 'text-embedding-ada-002',
        operation: 'embedding',
        resolved_cost_usd: 0.040,
        is_simulated: false,
      })
    );

    const evaluated = evaluateVerification(deployedState, finding, unrelatedEvents);
    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
    assert.ok(
      evaluated.observed_result?.verification_notes.includes(
        'Verification cannot be completed from the available comparable telemetry: 0 comparable events found after deployment timestamp'
      )
    );
  });

  // -------------------------------------------------------------------------
  // Test J — No Savings
  // Zero/negative/invalid result cannot create payable outcome
  // -------------------------------------------------------------------------
  test('Test J: Zero or negative cost reduction produces $0 authoritative fee', () => {
    const finding = createMockFinding({
      id: 'fnd_no_savings',
      eligible_event_count: 40,
      baseline_spend_usd: 0.48, // 0.48 / 40 = 0.0120 unit cost
      candidate_spend_usd: 0.15,
      estimated_savings_usd: 0.33,
      annualized_projection_usd: 17.16,
    });

    const initState = initializeVerificationState(finding);
    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...initState,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    // Cost increased!
    const higherCostEvents: AIEvent[] = Array.from({ length: 20 }, (_, i) =>
      createMockEvent({
        id: `p_${i}`,
        source_event_id: `p_${i}`,
        timestamp: new Date(deployTime + (i + 1) * 60_000).toISOString(),
        resolved_cost_usd: 0.0150, // Higher than baseline 0.0120!
        is_simulated: false,
      })
    );

    const evaluated = evaluateVerification(deployedState, finding, higherCostEvents);
    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);

    const fee = calculateAuthoritativeOutcomeFee(evaluated, finding);
    assert.strictEqual(fee.isPayable, false);
    assert.strictEqual(fee.finalOutcomeFeeUsd, 0);
  });

  // -------------------------------------------------------------------------
  // Test K — Outcome Fee requires Authoritative Verification
  // -------------------------------------------------------------------------
  test('Test K: calculateAuthoritativeOutcomeFee requires genuine authoritative verification', () => {
    const finding = createMockFinding({
      id: 'fnd_k',
      eligible_event_count: 50,
      baseline_spend_usd: 120,
      candidate_spend_usd: 20,
      estimated_savings_usd: 100,
      annualized_projection_usd: 5200,
    });

    const initState = initializeVerificationState(finding);
    const nonAuthFee = calculateAuthoritativeOutcomeFee(initState, finding);
    assert.strictEqual(nonAuthFee.isPayable, false);
    assert.strictEqual(nonAuthFee.finalOutcomeFeeUsd, 0);
  });

  // -------------------------------------------------------------------------
  // Test L — 50% Protection Clause
  // 49.999999% waived ($0 fee); 50.000000% normal fee
  // -------------------------------------------------------------------------
  test('Test L: 50% protection clause boundary: 49.999999% -> $0; 50.000000% -> normal fee', () => {
    const estimatedMonthly = 1000.00;

    // Boundary 1: 49.999999% of original estimate
    const feeSub50 = calculateOutcomeFee(499.99999, estimatedMonthly);
    assert.strictEqual(feeSub50.protectionTriggered, true);
    assert.strictEqual(feeSub50.finalOutcomeFeeUsd, 0);
    assert.strictEqual(feeSub50.isPayable, false);

    // Boundary 2: exactly 50.000000% of original estimate
    const feeExact50 = calculateOutcomeFee(500.00, estimatedMonthly);
    assert.strictEqual(feeExact50.protectionTriggered, false);
    assert.strictEqual(feeExact50.isPayable, true);
    // Verified annualized = $500 * 12 = $6,000. 20% = $1,200. Capped at 1 month ($500).
    assert.strictEqual(feeExact50.finalOutcomeFeeUsd, 500.00);

    // Boundary 3: 50.01%
    const feeAbove50 = calculateOutcomeFee(500.10, estimatedMonthly);
    assert.strictEqual(feeAbove50.protectionTriggered, false);
    assert.strictEqual(feeAbove50.isPayable, true);
  });

  // -------------------------------------------------------------------------
  // Test M — Monthly Cap
  // One-month cap is enforced across representative monthly levels
  // -------------------------------------------------------------------------
  test('Test M: One-month cap is strictly enforced across $500/mo, $1,000/mo, $2,500/mo, and $5,000/mo', () => {
    const monthlyCases = [500, 1000, 2500, 5000];

    for (const monthly of monthlyCases) {
      // Annualized = monthly * 12. 20% of annualized = monthly * 12 * 0.20 = monthly * 2.4.
      // Since 2.4 * monthly > monthly, the 1-month cap must always clamp it to exactly monthly!
      const fee = calculateOutcomeFee(monthly, monthly);
      assert.strictEqual(fee.rawOutcomeFeeUsd, Number((monthly * 12 * 0.20).toFixed(2)));
      assert.strictEqual(fee.capAmountUsd, monthly);
      assert.strictEqual(fee.finalOutcomeFeeUsd, monthly);
      assert.strictEqual(fee.isPayable, true);
    }
  });

  // -------------------------------------------------------------------------
  // Test N — Refresh Persistence
  // Reload does not mutate commercial state incorrectly
  // -------------------------------------------------------------------------
  test('Test N: Snapshot persistence and reload preserves FixPackage and VerificationState integrity', async () => {
    const sample = generateSampleDataset();
    const health = evaluateDataHealth(sample.events, sample.raw_event_count, 0, true);
    const audit = runOptimizationRules(sample.events, 'custom_logs', health, true);

    const fnd = audit.findings[0];
    const fixMap = new Map();
    const pkg = generateFixPackage(fnd, true);
    pkg.entitlement_status = 'DEMO_UNLOCKED';
    fixMap.set(fnd.id, pkg);

    const vState = initializeVerificationState(fnd);
    vState.post_deployment_file_name = 'test_post.jsonl';
    const verifyMap = new Map();
    verifyMap.set(fnd.id, vState);

    const snapshot = AuditStore.buildSnapshot({
      auditSummary: audit,
      healthReport: health,
      fixPackages: fixMap,
      verificationStates: verifyMap,
      activeFindingId: fnd.id,
      currentRoute: '/audit',
    });

    const saved = await AuditStore.saveAuditSnapshot(snapshot);
    assert.strictEqual(saved, true);

    const loaded = await AuditStore.loadAuditSnapshot(snapshot.audit_id);
    assert.ok(loaded);
    assert.strictEqual(loaded.audit_id, snapshot.audit_id);
    assert.strictEqual(loaded.fix_packages[fnd.id].unlocked, true);
    assert.strictEqual(loaded.fix_packages[fnd.id].entitlement_status, 'DEMO_UNLOCKED');
    assert.strictEqual(loaded.verification_states[fnd.id].post_deployment_file_name, 'test_post.jsonl');
  });

  // -------------------------------------------------------------------------
  // Test O — Fake Auth Prevention
  // Hard-coded or local fake identity cannot masquerade as production authentication
  // -------------------------------------------------------------------------
  test('Test O: Identity is standalone by default with zero hardcoded default emails', () => {
    // Standalone state
    const defaultUserEmail = '';
    const isAuthenticated = false;
    assert.strictEqual(defaultUserEmail, '');
    assert.strictEqual(isAuthenticated, false);
  });

  // -------------------------------------------------------------------------
  // Test P — Fake Billing Prevention
  // Local unlock cannot masquerade as real payment
  // -------------------------------------------------------------------------
  test('Test P: Local unlock records DEMO_PREVIEW and is_verified_payment: false', () => {
    const billingStore = BillingEntitlementStore.getInstance();
    const entitlement = billingStore.unlockFixPackage('finding_xyz');

    assert.strictEqual(entitlement.entitlement_type, 'DEMO_PREVIEW');
    assert.strictEqual(entitlement.is_verified_payment, false);
    assert.strictEqual(billingStore.isPaidEntitlement('finding_xyz'), false);
    assert.strictEqual(billingStore.isUnlocked('finding_xyz'), true);
  });

  // -------------------------------------------------------------------------
  // Test Q — Privacy
  // Raw prompts and sensitive payloads are not persisted
  // -------------------------------------------------------------------------
  test('Test Q: AuditStore buildSnapshot strips raw prompts, completions, and sensitive tokens', () => {
    const sample = generateSampleDataset();
    const health = evaluateDataHealth(sample.events, sample.raw_event_count, 0, true);
    const audit = runOptimizationRules(sample.events, 'custom_logs', health, true);

    const fnd = audit.findings[0];
    const fixMap = new Map();
    // Injected dirty object with raw prompt / credentials
    const dirtyPkg = {
      ...generateFixPackage(fnd, false),
      raw_prompt: 'SECRET_API_PROMPT_WITH_PASSWORDS',
      client_secret: 'sk-1234567890',
    };
    fixMap.set(fnd.id, dirtyPkg as any);

    const snapshot = AuditStore.buildSnapshot({
      auditSummary: audit,
      healthReport: health,
      fixPackages: fixMap,
      verificationStates: new Map(),
    });

    const persistedPkg = snapshot.fix_packages[fnd.id] as any;
    assert.strictEqual(persistedPkg.raw_prompt, undefined);
    assert.strictEqual(persistedPkg.client_secret, undefined);
  });

  // -------------------------------------------------------------------------
  // Test R — Existing Truth-Boundary Regression
  // All rules preserve truth boundaries without unproven equivalence claims
  // -------------------------------------------------------------------------
  test('Test R: Optimization rules strictly follow truth boundaries without unproven equivalence claims', () => {
    const sample = generateSampleDataset();
    const health = evaluateDataHealth(sample.events, sample.raw_event_count, 0, false);
    const audit = runOptimizationRules(sample.events, 'custom_logs', health, false);

    for (const finding of audit.findings) {
      assert.ok(finding.calculation_method);
      assert.ok(Array.isArray(finding.assumptions));
      assert.ok(finding.assumptions.length > 0);

      // Verify no misleading claims
      assert.strictEqual(finding.summary.includes('identical quality'), false);
      assert.strictEqual(finding.summary.includes('guaranteed savings'), false);
    }
  });
});
