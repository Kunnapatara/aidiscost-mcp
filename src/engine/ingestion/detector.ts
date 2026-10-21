/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type IngestFormat = 'csv' | 'json' | 'jsonl' | 'ndjson';

export type DetectedSource = 'opentelemetry' | 'langfuse' | 'helicone' | 'custom_logs' | 'SOURCE_UNCERTAIN';

export interface DetectionResult {
  format: IngestFormat | 'UNSUPPORTED';
  detectedSource: DetectedSource;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNCERTAIN';
  rawRecordCountEstimate?: number;
  error?: string;
}

/**
 * Detects the serialization format (csv, json, jsonl, ndjson) from content and optional filename.
 */
export function detectFormat(content: string, fileName?: string): IngestFormat | 'UNSUPPORTED' {
  const trimmed = content.trim();
  if (!trimmed) {
    return 'UNSUPPORTED';
  }

  const ext = fileName ? fileName.split('.').pop()?.toLowerCase() : undefined;

  // Check 1: JSON array or single JSON object
  if (trimmed.startsWith('[') || (trimmed.startsWith('{') && !trimmed.includes('\n'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Might be malformed or JSONL
    }
  }

  // Check 2: Multi-line JSON object (formatted JSON)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Continue to test JSONL / CSV
    }
  }

  // Check 3: JSONL / NDJSON (lines starting with '{' and ending with '}')
  const lines = trimmed.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length > 0 && lines.every(l => l.trim().startsWith('{') && l.trim().endsWith('}'))) {
    try {
      JSON.parse(lines[0].trim());
      return ext === 'ndjson' ? 'ndjson' : 'jsonl';
    } catch {
      // Not valid JSON lines
    }
  }

  // Also check if multiple lines parse as JSON
  if (lines.length > 1) {
    let validJsonLineCount = 0;
    const testLimit = Math.min(lines.length, 5);
    for (let i = 0; i < testLimit; i++) {
      try {
        JSON.parse(lines[i].trim());
        validJsonLineCount++;
      } catch {
        break;
      }
    }
    if (validJsonLineCount === testLimit) {
      return ext === 'ndjson' ? 'ndjson' : 'jsonl';
    }
  }

  // Check 4: CSV (contains commas, header row with typical column names or delimiters)
  if (ext === 'csv' || isCsvContent(trimmed)) {
    return 'csv';
  }

  if (ext === 'json') return 'json';
  if (ext === 'jsonl') return 'jsonl';
  if (ext === 'ndjson') return 'ndjson';

  return 'UNSUPPORTED';
}

/**
 * Checks whether content is likely CSV by inspecting delimiters and headers.
 */
function isCsvContent(trimmed: string): boolean {
  // If string starts with '{' or '[', it is JSON or corrupt JSON, not CSV
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return false;
  }

  const firstLine = trimmed.split(/\r?\n/)[0];
  if (!firstLine) return false;

  // Has comma delimiters
  if (!firstLine.includes(',')) return false;

  // Check if first line contains typical column keywords
  const lower = firstLine.toLowerCase();
  const csvKeywords = [
    'model',
    'timestamp',
    'tokens',
    'input_tokens',
    'output_tokens',
    'latency',
    'cost',
    'provider',
    'status',
    'trace_id',
    'id',
  ];

  let matches = 0;
  for (const kw of csvKeywords) {
    if (lower.includes(kw)) matches++;
  }

  return matches >= 1;
}

/**
 * Detects the likely telemetry source (OpenTelemetry, Langfuse, Helicone, custom_logs)
 * using authoritative schema signatures. If ambiguous or unrecognized, returns SOURCE_UNCERTAIN.
 */
