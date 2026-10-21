/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateAnnualizedVerifiedSavings,
  evaluateVerification,
  initializeVerificationState,
  isAuthoritativeVerified,
  getAuthoritativeVerifiedSavings,
  isValidEventData,
} from '../engine/verification/comparator';
import { calculateAuthoritativeOutcomeFee, calculateOutcomeFee } from '../engine/billing/outcome';
import { Finding, VerificationState, AIEvent } from '../types/domain';

function createMockProductionFinding(overrides: Partial<Finding> = {}): Finding {
  const now = Date.now();
  return {
    id: 'fnd_annualization_test',
    audit_id: 'aud_annualization_123',
    rule_id: 'MODEL_RIGHT_SIZING',
    title: 'Model Right-Sizing: gpt-4o -> gpt-4o-mini',
    summary: 'Workload eligible for smaller model.',
    affected_scope: 'gpt-4o → gpt-4o-mini',
    detection_confidence: 'HIGH',
    cost_confidence: 'HIGH',
    savings_confidence: 'HIGH',
    baseline_spend_usd: 10.0,
    candidate_spend_usd: 5.0,
    estimated_savings_usd: 5.0,
    potential_savings_pct: 50.0,
    annualized_projection_usd: 260.71,
    eligible_event_count: 1000,
    calculation_method: 'Observed / days * 365',
    assumptions: [],
    evidence: {
      affected_event_count: 1000,
      sample_events: [],
      metrics_comparison: [],
      trace_samples: [],
      mathematical_proof: 'Mathematical proof text',
      baseline_period: {
        start: new Date(now - 7 * 86_400_000).toISOString(),
        end: new Date(now).toISOString(),
      },
    },
    status: 'DETECTED',
    is_sample_data: false,
    ...overrides,
  };
}

function createTestEvents(
  count: number,
  params: {
    is_simulated?: boolean;
    cost?: number;
    model?: string;
    status?: 'SUCCESS' | 'ERROR';
    baseTimestamp?: number;
    stepMs?: number;
  } = {}
): AIEvent[] {
  const baseTime = params.baseTimestamp ?? Date.now() - 1800_000;
  const step = params.stepMs ?? 10_000;
  const events: AIEvent[] = [];

  for (let i = 0; i < count; i++) {
    events.push({
      id: `evt_m_${i}_${Math.random().toString(36).substring(2, 6)}`,
      source: 'custom_logs',
      source_event_id: `src_${i}`,
      timestamp: new Date(baseTime + (i + 1) * step).toISOString(),
      provider: 'openai',
      model: params.model ?? 'gpt-4o-mini',
      operation: 'chat',
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      latency_ms: 120,
      status: params.status ?? 'SUCCESS',
      trace_id: `tr_${i}`,
      tool_calls: [],
      source_reported_cost_usd: params.cost ?? 0.005,
      calculated_cost_usd: params.cost ?? 0.005,
      resolved_cost_usd: params.cost ?? 0.005,
      cost_provenance: 'CALCULATED',
      cost_confidence: 'HIGH',
      metadata: {},
      is_simulated: params.is_simulated,
    });
  }

  return events;
}

