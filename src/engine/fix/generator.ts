/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Finding, FixPackage } from '../../types/domain';

export function generateFixPackage(finding: Finding, isUnlocked: boolean = false): FixPackage {
  // Derive projected monthly savings conservatively:
  // If annualized projection is available (> 0), monthly projection is annualized / 12.
  // Otherwise, monthly projection is held at 0.00 or observed window savings with explicit basis note.
  const hasAnnualized = finding.annualized_projection_usd > 0;
  const monthlyProjectionUsd = hasAnnualized
    ? Number((finding.annualized_projection_usd / 12).toFixed(2))
    : Number(finding.estimated_savings_usd.toFixed(2));

  const projectionBasis = hasAnnualized
    ? `Extrapolated run-rate projection: modeled monthly opportunity derived from annualized projection ($${finding.annualized_projection_usd.toFixed(2)} / 12 months) under constant-volume assumptions. Not an empirical guarantee or historical fact.`
    : `Extrapolation withheld: telemetry observation window is insufficient to extrapolate a monthly run-rate. Value reflects observed window savings ($${finding.estimated_savings_usd.toFixed(2)}).`;

  switch (finding.rule_id) {
    case 'MODEL_RIGHT_SIZING':
      return {
        finding_id: finding.id,
        unlocked: isUnlocked,
        entitlement_status: isUnlocked ? 'DEMO_UNLOCKED' : 'LOCKED',
        root_cause_hypothesis:
          'Hypothesis: Application routing defaults to a frontier flagship model regardless of task complexity. For short classification, extraction, and structured validation calls matching observed token profiles, candidate distilled models may provide sufficient capability at lower catalog pricing.',
        recommended_approach:
          'Recommended Approach: Implement conditional task-based routing or candidate tier migration. Evaluate candidate models (e.g. gpt-4o-mini, claude-3-5-haiku, gemini-flash) against task accuracy benchmarks on customer golden test sets while retaining flagship models for complex multi-step reasoning.',
        expected_impact: {
          monthly_savings_usd: monthlyProjectionUsd,
          latency_delta_ms: 0, // Unmeasured; requires empirical benchmark measurement during canary evaluation
          quality_risk: 'REQUIRES_BENCHMARK', // Truth-preserving status: quality equivalence cannot be assumed without benchmark evaluation
          projection_basis: projectionBasis,
        },
        test_plan: {
          sample_size: Math.min(250, Math.max(50, finding.eligible_event_count)),
          evaluation_criteria:
            '[Template Benchmark] Candidate model completions achieve acceptable semantic equivalence and task accuracy on customer golden evaluation dataset.',
          traffic_allocation_pct: 10,
          test_harness_instructions:
            '[Template Harness] Deploy an A/B or shadow-traffic evaluation harness routing 10% of non-critical requests to candidate model. Log outputs and execute automated schema validation and semantic diff against baseline completions.',
        },
        acceptance_criteria: [
          '[Template Criterion] Task accuracy and evaluation metrics meet customer-defined benchmark tolerance on task test set.',
          '[Template Criterion] Latency distribution (p50 / p95) meets application SLA requirements under production load.',
          '[Template Criterion] Zero schema validation or JSON parse failures in structured responses.',
          '[Template Criterion] Observed unit-cost reduction on target workload conforms to catalog rate differential without regression.',
        ],
        verification_instructions:
          'Conduct continuous observation over active post-deployment window. Authoritative verification requires at least 15 post-deployment events and observed unit-cost reduction of at least 10.0% across comparable production traffic without error or latency regressions.',
        rollback_plan:
          'Maintain an application configuration or environment variable flag (e.g. AI_MODEL_ROUTING_OVERRIDE) to immediately toggle routing back to baseline model if benchmark degradation, error spikes, or schema failures are detected.',
      };

    case 'RETRY_ERROR_LOOP':
      return {
        finding_id: finding.id,
        unlocked: isUnlocked,
        entitlement_status: isUnlocked ? 'DEMO_UNLOCKED' : 'LOCKED',
        root_cause_hypothesis:
          'Hypothesis: Client SDK error handling lacks decorrelated exponential backoff and jitter. When provider APIs return HTTP 429 (rate limit) or 500 (transient timeout), clients trigger rapid consecutive retries, exacerbating throttling and incurring spend on aborted attempts.',
        recommended_approach:
          'Recommended Approach: Configure a resilient retry policy with Full Jitter exponential backoff. Cap maximum retries at 3 attempts, initialize backoff interval at 1,000ms with random jitter, and attach a circuit breaker that halts calls after consecutive service failures.',
        expected_impact: {
          monthly_savings_usd: monthlyProjectionUsd,
          latency_delta_ms: 0,
          quality_risk: 'NEGLIGIBLE', // Eliminating failed/aborted attempts does not alter completed responses
          projection_basis: projectionBasis,
        },
        test_plan: {
          sample_size: Math.min(50, Math.max(10, finding.eligible_event_count)),
          evaluation_criteria:
            '[Template Test] Zero unjittered consecutive retry bursts exceeding 3 attempts in any 60-second window during simulated error conditions.',
          traffic_allocation_pct: 100,
          test_harness_instructions:
            '[Template Harness] Simulate synthetic HTTP 429 and 503 error responses in a staging test environment. Validate that client introduces exponential backoff with random jitter between attempts and trips circuit breaker rather than looping.',
        },
        acceptance_criteria: [
          '[Template Criterion] Consecutive retry attempts per failure event are strictly capped at <= 3.',
          '[Template Criterion] Exponential backoff with random jitter is enforced across outbound LLM client calls.',
          '[Template Criterion] Potentially avoidable retry spend associated with rapid failure bursts is eliminated.',
        ],
        verification_instructions:
          'Monitor telemetry error traces across active post-deployment observation window. Check that rapid consecutive 429/500 retry bursts are eliminated from production metrics.',
        rollback_plan:
          'Revert client retry wrapper configuration if circuit breaker triggers prematurely during non-rate-limit transient network blips.',
      };

    case 'REPEATED_CALL_PATTERN':
      return {
        finding_id: finding.id,
        unlocked: isUnlocked,
        entitlement_status: isUnlocked ? 'DEMO_UNLOCKED' : 'LOCKED',
        root_cause_hypothesis:
          'Hypothesis: Application workflows execute repetitive identical prompts multiple times within the same user session or trace context without a temporary response cache.',
        recommended_approach:
          'Recommended Approach: Implement an application-level response cache (e.g. Redis, Memcached, or in-memory LRU) keyed by SHA-256 of the prompt and execution parameters with a bounded TTL (e.g. 5 to 15 minutes) for deterministic workloads (temperature <= 0.2).',
        expected_impact: {
          monthly_savings_usd: monthlyProjectionUsd,
          latency_delta_ms: 0, // Latency improvement occurs on cache hits; requires empirical measurement
          quality_risk: 'REQUIRES_BENCHMARK', // Truth-preserving: semantic invariance and cache invalidation safety must be verified
          projection_basis: projectionBasis,
        },
        test_plan: {
          sample_size: Math.min(100, Math.max(20, finding.eligible_event_count)),
          evaluation_criteria:
            '[Template Test] Verified response cache returns valid completions for repeated identical prompts within TTL window without serving stale or incorrect data.',
          traffic_allocation_pct: 50,
          test_harness_instructions:
            '[Template Harness] Execute automated test runs with recurring query patterns. Verify that initial query calls upstream provider and subsequent identical queries within TTL resolve from local cache without error.',
        },
        acceptance_criteria: [
          '[Template Criterion] Exact identical prompt executions within active workflow context return valid cached completions.',
          '[Template Criterion] Cache invalidation and TTL policies prevent serving stale responses across sessions.',
          '[Template Criterion] Duplicate provider token charges for repeated identical invocations are reduced without regression.',
        ],
        verification_instructions:
          'Examine post-deployment cache metrics to confirm reduction in repetitive upstream API calls for identical prompt executions without stale response complaints.',
        rollback_plan:
          'Provide a cache-bypass header or configuration flag (e.g. CACHE_ENABLED=false) to immediately disable cached responses if dynamic prompt updates fail to invalidate properly.',
      };
  }
}
