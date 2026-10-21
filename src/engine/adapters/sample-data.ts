/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AIEvent, NormalizedIngestResult } from '../../types/domain';
import { crossValidateCost } from '../pricing/registry';

/**
 * Deterministic Sample Dataset explicitly labeled as SAMPLE DATA
 * Models real production AI spend patterns across 120 representative calls.
 */
export function generateSampleDataset(): NormalizedIngestResult {
  const baseTime = new Date('2026-09-15T10:00:00Z').getTime();
  const events: AIEvent[] = [];

  // Group 1: Model Right-Sizing Pattern (60 events)
  // Workload: Customer support intent classification & entity extraction
  // Using gpt-4o for trivial queries (< 180 input tokens, < 40 output tokens)
  for (let i = 0; i < 60; i++) {
    const timestamp = new Date(baseTime + i * 45_000).toISOString();
    const sourceId = `sample_rs_${i + 1}`;
    const inTokens = 120 + (i % 25);
    const outTokens = 22 + (i % 10);
    const totTokens = inTokens + outTokens;
    const model = 'gpt-4o';
    const reportedCost = Number((((inTokens / 1_000_000) * 2.50) + ((outTokens / 1_000_000) * 10.00)).toFixed(6));
    const costVal = crossValidateCost(model, inTokens, outTokens, reportedCost);

    events.push({
      id: `evt_sample_${sourceId}`,
      source: 'custom_logs',
      source_event_id: sourceId,
      timestamp,
      provider: 'openai',
      model,
      operation: 'chat',
      input_tokens: inTokens,
      output_tokens: outTokens,
      total_tokens: totTokens,
      latency_ms: 420 + (i % 80),
      status: 'SUCCESS',
      trace_id: `tr_support_classifier_${Math.floor(i / 3)}`,
      tool_calls: [],
      prompt_hash: `ph_classify_support_${i % 15}`,
      source_reported_cost_usd: reportedCost,
      calculated_cost_usd: costVal.calculated_cost_usd,
      resolved_cost_usd: costVal.resolved_cost_usd,
      cost_provenance: costVal.cost_provenance,
      cost_confidence: costVal.cost_confidence,
      metadata: {
        workload: 'support_intent_classifier',
        dataset_marker: 'SAMPLE_DATA',
      },
    });
  }

  // Group 2: Retry / Error Loop Pattern (24 events)
  // Burst of 429 Rate Limits and 500 retries without backoff on Claude 3.5 Sonnet
  const loopStartTime = baseTime + 3_600_000;
  for (let batch = 0; batch < 4; batch++) {
    const burstTime = loopStartTime + batch * 300_000;
    const sharedHash = `ph_retry_storm_batch_${batch}`;
    const traceId = `tr_retry_burst_${batch}`;

    // 6 rapid retries in 30 seconds
    for (let retry = 0; retry < 6; retry++) {
      const timestamp = new Date(burstTime + retry * 4_000).toISOString();
      const sourceId = `sample_retry_${batch}_${retry}`;
      const inTokens = 1250;
      const outTokens = retry === 5 ? 380 : 0; // Only last attempt succeeded
      const totTokens = inTokens + outTokens;
      const model = 'claude-3-5-sonnet';
      const isFailure = retry < 5;
      const status = isFailure ? (retry % 2 === 0 ? 'RATE_LIMITED' : 'ERROR') : 'SUCCESS';
      const reportedCost = Number((((inTokens / 1_000_000) * 3.00) + ((outTokens / 1_000_000) * 15.00)).toFixed(6));
      const costVal = crossValidateCost(model, inTokens, outTokens, reportedCost);

      events.push({
        id: `evt_sample_${sourceId}`,
        source: 'custom_logs',
        source_event_id: sourceId,
        timestamp,
        provider: 'anthropic',
        model,
        operation: 'chat',
        input_tokens: inTokens,
        output_tokens: outTokens,
        total_tokens: totTokens,
        latency_ms: isFailure ? 120 : 1850,
        status,
        error_code: isFailure ? (status === 'RATE_LIMITED' ? 'HTTP_429' : 'HTTP_500') : undefined,
        trace_id: traceId,
        parent_id: retry > 0 ? `evt_sample_sample_retry_${batch}_${retry - 1}` : undefined,
        tool_calls: [],
        prompt_hash: sharedHash,
        source_reported_cost_usd: reportedCost,
        calculated_cost_usd: costVal.calculated_cost_usd,
        resolved_cost_usd: costVal.resolved_cost_usd,
        cost_provenance: costVal.cost_provenance,
        cost_confidence: costVal.cost_confidence,
        metadata: {
          retry_attempt: retry + 1,
          dataset_marker: 'SAMPLE_DATA',
        },
      });
    }
  }

  // Group 3: Repeated Call Pattern (20 events)
  // Exact same static system prompt + user question executed 5 times in 2 minutes
  const repeatBase = baseTime + 7_200_000;
  for (let rep = 0; rep < 4; rep++) {
    const sharedHash = `ph_static_faq_query_${rep}`;
    const traceId = `tr_faq_session_${rep}`;
    for (let c = 0; c < 5; c++) {
      const timestamp = new Date(repeatBase + rep * 600_000 + c * 20_000).toISOString();
      const sourceId = `sample_repeat_${rep}_${c}`;
      const inTokens = 840;
      const outTokens = 310;
      const model = 'gpt-4o';
      const reportedCost = Number((((inTokens / 1_000_000) * 2.50) + ((outTokens / 1_000_000) * 10.00)).toFixed(6));
      const costVal = crossValidateCost(model, inTokens, outTokens, reportedCost);

      events.push({
        id: `evt_sample_${sourceId}`,
        source: 'custom_logs',
        source_event_id: sourceId,
        timestamp,
        provider: 'openai',
        model,
        operation: 'chat',
        input_tokens: inTokens,
        output_tokens: outTokens,
        total_tokens: inTokens + outTokens,
        latency_ms: 850,
        status: 'SUCCESS',
        trace_id: traceId,
        tool_calls: [],
        prompt_hash: sharedHash,
        source_reported_cost_usd: reportedCost,
        calculated_cost_usd: costVal.calculated_cost_usd,
        resolved_cost_usd: costVal.resolved_cost_usd,
        cost_provenance: costVal.cost_provenance,
        cost_confidence: costVal.cost_confidence,
        metadata: {
          temperature: 0.0,
          dataset_marker: 'SAMPLE_DATA',
        },
      });
    }
  }

  // Group 4: Healthy Baseline Workloads (14 events)
  // Well-sized models and valid varied calls
  const healthyBase = baseTime + 10_800_000;
  for (let h = 0; h < 14; h++) {
    const timestamp = new Date(healthyBase + h * 60_000).toISOString();
    const sourceId = `sample_healthy_${h}`;
    const inTokens = 350 + h * 40;
    const outTokens = 150 + h * 20;
    const model = 'gpt-4o-mini';
    const reportedCost = Number((((inTokens / 1_000_000) * 0.15) + ((outTokens / 1_000_000) * 0.60)).toFixed(6));
    const costVal = crossValidateCost(model, inTokens, outTokens, reportedCost);

    events.push({
      id: `evt_sample_${sourceId}`,
      source: 'custom_logs',
      source_event_id: sourceId,
      timestamp,
      provider: 'openai',
      model,
      operation: 'chat',
      input_tokens: inTokens,
      output_tokens: outTokens,
      total_tokens: inTokens + outTokens,
      latency_ms: 280 + h * 15,
      status: 'SUCCESS',
      trace_id: `tr_healthy_${h}`,
      tool_calls: [],
      prompt_hash: `ph_healthy_unique_${h}`,
      source_reported_cost_usd: reportedCost,
      calculated_cost_usd: costVal.calculated_cost_usd,
      resolved_cost_usd: costVal.resolved_cost_usd,
      cost_provenance: costVal.cost_provenance,
      cost_confidence: costVal.cost_confidence,
      metadata: {
        dataset_marker: 'SAMPLE_DATA',
      },
    });
  }

  // Group 5: Unpriced Model Test Event (2 events)
  // Custom fine-tune or internal model to test the UNPRICED truth boundary
  for (let u = 0; u < 2; u++) {
    const timestamp = new Date(healthyBase + 1_000_000 + u * 30_000).toISOString();
    const sourceId = `sample_unpriced_${u}`;
    const inTokens = 500;
    const outTokens = 200;
    const model = 'custom-internal-classifier-v2';
    const costVal = crossValidateCost(model, inTokens, outTokens, null);

    events.push({
      id: `evt_sample_${sourceId}`,
      source: 'custom_logs',
      source_event_id: sourceId,
      timestamp,
      provider: 'internal',
      model,
      operation: 'chat',
      input_tokens: inTokens,
      output_tokens: outTokens,
      total_tokens: inTokens + outTokens,
      latency_ms: 190,
      status: 'SUCCESS',
      trace_id: `tr_unpriced_${u}`,
      tool_calls: [],
      prompt_hash: `ph_unpriced_${u}`,
      source_reported_cost_usd: null,
      calculated_cost_usd: costVal.calculated_cost_usd,
      resolved_cost_usd: costVal.resolved_cost_usd,
      cost_provenance: costVal.cost_provenance,
      cost_confidence: costVal.cost_confidence,
      metadata: {
        note: 'Proprietary internal fine-tune',
        dataset_marker: 'SAMPLE_DATA',
      },
    });
  }

  // Explicitly mark all generated demo/sample events as simulated
  for (const ev of events) {
    ev.is_simulated = true;
  }

  return {
    source: 'custom_logs',
    events,
    raw_event_count: events.length,
    unparseable_records: 0,
    duplicate_count: 0,
    warnings: [],
    is_sample_data: true,
  };
}
