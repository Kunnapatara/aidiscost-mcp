/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AIEvent, DataHealthReport } from '../types/domain';
import { evaluateModelRightSizing } from '../engine/rules/right-sizing';
import { evaluateRetryErrorLoop } from '../engine/rules/retry-loop';
import { evaluateRepeatedCallPattern } from '../engine/rules/repeated-call';
import { annualizeSavings } from '../engine/rules/annualization';
import { runOptimizationRules } from '../engine/rules/evaluator';
import { generateFixPackage } from '../engine/fix/generator';
import { isValidRuleEvent } from '../engine/rules/validation';
import { calculateAuthoritativeOutcomeFee, calculateOutcomeFee, COMMERCIAL_PRICING } from '../engine/billing/outcome';
import { evaluateVerification } from '../engine/verification/comparator';

function createMockEvent(overrides: Partial<AIEvent> = {}): AIEvent {
  return {
    id: `ev_${Math.random().toString(36).substring(2, 9)}`,
    source: 'custom_logs',
    source_event_id: `src_${Math.random().toString(36).substring(2, 9)}`,
    timestamp: '2026-03-01T12:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4o',
    operation: 'chat',
    input_tokens: 200,
    output_tokens: 50,
    total_tokens: 250,
    latency_ms: 320,
    status: 'SUCCESS',
    trace_id: 'trace_101',
    tool_calls: [],
    prompt_hash: 'hash_abc123',
    source_reported_cost_usd: 0.001,
    calculated_cost_usd: 0.001,
    resolved_cost_usd: 0.001,
    cost_provenance: 'CALCULATED',
    cost_confidence: 'HIGH',
    metadata: { environment: 'production' },
    is_simulated: false,
    ...overrides,
  };
}

const mockHealthyReport: DataHealthReport = {
  total_events: 100,
  unique_events: 100,
  duplicate_events_dropped: 0,
  time_range: {
    start: '2026-03-01T00:00:00.000Z',
    end: '2026-03-02T00:00:00.000Z', // 24 hours
  },
  model_coverage_pct: 100,
  token_coverage_pct: 100,
  source_cost_coverage_pct: 100,
  pricing_coverage_pct: 100,
  latency_coverage_pct: 100,
  trace_coverage_pct: 100,
  missing_critical_fields: [],
  warnings: [],
  analysis_confidence: 'HIGH',
  health_grade: 'HEALTHY',
  is_sample_data: false,
};

