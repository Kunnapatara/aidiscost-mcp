/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { NormalizedIngestResult, TelemetrySource } from '../../types/domain';
import { LangfuseAdapter } from '../adapters/langfuse';
import { HeliconeAdapter } from '../adapters/helicone';
import { OpenTelemetryAdapter } from '../adapters/opentelemetry';
import { CustomLogAdapter } from '../adapters/custom-log';
import { detectFormat, detectSource, IngestFormat } from './detector';

export interface IngestOptions {
  source?: TelemetrySource;
  fileName?: string;
}

export interface IngestPipelineResult {
  success: boolean;
  ingestResult: NormalizedIngestResult;
  format: IngestFormat | 'UNSUPPORTED';
  detectedSource: TelemetrySource | 'SOURCE_UNCERTAIN';
  unparseableRecords: number;
  duplicateCount: number;
  warnings: string[];
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Universal Ingestion Pipeline.
 * Converges File Upload, Direct Paste, and Provider/Observability inputs
 * into the canonical NormalizedIngestResult -> AIEvent contract.
 */
export class IngestionPipeline {
  /**
   * Ingest raw payload string through format detection, adapter resolution,
   * deterministic normalization, and data health evaluation.
   */
  static ingest(rawContent: string, options: IngestOptions = {}): IngestPipelineResult {
    const trimmed = (rawContent || '').trim();

    if (!trimmed) {
      return {
        success: false,
        ingestResult: {
          source: options.source || 'custom_logs',
          events: [],
          raw_event_count: 0,
          unparseable_records: 0,
          duplicate_count: 0,
          warnings: ['Empty telemetry payload provided.'],
          is_sample_data: false,
        },
        format: 'UNSUPPORTED',
        detectedSource: 'SOURCE_UNCERTAIN',
        unparseableRecords: 0,
        duplicateCount: 0,
        warnings: ['Empty telemetry payload provided.'],
        errorCode: 'EMPTY_PAYLOAD',
        errorMessage: 'The provided telemetry payload is empty.',
      };
    }

    // Step 1: Detect format
    const format = detectFormat(trimmed, options.fileName);
    if (format === 'UNSUPPORTED') {
      return {
        success: false,
        ingestResult: {
          source: options.source || 'custom_logs',
          events: [],
          raw_event_count: 0,
          unparseable_records: 1,
          duplicate_count: 0,
          warnings: ['Unsupported serialization format. Expected CSV, JSON, JSONL, or NDJSON.'],
          is_sample_data: false,
        },
        format: 'UNSUPPORTED',
        detectedSource: 'SOURCE_UNCERTAIN',
        unparseableRecords: 1,
        duplicateCount: 0,
        warnings: ['Unsupported serialization format. Expected CSV, JSON, JSONL, or NDJSON.'],
        errorCode: 'UNSUPPORTED_FORMAT',
        errorMessage: 'Unsupported file format. AIDisCost accepts CSV, JSON, JSONL, or NDJSON.',
      };
    }

    // Step 2: Resolve or detect source
    let resolvedSource: TelemetrySource;
    const detected = detectSource(trimmed);

    if (options.source) {
      resolvedSource = options.source;
    } else if (detected !== 'SOURCE_UNCERTAIN') {
      resolvedSource = detected;
    } else {
      resolvedSource = 'custom_logs';
    }

    // Step 3: Route to corresponding adapter
    let normResult: NormalizedIngestResult;
    try {
      switch (resolvedSource) {
        case 'langfuse': {
          const adapter = new LangfuseAdapter();
          normResult = adapter.parsePayload(trimmed);
          break;
        }
        case 'helicone': {
          const adapter = new HeliconeAdapter();
          normResult = adapter.parsePayload(trimmed);
          break;
        }
        case 'opentelemetry': {
          const adapter = new OpenTelemetryAdapter();
          normResult = adapter.parsePayload(trimmed);
          break;
        }
        case 'custom_logs':
        default: {
          const adapter = new CustomLogAdapter();
          normResult = adapter.parsePayload(trimmed);
          break;
        }
      }
    } catch (err) {
      return {
        success: false,
        ingestResult: {
          source: resolvedSource,
          events: [],
          raw_event_count: 0,
          unparseable_records: 1,
          duplicate_count: 0,
          warnings: [`Parser exception: ${(err as Error).message}`],
          is_sample_data: false,
        },
        format,
        detectedSource: detected,
        unparseableRecords: 1,
        duplicateCount: 0,
        warnings: [`Parser exception: ${(err as Error).message}`],
        errorCode: 'PARSER_ERROR',
        errorMessage: (err as Error).message,
      };
    }

    // Step 4: Handle case where zero valid events could be extracted
    const hasEvents = normResult.events.length > 0;
    const isSuccess = hasEvents || normResult.raw_event_count === 0;

    return {
      success: isSuccess,
      ingestResult: normResult,
      format,
      detectedSource: detected,
      unparseableRecords: normResult.unparseable_records,
      duplicateCount: normResult.duplicate_count,
      warnings: normResult.warnings,
      errorCode: !hasEvents && normResult.unparseable_records > 0 ? 'NO_VALID_EVENTS' : undefined,
      errorMessage:
        !hasEvents && normResult.unparseable_records > 0
          ? 'No valid AI telemetry events could be extracted from the payload.'
          : undefined,
    };
  }
}