describe('Verified Annualization Using Post-Deployment Observed Volume (Required Tests 1 - 8)', () => {
  // Test 1 — Baseline and post volume differ
  // Baseline: 1,000 events / 7 days ($0.010/call)
  // Post: 7,000 events / 7 days ($0.005/call)
  // Unit-cost delta: $0.005
  // Expected annualized savings: ($0.005 * 7,000) / 7 * 365 = $1,825.00
  // (Proves calculation uses 7,000 post events, NOT 1,000 baseline events which would give $260.71)
  it('Test 1: Baseline and post volume differ — calculation uses post-deployment volume (7,000), not baseline (1,000)', () => {
    const start = '2026-09-01T00:00:00.000Z';
    const end = '2026-09-08T00:00:00.000Z'; // Exactly 7 days
    const costDelta = 0.005;
    const postCount = 7000;

    const directResult = calculateAnnualizedVerifiedSavings(costDelta, postCount, start, end);
    assert.strictEqual(directResult.valid, true);
    assert.strictEqual(directResult.duration_days, 7);
    assert.strictEqual(directResult.annualized_savings_usd, 1825.0);

    // End-to-end comparator check
    const finding = createMockProductionFinding({
      eligible_event_count: 1000,
      baseline_spend_usd: 10.0, // Pre cost per call: 10.0 / 1000 = $0.010
    });

    const deployTime = new Date(start).getTime();
    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: new Date(deployTime - 7 * 86_400_000).toISOString(),
        end: start,
        avg_cost_per_call_usd: 0.01,
        sample_count: 1000, // Baseline has only 1,000 events
      },
      deployment_timestamp: start,
      observation_window: {
        start: start,
        end: end,
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    // 7,000 post-deployment production events at $0.005 each (delta = $0.005)
    const postEvents = createTestEvents(postCount, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: deployTime,
      stepMs: 60_000, // Spread across window
    });

    const evaluated = evaluateVerification(deployedState, finding, postEvents);
    assert.strictEqual(evaluated.stage, 'VERIFIED_RESULT');
    assert.strictEqual(evaluated.is_simulated, false);
    assert.strictEqual(isAuthoritativeVerified(evaluated), true);
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 1825.0);
  });

  // Test 2 — Post volume lower than baseline
  // Baseline: 10,000 events / 10 days ($0.010/call)
  // Post: 2,000 events / 5 days ($0.005/call)
  // Verify annualization uses: 2,000 / 5 * 365 = $730.00, not baseline (10,000 / 10 * 365 = $3,650.00)
  it('Test 2: Post volume lower than baseline — annualization uses post volume (2,000 / 5 * 365), not baseline volume', () => {
    const start = '2026-09-01T00:00:00.000Z';
    const end = '2026-09-06T00:00:00.000Z'; // Exactly 5 days
    const costDelta = 0.005;
    const postCount = 2000;

    const directResult = calculateAnnualizedVerifiedSavings(costDelta, postCount, start, end);
    assert.strictEqual(directResult.valid, true);
    assert.strictEqual(directResult.duration_days, 5);
    // (2000 * 0.005) / 5 * 365 = (10 / 5) * 365 = 730.00
    assert.strictEqual(directResult.annualized_savings_usd, 730.0);

    // End-to-end comparator check
    const finding = createMockProductionFinding({
      eligible_event_count: 10000,
      baseline_spend_usd: 100.0, // Pre cost per call: 100.0 / 10000 = $0.010
    });

    const deployTime = new Date(start).getTime();
    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: new Date(deployTime - 10 * 86_400_000).toISOString(),
        end: start,
        avg_cost_per_call_usd: 0.01,
        sample_count: 10000, // Baseline has 10,000 events
      },
      deployment_timestamp: start,
      observation_window: {
        start: start,
        end: end,
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    const postEvents = createTestEvents(postCount, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: deployTime,
      stepMs: 100_000,
    });

    const evaluated = evaluateVerification(deployedState, finding, postEvents);
    assert.strictEqual(evaluated.stage, 'VERIFIED_RESULT');
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 730.0);
  });

  // Test 3 — Different observation duration (1-day, 7-day, 30-day post-deployment windows)
  it('Test 3: Different observation durations (1-day, 7-day, 30-day post windows)', () => {
    // 1-day window: 100 events, delta $0.05 -> observed savings $5.00 -> $5 / 1 * 365 = $1,825.00
    const start1 = '2026-09-01T00:00:00.000Z';
    const end1 = '2026-09-02T00:00:00.000Z';
    const res1 = calculateAnnualizedVerifiedSavings(0.05, 100, start1, end1);
    assert.strictEqual(res1.valid, true);
    assert.strictEqual(res1.duration_days, 1);
    assert.strictEqual(res1.annualized_savings_usd, 1825.0);

    // 7-day window: 700 events, delta $0.01 -> observed savings $7.00 -> $7 / 7 * 365 = $365.00
    const start7 = '2026-09-01T00:00:00.000Z';
    const end7 = '2026-09-08T00:00:00.000Z';
    const res7 = calculateAnnualizedVerifiedSavings(0.01, 700, start7, end7);
    assert.strictEqual(res7.valid, true);
    assert.strictEqual(res7.duration_days, 7);
    assert.strictEqual(res7.annualized_savings_usd, 365.0);

    // 30-day window: 3,000 events, delta $0.02 -> observed savings $60.00 -> $60 / 30 * 365 = $730.00
    const start30 = '2026-08-01T00:00:00.000Z';
    const end30 = '2026-08-31T00:00:00.000Z';
    const res30 = calculateAnnualizedVerifiedSavings(0.02, 3000, start30, end30);
    assert.strictEqual(res30.valid, true);
    assert.strictEqual(res30.duration_days, 30);
    assert.strictEqual(res30.annualized_savings_usd, 730.0);
  });

  // Test 4 — Invalid post observation interval
  it('Test 4: Invalid post observation interval withholds annualization and prevents verification', () => {
    // End before start
    const start = '2026-09-10T00:00:00.000Z';
    const end = '2026-09-05T00:00:00.000Z';
    const res = calculateAnnualizedVerifiedSavings(0.01, 100, start, end);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.annualized_savings_usd, 0);

    // End equal to start (zero duration)
    const resZero = calculateAnnualizedVerifiedSavings(0.01, 100, start, start);
    assert.strictEqual(resZero.valid, false);
    assert.strictEqual(resZero.annualized_savings_usd, 0);

    // Missing start
    const resMissing = calculateAnnualizedVerifiedSavings(0.01, 100, undefined, end);
    assert.strictEqual(resMissing.valid, false);

    // End-to-end check with inverted observation window
    const finding = createMockProductionFinding();
    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: '2026-08-20T00:00:00.000Z',
        end: '2026-08-27T00:00:00.000Z',
        avg_cost_per_call_usd: 0.01,
        sample_count: 1000,
      },
      deployment_timestamp: start,
      observation_window: {
        start: start,
        end: end, // Inverted!
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    const postEvents = createTestEvents(25, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: new Date(start).getTime(),
    });

    const evaluated = evaluateVerification(deployedState, finding, postEvents);
    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 0);
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
  });

  // Test 5 — Zero post event count
  it('Test 5: Zero post event count withholds annualization', () => {
    const start = '2026-09-01T00:00:00.000Z';
    const end = '2026-09-08T00:00:00.000Z';
    const res = calculateAnnualizedVerifiedSavings(0.01, 0, start, end);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.annualized_savings_usd, 0);
  });

  // Test 6 — Simulation
  it('Test 6: Simulation must never create authoritative savings or payable outcome fee', () => {
    const finding = createMockProductionFinding();
    const state = initializeVerificationState(finding);
    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...state,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    const simEvents = createTestEvents(25, {
      is_simulated: true,
      cost: 0.0018,
      baseTimestamp: deployTime + 10_000,
    });

    const evaluated = evaluateVerification(deployedState, finding, simEvents);
    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
    assert.strictEqual(getAuthoritativeVerifiedSavings(evaluated), 0);
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 0);

    const fee = calculateAuthoritativeOutcomeFee(evaluated, finding);
    assert.strictEqual(fee.isPayable, false);
    assert.strictEqual(fee.finalOutcomeFeeUsd, 0);
  });

  // Test 7 — Sample baseline
  it('Test 7: Sample baseline must never create authoritative savings', () => {
    const sampleFinding = createMockProductionFinding({ is_sample_data: true });
    const state = initializeVerificationState(sampleFinding);
    const deployTime = Date.now() - 3600_000;
    const deployedState: VerificationState = {
      ...state,
      stage: 'OBSERVATION_ACTIVE',
      deployment_timestamp: new Date(deployTime).toISOString(),
    };

    const realEvents = createTestEvents(25, {
      is_simulated: false,
      cost: 0.0018,
      baseTimestamp: deployTime + 10_000,
    });

    const evaluated = evaluateVerification(deployedState, sampleFinding, realEvents);
    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
    assert.strictEqual(getAuthoritativeVerifiedSavings(evaluated), 0);

    const fee = calculateAuthoritativeOutcomeFee(evaluated, sampleFinding);
    assert.strictEqual(fee.isPayable, false);
    assert.strictEqual(fee.finalOutcomeFeeUsd, 0);
  });

  // Test 8 — Existing canonical commercial example
  it('Test 8: Canonical commercial example ($1,000/mo verified savings, 20% fee = $2,400, 1-mo cap = $1,000, fee = $1,000)', () => {
    const verifiedMonthly = 1000.0;
    const originalEstimatedMonthly = 1500.0; // Realized ratio: 1000 / 1500 = 66.7% (> 50%)

    const outcome = calculateOutcomeFee(verifiedMonthly, originalEstimatedMonthly);
    assert.strictEqual(outcome.verifiedAnnualizedSavingsUsd, 12000.0);
    assert.strictEqual(outcome.rawOutcomeFeeUsd, 2400.0); // 20% of $12,000
    assert.strictEqual(outcome.capAmountUsd, 1000.0); // 1-month cap
    assert.strictEqual(outcome.protectionTriggered, false);
    assert.strictEqual(outcome.finalOutcomeFeeUsd, 1000.0); // Capped at $1,000
    assert.strictEqual(outcome.isPayable, true);

    // Exact 50% boundary check:
    // Case 1: Exactly 50.00% -> Protection NOT triggered
    const exact50 = calculateOutcomeFee(1000.0, 2000.0);
    assert.strictEqual(exact50.protectionTriggered, false);
    assert.strictEqual(exact50.finalOutcomeFeeUsd, 1000.0);

    // Case 2: 49.99% -> Protection triggered, Fee = $0.00
    const below50 = calculateOutcomeFee(999.8, 2000.0);
    assert.strictEqual(below50.protectionTriggered, true);
    assert.strictEqual(below50.finalOutcomeFeeUsd, 0.0);
    assert.strictEqual(below50.isPayable, false);
  });
});

