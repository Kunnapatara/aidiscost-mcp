/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AIEvent, Finding } from '../../types/domain';
import { annualizeSavings, TimeRange } from './annualization';
import { isValidRuleEvent } from './validation';

export function evaluateRetryErrorLoop(
  events: AIEvent[],
  auditId: string,
  isSampleData: boolean,
  timeRange?: TimeRange
): Finding | null {
  // Filter and validate events strictly
  const validEvents = events.filter(isValidRuleEvent);
  if (validEvents.length < 4) {
    return null;
  }

  // Sort events chronologically
  const sorted = [...validEvents].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Group by (trace_id OR prompt_hash)
  const burstGroups = new Map<string, AIEvent[]>();
  for (const ev of sorted) {
    const key = ev.trace_id || ev.prompt_hash;
    if (!key) continue;
    const list = burstGroups.get(key) || [];
    list.push(ev);
    burstGroups.set(key, list);
  }

  const loopEvents: AIEvent[] = [];
  const burstIntervalsMs: number[] = [];
  let observedFailedSpend = 0;
  let totalLoopBursts = 0;
  let hasUnpricedOrEstimated = false;

  for (const [, group] of burstGroups.entries()) {
    if (group.length < 3) continue;

    // Check for rapid retry bursts with error/rate-limit statuses
    let burstStart = 0;
    for (let i = 0; i < group.length; i++) {
      const current = group[i];
      const startEv = group[burstStart];
      const timeDiff = new Date(current.timestamp).getTime() - new Date(startEv.timestamp).getTime();

      // Within a 60 second window
      if (timeDiff <= 60_000) {
        if (i - burstStart >= 2) {
          // Check if intermediate calls were errors or rate limits
          const errorAttempts = group.slice(burstStart, i + 1).filter(e => e.status === 'ERROR' || e.status === 'RATE_LIMITED');
          if (errorAttempts.length >= 2) {
            totalLoopBursts++;
            const burstSlice = group.slice(burstStart, i + 1);
            for (let k = 1; k < burstSlice.length; k++) {
              const interval = new Date(burstSlice[k].timestamp).getTime() - new Date(burstSlice[k - 1].timestamp).getTime();
              if (interval >= 0) {
                burstIntervalsMs.push(interval);
              }
            }
            for (const failed of errorAttempts) {
              loopEvents.push(failed);
              observedFailedSpend += failed.resolved_cost_usd;
              if (failed.cost_provenance === 'UNPRICED' || failed.cost_provenance === 'UNKNOWN') {
                hasUnpricedOrEstimated = true;
              }
            }
            burstStart = i + 1;
          }
        }
      } else {
        burstStart = i;
      }
    }
  }

  // Require sufficient evidence
  if (loopEvents.length < 4 || observedFailedSpend <= 0.001) {
    return null;
  }

  const baselineSpend = loopEvents.reduce((s, e) => s + e.resolved_cost_usd, 0);

  // Annualized projection based strictly on actual observed telemetry window
  const annualization = annualizeSavings(observedFailedSpend, timeRange);
  const annualized = annualization.annualized_usd;

  const sampleTraces = Array.from(new Set(loopEvents.map(e => e.trace_id))).filter(Boolean).slice(0, 5);

  // Compute actual observed average interval between consecutive attempts across flagged bursts
  const avgIntervalSec = burstIntervalsMs.length > 0
    ? Number((burstIntervalsMs.reduce((a, b) => a + b, 0) / burstIntervalsMs.length / 1000).toFixed(1))
    : 0;

  const costConfidence = hasUnpricedOrEstimated ? 'MEDIUM' : 'HIGH';

  const assumptions = [
    'Hypothesis: Failed intermediate retry attempts (HTTP 429 / HTTP 500) within rapid burst intervals may yield zero downstream user value; downstream task idempotency and impact must be evaluated.',
    'Implementation of client-side exponential backoff with full jitter and circuit breakers is assumed to eliminate redundant retry storms without dropping legitimate traffic.',
  ];
  if (annualization.conservative_assumption) {
    assumptions.push(annualization.conservative_assumption);
  }

  return {
    id: `fnd_retry_loop_${auditId.substring(0, 8)}`,
    audit_id: auditId,
    rule_id: 'RETRY_ERROR_LOOP',
    title: 'Potential Retry / Error Loop',
    summary: `Identified ${loopEvents.length} rapid retry attempts across ${totalLoopBursts} bursts exhibiting consecutive 429/500 errors (avg interval: ${avgIntervalSec.toFixed(1)}s) without jittered exponential backoff. Spend on failed attempts represents a potential recovery opportunity.`,
    affected_scope: `${loopEvents[0]?.model || 'LLM API'} burst retries`,
    detection_confidence: 'HIGH',
    cost_confidence: costConfidence,
    savings_confidence: 'ESTIMATED',
    baseline_spend_usd: Number(baselineSpend.toFixed(4)),
    candidate_spend_usd: 0.0000,
    estimated_savings_usd: Number(observedFailedSpend.toFixed(4)),
    potential_savings_pct: 100.0,
    annualized_projection_usd: annualized,
    eligible_event_count: loopEvents.length,
    calculation_method: `Summation of billed tokens on failed retry attempts within rapid burst windows (consecutive failures in ≤60s sliding window). Potential recoverable spend is an estimated projection. ${annualization.methodology_description}`,
    assumptions,
    evidence: {
      affected_event_count: loopEvents.length,
      sample_events: loopEvents.slice(0, 4).map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        model: e.model,
        status: e.status,
        error_code: e.error_code,
        resolved_cost_usd: e.resolved_cost_usd,
        trace_id: e.trace_id,
        prompt_hash: e.prompt_hash,
      })),
      metrics_comparison: [
        {
          label: 'Failed Retry Events',
          current_value: loopEvents.length,
          target_value: 0,
          provenance: 'SOURCE_REPORTED',
        },
        {
          label: 'Burst Frequency Window',
          current_value: burstIntervalsMs.length > 0 ? `${avgIntervalSec.toFixed(1)}s average inter-attempt interval` : 'Consecutive attempts within ≤60s window',
          target_value: 'Exponential backoff (initial interval ≥ 1.0s with jitter)',
          provenance: 'CALCULATED',
        },
        {
          label: 'Observed Failed Retry Spend',
          current_value: `$${observedFailedSpend.toFixed(4)}`,
          target_value: `$0.0000`,
          provenance: 'CALCULATED',
        },
        {
          label: 'Potential Avoidable Retry Spend',
          current_value: `$${observedFailedSpend.toFixed(4)}`,
          target_value: `$0.0000`,
          provenance: 'ESTIMATED',
        },
      ],
      trace_samples: sampleTraces,
      mathematical_proof: `Formula: Sum[ Cost_failed_retry_i ] where status in ('ERROR', 'RATE_LIMITED') in consecutive burst windows (sliding window ≤60s, observed average attempt interval: ${avgIntervalSec.toFixed(1)}s) = $${observedFailedSpend.toFixed(4)} observed spend on failed attempts. Potential recoverable savings estimated at $${observedFailedSpend.toFixed(4)} under hypothesis of zero downstream value.`,
    },
    status: 'DETECTED',
    is_sample_data: isSampleData,
  };
}
