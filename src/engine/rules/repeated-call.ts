/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AIEvent, Finding } from '../../types/domain';
import { annualizeSavings, TimeRange } from './annualization';
import { isValidRuleEvent } from './validation';

export function evaluateRepeatedCallPattern(
  events: AIEvent[],
  auditId: string,
  isSampleData: boolean,
  timeRange?: TimeRange
): Finding | null {
  // Filter for valid events with prompt_hash and success status
  const validEvents = events.filter(e => isValidRuleEvent(e) && e.status === 'SUCCESS' && e.prompt_hash);
  if (validEvents.length < 5) {
    return null;
  }

  // Group by (trace_id + prompt_hash), or fall back to (model + prompt_hash) if trace is omitted
  const sessionPromptGroups = new Map<string, AIEvent[]>();

  for (const ev of validEvents) {
    const contextKey = ev.trace_id
      ? `trace:${ev.trace_id}:${ev.prompt_hash}`
      : `prompt:${ev.model}:${ev.prompt_hash}`;

    const list = sessionPromptGroups.get(contextKey) || [];
    list.push(ev);
    sessionPromptGroups.set(contextKey, list);
  }

  const originCalls: AIEvent[] = [];
  const repeatedCalls: AIEvent[] = [];
  let totalClusters = 0;
  let originSpend = 0;
  let repeatedSpend = 0;
  let hasUnpricedOrEstimated = false;

  for (const [key, cluster] of sessionPromptGroups.entries()) {
    // Need at least 3 identical calls within the same workflow context
    if (cluster.length < 3) continue;

    // Check time proximity: 15 minutes for trace-keyed, tighter 5 minutes for unkeyed prompts
    cluster.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const spanMs = new Date(cluster[cluster.length - 1].timestamp).getTime() - new Date(cluster[0].timestamp).getTime();
    const maxAllowedSpanMs = key.startsWith('trace:') ? 15 * 60_000 : 5 * 60_000;

    if (spanMs <= maxAllowedSpanMs) {
      totalClusters++;
      // Call 0 is original execution. Calls 1..N are subsequent identical invocations
      const origin = cluster[0];
      originCalls.push(origin);
      originSpend += origin.resolved_cost_usd;
      if (origin.cost_provenance === 'UNPRICED' || origin.cost_provenance === 'UNKNOWN') {
        hasUnpricedOrEstimated = true;
      }

      for (let i = 1; i < cluster.length; i++) {
        repeatedCalls.push(cluster[i]);
        repeatedSpend += cluster[i].resolved_cost_usd;
        if (cluster[i].cost_provenance === 'UNPRICED' || cluster[i].cost_provenance === 'UNKNOWN') {
          hasUnpricedOrEstimated = true;
        }
      }
    }
  }

  if (repeatedCalls.length < 4 || repeatedSpend <= 0.001) {
    return null;
  }

  // Exact arithmetic baseline spend: origin execution spend + subsequent duplicate spend
  const baselineSpend = originSpend + repeatedSpend;
  const candidateSpend = originSpend;

  // Annualized projection based strictly on actual observed telemetry window
  const annualization = annualizeSavings(repeatedSpend, timeRange);
  const annualized = annualization.annualized_usd;

  const sampleTraces = Array.from(new Set(repeatedCalls.map(e => e.trace_id))).filter(Boolean).slice(0, 5);

  // Inspect telemetry metadata to truthfully report on temperature
  const hasExplicitTemp = repeatedCalls.some(e => e.metadata?.temperature !== undefined);
  const verifiedLowTemp = hasExplicitTemp && repeatedCalls.every(e => {
    const t = Number(e.metadata?.temperature);
    return !isNaN(t) && t <= 0.2;
  });

  const tempAssumption = verifiedLowTemp
    ? 'Observed telemetry metadata confirms deterministic request parameters (temperature ≤ 0.2).'
    : 'Safe caching requires deterministic invocation parameters (such as temperature = 0 or temperature ≤ 0.2); telemetry does not prove invocation temperature, so request parameters and output determinism must be verified prior to enabling caching.';

  const avgCallsPerCluster = totalClusters > 0 ? ((repeatedCalls.length / totalClusters) + 1).toFixed(1) : '1';

  const costConfidence = hasUnpricedOrEstimated ? 'MEDIUM' : 'HIGH';

  const assumptions = [
    'Identical prompt hashes within trace context do not prove semantic equivalence or task idempotency (outputs may vary with external data, tool state, or temperature); caching feasibility requires validation.',
    tempAssumption,
    'A TTL of 5–15 minutes on application or gateway cache is assumed to prevent redundant upstream provider billing for identical deterministic requests.',
  ];
  if (annualization.conservative_assumption) {
    assumptions.push(annualization.conservative_assumption);
  }

  return {
    id: `fnd_repeated_calls_${auditId.substring(0, 8)}`,
    audit_id: auditId,
    rule_id: 'REPEATED_CALL_PATTERN',
    title: 'Potential Repeated Call Pattern',
    summary: `Observed ${repeatedCalls.length} identical request executions across ${totalClusters} distinct trace workflows within 15-minute windows representing a potential caching evaluation opportunity.`,
    affected_scope: `${repeatedCalls[0]?.model || 'LLM'} contextual workflows`,
    detection_confidence: 'HIGH',
    cost_confidence: costConfidence,
    savings_confidence: 'ESTIMATED',
    baseline_spend_usd: Number(baselineSpend.toFixed(4)),
    candidate_spend_usd: Number(candidateSpend.toFixed(4)),
    estimated_savings_usd: Number(repeatedSpend.toFixed(4)),
    potential_savings_pct: baselineSpend > 0 ? Number(((repeatedSpend / baselineSpend) * 100).toFixed(1)) : 0,
    annualized_projection_usd: annualized,
    eligible_event_count: repeatedCalls.length,
    calculation_method: `Sum of billed tokens for subsequent identical prompt executions (attempt > 1) within active 15-minute trace contexts. Savings are estimated and require cache hit validation. ${annualization.methodology_description}`,
    assumptions,
    evidence: {
      affected_event_count: repeatedCalls.length,
      sample_events: repeatedCalls.slice(0, 4).map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        model: e.model,
        prompt_hash: e.prompt_hash,
        trace_id: e.trace_id,
        resolved_cost_usd: e.resolved_cost_usd,
        cost_provenance: e.cost_provenance,
      })),
      metrics_comparison: [
        {
          label: 'Identical Executions per Trace',
          current_value: `${avgCallsPerCluster} calls / cluster average`,
          target_value: '1 origin call + local cache hit',
          provenance: 'CALCULATED',
        },
        {
          label: 'Subsequent Identical Invocations',
          current_value: repeatedCalls.length,
          target_value: 0,
          provenance: 'CALCULATED',
        },
        {
          label: 'Observed Repeated Call Spend',
          current_value: `$${repeatedSpend.toFixed(4)}`,
          target_value: `$0.0000`,
          provenance: 'CALCULATED',
        },
        {
          label: 'Potential Cache Savings',
          current_value: `$${repeatedSpend.toFixed(4)}`,
          target_value: `$0.0000`,
          provenance: 'ESTIMATED',
        },
      ],
      trace_samples: sampleTraces,
      mathematical_proof: `Formula: Sum[ Cost_call_k ] for k in (2..N) within identical (trace_id, prompt_hash) tuples = $${repeatedSpend.toFixed(4)} observed spend across ${repeatedCalls.length} subsequent identical calls. Potential recoverable savings estimated at $${repeatedSpend.toFixed(4)} subject to cache validation.`,
    },
    status: 'DETECTED',
    is_sample_data: isSampleData,
  };
}