describe('Cost Validation Integrity Suite (Critical Fix #2)', () => {
  const deployTime = 1700000000000;

  function baseEvent(resolvedCost: unknown): unknown {
    return {
      id: 'evt_cost_check',
      timestamp: new Date(deployTime + 10_000).toISOString(),
      model: 'gpt-4o-mini',
      status: 'SUCCESS',
      resolved_cost_usd: resolvedCost,
    };
  }

  it('Rejects negative cost', () => {
    const ev = baseEvent(-0.005) as AIEvent;
    assert.strictEqual(isValidEventData(ev, deployTime), false);
  });

  it('Rejects zero cost for authoritative verification telemetry', () => {
    const ev = baseEvent(0) as AIEvent;
    assert.strictEqual(isValidEventData(ev, deployTime), false);
  });

  it('Accepts valid strictly positive cost', () => {
    const ev = baseEvent(0.0018) as AIEvent;
    assert.strictEqual(isValidEventData(ev, deployTime), true);
  });

  it('Rejects NaN cost', () => {
    const ev = baseEvent(NaN) as AIEvent;
    assert.strictEqual(isValidEventData(ev, deployTime), false);
  });

  it('Rejects Infinity cost', () => {
    const ev = baseEvent(Infinity) as AIEvent;
    assert.strictEqual(isValidEventData(ev, deployTime), false);
  });

  it('Rejects missing or undefined cost', () => {
    const ev1 = baseEvent(undefined) as AIEvent;
    assert.strictEqual(isValidEventData(ev1, deployTime), false);

    const ev2 = baseEvent(null) as AIEvent;
    assert.strictEqual(isValidEventData(ev2, deployTime), false);
  });
});

