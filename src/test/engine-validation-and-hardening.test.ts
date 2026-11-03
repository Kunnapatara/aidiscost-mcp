/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AIEvent, DataHealthReport } from '../types/domain';
import { evaluateModelRightSizing, evaluateAllModelRightSizing } from '../engine/rules/right-sizing';
import { evaluateRetryErrorLoop } from '../engine/rules/retry-loop';
import { evaluateRepeatedCallPattern } from '../engine/rules/repeated-call';
import { runOptimizationRules } from '../engine/rules/evaluator';
import { lookupModelPricing } from '../engine/pricing/registry';

function createMockEvent(overrides: Partial<AIEvent> = {}): AIEvent {
  return {
    id: `ev_${Math.random().toString(36).substring(2, 9)}`,
    source: 'custom_logs',
    source_event_id: `src_${Math.random().toString(36).substring(2, 9)}`,
    timestamp: '2026-03-01T12:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4o',
    operation: 'chat',
    input_tokens: 150,
    output_tokens: 40,
    total_tokens: 190,
    latency_ms: 280,
    status: 'SUCCESS',
    trace_id: 'trace_test_suite_1',
    tool_calls: [],
    prompt_hash: 'hash_test_suite_prompt',
    source_reported_cost_usd: 0.000775,
    calculated_cost_usd: 0.000775,
    resolved_cost_usd: 0.000775,
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
    end: '2026-03-02T00:00:00.000Z',
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

describe('AI Cost Intelligence Engine Validation & Hardening Suite', () => {
  describe('1. Model Right-Sizing Precision & Substring Isolation', () => {
    it('does not classify gpt-4o-mini events as gpt-4o (eliminates substring collision false positive)', () => {
      // 20 events already running on gpt-4o-mini
      const miniEvents: AIEvent[] = [];
      for (let i = 0; i < 20; i++) {
        miniEvents.push(
          createMockEvent({
            id: `ev_mini_${i}`,
            model: 'gpt-4o-mini',
            input_tokens: 100,
            output_tokens: 25,
            resolved_cost_usd: 0.00003,
          })
        );
      }

      const finding = evaluateModelRightSizing(miniEvents, 'audit_mini_test', false);
      // Workload already on gpt-4o-mini must NOT receive a finding recommending migration to gpt-4o-mini
      assert.strictEqual(finding, null, 'Must not recommend right-sizing when workload is already on candidate model');
    });

    it('correctly flags lightweight gpt-4o workloads for right-sizing to gpt-4o-mini', () => {
      const gpt4oEvents: AIEvent[] = [];
      for (let i = 0; i < 15; i++) {
        gpt4oEvents.push(
          createMockEvent({
            id: `ev_4o_${i}`,
            model: 'gpt-4o',
            input_tokens: 150,
            output_tokens: 30,
            resolved_cost_usd: 0.000675,
          })
        );
      }

      const finding = evaluateModelRightSizing(gpt4oEvents, 'audit_4o_test', false);
      assert.ok(finding !== null);
      assert.strictEqual(finding.affected_scope, 'gpt-4o → gpt-4o-mini');
      assert.ok(finding.estimated_savings_usd > 0);
      assert.ok(finding.baseline_spend_usd > finding.candidate_spend_usd);
    });

    it('ranks multiple candidate pairs by highest savings', () => {
      const events: AIEvent[] = [];
      // 15 gpt-4-turbo events (more expensive)
      for (let i = 0; i < 15; i++) {
        events.push(
          createMockEvent({
            id: `ev_turbo_${i}`,
            model: 'gpt-4-turbo',
            input_tokens: 200,
            output_tokens: 50,
            resolved_cost_usd: 0.0035,
          })
        );
      }
      // 15 gpt-4o events (less expensive than turbo)
      for (let i = 0; i < 15; i++) {
        events.push(
          createMockEvent({
            id: `ev_4o_${i}`,
            model: 'gpt-4o',
            input_tokens: 200,
            output_tokens: 50,
            resolved_cost_usd: 0.001,
          })
        );
      }

      const allFindings = evaluateAllModelRightSizing(events, 'audit_multi_test', false);
      assert.strictEqual(allFindings.length, 2, 'Should detect both eligible model workloads');

      const topFinding = evaluateModelRightSizing(events, 'audit_multi_test', false);
      assert.ok(topFinding !== null);
      // Top finding should be the higher savings one (gpt-4-turbo)
      assert.strictEqual(topFinding.affected_scope, 'gpt-4-turbo → gpt-4o-mini');
    });
  });

  describe('2. Pricing Registry Prefix Resolution', () => {
    it('resolves gpt-4o-mini with longer prefix match over gpt-4o', () => {
      const pricing = lookupModelPricing('gpt-4o-mini-2024-07-18');
      assert.ok(pricing !== null);
      assert.strictEqual(pricing.model, 'gpt-4o-mini');
      assert.strictEqual(pricing.input_per_million_usd, 0.15);
      assert.strictEqual(pricing.output_per_million_usd, 0.60);
    });

    it('resolves unaliased snapshot prefix gpt-4o-mini-0718 to gpt-4o-mini pricing', () => {
      const pricing = lookupModelPricing('gpt-4o-mini-0718');
      assert.ok(pricing !== null);
      assert.strictEqual(pricing.model, 'gpt-4o-mini');
      assert.strictEqual(pricing.input_per_million_usd, 0.15);
    });

    it('resolves exact gpt-4o correctly', () => {
      const pricing = lookupModelPricing('gpt-4o');
      assert.ok(pricing !== null);
      assert.strictEqual(pricing.model, 'gpt-4o');
      assert.strictEqual(pricing.input_per_million_usd, 2.50);
    });
  });

  describe('3. Repeated Call Pattern Exact Arithmetic & Non-Trace Telemetry', () => {
    it('calculates baseline spend, candidate spend, and savings with 100% arithmetic balance', () => {
      const events: AIEvent[] = [];
      const baseTime = new Date('2026-03-01T12:00:00.000Z').getTime();

      // Cluster of 5 identical calls: 1 origin ($0.05) + 4 repeated ($0.05 each)
      // Total cluster spend = $0.2500
      for (let i = 0; i < 5; i++) {
        events.push(
          createMockEvent({
            id: `ev_cluster_${i}`,
            timestamp: new Date(baseTime + i * 30000).toISOString(),
            status: 'SUCCESS',
            trace_id: 'trace_cluster_a',
            prompt_hash: 'hash_cluster_deterministic_query',
            resolved_cost_usd: 0.05,
          })
        );
      }

      const finding = evaluateRepeatedCallPattern(events, 'audit_rep_exact', false);
      assert.ok(finding !== null);
      assert.strictEqual(finding.rule_id, 'REPEATED_CALL_PATTERN');

      // 4 repeated calls
      assert.strictEqual(finding.eligible_event_count, 4);
      // Baseline spend = 5 calls * $0.05 = $0.2500
      assert.strictEqual(finding.baseline_spend_usd, 0.2500);
      // Candidate spend = 1 origin call * $0.05 = $0.0500
      assert.strictEqual(finding.candidate_spend_usd, 0.0500);
      // Estimated savings = 4 repeated calls * $0.05 = $0.2000
      assert.strictEqual(finding.estimated_savings_usd, 0.2000);
      // Potential savings pct = 0.2000 / 0.2500 = 80.0%
      assert.strictEqual(finding.potential_savings_pct, 80.0);
      // Invariant: baseline - candidate === estimated_savings
      assert.strictEqual(
        Number((finding.baseline_spend_usd - finding.candidate_spend_usd).toFixed(4)),
        finding.estimated_savings_usd
      );
    });

    it('supports clustering for non-trace telemetry using prompt_hash within tight window', () => {
      const events: AIEvent[] = [];
      const baseTime = new Date('2026-03-01T14:00:00.000Z').getTime();

      // 5 identical calls on same model without trace_id within 3 minutes
      for (let i = 0; i < 5; i++) {
        events.push(
          createMockEvent({
            id: `ev_notrace_${i}`,
            timestamp: new Date(baseTime + i * 30000).toISOString(),
            status: 'SUCCESS',
            trace_id: undefined, // No trace ID
            prompt_hash: 'hash_proxy_prompt_no_trace',
            resolved_cost_usd: 0.02,
          })
        );
      }

      const finding = evaluateRepeatedCallPattern(events, 'audit_rep_notrace', false);
      assert.ok(finding !== null, 'Should detect repeated calls even when trace_id is omitted');
      assert.strictEqual(finding.eligible_event_count, 4);
      assert.strictEqual(finding.baseline_spend_usd, 0.1000);
      assert.strictEqual(finding.candidate_spend_usd, 0.0200);
      assert.strictEqual(finding.estimated_savings_usd, 0.0800);
    });
  });

  describe('4. Retry Loop Consecutive Error Burst Detection', () => {
    it('does NOT flag alternating intermittent success/error traffic as a retry loop', () => {
      const events: AIEvent[] = [];
      const baseTime = new Date('2026-03-01T12:00:00.000Z').getTime();

      // Alternating sequence: SUCCESS, ERROR, SUCCESS, ERROR, SUCCESS, ERROR
      for (let i = 0; i < 6; i++) {
        events.push(
          createMockEvent({
            id: `ev_intermittent_${i}`,
            timestamp: new Date(baseTime + i * 5000).toISOString(),
            status: i % 2 === 0 ? 'SUCCESS' : 'ERROR',
            error_code: i % 2 === 0 ? undefined : 'HTTP_500',
            trace_id: 'trace_normal_service',
            resolved_cost_usd: 0.005,
          })
        );
      }

      const finding = evaluateRetryErrorLoop(events, 'audit_intermittent', false);
      assert.strictEqual(finding, null, 'Alternating errors with intervening successes must not be flagged as a retry loop');
    });

    it('correctly flags consecutive error bursts with subsequent resolution or abandonment', () => {
      const events: AIEvent[] = [];
      const baseTime = new Date('2026-03-01T12:00:00.000Z').getTime();

      // Burst 1: ERROR, ERROR, SUCCESS (2 failed retries)
      for (let i = 0; i < 2; i++) {
        events.push(
          createMockEvent({
            id: `ev_b1_err_${i}`,
            timestamp: new Date(baseTime + i * 2000).toISOString(),
            status: 'ERROR',
            error_code: 'HTTP_429',
            trace_id: 'trace_loop_burst',
            resolved_cost_usd: 0.005,
          })
        );
      }
      events.push(
        createMockEvent({
          id: 'ev_b1_succ',
          timestamp: new Date(baseTime + 5000).toISOString(),
          status: 'SUCCESS',
          trace_id: 'trace_loop_burst',
          resolved_cost_usd: 0.005,
        })
      );

      // Burst 2: ERROR, ERROR, ERROR (3 failed retries)
      for (let i = 0; i < 3; i++) {
        events.push(
          createMockEvent({
            id: `ev_b2_err_${i}`,
            timestamp: new Date(baseTime + 15000 + i * 2000).toISOString(),
            status: 'ERROR',
            error_code: 'HTTP_500',
            trace_id: 'trace_loop_burst',
            resolved_cost_usd: 0.005,
          })
        );
      }

      const finding = evaluateRetryErrorLoop(events, 'audit_burst_test', false);
      assert.ok(finding !== null, 'Consecutive error bursts should be detected');
      assert.strictEqual(finding.rule_id, 'RETRY_ERROR_LOOP');
      assert.strictEqual(finding.eligible_event_count, 5); // 2 from burst 1 + 3 from burst 2
      assert.strictEqual(finding.estimated_savings_usd, 0.0250);
    });

    it('prevents event double-counting when events are duplicated in raw telemetry', () => {
      const events: AIEvent[] = [];
      const baseTime = new Date('2026-03-01T12:00:00.000Z').getTime();

      // 4 consecutive errors
      for (let i = 0; i < 4; i++) {
        const ev = createMockEvent({
          id: `ev_dup_err_${i}`,
          timestamp: new Date(baseTime + i * 2000).toISOString(),
          status: 'ERROR',
          error_code: 'HTTP_429',
          trace_id: 'trace_dup_burst',
          resolved_cost_usd: 0.005,
        });
        events.push(ev);
        // Push duplicate event object with identical ID
        events.push({ ...ev });
      }

      const finding = evaluateRetryErrorLoop(events, 'audit_dup_test', false);
      assert.ok(finding !== null);
      // Deduplicated unique events should be 4
      assert.strictEqual(finding.eligible_event_count, 4);
      assert.strictEqual(finding.estimated_savings_usd, 0.0200);
    });
  });

  describe('5. Cross-Rule Portfolio Deduplication in Evaluator', () => {
    it('computes deduplicated potential savings alongside gross aggregate', () => {
      const events: AIEvent[] = [];
      const baseTime = new Date('2026-03-01T12:00:00.000Z').getTime();

      // Generate workload: 20 gpt-4o lightweight events
      // 5 of these events belong to a repeated call cluster on gpt-4o
      for (let i = 0; i < 20; i++) {
        const isRepeatedCluster = i < 5;
        events.push(
          createMockEvent({
            id: `ev_mix_${i}`,
            timestamp: new Date(baseTime + i * 20000).toISOString(),
            model: 'gpt-4o',
            input_tokens: 150,
            output_tokens: 30,
            resolved_cost_usd: 0.000675,
            status: 'SUCCESS',
            trace_id: isRepeatedCluster ? 'trace_mix_repeated' : `trace_mix_other_${i}`,
            prompt_hash: isRepeatedCluster ? 'hash_mix_repeated_prompt' : `hash_mix_prompt_${i}`,
          })
        );
      }

      const audit = runOptimizationRules(events, 'custom_logs', mockHealthyReport, false);

      // Verify findings were generated
      assert.ok(audit.findings.length >= 2, 'Should detect right-sizing and repeated-call');
      // Gross potential savings is sum of individual estimates
      assert.ok(audit.potential_savings_usd > 0);
      // Deduplicated potential savings must be <= gross potential savings (portfolio deduplication)
      assert.ok(audit.deduplicated_potential_savings_usd !== undefined);
      assert.ok(audit.deduplicated_potential_savings_usd <= audit.potential_savings_usd);
      // Invariant: aggregate_is_deduplicated remains false with transparency note
      assert.strictEqual(audit.aggregate_is_deduplicated, false);
      assert.ok(audit.deduplication_note?.includes('not been portfolio-deduplicated'));
    });
  });
});
