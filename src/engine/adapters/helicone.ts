/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AIEvent, NormalizedIngestResult, TelemetrySource } from '../../types/domain';
import { crossValidateCost } from '../pricing/registry';
import { computePromptHashSync } from '../privacy/hasher';
import { sanitizeErrorCode } from './sanitizer';

export interface HeliconeRawRecord {
  response_id?: string;
  request_id?: string;
  request_created_at?: string;
  response_created_at?: string;
  model?: string;
  target_url?: string;
  status?: number;
  latency?: number;
  time_to_first_token?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number;
  cost?: number;
  provider?: string;
  user_id?: string;
  properties?: Record<string, unknown>;
  cache_hit?: boolean;
  request_body?: unknown; // Stripped!
  response_body?: unknown; // Stripped!
}

export class HeliconeAdapter {
  readonly source: TelemetrySource = 'helicone';

  parsePayload(rawContent: string | object[] | Record<string, unknown>): NormalizedIngestResult {
    let records: HeliconeRawRecord[] = [];
    const warnings: string[] = [];

    try {
      if (typeof rawContent === 'string') {
        const trimmed = rawContent.trim();
        if (trimmed.startsWith('[')) {
          records = JSON.parse(trimmed);
        } else if (trimmed.startsWith('{')) {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed.data)) {
            records = parsed.data;
          } else if (Array.isArray(parsed.requests)) {
            records = parsed.requests;
          } else {
            records = [parsed];
          }
        } else {
          // JSONL format
          const lines = trimmed.split('\n').filter(l => l.trim().length > 0);
          records = lines.map(line => JSON.parse(line));
        }
      } else if (Array.isArray(rawContent)) {
        records = rawContent as HeliconeRawRecord[];
      } else if (typeof rawContent === 'object' && rawContent !== null) {
        const obj = rawContent as Record<string, unknown>;
        records = Array.isArray(obj.data) ? (obj.data as HeliconeRawRecord[]) : [obj as HeliconeRawRecord];
      }
    } catch (err) {
      return {
        source: 'helicone',
        events: [],
        raw_event_count: 0,
        unparseable_records: 1,
        duplicate_count: 0,
        warnings: [`Failed to parse Helicone payload: ${(err as Error).message}`],
        is_sample_data: false,
      };
    }

    const seenIds = new Set<string>();
    const events: AIEvent[] = [];
    let duplicateCount = 0;
    let unparseable = 0;

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec || typeof rec !== 'object') {
        unparseable++;
        continue;
      }

      const sourceId = rec.response_id || rec.request_id || `heli_${i}_${Date.now()}`;
      const dedupKey = `helicone:${sourceId}`;
      if (seenIds.has(dedupKey)) {
        duplicateCount++;
        continue;
      }
      seenIds.add(dedupKey);

      const model = rec.model || 'unknown-model';
      const inputTokens = rec.prompt_tokens ?? 0;
      const outputTokens = rec.completion_tokens ?? 0;
      const totalTokens = rec.total_tokens ?? (inputTokens + outputTokens);

      const reportedCost = rec.cost_usd ?? rec.cost ?? null;
      const latencyMs = rec.latency ?? 0;

      const statusCode = rec.status ?? 200;
      let status: AIEvent['status'] = 'SUCCESS';
      if (statusCode === 429) {
        status = 'RATE_LIMITED';
      } else if (statusCode >= 400) {
        status = 'ERROR';
      }

      let promptHash: string | undefined;
      if (rec.request_body && typeof rec.request_body === 'object') {
        promptHash = computePromptHashSync(JSON.stringify(rec.request_body));
      }

      const safeMeta: Record<string, string | number | boolean> = {};
      if (rec.cache_hit !== undefined) safeMeta['cache_hit'] = rec.cache_hit;
      if (rec.status) safeMeta['http_status'] = rec.status;

      const costValidation = crossValidateCost(model, inputTokens, outputTokens, reportedCost);

      let timestamp = new Date().toISOString();
      if (rec.request_created_at) {
        const parsedTime = new Date(rec.request_created_at).getTime();
        if (!isNaN(parsedTime)) {
          timestamp = new Date(parsedTime).toISOString();
        }
      }

      events.push({
        id: `evt_heli_${sourceId}`,
        source: 'helicone',
        source_event_id: sourceId,
        timestamp,
        provider: rec.provider || 'openai',
        model,
        operation: 'chat',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        latency_ms: latencyMs,
        status,
        error_code: status !== 'SUCCESS' ? (sanitizeErrorCode(undefined, undefined, statusCode) || 'ERR_GENERATION') : undefined,
        trace_id: rec.request_id || `tr_${sourceId}`,
        tool_calls: [],
        prompt_hash: promptHash,
        source_reported_cost_usd: reportedCost,
        calculated_cost_usd: costValidation.calculated_cost_usd,
        resolved_cost_usd: costValidation.resolved_cost_usd,
        cost_provenance: costValidation.cost_provenance,
        cost_confidence: costValidation.cost_confidence,
        metadata: safeMeta,
        is_simulated: false,
      });
    }

    return {
      source: 'helicone',
      events,
      raw_event_count: records.length,
      unparseable_records: unparseable,
      duplicate_count: duplicateCount,
      warnings,
      is_sample_data: false,
    };
  }
}
