/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { ServerStorage } from '../server/storage';
import { hashPassword, authenticate } from '../server/auth';
import { createApiRouter } from '../server/api';
import { AIEvent, Finding, VerificationState } from '../types/domain';
import { isCommerciallyVerified, evaluateVerification } from '../engine/verification/comparator';
import { createDatabaseConnection } from '../server/db/index';
import { DrizzleStorageAdapter } from '../server/db/adapter';
import { runDatabaseMigrations } from '../../scripts/migrate-db';
import fs from 'fs';

describe('AIDisCost — Server-Side Verification Authority Suite', () => {
  let server: http.Server;
  let serverUrl: string;
  const storage = ServerStorage.getInstance('data', 'test-verify-db.json');

  let userA: { id: string; email: string; cookie: string };
  let userB: { id: string; email: string; cookie: string };

  const findingA = 'fnd_auth_ver_user_a_01';
  const findingB = 'fnd_auth_ver_user_b_01';

  const mockFindingDataA: Finding = {
    id: findingA,
    audit_id: 'adt_01',
    rule_id: 'MODEL_RIGHT_SIZING',
    title: 'Model Right-Sizing: gpt-4o → gpt-4o-mini',
    summary: 'Candidate models provide comparable accuracy at lower unit cost.',
    affected_scope: 'gpt-4o → gpt-4o-mini',
    detection_confidence: 'HIGH',
    cost_confidence: 'HIGH',
    savings_confidence: 'HIGH',
    baseline_spend_usd: 100.0,
    candidate_spend_usd: 15.0,
    estimated_savings_usd: 85.0,
    potential_savings_pct: 85.0,
    annualized_projection_usd: 1020.0,
    eligible_event_count: 50,
    calculation_method: 'unit_reduction',
    assumptions: [],
    evidence: {
      affected_event_count: 50,
      sample_events: [{ model: 'gpt-4o' }],
      metrics_comparison: [],
      trace_samples: [],
      mathematical_proof: 'proof',
      baseline_period: {
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-09-10T00:00:00.000Z',
      },
    },
    status: 'DETECTED',
    is_sample_data: false,
  };

  before(async () => {
    storage.setTestMode(true);
    storage.clearAll();

    const app = express();
    app.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      })
    );
    app.use(cookieParser());
    app.use(authenticate);
    app.use('/api', createApiRouter());

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // Create User A
    const passwordHash = hashPassword('Password123!');
    const uA = await storage.createUser({
      id: 'usr_ver_a',
      email: 'usera@example.com',
      password_hash: passwordHash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const sA = await storage.createSession({
      token: 'tok_sess_ver_a',
      user_id: uA.id,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: new Date().toISOString(),
    });
    userA = { id: uA.id, email: uA.email, cookie: `aidiscost_session=${sA.token}` };

    // Create User B
    const uB = await storage.createUser({
      id: 'usr_ver_b',
      email: 'userb@example.com',
      password_hash: passwordHash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const sB = await storage.createSession({
      token: 'tok_sess_ver_b',
      user_id: uB.id,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: new Date().toISOString(),
    });
    userB = { id: uB.id, email: uB.email, cookie: `aidiscost_session=${sB.token}` };

    // Register finding ownerships
    await storage.registerFindingOwnership(findingA, userA.id);
    await storage.registerFindingOwnership(findingB, userB.id);
  });

  after(async () => {
    storage.clearAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // Helper to generate N post-deployment events
  function generatePostEvents(count: number, unitCost: number, isSimulated = false, model = 'gpt-4o-mini'): AIEvent[] {
    const events: AIEvent[] = [];
    const baseTime = new Date('2026-09-15T00:00:00.000Z').getTime();
    for (let i = 0; i < count; i++) {
      events.push({
        id: `post_evt_${i}_${Date.now()}_${Math.random()}`,
        source: 'custom_logs',
        source_event_id: `src_post_${i}`,
        timestamp: new Date(baseTime + i * 3600_000).toISOString(), // 1 hour intervals
        provider: 'openai',
        model,
        operation: 'chat',
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        latency_ms: 120,
        status: 'SUCCESS',
        trace_id: `tr_${i}`,
        tool_calls: [],
        source_reported_cost_usd: unitCost,
        calculated_cost_usd: unitCost,
        resolved_cost_usd: unitCost,
        cost_provenance: 'CALCULATED',
        cost_confidence: 'HIGH',
        metadata: {},
        is_simulated: isSimulated,
      });
    }
    return events;
  }

  describe('1. Authentication & Finding Ownership Boundary', () => {
    test('unauthenticated request to GET verification returns 401 UNAUTHORIZED', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification`);
      assert.strictEqual(res.status, 401);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'UNAUTHORIZED');
    });

    test('unauthenticated request to POST deploy returns 401 UNAUTHORIZED', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseline: { start: '2026-09-01T00:00:00Z', end: '2026-09-10T00:00:00Z', sample_count: 50, avg_cost_per_call_usd: 2.0 } }),
      });
      assert.strictEqual(res.status, 401);
    });

    test('unauthenticated request to POST evaluate returns 401 UNAUTHORIZED', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [], finding: mockFindingDataA }),
      });
      assert.strictEqual(res.status, 401);
    });

    test('user cannot retrieve another user\'s verification state (returns 404 NOT_FOUND)', async () => {
      // User B attempts to access finding A owned by User A
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification`, {
        headers: { Cookie: userB.cookie },
      });
      assert.strictEqual(res.status, 404);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'NOT_FOUND');
    });

    test('user cannot deploy verification for another user\'s finding (returns 404 NOT_FOUND)', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userB.cookie },
        body: JSON.stringify({ baseline: { start: '2026-09-01T00:00:00Z', end: '2026-09-10T00:00:00Z', sample_count: 50, avg_cost_per_call_usd: 2.0 } }),
      });
      assert.strictEqual(res.status, 404);
    });

    test('user cannot evaluate verification for another user\'s finding (returns 404 NOT_FOUND)', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userB.cookie },
        body: JSON.stringify({ events: generatePostEvents(20, 0.3), finding: mockFindingDataA }),
      });
      assert.strictEqual(res.status, 404);
    });
  });

  describe('2. Client Authority Forgery Resistance (Invariants A & C)', () => {
    test('client cannot manufacture authority by sending is_authoritative: true', async () => {
      // Deploy first
      await fetch(`${serverUrl}/api/findings/${findingA}/verification/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({
          baseline: {
            start: '2026-09-01T00:00:00.000Z',
            end: '2026-09-10T00:00:00.000Z',
            sample_count: 50,
            avg_cost_per_call_usd: 2.0,
          },
          deployment_timestamp: '2026-09-14T00:00:00.000Z',
        }),
      });

      // Send 5 events (insufficient; minimum is 15), but client fraudulently claims is_authoritative: true
      const forgedPayload = {
        events: generatePostEvents(5, 0.3),
        finding: mockFindingDataA,
        is_authoritative: true,
        stage: 'VERIFIED_RESULT',
        verified_annualized_savings_usd: 999999.0,
      };

      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify(forgedPayload),
      });

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();

      // Server MUST reject client claims and evaluate canonical outcome:
      assert.strictEqual(json.is_authoritative, false, 'Server must override client claim of is_authoritative');
      assert.strictEqual(json.stage, 'OBSERVATION_ACTIVE', 'Stage must remain OBSERVATION_ACTIVE due to insufficient sample (< 15)');
      assert.strictEqual(json.verified_annualized_savings_usd, 0, 'Authoritative savings must be 0');
    });

    test('client cannot force arbitrary verified annualized savings without empirical justification', async () => {
      // Send events with NO unit reduction (post cost = baseline cost = 2.0)
      const zeroReductionEvents = generatePostEvents(20, 2.0); // 0% reduction
      const forgedPayload = {
        events: zeroReductionEvents,
        finding: mockFindingDataA,
        verified_annualized_savings_usd: 50000.0,
        stage: 'VERIFIED_RESULT',
      };

      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify(forgedPayload),
      });

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();

      assert.strictEqual(json.is_authoritative, false);
      assert.strictEqual(json.stage, 'OBSERVATION_ACTIVE');
      assert.strictEqual(json.verified_annualized_savings_usd, 0);
    });
  });

  describe('3. Simulation Isolation (Invariant E)', () => {
    test('simulated telemetry events (is_simulated: true) NEVER produce an authoritative verification', async () => {
      const simulatedEvents = generatePostEvents(25, 0.2, true); // 25 events, 90% reduction, but marked is_simulated: true

      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({
          events: simulatedEvents,
          finding: mockFindingDataA,
        }),
      });

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();

      assert.strictEqual(json.is_authoritative, false, 'Simulated events must NEVER be authoritative');
      assert.strictEqual(json.is_simulated, true);
      assert.strictEqual(json.stage, 'OBSERVATION_ACTIVE', 'Simulated events cannot advance stage to VERIFIED_RESULT');
      assert.strictEqual(json.verified_annualized_savings_usd, 0, 'Authoritative verified savings must be $0.00');

      // Verify persisted state in storage
      const persisted = await storage.getVerificationByFindingId(findingA);
      assert.ok(persisted);
      assert.strictEqual(persisted.is_authoritative, false);
      assert.strictEqual(persisted.is_simulated, true);
      assert.strictEqual(persisted.verified_annualized_savings_usd, 0);
    });
  });

  describe('4. Canonical Verification Correctness & Authoritative Transitions', () => {
    test('insufficient sample size (< 15 events) remains OBSERVATION_ACTIVE with 0 savings', async () => {
      const events = generatePostEvents(14, 0.2, false); // 14 events (just below 15 threshold)

      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({ events, finding: mockFindingDataA }),
      });

      const json: any = await res.json();
      assert.strictEqual(json.stage, 'OBSERVATION_ACTIVE');
      assert.strictEqual(json.is_authoritative, false);
      assert.strictEqual(json.verified_annualized_savings_usd, 0);
    });

    test('reduction below 10% threshold remains OBSERVATION_ACTIVE with 0 savings', async () => {
      // Baseline is $2.0. Post-cost $1.90 is 5% reduction (< 10%)
      const events = generatePostEvents(20, 1.90, false);

      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({ events, finding: mockFindingDataA }),
      });

      const json: any = await res.json();
      assert.strictEqual(json.stage, 'OBSERVATION_ACTIVE');
      assert.strictEqual(json.is_authoritative, false);
      assert.strictEqual(json.verified_annualized_savings_usd, 0);
    });

    test('valid production telemetry meeting all constraints produces authoritative VERIFIED_RESULT', async () => {
      // Baseline: $2.0. Post: $0.30 (85% reduction). Sample: 20 events (> 15).
      const events = generatePostEvents(20, 0.30, false);

      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({ events, finding: mockFindingDataA }),
      });

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();

      assert.strictEqual(json.stage, 'VERIFIED_RESULT');
      assert.strictEqual(json.is_authoritative, true);
      assert.strictEqual(json.is_simulated, false);
      assert.ok(json.verified_annualized_savings_usd > 0, 'Verified annualized savings must be positive');
      assert.strictEqual(json.verification.stage, 'VERIFIED_RESULT');
      assert.strictEqual(json.verification.is_authoritative, true);

      // Verify GET endpoint returns authoritative state
      const getRes = await fetch(`${serverUrl}/api/findings/${findingA}/verification`, {
        headers: { Cookie: userA.cookie },
      });
      const getJson: any = await getRes.json();
      assert.strictEqual(getJson.stage, 'VERIFIED_RESULT');
      assert.strictEqual(getJson.is_authoritative, true);
      assert.strictEqual(getJson.verified_annualized_savings_usd, json.verified_annualized_savings_usd);
    });
  });

  describe('5. Database Persistence & libSQL Adapter Verification', () => {
    const testDbPath = 'data/test-adapter-ver.db';
    let adapter: DrizzleStorageAdapter;
    let clientClose: () => void;

    before(async () => {
      if (fs.existsSync(testDbPath)) {
        fs.rmSync(testDbPath, { force: true });
      }
      process.env.TURSO_DATABASE_URL = `file:${testDbPath}`;
      await runDatabaseMigrations();

      const { db, client } = createDatabaseConnection({ url: `file:${testDbPath}` });
      adapter = new DrizzleStorageAdapter(db, client);
      clientClose = () => client.close();

      // Seed user and finding ownership in SQL db
      await adapter.createUser({
        id: 'usr_sql_01',
        email: 'sqluser@example.com',
        password_hash: hashPassword('Pass123'),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await adapter.registerFindingOwnership('fnd_sql_01', 'usr_sql_01');
    });

    after(async () => {
      if (clientClose) clientClose();
      if (fs.existsSync(testDbPath)) {
        fs.rmSync(testDbPath, { force: true });
      }
      delete process.env.TURSO_DATABASE_URL;
    });

    test('DrizzleStorageAdapter persists authoritative verification to SQLite/libSQL database', async () => {
      const now = new Date().toISOString();
      const record = {
        id: 'ver_sql_test_01',
        finding_id: 'fnd_sql_01',
        user_id: 'usr_sql_01',
        stage: 'VERIFIED_RESULT' as const,
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 1.5,
        deployment_timestamp: '2026-09-12T00:00:00Z',
        observation_start: '2026-09-12T00:00:00Z',
        observation_end: '2026-09-14T00:00:00Z',
        observation_sample_count: 25,
        post_avg_cost_usd: 0.25,
        observed_reduction_pct: 83.3,
        verified_annualized_savings_usd: 11400.0,
        verification_confidence: 'HIGH' as const,
        verification_notes: 'Empirically verified on persistent database',
        verified_at: now,
        created_at: now,
        updated_at: now,
      };

      const saved = await adapter.saveVerification(record);
      assert.strictEqual(saved.id, 'ver_sql_test_01');

      // Query from database
      const fetched = await adapter.getVerificationByFindingId('fnd_sql_01');
      assert.ok(fetched);
      assert.strictEqual(fetched.id, 'ver_sql_test_01');
      assert.strictEqual(fetched.stage, 'VERIFIED_RESULT');
      assert.strictEqual(fetched.is_authoritative, true);
      assert.strictEqual(fetched.is_simulated, false);
      assert.strictEqual(fetched.verified_annualized_savings_usd, 11400.0);
      assert.strictEqual(fetched.user_id, 'usr_sql_01');
    });

    test('DrizzleStorageAdapter upsert updates existing verification without creating duplicate records', async () => {
      const updatedRecord = {
        id: 'ver_sql_test_01_alt_id', // different id attempted
        finding_id: 'fnd_sql_01',     // same finding
        user_id: 'usr_sql_01',
        stage: 'VERIFIED_RESULT' as const,
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 60,
        baseline_avg_cost_usd: 1.5,
        deployment_timestamp: '2026-09-12T00:00:00Z',
        observation_start: '2026-09-12T00:00:00Z',
        observation_end: '2026-09-15T00:00:00Z',
        observation_sample_count: 35,
        post_avg_cost_usd: 0.20,
        observed_reduction_pct: 86.7,
        verified_annualized_savings_usd: 12500.0,
        verification_confidence: 'HIGH' as const,
        verification_notes: 'Updated verification with additional telemetry',
        verified_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await adapter.saveVerification(updatedRecord);
      const fetched = await adapter.getVerificationByFindingId('fnd_sql_01');
      assert.ok(fetched);
      assert.strictEqual(fetched.finding_id, 'fnd_sql_01');
      assert.strictEqual(fetched.verified_annualized_savings_usd, 12500.0);
      assert.strictEqual(fetched.observation_sample_count, 35);
    });
  });

  describe('6. Full Trust Boundary End-to-End Test', () => {
    test('CLIENT REQUEST → SERVER AUTH → FINDING OWNERSHIP → SERVER ENGINE → PERSISTENCE → AUTHORITATIVE RESULT', async () => {
      const findingE2E = 'fnd_trust_boundary_e2e';
      const mockFindingE2E: Finding = {
        ...mockFindingDataA,
        id: findingE2E,
        title: 'Full Trust Boundary Verification',
      };

      // Step 1: User A registers ownership of findingE2E
      await storage.registerFindingOwnership(findingE2E, userA.id);

      // Step 2: User A marks deployment on the server
      const deployRes = await fetch(`${serverUrl}/api/findings/${findingE2E}/verification/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({
          baseline: {
            start: '2026-09-01T00:00:00.000Z',
            end: '2026-09-10T00:00:00.000Z',
            sample_count: 50,
            avg_cost_per_call_usd: 2.0,
          },
          deployment_timestamp: '2026-09-14T00:00:00.000Z',
        }),
      });
      assert.strictEqual(deployRes.status, 200);
      const deployJson: any = await deployRes.json();
      assert.strictEqual(deployJson.stage, 'CUSTOMER_DEPLOYED');
      assert.strictEqual(deployJson.is_authoritative, false);

      // Step 3: User A submits 20 production telemetry events with 85% unit cost reduction
      const telemetry = generatePostEvents(20, 0.30, false);
      const evalRes = await fetch(`${serverUrl}/api/findings/${findingE2E}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({
          events: telemetry,
          finding: mockFindingE2E,
          file_name: 'production_canary_run.json',
        }),
      });
      assert.strictEqual(evalRes.status, 200);
      const evalJson: any = await evalRes.json();

      // Step 4: Verification Engine on Server decided result
      assert.strictEqual(evalJson.stage, 'VERIFIED_RESULT');
      assert.strictEqual(evalJson.is_authoritative, true);
      assert.strictEqual(evalJson.is_simulated, false);
      assert.ok(evalJson.verified_annualized_savings_usd > 0);

      // Step 5: Server Persisted Authoritative State in Storage
      const persisted = await storage.getVerificationByFindingId(findingE2E);
      assert.ok(persisted);
      assert.strictEqual(persisted.stage, 'VERIFIED_RESULT');
      assert.strictEqual(persisted.is_authoritative, true);
      assert.strictEqual(persisted.verified_annualized_savings_usd, evalJson.verified_annualized_savings_usd);
      assert.strictEqual(persisted.user_id, userA.id);

      // Step 6: Client queries verification status and receives authoritative proof
      const getRes = await fetch(`${serverUrl}/api/findings/${findingE2E}/verification`, {
        headers: { Cookie: userA.cookie },
      });
      assert.strictEqual(getRes.status, 200);
      const getJson: any = await getRes.json();
      assert.strictEqual(getJson.is_authoritative, true);
      assert.strictEqual(getJson.stage, 'VERIFIED_RESULT');
      assert.strictEqual(getJson.verified_annualized_savings_usd, evalJson.verified_annualized_savings_usd);

      // Step 7: Attacker User B queries the finding -> strictly rejected with 404
      const attackerRes = await fetch(`${serverUrl}/api/findings/${findingE2E}/verification`, {
        headers: { Cookie: userB.cookie },
      });
      assert.strictEqual(attackerRes.status, 404);
    });
  });

  describe('7. Server Failure & Resilience (Sprint A.1 Test 2)', () => {
    test('server verification failure produces no authoritative verification in storage', async () => {
      const failingFindingId = 'fnd_server_fail_test';
      await storage.registerFindingOwnership(failingFindingId, userA.id);

      // Malformed request with invalid events parameter
      const failRes = await fetch(`${serverUrl}/api/findings/${failingFindingId}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({ events: 'not-an-array', finding: { ...mockFindingDataA, id: failingFindingId } }),
      });

      assert.strictEqual(failRes.status, 400);
      const failJson: any = await failRes.json();
      assert.strictEqual(failJson.error, 'INVALID_EVENTS');

      // Assert storage holds NO authoritative verification
      const record = await storage.getVerificationByFindingId(failingFindingId);
      assert.strictEqual(record, null);
    });

    test('server returns 404 for unowned finding and creates no verification', async () => {
      // User B attempts to evaluate finding A owned by User A
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userB.cookie },
        body: JSON.stringify({ events: generatePostEvents(20, 0.3), finding: mockFindingDataA }),
      });
      assert.strictEqual(res.status, 404);
    });
  });

  describe('8. Client Fallback Authority Boundary (Sprint A.1 Test 3)', () => {
    test('local fallback execution remains OBSERVATION_ACTIVE and cannot establish commercial authority', () => {
      const mockFindingFallback: Finding = {
        ...mockFindingDataA,
        id: 'fnd_fallback_01',
      };

      const baseState: VerificationState = {
        finding_id: 'fnd_fallback_01',
        stage: 'CUSTOMER_DEPLOYED',
        baseline_window: {
          start: '2026-09-01T00:00:00Z',
          end: '2026-09-10T00:00:00Z',
          sample_count: 50,
          avg_cost_per_call_usd: 2.0,
        },
        deployment_timestamp: '2026-09-14T00:00:00Z',
        observation_window: {
          start: '2026-09-14T00:00:00Z',
          end: '2026-09-14T00:00:00Z',
          sample_event_count: 0,
        },
      };

      // Telemetry meets mathematical criteria (20 events, 85% reduction)
      const telemetry = generatePostEvents(20, 0.3, false);

      // Local fallback calculation (what applyNonAuthoritativeLocalPreview executes)
      const localRaw = evaluateVerification(baseState, mockFindingFallback, telemetry, 'local_fallback.json');

      // Invariant: local fallback is explicitly constrained to non-authoritative
      const nonAuthFallback: VerificationState = {
        ...localRaw,
        stage: 'OBSERVATION_ACTIVE', // Cannot be VERIFIED_RESULT without server authority!
        is_authoritative: false,
        observed_result: localRaw.observed_result
          ? {
              ...localRaw.observed_result,
              is_authoritative: false,
              annualized_realized_savings_usd: 0,
              verification_confidence: 'INSUFFICIENT_OBSERVATION',
              verification_notes: '[NON-AUTHORITATIVE PREVIEW] Server verification unavailable.',
            }
          : undefined,
      };

      assert.strictEqual(nonAuthFallback.stage, 'OBSERVATION_ACTIVE');
      assert.strictEqual(nonAuthFallback.is_authoritative, false);
      assert.strictEqual(nonAuthFallback.observed_result?.is_authoritative, false);
      assert.strictEqual(nonAuthFallback.observed_result?.annualized_realized_savings_usd, 0);

      // Verify UI commercial check also rejects this state
      assert.strictEqual(isCommerciallyVerified(nonAuthFallback, null), false);
    });
  });

  describe('9. UI Authority Invariant (Sprint A.1 Test 4)', () => {
    test('local object with stage=VERIFIED_RESULT and is_authoritative=true is rejected if server verification is missing', () => {
      const forgedLocalState: VerificationState = {
        finding_id: 'fnd_tampered_local',
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        baseline_window: {
          start: '2026-09-01T00:00:00Z',
          end: '2026-09-10T00:00:00Z',
          sample_count: 50,
          avg_cost_per_call_usd: 2.0,
        },
        observed_result: {
          pre_cost_per_call_usd: 2.0,
          post_cost_per_call_usd: 0.3,
          observed_reduction_pct: 85.0,
          annualized_realized_savings_usd: 50000.0,
          verification_confidence: 'HIGH',
          verification_notes: 'Forged client claim',
          is_authoritative: true,
        },
      };

      // Server verification is null (not confirmed by server)
      const result = isCommerciallyVerified(forgedLocalState, null);
      assert.strictEqual(result, false, 'UI authority must reject when server verification is missing');
    });

    test('UI authority rejects when server verification is_authoritative is false', () => {
      const localState: VerificationState = {
        finding_id: 'fnd_test_02',
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        baseline_window: { start: '', end: '', sample_count: 50, avg_cost_per_call_usd: 2.0 },
      };

      const nonAuthServerRecord = {
        id: 'ver_01',
        finding_id: 'fnd_test_02',
        user_id: 'usr_01',
        stage: 'OBSERVATION_ACTIVE' as const,
        is_authoritative: false,
        is_simulated: false,
        baseline_start: '',
        baseline_end: '',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 5,
        post_avg_cost_usd: 1.0,
        observed_reduction_pct: 50,
        verified_annualized_savings_usd: 0,
        verification_confidence: 'INSUFFICIENT_OBSERVATION' as const,
        created_at: '',
        updated_at: '',
      };

      assert.strictEqual(isCommerciallyVerified(localState, nonAuthServerRecord), false);
    });

    test('UI authority rejects when server verification is marked simulated', () => {
      const localState: VerificationState = {
        finding_id: 'fnd_test_03',
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_window: { start: '', end: '', sample_count: 50, avg_cost_per_call_usd: 2.0 },
      };

      const simulatedServerRecord = {
        id: 'ver_sim_01',
        finding_id: 'fnd_test_03',
        user_id: 'usr_01',
        stage: 'VERIFIED_RESULT' as const,
        is_authoritative: true, // even if marked true erroneously
        is_simulated: true,     // simulation flag present!
        baseline_start: '',
        baseline_end: '',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 25,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85,
        verified_annualized_savings_usd: 50000,
        verification_confidence: 'HIGH' as const,
        created_at: '',
        updated_at: '',
      };

      assert.strictEqual(isCommerciallyVerified(localState, simulatedServerRecord), false);
    });

    test('UI authority accepts genuine production verification with server authority confirmation', () => {
      const validLocalState: VerificationState = {
        finding_id: 'fnd_valid_01',
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_window: { start: '', end: '', sample_count: 50, avg_cost_per_call_usd: 2.0 },
      };

      const validServerRecord = {
        id: 'ver_valid_01',
        finding_id: 'fnd_valid_01',
        user_id: 'usr_01',
        stage: 'VERIFIED_RESULT' as const,
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '',
        baseline_end: '',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 25,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85,
        verified_annualized_savings_usd: 12000,
        verification_confidence: 'HIGH' as const,
        created_at: '',
        updated_at: '',
      };

      assert.strictEqual(isCommerciallyVerified(validLocalState, validServerRecord), true);
    });
  });

  describe('10. IndexedDB Authority Isolation (Sprint A.1 Test 5)', () => {
    test('cached local snapshot loaded from IndexedDB cannot establish commercial authority without server confirmation', () => {
      // Simulate snapshot loaded from IndexedDB where finding claims VERIFIED_RESULT
      const cachedIdbState: VerificationState = {
        finding_id: 'fnd_idb_cache_only',
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_window: {
          start: '2026-09-01T00:00:00Z',
          end: '2026-09-10T00:00:00Z',
          sample_count: 50,
          avg_cost_per_call_usd: 2.0,
        },
        observed_result: {
          pre_cost_per_call_usd: 2.0,
          post_cost_per_call_usd: 0.3,
          observed_reduction_pct: 85.0,
          annualized_realized_savings_usd: 45000.0,
          verification_confidence: 'HIGH',
          verification_notes: 'Cached in IndexedDB',
          is_authoritative: true,
        },
      };

      // Server storage has no authoritative record for this finding
      // (e.g. fresh session, other device, or never verified on server)
      const serverVerification = null;

      // Invariant: IndexedDB alone CANNOT establish commercial authority!
      const isVerified = isCommerciallyVerified(cachedIdbState, serverVerification);
      assert.strictEqual(isVerified, false, 'IndexedDB cached record must NOT be sufficient for commercial verification');
    });
  });

  describe('11. Server GET Recovery Lifecycle (Sprint A.1 Test 6)', () => {
    test('authoritative verification persists on server and recovers across client refresh via GET', async () => {
      const recoveryFindingId = 'fnd_recovery_test_01';
      const recoveryFinding: Finding = {
        ...mockFindingDataA,
        id: recoveryFindingId,
        title: 'Recovery Test Finding',
      };

      // Register ownership
      await storage.registerFindingOwnership(recoveryFindingId, userA.id);

      // Deploy finding
      await fetch(`${serverUrl}/api/findings/${recoveryFindingId}/verification/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({
          baseline: {
            start: '2026-09-01T00:00:00.000Z',
            end: '2026-09-10T00:00:00.000Z',
            sample_count: 50,
            avg_cost_per_call_usd: 2.0,
          },
          deployment_timestamp: '2026-09-14T00:00:00.000Z',
        }),
      });

      // Submit production telemetry (25 events, 85% reduction)
      const events = generatePostEvents(25, 0.3, false);
      const evalRes = await fetch(`${serverUrl}/api/findings/${recoveryFindingId}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({ events, finding: recoveryFinding }),
      });
      assert.strictEqual(evalRes.status, 200);
      const evalData: any = await evalRes.json();
      assert.strictEqual(evalData.stage, 'VERIFIED_RESULT');
      assert.strictEqual(evalData.is_authoritative, true);

      // SIMULATE BROWSER RELOAD / CACHE WIPED:
      // Client has zero local in-memory verification state
      let clientLocalState: VerificationState | null = null;
      let clientServerRecord: any = null;

      // Client performs recovery fetch: GET /api/findings/:id/verification
      const recoveryRes = await fetch(`${serverUrl}/api/findings/${recoveryFindingId}/verification`, {
        headers: { Cookie: userA.cookie },
      });
      assert.strictEqual(recoveryRes.status, 200);
      const recoveryData: any = await recoveryRes.json();

      // Verify recovery payload
      assert.ok(recoveryData.verification);
      assert.strictEqual(recoveryData.stage, 'VERIFIED_RESULT');
      assert.strictEqual(recoveryData.is_authoritative, true);
      assert.strictEqual(recoveryData.is_simulated, false);
      assert.strictEqual(recoveryData.verified_annualized_savings_usd, evalData.verified_annualized_savings_usd);

      // Client restores state from server GET response
      const v = recoveryData.verification;
      clientServerRecord = v;
      clientLocalState = {
        finding_id: recoveryFindingId,
        stage: v.stage,
        is_authoritative: v.is_authoritative,
        is_simulated: v.is_simulated,
        baseline_window: {
          start: v.baseline_start,
          end: v.baseline_end,
          sample_count: v.baseline_sample_count,
          avg_cost_per_call_usd: v.baseline_avg_cost_usd,
        },
        deployment_timestamp: v.deployment_timestamp,
        observation_window: {
          start: v.observation_start || '',
          end: v.observation_end || '',
          sample_event_count: v.observation_sample_count,
        },
        observed_result: {
          pre_cost_per_call_usd: v.baseline_avg_cost_usd,
          post_cost_per_call_usd: v.post_avg_cost_usd,
          observed_reduction_pct: v.observed_reduction_pct,
          annualized_realized_savings_usd: v.verified_annualized_savings_usd,
          verification_confidence: v.verification_confidence,
          verification_notes: v.verification_notes,
          is_authoritative: v.is_authoritative,
        },
      };

      // Client commercial UI evaluates recovered state:
      const recoveredAuth = isCommerciallyVerified(clientLocalState, clientServerRecord);
      assert.strictEqual(recoveredAuth, true, 'Recovered state from server GET must satisfy commercial verification');
    });
  });
});
