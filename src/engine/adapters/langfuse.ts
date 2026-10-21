/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AIEvent, NormalizedIngestResult, TelemetrySource } from '../../types/domain';
import { crossValidateCost } from '../pricing/registry';
import { computePromptHashSync } from '../privacy/hasher';
import { sanitizeErrorCode } from './sanitizer';

export interface LangfuseRawRecord {
  id?: string;
  traceId?: string;
  parentObservationId?: string;
  name?: string;
  type?: string; // 'GENERATION' | 'SPAN' | 'EVENT'
  startTime?: string;
  endTime?: string;
  model?: string;
  modelParameters?: Record<string, unknown>;
  input?: unknown; // Stripped!
  output?: unknown; // Stripped!
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    unit?: string;
  };
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  calculatedTotalCost?: number;
  totalCost?: number;
  level?: 'DEFAULT' | 'DEBUG' | 'WARNING' | 'ERROR';
  statusMessage?: string;
  metadata?: Record<string, unknown>;
}

export class LangfuseAdapter {
  readonly source: TelemetrySource = 'langfuse';

  parsePayload(rawContent: string | object[] | Record<string, unknown>): NormalizedIngestResult {
    let records: LangfuseRawRecord[] = [];
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
          } else if (Array.isArray(parsed.observations)) {
            records = parsed.observations;
          } else {
            records = [parsed];
          }
        } else {
          // Attempt JSONL
          const lines = trimmed.split('\n').filter(l => l.trim().length > 0);
          records = lines.map(line => JSON.parse(line));
        }
      } else if (Array.isArray(rawContent)) {
        records = rawContent as LangfuseRawRecord[];
      } else if (typeof rawContent === 'object' && rawContent !== null) {
        const obj = rawContent as Record<string, unknown>;
        records = Array.isArray(obj.data) ? (obj.data as LangfuseRawRecord[]) : [obj as LangfuseRawRecord];
      }
    } catch (err) {
      return {
        source: 'langfuse',
        events: [],
        raw_event_count: 0,
        unparseable_records: 1,
        duplicate_count: 0,
        warnings: [`Failed to parse Langfuse payload: ${(err as Error).message}`],
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

      // Filter generation events or LLM calls
      const isGeneration = !rec.type || rec.type.toUpperCase() === 'GENERATION' || rec.type.toUpperCase() === 'LLM' || rec.model;
      if (!isGeneration) {
        continue;
      }

      const sourceId = rec.id || `lf_${i}_${Date.now()}`;
      const dedupKey = `langfuse:${sourceId}`;
      if (seenIds.has(dedupKey)) {
        duplicateCount++;
        continue;
      }
      seenIds.add(dedupKey);

      const model = rec.model || 'unknown-model';
      const inputTokens = rec.usage?.input ?? rec.promptTokens ?? 0;
      const outputTokens = rec.usage?.output ?? rec.completionTokens ?? 0;
      const totalTokens = rec.usage?.total ?? rec.totalTokens ?? (inputTokens + outputTokens);

      const reportedCost = rec.calculatedTotalCost ?? rec.totalCost ?? null;

      // Calculate latency
      let latencyMs = 0;
      if (rec.startTime && rec.endTime) {
        const start = new Date(rec.startTime).getTime();
        const end = new Date(rec.endTime).getTime();
        if (!isNaN(start) && !isNaN(end) && end >= start) {
          latencyMs = end - start;
        }
      }

      const isError = rec.level === 'ERROR' || Boolean(rec.statusMessage && rec.statusMessage.toLowerCase().includes('error'));
      const status = isError ? 'ERROR' : 'SUCCESS';
      const sanitizedErr = isError ? sanitizeErrorCode(rec.statusMessage, rec.level === 'ERROR' ? rec.level : undefined) : undefined;

      // Non-reversible prompt hash from input text if string
      let promptHash: string | undefined;
      if (typeof rec.input === 'string') {
        promptHash = computePromptHashSync(rec.input);
      } else if (rec.input && typeof rec.input === 'object') {
        promptHash = computePromptHashSync(JSON.stringify(rec.input));
      }

      // Safe metadata without raw prompt content
      const safeMeta: Record<string, string | number | boolean> = {};
      if (rec.name) safeMeta['name'] = rec.name;
      if (rec.level) safeMeta['level'] = rec.level;

      const costValidation = crossValidateCost(model, inputTokens, outputTokens, reportedCost);

      let timestamp = new Date().toISOString();
      if (rec.startTime) {
        const parsedTime = new Date(rec.startTime).getTime();
        if (!isNaN(parsedTime)) {
          timestamp = new Date(parsedTime).toISOString();
        }
      }

      events.push({
        id: `evt_lf_${sourceId}`,
        source: 'langfuse',
        source_event_id: sourceId,
        timestamp,
        provider: rec.modelParameters?.provider ? String(rec.modelParameters.provider) : 'openai',
        model,
        operation: 'chat',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        latency_ms: latencyMs,
        status,
        error_code: isError ? (sanitizedErr || 'ERR_GENERATION') : undefined,
        trace_id: rec.traceId || `tr_${sourceId}`,
        parent_id: rec.parentObservationId,
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
      source: 'langfuse',
      events,
      raw_event_count: records.length,
      unparseable_records: unparseable,
      duplicate_count: duplicateCount,
      warnings,
      is_sample_data: false,
    };
  }
}