describe('Observation Population ↔ Observation Window Integrity Suite (Tests A - J)', () => {
  // Test A — Event before observation start
  it('Test A: Event before observation_window.start is strictly excluded from population and cost calculations', () => {
    const finding = createMockProductionFinding({
      eligible_event_count: 1000,
      baseline_spend_usd: 10.0, // $0.010/call
    });

    const deployTime = new Date('2026-09-01T00:00:00.000Z').getTime();
    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: '2026-08-25T00:00:00.000Z',
        end: '2026-09-01T00:00:00.000Z',
        avg_cost_per_call_usd: 0.010,
        sample_count: 1000,
      },
      deployment_timestamp: '2026-09-01T00:00:00.000Z',
      observation_window: {
        start: '2026-09-05T00:00:00.000Z', // Observation window starts Sep 5
        end: '2026-09-12T00:00:00.000Z',   // Observation window ends Sep 12 (7 days)
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    // 5 events on Sep 2 (before observation window start) with high cost $0.05
    const earlyEvents = createTestEvents(5, {
      cost: 0.05,
      is_simulated: false,
      baseTimestamp: new Date('2026-09-02T00:00:00.000Z').getTime(),
      stepMs: 3600_000,
    });

    // 20 events inside window (Sep 6) with reduced cost $0.005
    const validEvents = createTestEvents(20, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: new Date('2026-09-06T00:00:00.000Z').getTime(),
      stepMs: 3600_000,
    });

    const evaluated = evaluateVerification(deployedState, finding, [...earlyEvents, ...validEvents]);
    assert.strictEqual(evaluated.stage, 'VERIFIED_RESULT');
    assert.strictEqual(isAuthoritativeVerified(evaluated), true);
    // Only the 20 events inside the window participate
    assert.strictEqual(evaluated.observation_window?.sample_event_count, 20);
    // Cost must be $0.005, not tainted by the $0.05 early events
    assert.strictEqual(evaluated.observed_result?.post_cost_per_call_usd, 0.005);
    assert.strictEqual(evaluated.observed_result?.observed_reduction_pct, 50.0);
    // Annualized: (20 * 0.005 / 7) * 365 = (0.10 / 7) * 365 = 5.21
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 5.21);
  });

  // Test B — Event after observation end
  it('Test B: Event after observation_window.end is strictly excluded from population and cost calculations', () => {
    const finding = createMockProductionFinding({
      eligible_event_count: 1000,
      baseline_spend_usd: 10.0, // $0.010/call
    });

    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: '2026-08-25T00:00:00.000Z',
        end: '2026-09-01T00:00:00.000Z',
        avg_cost_per_call_usd: 0.010,
        sample_count: 1000,
      },
      deployment_timestamp: '2026-09-01T00:00:00.000Z',
      observation_window: {
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-09-08T00:00:00.000Z', // 7 days
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    // 20 events inside window (Sep 3) at $0.005
    const inWindowEvents = createTestEvents(20, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: new Date('2026-09-03T00:00:00.000Z').getTime(),
      stepMs: 3600_000,
    });

    // 10 events after window end (Sep 15) at $0.05
    const lateEvents = createTestEvents(10, {
      cost: 0.05,
      is_simulated: false,
      baseTimestamp: new Date('2026-09-15T00:00:00.000Z').getTime(),
      stepMs: 3600_000,
    });

    const evaluated = evaluateVerification(deployedState, finding, [...inWindowEvents, ...lateEvents]);
    assert.strictEqual(evaluated.stage, 'VERIFIED_RESULT');
    assert.strictEqual(isAuthoritativeVerified(evaluated), true);
    assert.strictEqual(evaluated.observation_window?.sample_event_count, 20);
    assert.strictEqual(evaluated.observed_result?.post_cost_per_call_usd, 0.005);
    assert.strictEqual(evaluated.observed_result?.observed_reduction_pct, 50.0);
  });

  // Test C — Events span a much longer period than observation window (81-day / 7-day error class)
  it('Test C: Long-span telemetry (81 days) vs short window (7 days) — never divides 81-day volume by 7 days', () => {
    const finding = createMockProductionFinding({
      eligible_event_count: 1000,
      baseline_spend_usd: 10.0, // $0.010/call
    });

    const start = '2026-09-01T00:00:00.000Z';
    const end = '2026-09-08T00:00:00.000Z'; // Exactly 7 days

    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: '2026-08-25T00:00:00.000Z',
        end: start,
        avg_cost_per_call_usd: 0.010,
        sample_count: 1000,
      },
      deployment_timestamp: start,
      observation_window: {
        start,
        end,
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    // 20 events inside the 7-day window (Sep 2)
    const inWindowEvents = createTestEvents(20, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: new Date(start).getTime(),
      stepMs: 3600_000,
    });

    // 100 events outside window spanning up to Nov 21 (81 days after deploy)
    const outsideEvents = createTestEvents(100, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: new Date('2026-09-09T00:00:00.000Z').getTime(),
      stepMs: 40_000_000,
    });

    const evaluated = evaluateVerification(deployedState, finding, [...inWindowEvents, ...outsideEvents]);
    assert.strictEqual(evaluated.stage, 'VERIFIED_RESULT');
    // Crucial: Only the 20 events within the 7-day window participate
    assert.strictEqual(evaluated.observation_window?.sample_event_count, 20);
    // Verified annualization: (20 * 0.005 / 7) * 365 = $5.21
    // (If all 120 events were naively divided by 7 days, it would have inflated to $31.29)
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 5.21);
  });

  // Test D — Explicit observation window
  it('Test D: Explicit observation window sample_event_count strictly equals eligible events inside window', () => {
    const finding = createMockProductionFinding();
    const start = '2026-09-01T00:00:00.000Z';
    const end = '2026-09-08T00:00:00.000Z';

    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: '2026-08-25T00:00:00.000Z',
        end: start,
        avg_cost_per_call_usd: 0.010,
        sample_count: 1000,
      },
      deployment_timestamp: start,
      observation_window: {
        start,
        end,
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    // 5 events before start
    const before = createTestEvents(5, {
      is_simulated: false,
      baseTimestamp: new Date('2026-08-30T00:00:00.000Z').getTime(),
      stepMs: 3600_000,
    });
    // 25 events inside window
    const inside = createTestEvents(25, {
      is_simulated: false,
      baseTimestamp: new Date('2026-09-02T00:00:00.000Z').getTime(),
      stepMs: 3600_000,
    });
    // 15 events after window
    const after = createTestEvents(15, {
      is_simulated: false,
      baseTimestamp: new Date('2026-09-10T00:00:00.000Z').getTime(),
      stepMs: 3600_000,
    });

    const evaluated = evaluateVerification(deployedState, finding, [...before, ...inside, ...after]);
    assert.strictEqual(evaluated.observation_window?.sample_event_count, 25);
  });

  // Test E — Event-derived observation window
  it('Test E: Event-derived observation window sets end to max eligible production timestamp', () => {
    const finding = createMockProductionFinding({
      eligible_event_count: 1000,
      baseline_spend_usd: 10.0, // $0.010/call
    });

    const deployTime = '2026-09-01T00:00:00.000Z';
    // State without explicit end (start === end, initial state)
    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: '2026-08-25T00:00:00.000Z',
        end: deployTime,
        avg_cost_per_call_usd: 0.010,
        sample_count: 1000,
      },
      deployment_timestamp: deployTime,
      observation_window: {
        start: deployTime,
        end: deployTime, // Unclosed placeholder
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    // Exactly 20 events spanning from Sep 1 to Sep 5 (4 days duration)
    const deployMs = new Date(deployTime).getTime();
    const fourDaysMs = 4 * 86_400_000;
    const postEvents = createTestEvents(20, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: deployMs,
      stepMs: fourDaysMs / 20, // Final event at deployMs + 4 days
    });

    const evaluated = evaluateVerification(deployedState, finding, postEvents);
    assert.strictEqual(evaluated.stage, 'VERIFIED_RESULT');
    assert.strictEqual(evaluated.observation_window?.sample_event_count, 20);
    assert.strictEqual(evaluated.observation_window?.start, deployTime);

    // End must match the max event timestamp (Sep 5)
    const expectedEnd = new Date(deployMs + fourDaysMs).toISOString();
    assert.strictEqual(evaluated.observation_window?.end, expectedEnd);

    // Annualized: (20 * 0.005 / 4) * 365 = (0.10 / 4) * 365 = 9.125 -> 9.12
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 9.12);
  });

  // Test F — No valid observation window
  it('Test F: Missing, inverted, or invalid observation window withholds authoritative verification', () => {
    const finding = createMockProductionFinding();
    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: '2026-08-25T00:00:00.000Z',
        end: '2026-09-01T00:00:00.000Z',
        avg_cost_per_call_usd: 0.010,
        sample_count: 1000,
      },
      deployment_timestamp: '2026-09-01T00:00:00.000Z',
      observation_window: {
        start: '2026-09-10T00:00:00.000Z',
        end: '2026-09-05T00:00:00.000Z', // Inverted (end < start)
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    const postEvents = createTestEvents(25, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: new Date('2026-09-06T00:00:00.000Z').getTime(),
    });

    const evaluated = evaluateVerification(deployedState, finding, postEvents);
    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 0);
    assert.ok(
      evaluated.observed_result?.verification_notes.includes(
        'Authoritative verification withheld: observation window is invalid or inverted'
      )
    );
  });

  // Test G — Current timestamp must not inflate/deflate historical telemetry
  it('Test G: Historical telemetry imported does not use current wall-clock date as observation end', () => {
    const finding = createMockProductionFinding({
      eligible_event_count: 1000,
      baseline_spend_usd: 10.0, // $0.010/call
    });

    // Historical deployment on Jan 1, 2026
    const deployTime = '2026-01-01T00:00:00.000Z';
    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: '2025-12-25T00:00:00.000Z',
        end: deployTime,
        avg_cost_per_call_usd: 0.010,
        sample_count: 1000,
      },
      deployment_timestamp: deployTime,
      is_simulated: false,
    };

    // Historical telemetry: 20 events spanning 7 days (Jan 1 to Jan 8, 2026)
    const deployMs = new Date(deployTime).getTime();
    const sevenDaysMs = 7 * 86_400_000;
    const postEvents = createTestEvents(20, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: deployMs,
      stepMs: sevenDaysMs / 20,
    });

    const evaluated = evaluateVerification(deployedState, finding, postEvents);
    assert.strictEqual(evaluated.stage, 'VERIFIED_RESULT');
    // End must be the Jan 8, 2026 telemetry boundary, NOT today's date
    const expectedHistoricalEnd = new Date(deployMs + sevenDaysMs).toISOString();
    assert.strictEqual(evaluated.observation_window?.end, expectedHistoricalEnd);
    // Annualized uses 7 days: (20 * 0.005 / 7) * 365 = 5.21
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 5.21);
  });

  // Test H — Existing differing-volume tests remain valid
  it('Test H: Differing volume tests remain strictly valid (7,000 / 7d = $1,825; 2,000 / 5d = $730)', () => {
    const res1 = calculateAnnualizedVerifiedSavings(0.005, 7000, '2026-09-01T00:00:00.000Z', '2026-09-08T00:00:00.000Z');
    assert.strictEqual(res1.annualized_savings_usd, 1825.0);

    const res2 = calculateAnnualizedVerifiedSavings(0.005, 2000, '2026-09-01T00:00:00.000Z', '2026-09-06T00:00:00.000Z');
    assert.strictEqual(res2.annualized_savings_usd, 730.0);
  });

  // Test I — Commercial isolation
  it('Test I: Observation window failure never produces a payable commercial outcome', () => {
    const finding = createMockProductionFinding();
    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: '2026-08-25T00:00:00.000Z',
        end: '2026-09-01T00:00:00.000Z',
        avg_cost_per_call_usd: 0.010,
        sample_count: 1000,
      },
      deployment_timestamp: '2026-09-01T00:00:00.000Z',
      observation_window: {
        start: '2026-09-10T00:00:00.000Z',
        end: '2026-09-05T00:00:00.000Z', // Inverted
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    const postEvents = createTestEvents(25, { cost: 0.005, is_simulated: false });
    const evaluated = evaluateVerification(deployedState, finding, postEvents);

    const fee = calculateAuthoritativeOutcomeFee(evaluated, finding);
    assert.strictEqual(fee.isPayable, false);
    assert.strictEqual(fee.finalOutcomeFeeUsd, 0);
  });

  // Test J — Deduplication integrity
  it('Test J: Duplicate event IDs in post-deployment telemetry are deduplicated and not double-counted', () => {
    const finding = createMockProductionFinding({
      eligible_event_count: 1000,
      baseline_spend_usd: 10.0,
    });

    const start = '2026-09-01T00:00:00.000Z';
    const end = '2026-09-08T00:00:00.000Z';

    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: '2026-08-25T00:00:00.000Z',
        end: start,
        avg_cost_per_call_usd: 0.010,
        sample_count: 1000,
      },
      deployment_timestamp: start,
      observation_window: {
        start,
        end,
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    // 20 unique events
    const uniqueEvents = createTestEvents(20, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: new Date(start).getTime(),
      stepMs: 3600_000,
    });

    // Duplicate 10 of those exact events (same event IDs)
    const duplicateCopies = uniqueEvents.slice(0, 10).map(e => ({ ...e }));

    const evaluated = evaluateVerification(deployedState, finding, [...uniqueEvents, ...duplicateCopies]);
    assert.strictEqual(evaluated.stage, 'VERIFIED_RESULT');
    // Sample count must be 20, NOT 30
    assert.strictEqual(evaluated.observation_window?.sample_event_count, 20);
    // Exclusion note should indicate the 10 duplicate IDs
    assert.ok(evaluated.observed_result?.verification_notes.includes('10 duplicate IDs'));
  });

  // Test K — Observation window begins before deployment timestamp (deployment = 2026-09-01, start = 2026-08-25, end = 2026-09-08)
  it('Test K: Observation window beginning before deployment timestamp is withheld from authoritative verification', () => {
    const finding = createMockProductionFinding({
      eligible_event_count: 1000,
      baseline_spend_usd: 10.0, // $0.010/call
    });

    const deployedState: VerificationState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE',
      baseline_window: {
        start: '2026-08-18T00:00:00.000Z',
        end: '2026-09-01T00:00:00.000Z',
        avg_cost_per_call_usd: 0.010,
        sample_count: 1000,
      },
      deployment_timestamp: '2026-09-01T00:00:00.000Z',
      observation_window: {
        start: '2026-08-25T00:00:00.000Z',
        end: '2026-09-08T00:00:00.000Z',
        sample_event_count: 0,
      },
      is_simulated: false,
    };

    // Valid post-deployment production telemetry (25 events on 2026-09-02, cost $0.005 vs baseline $0.010)
    const validPostTelemetry = createTestEvents(25, {
      cost: 0.005,
      is_simulated: false,
      baseTimestamp: new Date('2026-09-02T00:00:00.000Z').getTime(),
      stepMs: 3600_000,
    });

    const evaluated = evaluateVerification(deployedState, finding, validPostTelemetry);

    // Invariant: VERIFIED_RESULT is false (stage remains OBSERVATION_ACTIVE)
    assert.strictEqual(evaluated.stage === 'VERIFIED_RESULT', false);
    assert.strictEqual(evaluated.stage, 'OBSERVATION_ACTIVE');

    // Invariant: is_authoritative = false
    assert.strictEqual(evaluated.observed_result?.is_authoritative, false);
    assert.strictEqual(isAuthoritativeVerified(evaluated), false);

    // Invariant: annualized_realized_savings_usd = 0
    assert.strictEqual(evaluated.observed_result?.annualized_realized_savings_usd, 0);

    // Truthful note explaining that the observation window begins before deployment
    assert.ok(
      evaluated.observed_result?.verification_notes.includes(
        'observation window begins before deployment'
      )
    );

    // Verify observation window start was NOT silently shifted
    assert.strictEqual(evaluated.observation_window?.start, '2026-08-25T00:00:00.000Z');
    assert.strictEqual(evaluated.observation_window?.end, '2026-09-08T00:00:00.000Z');

    // Payable outcome fee is $0 because verification is not authoritative
    const outcomeFee = calculateAuthoritativeOutcomeFee(evaluated, finding);
    assert.strictEqual(outcomeFee.isPayable, false);
    assert.strictEqual(outcomeFee.finalOutcomeFeeUsd, 0);
    assert.strictEqual(outcomeFee.verifiedAnnualizedSavingsUsd, 0);
  });
});
