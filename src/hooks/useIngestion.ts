/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { IngestionPipeline, IngestPipelineResult } from '../engine/ingestion/pipeline';
import { TelemetrySource } from '../types/domain';

export interface UseIngestionReturn {
  processPayload: (
    rawContent: string,
    options?: { source?: TelemetrySource; fileName?: string }
  ) => IngestPipelineResult;
}

export function useIngestion(): UseIngestionReturn {
  const processPayload = (
    rawContent: string,
    options: { source?: TelemetrySource; fileName?: string } = {}
  ): IngestPipelineResult => {
    return IngestionPipeline.ingest(rawContent, options);
  };

  return { processPayload };
}
