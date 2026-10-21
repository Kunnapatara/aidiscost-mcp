/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AIEvent, NormalizedIngestResult, TelemetrySource } from '../../types/domain';
import { crossValidateCost } from '../pricing/registry';
import { computePromptHashSync } from '../privacy/hasher';
import { sanitizeErrorCode } from './sanitizer';

export interface OtelSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: Record<string, unknown> | { key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }[];
  status?: {
    code?: number; // 0 = UNSET, 1 = OK, 2 = ERROR
    message?: string;
  };
}

export class OpenTelemetryAdapter {
  readonly source: TelemetrySource = 'opentelemetry';

  parsePayload(rawContent: string | object[] | Record<string, unknown>): NormalizedIngestResult {
    let spans: OtelSpan[] = [];
    const warnings: string[] = [];

    try {
      if (typeof rawContent === 'string') {
        const trimmed = rawContent.trim();
        if (trimmed.startsWith('[')) {
          spans = JSON.parse(trimmed);
        } else if (trimmed.startsWith('{')) {
          const parsed = JSON.parse(trimmed);
          // Standard OTLP envelope
          if (Array.isArray(parsed.resourceSpans)) {
            for (const rs of parsed.resourceSpans) {
              for (const ss of rs.scopeSpans || []) {
                for (const span of ss.spans || []) {
                  spans.push(span);
                }
              }
            }
          } else if (Array.isArray(parsed.spans)) {
            spans = parsed.spans;
          } else {
            spans = [parsed];
          }
        } else {
          // JSONL
          const lines = trimmed.split('\n').filter(l => l.trim().length > 0);
          spans = lines.map(line => JSON.parse(line));
        }
      } else if (Array.isArray(rawContent)) {
        spans = rawContent as OtelSpan[];
      }
    } catch (err) {
      return {
        source: 'opentelemetry',
        events: [],
        raw_event_count: 0,
        unparseable_records: 1,
        duplicate_count: 0,
        warnings: [`Failed to parse OpenTelemetry payload: ${(err as Error).message}`],
        is_sample_data: false,
      };
    }

    const seenIds = new Set<string>();
    const events: AIEvent[] = [];
    let duplicateCount = 0;
    let unparseable = 0;

    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (!span || typeof span !== 'object') {
        unparseable++;
        continue;
      }

      // Convert OTLP key-value attributes array to key-value record if necessary
      const attrs: Record<string, unknown> = {};
      if (Array.isArray(span.attributes)) {
        for (const item of span.attributes) {
          if (item && item.key && item.value) {
            const val = item.value.stringValue ?? item.value.intValue ?? item.value.doubleValue;
            attrs[item.key] = val;
          }
        }
      } else if (span.attributes && typeof span.attributes === 'object') {
        Object.assign(attrs, span.attributes);
      }

      // Filter: must be GenAI or LLM span
      const model = String(
        attrs['gen_ai.request.model'] ||
        attrs['gen_ai.response.model'] ||
        attrs['llm.request.model'] ||
        attrs['model'] ||
        ''
      );

      // If no model detected, check if span name indicates AI operation
      if (!model && !span.name?.toLowerCase().includes('chat') && !span.name?.toLowerCase().includes('completion')) {
        continue;
      }

      const sourceId = span.spanId || `otel_${i}_${Date.now()}`;
      const dedupKey = `otel:${sourceId}`;
      if (seenIds.has(dedupKey)) {
        duplicateCount++;
        continue;
      }
      seenIds.add(dedupKey);

      const inputTokens = Number(
        attrs['gen_ai.usage.prompt_tokens'] ??
        attrs['gen_ai.usage.input_tokens'] ??
        attrs['llm.usage.prompt_tokens'] ??
        0
      );

      const outputTokens = Number(
        attrs['gen_ai.usage.completion_tokens'] ??
        attrs['gen_ai.usage.output_tokens'] ??
        attrs['llm.usage.completion_tokens'] ??
        0
      );

      const totalTokens = Number(
        attrs['gen_ai.usage.total_tokens'] ??
        attrs['llm.usage.total_tokens'] ??
        (inputTokens + outputTokens)
      );

      const reportedCost = attrs['gen_ai.usage.cost'] ? Number(attrs['gen_ai.usage.cost']) : null;

      // Latency calculation from nano timestamps
      let latencyMs = 0;
      if (span.startTimeUnixNano && span.endTimeUnixNano) {
        const start = BigInt(span.startTimeUnixNano);
        const end = BigInt(span.endTimeUnixNano);
        latencyMs = Number((end - start) / BigInt(1_000_000));
      }

      const isError = span.status?.code === 2;
      const httpStatus = attrs['http.status_code'] || attrs['http.response.status_code'];
      const status: AIEvent['status'] = (Number(httpStatus) === 429)
        ? 'RATE_LIMITED'
        : (isError ? 'ERROR' : 'SUCCESS');

      const sanitizedErr = status !== 'SUCCESS'
        ? (sanitizeErrorCode(span.status?.message, attrs['error.type'], httpStatus as number | string) || 'SPAN_ERROR')
        : undefined;

      const promptHash = attrs['gen_ai.prompt'] ? computePromptHashSync(String(attrs['gen_ai.prompt'])) : undefined;

      const provider = String(attrs['gen_ai.system'] || 'openai');

      const costValidation = crossValidateCost(model || 'unknown-model', inputTokens, outputTokens, reportedCost);

      // Timestamp conversion from nano or current time
      let timestamp = new Date().toISOString();
      if (span.startTimeUnixNano) {
        const ms = Number(BigInt(span.startTimeUnixNano) / BigInt(1_000_000));
        timestamp = new Date(ms).toISOString();
      }

      events.push({
        id: `evt_otel_${sourceId}`,
        source: 'opentelemetry',
        source_event_id: sourceId,
        timestamp,
        provider,
        model: model || 'unspecified-model',
        operation: 'chat',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        latency_ms: Math.max(0, latencyMs),
        status,
        error_code: sanitizedErr,
        trace_id: span.traceId || `tr_${sourceId}`,
        parent_id: span.parentSpanId,
        tool_calls: [],
        prompt_hash: promptHash,
        source_reported_cost_usd: reportedCost,
        calculated_cost_usd: costValidation.calculated_cost_usd,
        resolved_cost_usd: costValidation.resolved_cost_usd,
        cost_provenance: costValidation.cost_provenance,
        cost_confidence: costValidation.cost_confidence,
        metadata: {
          span_name: span.name || '',
          gen_ai_system: provider,
        },
        is_simulated: false,
      });
    }

    return {
      source: 'opentelemetry',
      events,
      raw_event_count: spans.length,
      unparseable_records: unparseable,
      duplicate_count: duplicateCount,
      warnings,
      is_sample_data: false,
    };
  }
}