describe('Optimization Engine & Fix Package Truth Boundary Hardening', () => {
  // Test A: Model substitution is an estimate
  it('Test A: Model right-sizing preserves observed baseline, calculates candidate, labels savings as estimated, and avoids unverified quality equivalence claims', () => {
    const events: AIEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(
        createMockEvent({
          id: `ev_rs_${i}`,
          model: 'gpt-4o',
          input_tokens: 250,
          output_tokens: 60,
          resolved_cost_usd: 0.0012,
          cost_provenance: 'SOURCE_REPORTED',
          status: 'SUCCESS',
        })
      );
    }

    const finding = evaluateModelRightSizing(events, 'audit_test_a', false, {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-02T00:00:00.000Z',
    });

    assert.ok(finding !== null, 'Right sizing finding should be detected');
    assert.strictEqual(finding.rule_id, 'MODEL_RIGHT_SIZING');
    assert.strictEqual(finding.savings_confidence, 'ESTIMATED');
    assert.ok(finding.baseline_spend_usd > 0, 'Baseline spend must be positive observed');
    assert.ok(finding.candidate_spend_usd > 0, 'Candidate spend must be calculated');
    assert.ok(finding.estimated_savings_usd > 0, 'Savings must be estimated');
    assert.strictEqual(finding.title, 'Potential Model Right-Sizing Opportunity');
    assert.ok(!finding.summary.includes('safely replace'), 'Must not claim safe replacement');
    assert.ok(
      finding.assumptions.some(a => a.includes('benchmark testing is required') || a.includes('evaluation opportunity')),
      'Must contain benchmark requirement assumption'
    );
  });

  // Test B: Hard-coded quality claims are not treated as customer facts
  it('Test B: Fix Package does not assert unverified quality equivalence or fabricated performance metrics', () => {
    const events: AIEvent[] = [];
    for (let i = 0; i < 15; i++) {
      events.push(
        createMockEvent({
          id: `ev_b_${i}`,
          model: 'gpt-4o',
          input_tokens: 200,
          output_tokens: 40,
          resolved_cost_usd: 0.001,
        })
      );
    }

    const finding = evaluateModelRightSizing(events, 'audit_test_b', false, {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-02T00:00:00.000Z',
    });
    assert.ok(finding);

    const fix = generateFixPackage(finding, true);

    // Root cause must explicitly be a hypothesis
    assert.ok(fix.root_cause_hypothesis.startsWith('Hypothesis:'), 'Root cause must be explicitly labeled as a hypothesis');

    // Quality risk must be truth-preserving REQUIRES_BENCHMARK
    assert.strictEqual(fix.expected_impact.quality_risk, 'REQUIRES_BENCHMARK');

    // Latency delta must not be fabricated as a guaranteed fact
    assert.strictEqual(fix.expected_impact.latency_delta_ms, 0);

    // Acceptance criteria must be explicitly labeled as templates
    assert.ok(fix.acceptance_criteria.every(c => c.startsWith('[Template Criterion]')), 'Criteria must be template criteria');
    assert.ok(!fix.acceptance_criteria.some(c => c.includes('99.2%') || c.includes('under 0.05%')), 'Must not contain fabricated numbers');
  });

  // Test C: Expected monthly savings is not falsely derived with arbitrary * 30
  it('Test C: Fix Package does not use naive * 30 multiplier on short observation windows', () => {
    const events: AIEvent[] = [];
    for (let i = 0; i < 15; i++) {
      events.push(
        createMockEvent({
          id: `ev_c_${i}`,
          model: 'gpt-4o',
          input_tokens: 200,
          output_tokens: 50,
          resolved_cost_usd: 0.001,
        })
      );
    }

    // Narrow 2-hour observation window
    const finding = evaluateModelRightSizing(events, 'audit_test_c', false, {
      start: '2026-03-01T12:00:00.000Z',
      end: '2026-03-01T14:00:00.000Z', // 2 hours
    });
    assert.ok(finding);

    const fix = generateFixPackage(finding, false);

    // Naive * 30 would have produced: finding.estimated_savings_usd * 30
    // Under annualization: (savings / (2/24)) * 365 / 12 months
    const naiveValue = Number((finding.estimated_savings_usd * 30).toFixed(2));
    const annualizedMonthly = Number((finding.annualized_projection_usd / 12).toFixed(2));

    assert.strictEqual(fix.expected_impact.monthly_savings_usd, annualizedMonthly);
    assert.notStrictEqual(fix.expected_impact.monthly_savings_usd, naiveValue);
    assert.ok(fix.expected_impact.projection_basis?.includes('annualized projection'));
  });

  // Test D: Annualization remains conservative
  it('Test D: Annualization handles valid, short, invalid, zero, negative, and infinite inputs safely', () => {
    // 1. Valid 24-hour window
    const valid = annualizeSavings(10.0, {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-02T00:00:00.000Z',
    });
    assert.strictEqual(valid.is_annualized, true);
    assert.strictEqual(valid.annualized_usd, 3650.0);

    // 2. Narrow window (< 1 hour): withheld
    const narrow = annualizeSavings(10.0, {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-01T00:30:00.000Z', // 30 mins
    });
    assert.strictEqual(narrow.is_annualized, false);
    assert.strictEqual(narrow.annualized_usd, 0.0);
    assert.ok(narrow.conservative_assumption?.includes('too short'));

    // 3. Inverted window (end <= start): withheld
    const inverted = annualizeSavings(10.0, {
      start: '2026-03-02T00:00:00.000Z',
      end: '2026-03-01T00:00:00.000Z',
    });
    assert.strictEqual(inverted.is_annualized, false);
    assert.strictEqual(inverted.annualized_usd, 0.0);

    // 4. Zero savings
    const zero = annualizeSavings(0.0, {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-02T00:00:00.000Z',
    });
    assert.strictEqual(zero.is_annualized, false);
    assert.strictEqual(zero.annualized_usd, 0.0);

    // 5. Negative savings
    const negative = annualizeSavings(-5.0, {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-02T00:00:00.000Z',
    });
    assert.strictEqual(negative.is_annualized, false);
    assert.strictEqual(negative.annualized_usd, 0.0);

    // 6. Non-finite / NaN
    const nanRes = annualizeSavings(NaN, {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-02T00:00:00.000Z',
    });
    assert.strictEqual(nanRes.is_annualized, false);
    assert.strictEqual(nanRes.annualized_usd, 0.0);

    // 7. Improbably large window (> 10 years)
    const corruptLong = annualizeSavings(10.0, {
      start: '2010-01-01T00:00:00.000Z',
      end: '2026-01-01T00:00:00.000Z', // 16 years
    });
    assert.strictEqual(corruptLong.is_annualized, false);
    assert.strictEqual(corruptLong.annualized_usd, 0.0);
  });

  // Test E: Retry spend language
  it('Test E: Retry engine distinguishes observed failed retry spend from potential avoidable spend', () => {
    const events: AIEvent[] = [];
    const baseTime = new Date('2026-03-01T12:00:00.000Z').getTime();

    // 2 consecutive bursts with errors to ensure sufficient sample count
    for (let i = 0; i < 8; i++) {
      events.push(
        createMockEvent({
          id: `ev_err_${i}`,
          timestamp: new Date(baseTime + i * 3000).toISOString(),
          status: i % 4 === 0 ? 'SUCCESS' : 'ERROR',
          error_code: i % 4 === 0 ? undefined : 'HTTP_429',
          trace_id: 'trace_retry_loop_1',
          resolved_cost_usd: 0.005,
        })
      );
    }

    const finding = evaluateRetryErrorLoop(events, 'audit_retry_test', false, {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-02T00:00:00.000Z',
    });

    assert.ok(finding, 'Retry error loop finding should be detected');
    assert.strictEqual(finding.rule_id, 'RETRY_ERROR_LOOP');
    assert.strictEqual(finding.savings_confidence, 'ESTIMATED');

    // Mathematical proof and metrics must frame failed spend accurately
    const failedMetric = finding.evidence.metrics_comparison.find(m => m.label === 'Observed Failed Retry Spend');
    const avoidableMetric = finding.evidence.metrics_comparison.find(m => m.label === 'Potential Avoidable Retry Spend');

    assert.ok(failedMetric, 'Must contain Observed Failed Retry Spend metric');
    assert.strictEqual(failedMetric.provenance, 'CALCULATED');
    assert.ok(avoidableMetric, 'Must contain Potential Avoidable Retry Spend metric');
    assert.strictEqual(avoidableMetric.provenance, 'ESTIMATED');

    assert.ok(!finding.summary.includes('wasted spend'), 'Must not claim wasted spend in summary');
  });

  // Test F: Repeated-call detection
  it('Test F: Repeated-call engine identifies potential caching opportunities without asserting semantic output equivalence', () => {
    const events: AIEvent[] = [];
    const baseTime = new Date('2026-03-01T12:00:00.000Z').getTime();

    // 6 identical calls (1 origin + 5 repeated) within 15 minutes
    for (let i = 0; i < 6; i++) {
      events.push(
        createMockEvent({
          id: `ev_rep_${i}`,
          timestamp: new Date(baseTime + i * 40000).toISOString(),
          status: 'SUCCESS',
          trace_id: 'trace_same_session',
          prompt_hash: 'hash_deterministic_query_999',
          resolved_cost_usd: 0.004,
        })
      );
    }

    const finding = evaluateRepeatedCallPattern(events, 'audit_rep_test', false, {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-02T00:00:00.000Z',
    });

    assert.ok(finding, 'Repeated call pattern finding should be detected');
    assert.strictEqual(finding.rule_id, 'REPEATED_CALL_PATTERN');
    assert.strictEqual(finding.savings_confidence, 'ESTIMATED');
    assert.ok(
      finding.assumptions.some(a => a.includes('do not prove semantic equivalence') || a.includes('idempotency')),
      'Must warn that prompt hash equality does not prove output equivalence'
    );
  });

  // Test G: Cost provenance downgrades cost confidence when pricing is unpriced or unknown
  it('Test G: Cost confidence is downgraded when events contain unpriced or unknown provenance', () => {
    const events: AIEvent[] = [];
    for (let i = 0; i < 15; i++) {
      events.push(
        createMockEvent({
          id: `ev_prov_${i}`,
          model: 'gpt-4o',
          cost_provenance: i === 0 ? 'UNPRICED' : 'CALCULATED',
          resolved_cost_usd: 0.001,
        })
      );
    }

    const finding = evaluateModelRightSizing(events, 'audit_prov_test', false, {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-02T00:00:00.000Z',
    });

    assert.ok(finding);
    assert.strictEqual(finding.cost_confidence, 'MEDIUM', 'Unpriced event must prevent HIGH cost confidence');
  });

  // Test H: Invalid event data validation
  it('Test H: Rejects negative cost, NaN, Infinity, corrupt timestamps, and negative tokens', () => {
    assert.strictEqual(isValidRuleEvent(createMockEvent({ resolved_cost_usd: -0.05 })), false);
    assert.strictEqual(isValidRuleEvent(createMockEvent({ resolved_cost_usd: NaN })), false);
    assert.strictEqual(isValidRuleEvent(createMockEvent({ resolved_cost_usd: Infinity })), false);
    assert.strictEqual(isValidRuleEvent(createMockEvent({ input_tokens: -10 })), false);
    assert.strictEqual(isValidRuleEvent(createMockEvent({ timestamp: 'invalid-date' })), false);
    assert.strictEqual(isValidRuleEvent(createMockEvent({ model: '' })), false);
    assert.strictEqual(isValidRuleEvent(createMockEvent()), true);
  });

  // Test I: Sample data boundary
  it('Test I: Sample data flag is preserved and simulated events are excluded from production audits', () => {
    const mixedEvents: AIEvent[] = [
      createMockEvent({ id: 'ev_prod_1', is_simulated: false }),
      createMockEvent({ id: 'ev_sim_1', is_simulated: true }),
    ];

    const prodAudit = runOptimizationRules(mixedEvents, 'custom_logs', mockHealthyReport, false);
    assert.strictEqual(prodAudit.is_sample_data, false);

    // Production audit must only account for non-simulated spend
    assert.strictEqual(prodAudit.total_spend_usd, 0.001);

    const sampleAudit = runOptimizationRules(mixedEvents, 'custom_logs', mockHealthyReport, true);
    assert.strictEqual(sampleAudit.is_sample_data, true);
  });

  // Test J: Aggregate double counting
  it('Test J: Evaluator sets aggregate_is_deduplicated to false and provides transparency note', () => {
    const events: AIEvent[] = [];
    for (let i = 0; i < 25; i++) {
      events.push(
        createMockEvent({
          id: `ev_agg_${i}`,
          model: 'gpt-4o',
          input_tokens: 200,
          output_tokens: 40,
          resolved_cost_usd: 0.001,
        })
      );
    }

    const audit = runOptimizationRules(events, 'custom_logs', mockHealthyReport, false);
    assert.strictEqual(audit.aggregate_is_deduplicated, false);
    assert.ok(audit.deduplication_note?.includes('not been portfolio-deduplicated'));
  });

  // Test K: Existing commercial contract preservation
  it('Test K: Preserves commercial pricing, one-month cap, and 50% protection clause boundary tests', () => {
    assert.strictEqual(COMMERCIAL_PRICING.FIX_PACKAGE_PRICE_USD, 49);
    assert.strictEqual(COMMERCIAL_PRICING.OUTCOME_FEE_ANNUAL_PCT, 0.20);
    assert.strictEqual(COMMERCIAL_PRICING.PROTECTION_MIN_RATIO, 0.50);

    // Fee calculation with 50% protection clause
    // Original estimated monthly: $833.33 ($10,000 / 12)
    // 49.99% of original estimate ($416.58) -> waived ($0.00)
    const waived = calculateOutcomeFee(416.58, 833.33);
    assert.strictEqual(waived.isPayable, false);
    assert.strictEqual(waived.finalOutcomeFeeUsd, 0.0);

    // Exactly 50.00% ($416.67) -> payable
    const payable = calculateOutcomeFee(416.67, 833.33);
    assert.strictEqual(payable.isPayable, true);
    assert.ok(payable.finalOutcomeFeeUsd > 0);
  });

  // Test L: Existing verification integrity preservation
  it('Test L: Preserves verification integrity: simulation cannot verify and synthetic baseline is rejected', () => {
    const finding = evaluateModelRightSizing(
      Array.from({ length: 15 }, (_, i) => createMockEvent({ id: `ev_base_${i}` })),
      'audit_verif',
      false
    );
    assert.ok(finding);

    const baseState = {
      finding_id: finding.id,
      stage: 'OBSERVATION_ACTIVE' as const,
      baseline_window: {
        start: '2026-03-01T00:00:00.000Z',
        end: '2026-03-02T00:00:00.000Z',
        avg_cost_per_call_usd: 0.001,
        sample_count: 15,
      },
      deployment_timestamp: '2026-03-02T12:00:00.000Z',
    };

    // Simulation events cannot reach VERIFIED_RESULT
    const simEvents = Array.from({ length: 25 }, (_, i) =>
      createMockEvent({
        id: `sim_post_${i}`,
        timestamp: '2026-03-02T13:00:00.000Z',
        resolved_cost_usd: 0.0001,
        is_simulated: true,
      })
    );

    const simRes = evaluateVerification(baseState, finding, simEvents);
    assert.strictEqual(simRes.stage, 'OBSERVATION_ACTIVE');
    assert.strictEqual(simRes.is_simulated, true);

    const billing = calculateAuthoritativeOutcomeFee(simRes, finding);
    assert.strictEqual(billing.isPayable, false);
    assert.strictEqual(billing.finalOutcomeFeeUsd, 0.0);
  });
});
