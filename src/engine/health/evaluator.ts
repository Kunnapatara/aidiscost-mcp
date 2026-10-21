/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AIEvent, DataHealthReport, HealthGrade, ConfidenceLevel } from '../../types/domain';

export function evaluateDataHealth(
  events: AIEvent[],
  rawEventCount: number,
  duplicateCount: number,
  isSampleData: boolean = false
): DataHealthReport {
  if (events.length === 0) {
    return {
      total_events: rawEventCount,
      unique_events: 0,
      duplicate_events_dropped: duplicateCount,
      time_range: { start: 'N/A', end: 'N/A' },
      model_coverage_pct: 0,
      token_coverage_pct: 0,
      source_cost_coverage_pct: 0,
      pricing_coverage_pct: 0,
      latency_coverage_pct: 0,
      trace_coverage_pct: 0,
      missing_critical_fields: ['events', 'model', 'tokens'],
      warnings: ['No valid telemetry records found in the provided payload.'],
      analysis_confidence: 'LOW',
      health_grade: 'INSUFFICIENT_DATA',
      is_sample_data: isSampleData,
    };
  }

  let modelCount = 0;
  let tokenCount = 0;
  let sourceCostCount = 0;
  let pricingCount = 0;
  let latencyCount = 0;
  let traceCount = 0;

  let minTimestamp = Infinity;
  let maxTimestamp = -Infinity;

  for (const ev of events) {
    // Model coverage
    if (ev.model && ev.model !== 'unknown-model' && ev.model !== 'unspecified-model') {
      modelCount++;
    }
    // Token coverage
    if (ev.total_tokens > 0 || (ev.input_tokens > 0 || ev.output_tokens > 0)) {
      tokenCount++;
    }
    // Source cost coverage
    if (ev.source_reported_cost_usd !== null && ev.source_reported_cost_usd > 0) {
      sourceCostCount++;
    }
    // Pricing coverage
    if (ev.cost_provenance !== 'UNPRICED') {
      pricingCount++;
    }
    // Latency coverage
    if (ev.latency_ms > 0) {
      latencyCount++;
    }
    // Trace coverage
    if (ev.trace_id && !ev.trace_id.startsWith('tr_custom_')) {
      traceCount++;
    }

    const t = new Date(ev.timestamp).getTime();
    if (!isNaN(t)) {
      if (t < minTimestamp) minTimestamp = t;
      if (t > maxTimestamp) maxTimestamp = t;
    }
  }

  const total = events.length;
  const modelPct = Number(((modelCount / total) * 100).toFixed(1));
  const tokenPct = Number(((tokenCount / total) * 100).toFixed(1));
  const sourceCostPct = Number(((sourceCostCount / total) * 100).toFixed(1));
  const pricingPct = Number(((pricingCount / total) * 100).toFixed(1));
  const latencyPct = Number(((latencyCount / total) * 100).toFixed(1));
  const tracePct = Number(((traceCount / total) * 100).toFixed(1));

  const missingFields: string[] = [];
  const warnings: string[] = [];

  if (modelPct < 80) missingFields.push('model');
  if (tokenPct < 80) missingFields.push('tokens');
  if (sourceCostPct < 50) warnings.push('Source-reported costs are largely missing; AIDisCost internal pricing will calculate estimates.');
  if (pricingPct < 80) warnings.push('Some models are unlisted in AIDisCost pricing registry and marked UNPRICED.');
  if (tracePct < 50) warnings.push('Limited distributed trace coverage; correlation across multi-step loops will be conservative.');
  if (duplicateCount > 0) warnings.push(`Dropped ${duplicateCount} duplicate events to prevent double counting.`);

  let healthGrade: HealthGrade = 'HEALTHY';
  let analysisConfidence: ConfidenceLevel = 'HIGH';

  if (total < 10 || modelPct < 50 || tokenPct < 50) {
    healthGrade = 'INSUFFICIENT_DATA';
    analysisConfidence = 'LOW';
  } else if (pricingPct < 70 || modelPct < 80 || tokenPct < 80) {
    healthGrade = 'USABLE_WITH_ESTIMATES';
    analysisConfidence = 'MEDIUM';
  } else {
    healthGrade = 'HEALTHY';
    analysisConfidence = 'HIGH';
  }

  const startIso = minTimestamp !== Infinity ? new Date(minTimestamp).toISOString() : new Date().toISOString();
  const endIso = maxTimestamp !== -Infinity ? new Date(maxTimestamp).toISOString() : new Date().toISOString();

  return {
    total_events: total,
    unique_events: total,
    duplicate_events_dropped: duplicateCount,
    time_range: { start: startIso, end: endIso },
    model_coverage_pct: modelPct,
    token_coverage_pct: tokenPct,
    source_cost_coverage_pct: sourceCostPct,
    pricing_coverage_pct: pricingPct,
    latency_coverage_pct: latencyPct,
    trace_coverage_pct: tracePct,
    missing_critical_fields: missingFields,
    warnings,
    analysis_confidence: analysisConfidence,
    health_grade: healthGrade,
    is_sample_data: isSampleData,
  };
}
