/**
 * Automated Test Suite for Sprint 2 Durable Local Audit Persistence
 * Covers Required Tests:
 * Test A: Save / Load Round Trip
 * Test B: Latest Audit
 * Test C: Schema Version
 * Test D: Corrupt Record
 * Test E: Privacy (No raw telemetry, prompt, completion, or arbitrary metadata)
 * Test F: Analytical Values Preserved
 * Test G: Persistence Failure
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createMockIndexedDB } from './mock-idb';
import { AuditStore } from '../engine/storage/audit-store';
import {
  AUDIT_SNAPSHOT_SCHEMA_VERSION,
  PersistedAuditSnapshot,
} from '../engine/storage/types';
import {
  AuditSummary,
  DataHealthReport,
  Finding,
  FixPackage,
  VerificationState,
} from '../types/domain';

// Setup Mock Browser Global
function setupTestEnvironment() {
  (globalThis as any).window = globalThis;
  (globalThis as any).indexedDB = createMockIndexedDB();
}

function createSampleHealthReport(): DataHealthReport {
  return {
    total_events: 250,
    unique_events: 245,
    duplicate_events_dropped: 5,
    time_range: {
      start: '2026-09-01T00:00:00Z',
      end: '2026-09-02T00:00:00Z',
    },
    model_coverage_pct: 100,
    token_coverage_pct: 100,
    source_cost_coverage_pct: 100,
    pricing_coverage_pct: 100,
    latency_coverage_pct: 100,
    trace_coverage_pct: 95,
    missing_critical_fields: [],
    warnings: [],
    analysis_confidence: 'HIGH',
    health_grade: 'HEALTHY',
    is_sample_data: false,
  };
}

function createSampleFinding(auditId: string, idSuffix: string = '1'): Finding {
  return {
    id: `fnd_test_${idSuffix}`,
    audit_id: auditId,
    rule_id: 'MODEL_RIGHT_SIZING',
    title: 'Model Right Sizing Finding',
    summary: 'Candidate model gpt-4o-mini offers 80% reduction for lightweight calls.',
    affected_scope: 'gpt-4o -> gpt-4o-mini',
    detection_confidence: 'HIGH',
    cost_confidence: 'HIGH',
    savings_confidence: 'ESTIMATED',
    baseline_spend_usd: 120.50,
    candidate_spend_usd: 24.10,
    estimated_savings_usd: 96.40,
    potential_savings_pct: 80.0,
    annualized_projection_usd: 35186.00,
    eligible_event_count: 200,
    calculation_method: 'Deterministic catalog price rate applied to token distribution.',
    assumptions: ['Token distribution remains representative.'],
    evidence: {
      affected_event_count: 200,
      sample_events: [
        {
          id: `evt_sample_${idSuffix}`,
          model: 'gpt-4o',
          input_tokens: 150,
          output_tokens: 50,
          resolved_cost_usd: 0.00125,
          cost_provenance: 'CALCULATED',
          prompt_hash: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
          trace_id: 'tr_test_123',
        },
      ],
      metrics_comparison: [
        {
          label: 'Average Latency',
          current_value: '450ms',
          target_value: '300ms',
          provenance: 'VERIFIED',
        },
      ],
      trace_samples: ['tr_test_123'],
      mathematical_proof: 'Formula: Sum[ Cost_gpt4o - Cost_gpt4o_mini ] = $96.40',
    },
    status: 'DETECTED',
    is_sample_data: false,
  };
}

function createSampleFixPackage(findingId: string): FixPackage {
  return {
    finding_id: findingId,
    unlocked: true,
    unlocked_at: '2026-09-02T10:00:00Z',
    purchase_id: 'pur_12345',
    root_cause_hypothesis: 'Defaulting to flagship model for lightweight queries.',
    recommended_approach: 'Route classification queries to gpt-4o-mini.',
    expected_impact: {
      monthly_savings_usd: 2932.16,
      latency_delta_ms: -150,
      quality_risk: 'LOW',
    },
    test_plan: {
      sample_size: 50,
      evaluation_criteria: 'Exact match or cosine similarity >= 0.95',
      traffic_allocation_pct: 10,
      test_harness_instructions: 'Run shadow pipeline for 24 hours.',
    },
    acceptance_criteria: ['Accuracy >= 98%', 'P95 latency <= 350ms'],
    verification_instructions: 'Compare post-deployment spend with pre-deployment baseline.',
    rollback_plan: 'Revert environment variable MODEL_OVERRIDE.',
  };
}

function createSampleVerificationState(findingId: string): VerificationState {
  return {
    finding_id: findingId,
    stage: 'CUSTOMER_DEPLOYED',
    baseline_window: {
      start: '2026-09-01T00:00:00Z',
      end: '2026-09-02T00:00:00Z',
      avg_cost_per_call_usd: 0.00125,
      sample_count: 200,
    },
    deployment_timestamp: '2026-09-02T12:00:00Z',
  };
}

describe('AuditStore — Durable Local Audit Persistence Tests', () => {
  beforeEach(() => {
    setupTestEnvironment();
    (AuditStore as any).dbPromise = null;
  });

  test('Test A — Save / Load Round Trip preserves all canonical audit fields', async () => {
    const auditId = 'audit_round_trip_1001';
    const finding = createSampleFinding(auditId, '1');
    const health = createSampleHealthReport();
    const fixPackage = createSampleFixPackage(finding.id);
    const verifyState = createSampleVerificationState(finding.id);

    const auditSummary: AuditSummary = {
      id: auditId,
      created_at: '2026-09-02T12:00:00Z',
      source: 'langfuse',
      total_spend_usd: 120.50,
      potential_savings_usd: 96.40,
      annualized_savings_projection_usd: 35186.00,
      health,
      findings: [finding],
      is_sample_data: false,
    };

    const fixMap = new Map<string, FixPackage>([[finding.id, fixPackage]]);
    const verifyMap = new Map<string, VerificationState>([[finding.id, verifyState]]);

    const snapshot = AuditStore.buildSnapshot({
      auditSummary,
      healthReport: health,
      findings: [finding],
      fixPackages: fixMap,
      verificationStates: verifyMap,
      activeFindingId: finding.id,
      currentRoute: `/finding/${finding.id}`,
    });

    const saveSuccess = await AuditStore.saveAuditSnapshot(snapshot);
    assert.strictEqual(saveSuccess, true, 'Saving valid snapshot should succeed');

    const loaded = await AuditStore.loadAuditSnapshot(auditId);
    assert.ok(loaded, 'Loaded snapshot should not be null');

    // Assert essential structural keys preserved
    assert.strictEqual(loaded.audit_id, auditId);
    assert.strictEqual(loaded.created_at, '2026-09-02T12:00:00Z');
    assert.strictEqual(loaded.source, 'langfuse');
    assert.strictEqual(loaded.is_sample_data, false);
    assert.strictEqual(loaded.active_finding_id, finding.id);
    assert.strictEqual(loaded.current_route, `/finding/${finding.id}`);

    // Assert health report preserved
    assert.strictEqual(loaded.health.total_events, health.total_events);
    assert.strictEqual(loaded.health.health_grade, 'HEALTHY');

    // Assert summary and findings preserved
    assert.strictEqual(loaded.audit_summary.id, auditId);
    assert.strictEqual(loaded.audit_summary.total_spend_usd, 120.50);
    assert.strictEqual(loaded.audit_summary.potential_savings_usd, 96.40);
    assert.strictEqual(loaded.findings.length, 1);
    assert.strictEqual(loaded.findings[0].id, finding.id);

    // Assert fix package preserved
    assert.ok(loaded.fix_packages[finding.id]);
    assert.strictEqual(loaded.fix_packages[finding.id].unlocked, true);
    assert.strictEqual(loaded.fix_packages[finding.id].purchase_id, 'pur_12345');

    // Assert verification state preserved
    assert.ok(loaded.verification_states[finding.id]);
    assert.strictEqual(loaded.verification_states[finding.id].stage, 'CUSTOMER_DEPLOYED');
  });

  test('Test B — Latest Audit returns the newest valid snapshot by timestamp', async () => {
    const health = createSampleHealthReport();

    // Snapshot 1: Older (2026-09-01)
    const auditId1 = 'audit_older_20260901';
    const finding1 = createSampleFinding(auditId1, 'older');
    const summary1: AuditSummary = {
      id: auditId1,
      created_at: '2026-09-01T10:00:00Z',
      source: 'langfuse',
      total_spend_usd: 50.0,
      potential_savings_usd: 10.0,
      annualized_savings_projection_usd: 3650.0,
      health,
      findings: [finding1],
      is_sample_data: false,
    };
    const snap1 = AuditStore.buildSnapshot({
      auditSummary: summary1,
      healthReport: health,
      findings: [finding1],
      fixPackages: {},
      verificationStates: {},
    });
    await AuditStore.saveAuditSnapshot(snap1);

    // Snapshot 2: Newer (2026-09-02)
    const auditId2 = 'audit_newer_20260902';
    const finding2 = createSampleFinding(auditId2, 'newer');
    const summary2: AuditSummary = {
      id: auditId2,
      created_at: '2026-09-02T15:30:00Z',
      source: 'helicone',
      total_spend_usd: 200.0,
      potential_savings_usd: 80.0,
      annualized_savings_projection_usd: 29200.0,
      health,
      findings: [finding2],
      is_sample_data: false,
    };
    const snap2 = AuditStore.buildSnapshot({
      auditSummary: summary2,
      healthReport: health,
      findings: [finding2],
      fixPackages: {},
      verificationStates: {},
    });
    await AuditStore.saveAuditSnapshot(snap2);

    const latest = await AuditStore.loadLatestAuditSnapshot();
    assert.ok(latest, 'Latest snapshot should be found');
    assert.strictEqual(latest.audit_id, auditId2, 'Should return the newer snapshot');
    assert.strictEqual(latest.source, 'helicone');
  });

  test('Test C — Schema Version 1 is accepted, unsupported version (e.g. 999) is rejected safely without crashing', async () => {
    const auditId = 'audit_version_test';
    const finding = createSampleFinding(auditId, 'v');
    const health = createSampleHealthReport();
    const summary: AuditSummary = {
      id: auditId,
      created_at: '2026-09-02T12:00:00Z',
      source: 'custom_logs',
      total_spend_usd: 10.0,
      potential_savings_usd: 2.0,
      annualized_savings_projection_usd: 730.0,
      health,
      findings: [finding],
      is_sample_data: false,
    };

    const validSnapshot = AuditStore.buildSnapshot({
      auditSummary: summary,
      healthReport: health,
      findings: [finding],
      fixPackages: {},
      verificationStates: {},
    });

    assert.strictEqual(AuditStore.validateSnapshot(validSnapshot), true);
    assert.strictEqual(validSnapshot.schema_version, AUDIT_SNAPSHOT_SCHEMA_VERSION);

    // Test unsupported schema_version 999
    const unsupportedSnapshot = {
      ...validSnapshot,
      schema_version: 999,
    };

    assert.strictEqual(
      AuditStore.validateSnapshot(unsupportedSnapshot),
      false,
      'Unsupported schema version must be rejected by validator'
    );

    const saveResult = await AuditStore.saveAuditSnapshot(unsupportedSnapshot as any);
    assert.strictEqual(saveResult, false, 'Saving unsupported schema version must fail safely');
  });

  test('Test D — Corrupt Record is rejected and fails safely without throwing exceptions', async () => {
    const health = createSampleHealthReport();
    const finding = createSampleFinding('audit_valid', 'd');
    const summary: AuditSummary = {
      id: 'audit_valid',
      created_at: '2026-09-02T12:00:00Z',
      source: 'custom_logs',
      total_spend_usd: 10.0,
      potential_savings_usd: 2.0,
      annualized_savings_projection_usd: 730.0,
      health,
      findings: [finding],
      is_sample_data: false,
    };

    const baseSnapshot = AuditStore.buildSnapshot({
      auditSummary: summary,
      healthReport: health,
      findings: [finding],
      fixPackages: {},
      verificationStates: {},
    });

    // 1. Missing audit_id
    assert.strictEqual(
      AuditStore.validateSnapshot({ ...baseSnapshot, audit_id: '' }),
      false,
      'Empty audit_id must be rejected'
    );

    // 2. Mismatched audit_id != audit_summary.id
    assert.strictEqual(
      AuditStore.validateSnapshot({
        ...baseSnapshot,
        audit_id: 'audit_mismatch',
        audit_summary: { ...baseSnapshot.audit_summary, id: 'audit_different' },
      }),
      false,
      'Mismatched audit_id must be rejected'
    );

    // 3. Missing findings
    assert.strictEqual(
      AuditStore.validateSnapshot({ ...baseSnapshot, findings: null as any }),
      false,
      'Null findings must be rejected'
    );

    // 4. Missing health report
    assert.strictEqual(
      AuditStore.validateSnapshot({ ...baseSnapshot, health: undefined as any }),
      false,
      'Missing health must be rejected'
    );

    // 5. Loading non-existent ID returns null safely
    const nonExistent = await AuditStore.loadAuditSnapshot('does_not_exist');
    assert.strictEqual(nonExistent, null, 'Loading non-existent audit must return null');
  });

  test('Test E — Privacy: Raw prompt, raw completion, raw text, and arbitrary metadata are excluded from persisted DTO', async () => {
    const auditId = 'audit_privacy_test';
    const SECRET_TEXT = 'SECRET RAW PROMPT SHOULD NEVER BE STORED';
    const DANGEROUS_COMPLETION = 'DANGEROUS COMPLETION BODY THAT SHOULD NEVER PERSIST';

    // Construct a finding with dangerous fields intentionally injected
    const dirtyFinding: any = {
      id: 'fnd_dirty_1',
      audit_id: auditId,
      rule_id: 'MODEL_RIGHT_SIZING',
      title: 'Model Right Sizing Opportunity',
      summary: 'Candidate model gpt-4o-mini',
      affected_scope: 'gpt-4o -> gpt-4o-mini',
      detection_confidence: 'HIGH',
      cost_confidence: 'HIGH',
      savings_confidence: 'ESTIMATED',
      baseline_spend_usd: 100.0,
      candidate_spend_usd: 20.0,
      estimated_savings_usd: 80.0,
      potential_savings_pct: 80.0,
      annualized_projection_usd: 29200.0,
      eligible_event_count: 50,
      calculation_method: 'Pricing delta',
      assumptions: ['Stable usage'],
      evidence: {
        affected_event_count: 50,
        sample_events: [
          {
            id: 'evt_sample_clean',
            model: 'gpt-4o',
            input_tokens: 100,
            output_tokens: 20,
            resolved_cost_usd: 0.001,
            prompt_hash: 'd41d8cd98f00b204e9800998ecf8427e',
            // DANGEROUS FIELDS IN SAMPLE EVENT:
            prompt: SECRET_TEXT,
            completion: DANGEROUS_COMPLETION,
            metadata: {
              user_text: SECRET_TEXT,
              secret_key: 'sk-1234567890',
            },
            raw_payload: { prompt: SECRET_TEXT },
            stack: 'Error at runTelemetry()',
          },
        ],
        metrics_comparison: [],
        trace_samples: ['tr_123'],
        mathematical_proof: 'Delta math',
      },
      status: 'DETECTED',
      is_sample_data: false,
      // DANGEROUS FIELD DIRECTLY ON FINDING:
      metadata: {
        user_input: SECRET_TEXT,
      },
    };

    const health = createSampleHealthReport();
    const summary: AuditSummary = {
      id: auditId,
      created_at: '2026-09-02T12:00:00Z',
      source: 'langfuse',
      total_spend_usd: 100.0,
      potential_savings_usd: 80.0,
      annualized_savings_projection_usd: 29200.0,
      health,
      findings: [dirtyFinding as Finding],
      is_sample_data: false,
    };

    // Build the snapshot through the store
    const snapshot = AuditStore.buildSnapshot({
      auditSummary: summary,
      healthReport: health,
      findings: [dirtyFinding as Finding],
      fixPackages: {},
      verificationStates: {},
    });

    // Serialize the exact representation that would be written to IndexedDB
    const serialized = JSON.stringify(snapshot);

    // 1. Assert specific prohibited field keywords are completely absent
    const bannedKeys = [
      'prompt',
      'completion',
      'raw_prompt',
      'raw_completion',
      'request_body',
      'response_body',
      'raw_payload',
      'stack',
      'stack_trace',
      'exception',
      'error_message',
      'provider_response',
      'api_key',
      'authorization',
      'cookie',
      'metadata',
    ];

    for (const key of bannedKeys) {
      assert.strictEqual(
        serialized.includes(`"${key}"`),
        false,
        `Prohibited key "${key}" must NOT be present in serialized snapshot`
      );
    }

    // 2. Assert that arbitrary sensitive string values are completely absent anywhere in the snapshot
    assert.strictEqual(
      serialized.includes(SECRET_TEXT),
      false,
      'Secret text must NOT appear anywhere in the serialized persisted snapshot'
    );
    assert.strictEqual(
      serialized.includes(DANGEROUS_COMPLETION),
      false,
      'Completion text must NOT appear anywhere in the serialized persisted snapshot'
    );
    assert.strictEqual(
      serialized.includes('sk-1234567890'),
      false,
      'Secret key must NOT appear anywhere in the serialized persisted snapshot'
    );

    // 3. Assert that the snapshot is accepted by validateSnapshot because it is cleanly sanitized
    assert.strictEqual(AuditStore.validateSnapshot(snapshot), true);

    // 4. Assert that if an object with disallowed keys is presented to validateSnapshot, it is rejected
    const unSanitizedSnapshot = {
      ...snapshot,
      findings: [dirtyFinding], // Unsanitized with prompt and metadata
    };
    assert.strictEqual(
      AuditStore.validateSnapshot(unSanitizedSnapshot),
      false,
      'Unsanitized object containing metadata/prompt must be rejected by validator'
    );
  });

  test('Test F — Analytical Values Preserved across round-trip', async () => {
    const auditId = 'audit_analytical_precision';
    const baseline = 1254.7892;
    const candidate = 312.4512;
    const savings = 942.3380;
    const pct = 75.1;
    const annualized = 343953.37;
    const eventCount = 14200;
    const calcMethod = 'Deterministic catalog delta for GPT-4o -> GPT-4o-mini with token-weighted distribution';
    const mathProof = 'Sum[ Cost_k ] for k in (1..14200) = $942.3380';

    const finding: Finding = {
      id: 'fnd_precision_1',
      audit_id: auditId,
      rule_id: 'MODEL_RIGHT_SIZING',
      title: 'Model Right Sizing Precision',
      summary: 'Precision test finding',
      affected_scope: 'gpt-4o -> gpt-4o-mini',
      detection_confidence: 'HIGH',
      cost_confidence: 'HIGH',
      savings_confidence: 'ESTIMATED',
      baseline_spend_usd: baseline,
      candidate_spend_usd: candidate,
      estimated_savings_usd: savings,
      potential_savings_pct: pct,
      annualized_projection_usd: annualized,
      eligible_event_count: eventCount,
      calculation_method: calcMethod,
      assumptions: ['Distribution unchanged', 'Latency acceptable'],
      evidence: {
        affected_event_count: eventCount,
        sample_events: [],
        metrics_comparison: [],
        trace_samples: [],
        mathematical_proof: mathProof,
      },
      status: 'DETECTED',
      is_sample_data: false,
    };

    const health = createSampleHealthReport();
    const summary: AuditSummary = {
      id: auditId,
      created_at: '2026-09-02T14:00:00Z',
      source: 'langfuse',
      total_spend_usd: baseline,
      potential_savings_usd: savings,
      annualized_savings_projection_usd: annualized,
      health,
      findings: [finding],
      is_sample_data: false,
    };

    const snapshot = AuditStore.buildSnapshot({
      auditSummary: summary,
      healthReport: health,
      findings: [finding],
      fixPackages: {},
      verificationStates: {},
    });

    await AuditStore.saveAuditSnapshot(snapshot);
    const loaded = await AuditStore.loadAuditSnapshot(auditId);
    assert.ok(loaded);

    const loadedFinding = loaded.findings[0];
    assert.strictEqual(loadedFinding.baseline_spend_usd, baseline);
    assert.strictEqual(loadedFinding.candidate_spend_usd, candidate);
    assert.strictEqual(loadedFinding.estimated_savings_usd, savings);
    assert.strictEqual(loadedFinding.potential_savings_pct, pct);
    assert.strictEqual(loadedFinding.annualized_projection_usd, annualized);
    assert.strictEqual(loadedFinding.eligible_event_count, eventCount);
    assert.strictEqual(loadedFinding.calculation_method, calcMethod);
    assert.strictEqual(loadedFinding.evidence.mathematical_proof, mathProof);
    assert.deepStrictEqual(loadedFinding.assumptions, ['Distribution unchanged', 'Latency acceptable']);
  });

  test('Test G — Persistence Failure: Storage errors return false/null safely without crashing in-memory state', async () => {
    // Simulate broken IndexedDB where open throws or fails
    (globalThis as any).indexedDB = {
      open: () => {
        const req: any = {};
        setTimeout(() => {
          if (req.onerror) req.onerror(new Error('QuotaExceeded or StorageBlocked'));
        }, 0);
        return req;
      },
    };

    // Reset internal connection cache to test error path
    (AuditStore as any).dbPromise = null;

    const auditId = 'audit_failure_test';
    const finding = createSampleFinding(auditId, 'fail');
    const health = createSampleHealthReport();
    const summary: AuditSummary = {
      id: auditId,
      created_at: '2026-09-02T15:00:00Z',
      source: 'langfuse',
      total_spend_usd: 10.0,
      potential_savings_usd: 5.0,
      annualized_savings_projection_usd: 1825.0,
      health,
      findings: [finding],
      is_sample_data: false,
    };

    const snapshot = AuditStore.buildSnapshot({
      auditSummary: summary,
      healthReport: health,
      findings: [finding],
      fixPackages: {},
      verificationStates: {},
    });

    // Save should gracefully return false and not throw
    let saveResult: boolean | null = null;
    try {
      saveResult = await AuditStore.saveAuditSnapshot(snapshot);
    } catch (e) {
      assert.fail(`saveAuditSnapshot should not throw: ${(e as Error).message}`);
    }
    assert.strictEqual(saveResult, false, 'Save failure must return false safely');

    // Load should gracefully return null and not throw
    let loadResult: PersistedAuditSnapshot | null = null;
    try {
      loadResult = await AuditStore.loadAuditSnapshot(auditId);
    } catch (e) {
      assert.fail(`loadAuditSnapshot should not throw: ${(e as Error).message}`);
    }
    assert.strictEqual(loadResult, null, 'Load failure must return null safely');

    // Latest load should gracefully return null and not throw
    let latestResult: PersistedAuditSnapshot | null = null;
    try {
      latestResult = await AuditStore.loadLatestAuditSnapshot();
    } catch (e) {
      assert.fail(`loadLatestAuditSnapshot should not throw: ${(e as Error).message}`);
    }
    assert.strictEqual(latestResult, null, 'Load latest failure must return null safely');
  });

  test('Test H: FixPackage Privacy Isolation (Strips raw payloads, prompts, tokens, credentials)', async () => {
    const auditId = 'audit_fixpkg_privacy_test';
    const finding = createSampleFinding(auditId, '1');
    const health = createSampleHealthReport();
    const summary: AuditSummary = {
      id: auditId,
      created_at: '2026-09-02T16:00:00Z',
      source: 'opentelemetry',
      total_spend_usd: 120.0,
      potential_savings_usd: 40.0,
      annualized_savings_projection_usd: 14600.0,
      health,
      findings: [finding],
      is_sample_data: false,
    };

    // Construct a FixPackage that simulates a runtime object contaminated with sensitive/raw fields
    const contaminatedFixPackage: any = {
      finding_id: finding.id,
      unlocked: true,
      unlocked_at: '2026-09-02T16:05:00Z',
      purchase_id: 'purch_test_123',
      root_cause_hypothesis: 'Excessive prompt tokens from uncompressed system message',
      recommended_approach: 'Compress system prompt template and cache prefixes',
      expected_impact: {
        monthly_savings_usd: 40.0,
        latency_delta_ms: -150,
        quality_risk: 'LOW',
        // Injected raw properties
        raw_prompt: 'SYSTEM: You are a super confidential banking bot...',
        internal_api_key: 'sk-proj-supersecret123456789',
      },
      test_plan: {
        sample_size: 50,
        evaluation_criteria: 'Verify token reduction while semantic output remains identical',
        traffic_allocation_pct: 10,
        test_harness_instructions: 'Run shadow traffic through new prompt template',
        // Injected raw payload
        raw_payload: { prompt: 'Secret payload content', token: 'bearer-token-abc' },
      },
      acceptance_criteria: [
        'Prompt token count reduced by >= 30%',
        'Evaluation pass rate >= 98%',
      ],
      verification_instructions: 'Compare pre/post token distributions in baseline window',
      rollback_plan: 'Revert prompt template commit and invalidate edge cache',
      // Injected top-level disallowed keys
      prompt: 'RAW PROMPT TEXT THAT MUST NEVER BE STORED',
      completion: 'RAW COMPLETION TEXT THAT MUST NEVER BE STORED',
      metadata: { customer_email: 'ceo@confidential.com', api_key: 'secret_key_123' },
      secret: 'super_secret_token',
      credentials: { token: 'jwt.token.here' },
      headers: { Authorization: 'Bearer test' },
    };

    // Build snapshot through AuditStore
    const snapshot = AuditStore.buildSnapshot({
      auditSummary: summary,
      healthReport: health,
      findings: [finding],
      fixPackages: { [finding.id]: contaminatedFixPackage },
      verificationStates: {},
    });

    // 1. Verify buildSnapshot mapped to PersistedFixPackage DTO without leaky fields
    const persistedPkg = snapshot.fix_packages[finding.id];
    assert.ok(persistedPkg, 'Persisted fix package should exist');
    assert.strictEqual(persistedPkg.finding_id, finding.id);
    assert.strictEqual(persistedPkg.unlocked, true);
    assert.strictEqual(persistedPkg.root_cause_hypothesis, 'Excessive prompt tokens from uncompressed system message');
    assert.strictEqual(persistedPkg.expected_impact.monthly_savings_usd, 40.0);
    assert.strictEqual(persistedPkg.test_plan.sample_size, 50);

    // 2. Invariant verification: No disallowed keys in serialized snapshot
    const serialized = JSON.stringify(snapshot);
    assert.strictEqual(serialized.includes('RAW PROMPT TEXT'), false, 'Must not contain raw prompt text');
    assert.strictEqual(serialized.includes('RAW COMPLETION TEXT'), false, 'Must not contain raw completion text');
    assert.strictEqual(serialized.includes('sk-proj-supersecret'), false, 'Must not contain api key');
    assert.strictEqual(serialized.includes('ceo@confidential.com'), false, 'Must not contain metadata email');
    assert.strictEqual(serialized.includes('jwt.token.here'), false, 'Must not contain credentials token');

    // 3. Validation and save round-trip integrity
    const isValid = AuditStore.validateSnapshot(snapshot);
    assert.strictEqual(isValid, true, 'Sanitized snapshot must pass validation');

    const saveSuccess = await AuditStore.saveAuditSnapshot(snapshot);
    assert.strictEqual(saveSuccess, true, 'Save should succeed');

    const loaded = await AuditStore.loadAuditSnapshot(auditId);
    assert.ok(loaded, 'Loaded snapshot should exist');
    const loadedPkg = loaded!.fix_packages[finding.id];
    assert.ok(loadedPkg, 'Loaded fix package should exist');
    assert.strictEqual((loadedPkg as any).prompt, undefined, 'Loaded package must not have prompt');
    assert.strictEqual((loadedPkg as any).metadata, undefined, 'Loaded package must not have metadata');
    assert.strictEqual((loadedPkg as any).raw_payload, undefined, 'Loaded package must not have raw_payload');
  });

  test('Test I: VerificationState Privacy Isolation (Strips responses, payloads, tokens, headers)', async () => {
    const auditId = 'audit_verification_privacy_test';
    const finding = createSampleFinding(auditId, '1');
    const health = createSampleHealthReport();
    const summary: AuditSummary = {
      id: auditId,
      created_at: '2026-09-02T17:00:00Z',
      source: 'helicone',
      total_spend_usd: 80.0,
      potential_savings_usd: 25.0,
      annualized_savings_projection_usd: 9125.0,
      health,
      findings: [finding],
      is_sample_data: false,
    };

    // Construct a VerificationState contaminated with runtime payloads, headers, tokens
    const contaminatedVerificationState: any = {
      finding_id: finding.id,
      stage: 'VERIFIED_RESULT',
      baseline_window: {
        start: '2026-09-01T00:00:00Z',
        end: '2026-09-01T12:00:00Z',
        avg_cost_per_call_usd: 0.0085,
        sample_count: 500,
        // Injected raw responses
        response: { body: 'raw response data from provider' },
      },
      deployment_timestamp: '2026-09-01T13:00:00Z',
      observation_window: {
        start: '2026-09-01T13:00:00Z',
        end: '2026-09-02T01:00:00Z',
        sample_event_count: 520,
        // Injected request/response payload
        request: { headers: { Authorization: 'Bearer leak123' } },
      },
      observed_result: {
        pre_cost_per_call_usd: 0.0085,
        post_cost_per_call_usd: 0.0051,
        observed_reduction_pct: 40.0,
        annualized_realized_savings_usd: 9125.0,
        verification_confidence: 'HIGH',
        verification_notes: 'Consistent 40% cost reduction observed across 520 calls',
        // Injected raw completions & stack traces
        completion: 'Completed with token payload abc',
        stack_trace: 'Error at verification line 42',
      },
      // Injected top-level fields
      raw_payload: { all_events: [1, 2, 3] },
      metadata: { session_token: 'tok_sess_999' },
      cookie: 'session_cookie=abc',
    };

    // Build snapshot through AuditStore
    const snapshot = AuditStore.buildSnapshot({
      auditSummary: summary,
      healthReport: health,
      findings: [finding],
      fixPackages: {},
      verificationStates: { [finding.id]: contaminatedVerificationState },
    });

    // 1. Verify buildSnapshot mapped to PersistedVerificationState DTO without leaky fields
    const persistedState = snapshot.verification_states[finding.id];
    assert.ok(persistedState, 'Persisted verification state should exist');
    assert.strictEqual(persistedState.finding_id, finding.id);
    assert.strictEqual(persistedState.stage, 'VERIFIED_RESULT');
    assert.strictEqual(persistedState.baseline_window.avg_cost_per_call_usd, 0.0085);
    assert.strictEqual(persistedState.observed_result?.observed_reduction_pct, 40.0);

    // 2. Invariant verification: No disallowed keys in serialized snapshot
    const serialized = JSON.stringify(snapshot);
    assert.strictEqual(serialized.includes('raw response data'), false, 'Must not contain response data');
    assert.strictEqual(serialized.includes('Bearer leak123'), false, 'Must not contain auth header');
    assert.strictEqual(serialized.includes('Error at verification line 42'), false, 'Must not contain stack trace');
    assert.strictEqual(serialized.includes('tok_sess_999'), false, 'Must not contain session token');

    // 3. Validation and save round-trip integrity
    const isValid = AuditStore.validateSnapshot(snapshot);
    assert.strictEqual(isValid, true, 'Sanitized snapshot must pass validation');

    const saveSuccess = await AuditStore.saveAuditSnapshot(snapshot);
    assert.strictEqual(saveSuccess, true, 'Save should succeed');

    const loaded = await AuditStore.loadAuditSnapshot(auditId);
    assert.ok(loaded, 'Loaded snapshot should exist');
    const loadedState = loaded!.verification_states[finding.id];
    assert.ok(loadedState, 'Loaded verification state should exist');
    assert.strictEqual((loadedState as any).response, undefined);
    assert.strictEqual((loadedState as any).request, undefined);
    assert.strictEqual((loadedState as any).metadata, undefined);
    assert.strictEqual((loadedState as any).raw_payload, undefined);
  });

  test('Test J: Runtime Object Isolation & Deep Scan Rejection (Direct injection of disallowed keys fails validation)', async () => {
    const auditId = 'audit_isolation_rejection_test';
    const finding = createSampleFinding(auditId, '1');
    const health = createSampleHealthReport();
    const summary: AuditSummary = {
      id: auditId,
      created_at: '2026-09-02T18:00:00Z',
      source: 'custom_logs',
      total_spend_usd: 50.0,
      potential_savings_usd: 15.0,
      annualized_savings_projection_usd: 5475.0,
      health,
      findings: [finding],
      is_sample_data: false,
    };

    const validSnapshot = AuditStore.buildSnapshot({
      auditSummary: summary,
      healthReport: health,
      findings: [finding],
      fixPackages: {},
      verificationStates: {},
    });

    assert.strictEqual(AuditStore.validateSnapshot(validSnapshot), true, 'Clean snapshot must validate');

    // Test J1: Corrupt snapshot by injecting prompt key into fix_packages directly
    const corruptedSnapshot1 = JSON.parse(JSON.stringify(validSnapshot));
    corruptedSnapshot1.fix_packages = {
      fnd_1: {
        finding_id: 'fnd_1',
        unlocked: false,
        root_cause_hypothesis: 'hypothesis',
        recommended_approach: 'approach',
        expected_impact: { monthly_savings_usd: 10, latency_delta_ms: 0, quality_risk: 'LOW' },
        test_plan: { sample_size: 10, evaluation_criteria: 'crit', traffic_allocation_pct: 5, test_harness_instructions: 'inst' },
        acceptance_criteria: ['crit1'],
        verification_instructions: 'vinst',
        rollback_plan: 'rplan',
        prompt: 'Contaminated prompt injected directly',
      },
    };
    assert.strictEqual(
      AuditStore.validateSnapshot(corruptedSnapshot1),
      false,
      'Directly injected prompt in fix_package must fail validateSnapshot'
    );
    const saveCorrupt1 = await AuditStore.saveAuditSnapshot(corruptedSnapshot1);
    assert.strictEqual(saveCorrupt1, false, 'Saving contaminated snapshot 1 must return false safely');

    // Test J2: Corrupt snapshot by injecting metadata key into verification_states directly
    const corruptedSnapshot2 = JSON.parse(JSON.stringify(validSnapshot));
    corruptedSnapshot2.verification_states = {
      fnd_1: {
        finding_id: 'fnd_1',
        stage: 'BASELINE',
        baseline_window: { start: '2026-09-01T00:00:00Z', end: '2026-09-01T06:00:00Z', avg_cost_per_call_usd: 0.01, sample_count: 100 },
        metadata: { leaked_user_id: 'user_456' },
      },
    };
    assert.strictEqual(
      AuditStore.validateSnapshot(corruptedSnapshot2),
      false,
      'Directly injected metadata in verification_states must fail validateSnapshot'
    );
    const saveCorrupt2 = await AuditStore.saveAuditSnapshot(corruptedSnapshot2);
    assert.strictEqual(saveCorrupt2, false, 'Saving contaminated snapshot 2 must return false safely');

    // Test J3: Corrupt snapshot by injecting token key into sample_events directly
    const corruptedSnapshot3 = JSON.parse(JSON.stringify(validSnapshot));
    corruptedSnapshot3.findings[0].evidence.sample_events.push({
      id: 'evt_sample_leaked',
      token: 'jwt_leaked_token_123',
    });
    assert.strictEqual(
      AuditStore.validateSnapshot(corruptedSnapshot3),
      false,
      'Directly injected token in sample_events must fail validateSnapshot'
    );
    const saveCorrupt3 = await AuditStore.saveAuditSnapshot(corruptedSnapshot3);
    assert.strictEqual(saveCorrupt3, false, 'Saving contaminated snapshot 3 must return false safely');
  });
});