export function detectSource(content: string, parsedObjectOrArray?: unknown): DetectedSource {
  // If parsed object or array is available or can be inspected
  let sample: Record<string, unknown> | null = null;

  if (parsedObjectOrArray) {
    if (Array.isArray(parsedObjectOrArray) && parsedObjectOrArray.length > 0) {
      sample = (parsedObjectOrArray[0] as Record<string, unknown>) || null;
    } else if (typeof parsedObjectOrArray === 'object' && parsedObjectOrArray !== null) {
      const obj = parsedObjectOrArray as Record<string, unknown>;
      // Check top-level envelope signatures
      if (Array.isArray(obj.resourceSpans)) return 'opentelemetry';
      if (Array.isArray(obj.spans)) return 'opentelemetry';
      if (Array.isArray(obj.observations)) return 'langfuse';
      if (Array.isArray(obj.requests)) return 'helicone';
      if (Array.isArray(obj.data)) {
        if (obj.data.length > 0 && typeof obj.data[0] === 'object' && obj.data[0] !== null) {
          sample = obj.data[0] as Record<string, unknown>;
        }
      } else {
        sample = obj;
      }
    }
  }

  // If we couldn't inspect object, check text patterns safely
  const trimmed = content.trim();

  // 1. OpenTelemetry OTLP signature
  if (
    trimmed.includes('"resourceSpans"') ||
    trimmed.includes('"scopeSpans"') ||
    trimmed.includes('startTimeUnixNano') ||
    trimmed.includes('gen_ai.request.model') ||
    trimmed.includes('gen_ai.system') ||
    (sample && ('startTimeUnixNano' in sample || 'attributes' in sample && 'traceId' in sample))
  ) {
    return 'opentelemetry';
  }

  // 2. Langfuse signature
  if (
    trimmed.includes('"parentObservationId"') ||
    trimmed.includes('"calculatedTotalCost"') ||
    trimmed.includes('"promptTokens"') ||
    trimmed.includes('"completionTokens"') ||
    (sample && ('parentObservationId' in sample || 'calculatedTotalCost' in sample))
  ) {
    return 'langfuse';
  }

  // 3. Helicone signature
  if (
    trimmed.includes('"response_id"') ||
    trimmed.includes('"request_created_at"') ||
    trimmed.includes('"time_to_first_token"') ||
    trimmed.includes('"cost_usd"') ||
    trimmed.includes('"cache_hit"') ||
    (sample && ('response_id' in sample || 'request_created_at' in sample))
  ) {
    return 'helicone';
  }

  // 4. Custom logs / CSV signature
  if (
    trimmed.includes('input_tokens') ||
    trimmed.includes('output_tokens') ||
    trimmed.includes('total_tokens') ||
    trimmed.includes('latency_ms') ||
    (sample && ('input_tokens' in sample || 'prompt_tokens' in sample || 'model' in sample))
  ) {
    return 'custom_logs';
  }

  return 'SOURCE_UNCERTAIN';
}

/**
 * High-level detection routine combining format and source classification.
 */
export function inspectPayload(content: string, fileName?: string): DetectionResult {
  const format = detectFormat(content, fileName);
  if (format === 'UNSUPPORTED') {
    return {
      format: 'UNSUPPORTED',
      detectedSource: 'SOURCE_UNCERTAIN',
      confidence: 'UNCERTAIN',
      error: 'UNSUPPORTED_FORMAT',
    };
  }

  let parsed: unknown = undefined;
  let estimatedCount = 1;

  if (format === 'json') {
    try {
      parsed = JSON.parse(content.trim());
      if (Array.isArray(parsed)) {
        estimatedCount = parsed.length;
      } else if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.data)) estimatedCount = obj.data.length;
        else if (Array.isArray(obj.resourceSpans)) estimatedCount = obj.resourceSpans.length;
        else if (Array.isArray(obj.observations)) estimatedCount = obj.observations.length;
        else if (Array.isArray(obj.requests)) estimatedCount = obj.requests.length;
      }
    } catch {
      // Ignored
    }
  } else if (format === 'jsonl' || format === 'ndjson') {
    const lines = content.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
    estimatedCount = lines.length;
    try {
      if (lines[0]) parsed = JSON.parse(lines[0]);
    } catch {
      // Ignored
    }
  } else if (format === 'csv') {
    const lines = content.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
    estimatedCount = Math.max(0, lines.length - 1);
  }

  const detected = detectSource(content, parsed);
  const confidence = detected === 'SOURCE_UNCERTAIN' ? 'UNCERTAIN' : 'HIGH';

  return {
    format,
    detectedSource: detected,
    confidence,
    rawRecordCountEstimate: estimatedCount,
  };
}
