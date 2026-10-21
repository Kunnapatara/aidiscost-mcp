/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AIEvent, NormalizedIngestResult, TelemetrySource } from '../../types/domain';
import { crossValidateCost } from '../pricing/registry';
import { computePromptHashSync } from '../privacy/hasher';
import { sanitizeErrorCode } from './sanitizer';

export interface CustomLogRecord {
  id?: string | number;
  timestamp?: string;
  created_at?: string;
  time?: string;
  provider?: string;
  model?: string;
  operation?: string;
  input_tokens?: number | string;
  prompt_tokens?: number | string;
  output_tokens?: number | string;
  completion_tokens?: number | string;
  total_tokens?: number | string;
  cost_usd?: number | string;
  cost?: number | string;
  price?: number | string;
  latency_ms?: number | string;
  latency?: number | string;
  status?: string;
  status_code?: number | string;
  error?: string;
  error_code?: string;
  trace_id?: string;
  session_id?: string;
  parent_id?: string;
  prompt?: string; // Stripped! Only used for hash
  prompt_hash?: string;
  user_id?: string;
  environment?: string;
}

export class CustomLogAdapter {
  readonly source: TelemetrySource = 'custom_logs';

  /**
   * Parse CSV, JSON, or JSONL payload
   */
  parsePayload(rawContent: string | object[]): NormalizedIngestResult {
    let records: CustomLogRecord[] = [];
    const warnings: string[] = [];

    if (Array.isArray(rawContent)) {
      records = rawContent as CustomLogRecord[];
    } else if (typeof rawContent === 'string') {
      const trimmed = rawContent.trim();
      if (trimmed.startsWith('[') || (trimmed.startsWith('{') && !trimmed.includes('\n'))) {
        try {
          const parsed = JSON.parse(trimmed);
          records = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          records = this.parseJsonLines(trimmed, warnings);
        }
      } else if (trimmed.startsWith('{') || trimmed.includes('{"')) {
        records = this.parseJsonLines(trimmed, warnings);
      } else {
        // Assume CSV
        records = this.parseCsv(trimmed, warnings);
      }
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

      const model = String(rec.model || '').trim();
      if (!model) {
        // Unparseable if missing model
        unparseable++;
        continue;
      }

      const sourceId = String(rec.id || `custom_${i}_${Date.now()}`);
      const dedupKey = `custom_logs:${sourceId}`;
      if (seenIds.has(dedupKey)) {
        duplicateCount++;
        continue;
      }
      seenIds.add(dedupKey);

      const inTokens = Math.max(0, Number(rec.input_tokens ?? rec.prompt_tokens ?? 0));
      const outTokens = Math.max(0, Number(rec.output_tokens ?? rec.completion_tokens ?? 0));
      const totTokens = Math.max(0, Number(rec.total_tokens ?? (inTokens + outTokens)));

      const rawCost = rec.cost_usd ?? rec.cost ?? rec.price;
      const reportedCost = rawCost !== undefined && rawCost !== '' ? Number(rawCost) : null;

      const rawLatency = rec.latency_ms ?? rec.latency ?? 0;
      const latencyMs = Math.max(0, Number(rawLatency));

      let status: AIEvent['status'] = 'SUCCESS';
      const statusStr = String(rec.status || '').toUpperCase();
      const statusCode = Number(rec.status_code || 0);

      if (statusCode === 429 || statusStr.includes('RATE') || statusStr.includes('429')) {
        status = 'RATE_LIMITED';
      } else if (statusCode === 408 || statusStr.includes('TIMEOUT')) {
        status = 'TIMEOUT';
      } else if (statusCode >= 400 || statusStr.includes('ERROR') || statusStr.includes('FAIL') || Boolean(rec.error)) {
        status = 'ERROR';
      }

      // Prompt hash
      let promptHash = rec.prompt_hash;
      if (!promptHash && rec.prompt) {
        promptHash = computePromptHashSync(rec.prompt);
      }

      const rawTs = rec.timestamp || rec.created_at || rec.time;
      let timestamp = new Date().toISOString();
      if (rawTs) {
        const parsedTime = new Date(rawTs).getTime();
        if (!isNaN(parsedTime)) {
          timestamp = new Date(parsedTime).toISOString();
        }
      }
      const traceId = String(rec.trace_id || rec.session_id || `tr_${sourceId}`);

      const costValidation = crossValidateCost(model, inTokens, outTokens, reportedCost);

      const safeMeta: Record<string, string | number | boolean> = {};
      if (rec.user_id) safeMeta['user_id'] = String(rec.user_id);
      if (rec.environment) safeMeta['environment'] = String(rec.environment);

      let errorCode: string | undefined;
      if (status !== 'SUCCESS') {
        errorCode = sanitizeErrorCode(String(rec.error_code || rec.status || ''), rec.error, statusCode) || 'CUSTOM_ERROR';
      }

      events.push({
        id: `evt_custom_${sourceId}`,
        source: 'custom_logs',
        source_event_id: sourceId,
        timestamp,
        provider: rec.provider || 'openai',
        model,
        operation: (rec.operation as AIEvent['operation']) || 'chat',
        input_tokens: inTokens,
        output_tokens: outTokens,
        total_tokens: totTokens,
        latency_ms: latencyMs,
        status,
        error_code: errorCode,
        trace_id: traceId,
        parent_id: rec.parent_id,
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
      source: 'custom_logs',
      events,
      raw_event_count: records.length,
      unparseable_records: unparseable,
      duplicate_count: duplicateCount,
      warnings,
      is_sample_data: false,
    };
  }

  private parseJsonLines(content: string, warnings: string[]): CustomLogRecord[] {
    const lines = content.split('\n');
    const records: CustomLogRecord[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch (err) {
        warnings.push(`Line ${i + 1} skipped: invalid JSON (${(err as Error).message})`);
      }
    }
    return records;
  }

  private parseCsv(content: string, warnings: string[]): CustomLogRecord[] {
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) {
      warnings.push('CSV contains no data rows.');
      return [];
    }

    const headers = this.parseCsvLine(lines[0]).map(h => h.trim().toLowerCase().replace(/[\s_-]+/g, '_'));
    const records: CustomLogRecord[] = [];

    for (let i = 1; i < lines.length; i++) {
      const row = this.parseCsvLine(lines[i]);
      if (row.length === 0 || (row.length === 1 && !row[0].trim())) continue;

      const obj: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        if (j < row.length) {
          obj[headers[j]] = row[j];
        }
      }
      records.push(obj as unknown as CustomLogRecord);
    }

    return records;
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let insideQuote = false;
    let entry = '';

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (insideQuote && line[i + 1] === '"') {
          entry += '"';
          i++;
        } else {
          insideQuote = !insideQuote;
        }
      } else if (char === ',' && !insideQuote) {
        result.push(entry.trim());
        entry = '';
      } else {
        entry += char;
      }
    }
    result.push(entry.trim());
    return result;
  }
}
