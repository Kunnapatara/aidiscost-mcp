/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { IngestionPipeline } from '../engine/ingestion/pipeline';
import { detectFormat, detectSource, inspectPayload } from '../engine/ingestion/detector';
import { LangfuseAdapter } from '../engine/adapters/langfuse';
import { HeliconeAdapter } from '../engine/adapters/helicone';
import { OpenTelemetryAdapter } from '../engine/adapters/opentelemetry';
import { CustomLogAdapter } from '../engine/adapters/custom-log';
import { evaluateDataHealth } from '../engine/health/evaluator';
import { runOptimizationRules } from '../engine/rules/evaluator';
import { AuditStore } from '../engine/storage/audit-store';
import { createMockIndexedDB } from './mock-idb';

function setupTestEnvironment() {
  (globalThis as any).window = globalThis;
  (globalThis as any).indexedDB = createMockIndexedDB();
}

describe('Sprint 3: Universal Telemetry Ingestion Test Suite', () => {
  setupTestEnvironment();

  // Test A: Format Support — CSV
  test('Test A: Format Support — CSV', () => {
    const csvData = `timestamp,model,input_tokens,output_tokens,latency_ms,cost_usd,status,trace_id
2026-09-15T12:00:00Z,gpt-4o,150,25,800,0.000625,SUCCESS,tr_csv_1
2026-09-15T12:01:00Z,gpt-4o,200,30,950,0.0008,SUCCESS,tr_csv_2`;

    const format = detectFormat(csvData, 'telemetry.csv');
    assert.strictEqual(format, 'csv');

    const result = IngestionPipeline.ingest(csvData, { source: 'custom_logs', fileName: 'telemetry.csv' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ingestResult.events.length, 2);
    assert.strictEqual(result.ingestResult.events[0].model, 'gpt-4o');
    assert.strictEqual(result.ingestResult.events[0].input_tokens, 150);
  });

  // Test B: Format Support — JSON Array
  test('Test B: Format Support — JSON Array', () => {
    const jsonArray = JSON.stringify([
      { timestamp: '2026-09-15T12:00:00Z', model: 'gpt-4o-mini', input_tokens: 100, output_tokens: 15, latency_ms: 300 },
      { timestamp: '2026-09-15T12:01:00Z', model: 'gpt-4o-mini', input_tokens: 110, output_tokens: 20, latency_ms: 320 },
    ]);

    const format = detectFormat(jsonArray, 'events.json');
    assert.strictEqual(format, 'json');

    const result = IngestionPipeline.ingest(jsonArray, { source: 'custom_logs' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ingestResult.events.length, 2);
    assert.strictEqual(result.ingestResult.events[0].model, 'gpt-4o-mini');
  });

  // Test C: Format Support — JSONL
  test('Test C: Format Support — JSONL', () => {
    const jsonl = `{"timestamp": "2026-09-15T12:00:00Z", "model": "claude-3-5-sonnet", "input_tokens": 500, "output_tokens": 100}
{"timestamp": "2026-09-15T12:05:00Z", "model": "claude-3-5-sonnet", "input_tokens": 450, "output_tokens": 80}`;

    const format = detectFormat(jsonl, 'export.jsonl');
    assert.strictEqual(format, 'jsonl');

    const result = IngestionPipeline.ingest(jsonl, { source: 'custom_logs' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ingestResult.events.length, 2);
    assert.strictEqual(result.ingestResult.events[0].model, 'claude-3-5-sonnet');
  });

  // Test D: Format Support — NDJSON
  test('Test D: Format Support — NDJSON', () => {
    const ndjson = `{"timestamp": "2026-09-15T12:00:00Z", "model": "gemini-1.5-pro", "input_tokens": 300, "output_tokens": 50}
{"timestamp": "2026-09-15T12:02:00Z", "model": "gemini-1.5-pro", "input_tokens": 320, "output_tokens": 60}`;

    const format = detectFormat(ndjson, 'stream.ndjson');
    assert.strictEqual(format, 'ndjson');

    const result = IngestionPipeline.ingest(ndjson, { source: 'custom_logs', fileName: 'stream.ndjson' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ingestResult.events.length, 2);
  });

  // Test E: Adapter — OpenTelemetry Semantic Conventions
  test('Test E: Adapter — OpenTelemetry Semantic Conventions', () => {
    const otelPayload = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
                  spanId: '00f067aa0ba902b7',
                  name: 'chat gpt-4o',
                  startTimeUnixNano: '1726401600000000000',
                  endTimeUnixNano: '1726401600800000000',
                  attributes: [
                    { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
                    { key: 'gen_ai.system', value: { stringValue: 'openai' } },
                    { key: 'gen_ai.usage.prompt_tokens', value: { intValue: 200 } },
                    { key: 'gen_ai.usage.completion_tokens', value: { intValue: 50 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const detected = detectSource(otelPayload);
    assert.strictEqual(detected, 'opentelemetry');

    const result = IngestionPipeline.ingest(otelPayload);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ingestResult.events.length, 1);
    const ev = result.ingestResult.events[0];
    assert.strictEqual(ev.source, 'opentelemetry');
    assert.strictEqual(ev.model, 'gpt-4o');
    assert.strictEqual(ev.input_tokens, 200);
    assert.strictEqual(ev.output_tokens, 50);
    assert.strictEqual(ev.total_tokens, 250);
  });

  // Test F: Adapter — Langfuse
  test('Test F: Adapter — Langfuse', () => {
    const langfusePayload = JSON.stringify({
      data: [
        {
          id: 'lf_obs_123',
          model: 'claude-3-5-sonnet',
          startTime: '2026-09-15T12:00:00Z',
          endTime: '2026-09-15T12:00:01Z',
          usage: { input: 100, output: 40, total: 140 },
          calculatedTotalCost: 0.0009,
          level: 'DEFAULT',
          traceId: 'lf_trace_abc',
        },
      ],
    });

    const detected = detectSource(langfusePayload);
    assert.strictEqual(detected, 'langfuse');

    const result = IngestionPipeline.ingest(langfusePayload);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ingestResult.events.length, 1);
    const ev = result.ingestResult.events[0];
    assert.strictEqual(ev.source, 'langfuse');
    assert.strictEqual(ev.model, 'claude-3-5-sonnet');
    assert.strictEqual(ev.input_tokens, 100);
    assert.strictEqual(ev.output_tokens, 40);
  });

  // Test G: Adapter — Helicone
  test('Test G: Adapter — Helicone', () => {
    const heliconePayload = JSON.stringify({
      data: [
        {
          response_id: 'heli_resp_999',
          request_created_at: '2026-09-15T12:00:00Z',
          model: 'gpt-4o',
          total_tokens: 180,
          prompt_tokens: 150,
          completion_tokens: 30,
          cost_usd: 0.000675,
          delay_ms: 450,
          cache_hit: true,
        },
      ],
    });

    const detected = detectSource(heliconePayload);
    assert.strictEqual(detected, 'helicone');

    const result = IngestionPipeline.ingest(heliconePayload);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ingestResult.events.length, 1);
    const ev = result.ingestResult.events[0];
    assert.strictEqual(ev.source, 'helicone');
    assert.strictEqual(ev.model, 'gpt-4o');
    assert.strictEqual(ev.input_tokens, 150);
  });

  // Test H: Ingestion Mode Parity (File Upload vs Direct Paste)
  test('Test H: Ingestion Mode Parity (File Upload vs Direct Paste)', () => {
    const payload = JSON.stringify([
      { id: 'ev_1', model: 'gpt-4o', input_tokens: 100, output_tokens: 20 },
      { id: 'ev_2', model: 'gpt-4o', input_tokens: 120, output_tokens: 30 },
    ]);

    // Path 1: File Upload simulation
    const fileResult = IngestionPipeline.ingest(payload, { source: 'custom_logs', fileName: 'upload.json' });
    // Path 2: Direct Paste simulation
    const pasteResult = IngestionPipeline.ingest(payload, { source: 'custom_logs', fileName: 'pasted_payload' });

    assert.strictEqual(fileResult.ingestResult.events.length, pasteResult.ingestResult.events.length);
    assert.deepStrictEqual(
      fileResult.ingestResult.events.map(e => ({ model: e.model, in: e.input_tokens, out: e.output_tokens })),
      pasteResult.ingestResult.events.map(e => ({ model: e.model, in: e.input_tokens, out: e.output_tokens }))
    );
  });

  // Test I: Pipeline Convergence to NormalizedIngestResult
  test('Test I: Pipeline Convergence to NormalizedIngestResult', () => {
    const sources: Array<{ payload: string; src: 'custom_logs' | 'langfuse' | 'helicone' | 'opentelemetry' }> = [
      {
        src: 'custom_logs',
        payload: JSON.stringify([{ model: 'gpt-4o', input_tokens: 10, output_tokens: 5 }]),
      },
      {
        src: 'langfuse',
        payload: JSON.stringify({
          data: [{ id: 'l1', model: 'gpt-4o', usage: { input: 10, output: 5 } }],
        }),
      },
      {
        src: 'helicone',
        payload: JSON.stringify({
          data: [{ response_id: 'h1', model: 'gpt-4o', prompt_tokens: 10, completion_tokens: 5 }],
        }),
      },
      {
        src: 'opentelemetry',
        payload: JSON.stringify({
          spans: [
            {
              name: 'call',
              attributes: [
                { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
                { key: 'gen_ai.usage.prompt_tokens', value: { intValue: 10 } },
                { key: 'gen_ai.usage.completion_tokens', value: { intValue: 5 } },
              ],
            },
          ],
        }),
      },
    ];

    for (const s of sources) {
      const res = IngestionPipeline.ingest(s.payload, { source: s.src });
      assert.strictEqual(res.success, true);
      assert.strictEqual(typeof res.ingestResult.source, 'string');
      assert.strictEqual(Array.isArray(res.ingestResult.events), true);
      assert.strictEqual(typeof res.ingestResult.raw_event_count, 'number');
      assert.strictEqual(typeof res.ingestResult.unparseable_records, 'number');
      assert.strictEqual(typeof res.ingestResult.duplicate_count, 'number');
      assert.strictEqual(Array.isArray(res.ingestResult.warnings), true);
    }
  });

  // Test J: Privacy Boundary — No Raw Prompt/Completion Retained
  test('Test J: Privacy Boundary — No Raw Prompt/Completion Retained in AIEvent', () => {
    const rawWithSensitiveData = JSON.stringify([
      {
        id: 'sens_1',
        model: 'gpt-4o',
        input_tokens: 100,
        output_tokens: 50,
        prompt: 'Secret prompt with API key sk-1234567890abcdef and password secret',
        completion: 'Confidential completion text here',
        request_body: { secret_header: 'Bearer 12345' },
        response_body: { user_ssn: '000-00-0000' },
      },
    ]);

    const res = IngestionPipeline.ingest(rawWithSensitiveData, { source: 'custom_logs' });
    assert.strictEqual(res.success, true);
    const event = res.ingestResult.events[0];

    // Verify AIEvent does NOT have prompt or completion properties
    assert.strictEqual((event as any).prompt, undefined);
    assert.strictEqual((event as any).completion, undefined);
    assert.strictEqual((event as any).request_body, undefined);
    assert.strictEqual((event as any).response_body, undefined);

    // Prompt hash must be non-reversible hash if generated
    if (event.prompt_hash) {
      assert.ok(event.prompt_hash.startsWith('ph_'));
      assert.ok(!event.prompt_hash.includes('Secret'));
    }
  });

  // Test K: Non-Reversible Prompt Hash
  test('Test K: Non-Reversible Prompt Hash Computation', () => {
    const rawWithPrompt = JSON.stringify([
      {
        id: 'ph_test_1',
        model: 'gpt-4o',
        input_tokens: 10,
        output_tokens: 5,
        prompt: 'System message: You are an analytical bot.',
      },
      {
        id: 'ph_test_2',
        model: 'gpt-4o',
        input_tokens: 10,
        output_tokens: 5,
        prompt: 'System message: You are an analytical bot.',
      },
    ]);

    const res = IngestionPipeline.ingest(rawWithPrompt, { source: 'custom_logs' });
    const ev1 = res.ingestResult.events[0];
    const ev2 = res.ingestResult.events[1];

    assert.ok(ev1.prompt_hash);
    assert.ok(ev2.prompt_hash);
    // Same prompt text produces identical hash
    assert.strictEqual(ev1.prompt_hash, ev2.prompt_hash);
    // Hash does not expose prompt text
    assert.ok(!ev1.prompt_hash.includes('System message'));
  });

  // Test L: Missing Timestamp Handling
  test('Test L: Missing Timestamp Handling', () => {
    const noTimestampData = JSON.stringify([
      { id: 'no_ts_1', model: 'gpt-4o', input_tokens: 10, output_tokens: 5 },
    ]);

    const res = IngestionPipeline.ingest(noTimestampData, { source: 'custom_logs' });
    assert.strictEqual(res.success, true);
    const ev = res.ingestResult.events[0];
    assert.ok(ev.timestamp);
    assert.ok(!isNaN(new Date(ev.timestamp).getTime()));
  });

  // Test M: Missing Token Count Graceful Handling
  test('Test M: Missing Token Count Graceful Handling', () => {
    const noTokensData = JSON.stringify([
      { id: 'no_tok_1', model: 'gpt-4o', latency_ms: 200 },
    ]);

    const res = IngestionPipeline.ingest(noTokensData, { source: 'custom_logs' });
    assert.strictEqual(res.success, true);
    const ev = res.ingestResult.events[0];
    assert.strictEqual(ev.input_tokens, 0);
    assert.strictEqual(ev.output_tokens, 0);
    assert.strictEqual(ev.total_tokens, 0);
  });

  // Test N: Unrecognized Model Name
  test('Test N: Unrecognized Model Name Cross-Validation', () => {
    const unrecogModelData = JSON.stringify([
      { id: 'unrec_1', model: 'custom-fine-tune-xyz-v9', input_tokens: 100, output_tokens: 20 },
    ]);

    const res = IngestionPipeline.ingest(unrecogModelData, { source: 'custom_logs' });
    assert.strictEqual(res.success, true);
    const ev = res.ingestResult.events[0];
    assert.strictEqual(ev.model, 'custom-fine-tune-xyz-v9');
    assert.strictEqual(ev.cost_provenance, 'UNPRICED');
    assert.strictEqual(ev.cost_confidence, 'UNPRICED');
  });

  // Test O: Duplicate Record Deduplication
  test('Test O: Duplicate Record Deduplication', () => {
    const dupData = JSON.stringify([
      { id: 'dup_id_1', model: 'gpt-4o', input_tokens: 10, output_tokens: 5 },
      { id: 'dup_id_1', model: 'gpt-4o', input_tokens: 10, output_tokens: 5 },
    ]);

    const res = IngestionPipeline.ingest(dupData, { source: 'custom_logs' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.ingestResult.events.length, 1);
    assert.strictEqual(res.ingestResult.duplicate_count, 1);
  });

  // Test P: Empty Payload Handling
  test('Test P: Empty Payload Handling', () => {
    const emptyRes = IngestionPipeline.ingest('');
    assert.strictEqual(emptyRes.success, false);
    assert.strictEqual(emptyRes.errorCode, 'EMPTY_PAYLOAD');
  });

  // Test Q: Corrupt JSON Handling
  test('Test Q: Corrupt JSON Handling', () => {
    const corruptJson = '{"model": "gpt-4o", "input_tokens": 100, INVALID_JSON';
    const res = IngestionPipeline.ingest(corruptJson);
    // CustomLogAdapter attempts fallback CSV parsing; if invalid, reports unparseable or error
    assert.ok(res.unparseableRecords > 0 || !res.success);
  });

  // Test R: Unsupported Format Handling
  test('Test R: Unsupported Format Handling', () => {
    const binaryGarbage = '\x00\x01\x02\x03\x04\x05\x06\x07';
    const res = IngestionPipeline.ingest(binaryGarbage);
    assert.strictEqual(res.format, 'UNSUPPORTED');
  });

  // Test S: Large Payload Processing
  test('Test S: Large Payload Processing (1,000 records)', () => {
    const records = [];
    for (let i = 0; i < 1000; i++) {
      records.push({
        id: `batch_${i}`,
        timestamp: '2026-09-15T12:00:00Z',
        model: i % 2 === 0 ? 'gpt-4o' : 'gpt-4o-mini',
        input_tokens: 100 + (i % 50),
        output_tokens: 20 + (i % 10),
        latency_ms: 200 + (i % 100),
      });
    }
    const jsonStr = JSON.stringify(records);
    const start = Date.now();
    const res = IngestionPipeline.ingest(jsonStr, { source: 'custom_logs' });
    const elapsed = Date.now() - start;

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.ingestResult.events.length, 1000);
    // Verify fast local execution (< 1000ms for 1,000 items)
    assert.ok(elapsed < 1000, `Processing took ${elapsed}ms`);
  });

  // Test T: Cost Provenance Resolution During Ingestion
  test('Test T: Cost Provenance Resolution During Ingestion', () => {
    const withReportedCost = JSON.stringify([
      {
        id: 'cost_prov_1',
        model: 'gpt-4o',
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cost: 12.50, // $2.50 + $10.00 = $12.50 exact match with registry
      },
    ]);

    const res = IngestionPipeline.ingest(withReportedCost, { source: 'custom_logs' });
    assert.strictEqual(res.success, true);
    const ev = res.ingestResult.events[0];
    assert.strictEqual(ev.cost_provenance, 'SOURCE_REPORTED');
    assert.strictEqual(ev.cost_confidence, 'HIGH');
    assert.strictEqual(ev.resolved_cost_usd, 12.5);
  });

  // Test U: Integration with Data Health & Analysis Pipeline
  test('Test U: End-to-End Integration with Data Health & Analysis Pipeline', () => {
    const rawData = JSON.stringify([
      { id: 'e2e_1', model: 'gpt-4o', input_tokens: 500, output_tokens: 100, latency_ms: 1200, trace_id: 'tr_1' },
      { id: 'e2e_2', model: 'gpt-4o', input_tokens: 600, output_tokens: 120, latency_ms: 1100, trace_id: 'tr_2' },
      { id: 'e2e_3', model: 'gpt-4o', input_tokens: 550, output_tokens: 110, latency_ms: 1300, trace_id: 'tr_3' },
    ]);

    // 1. Ingest
    const pipelineRes = IngestionPipeline.ingest(rawData, { source: 'custom_logs' });
    assert.strictEqual(pipelineRes.success, true);

    // 2. Health gate
    const health = evaluateDataHealth(
      pipelineRes.ingestResult.events,
      pipelineRes.ingestResult.raw_event_count,
      pipelineRes.ingestResult.duplicate_count,
      false
    );
    assert.strictEqual(health.total_events, 3);
    assert.strictEqual(health.model_coverage_pct, 100);
    assert.strictEqual(health.token_coverage_pct, 100);

    // 3. Optimization rules
    const audit = runOptimizationRules(pipelineRes.ingestResult.events, pipelineRes.ingestResult.source, health, false);
    assert.strictEqual(audit.source, 'custom_logs');
    assert.ok(audit.id);
    assert.ok(Array.isArray(audit.findings));

    // 4. Persistence round-trip validation
    const snapshot = AuditStore.buildSnapshot({
      auditSummary: audit,
      healthReport: health,
      findings: audit.findings,
      fixPackages: new Map(),
      verificationStates: new Map(),
    });

    const isValid = AuditStore.validateSnapshot(snapshot);
    assert.strictEqual(isValid, true);
  });
});
