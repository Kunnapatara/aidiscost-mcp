/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { ServerStorage } from '../server/storage';
import { authenticate } from '../server/auth';
import { createMcpRouter, resetRateLimitsForTesting } from '../server/mcp/router';
import { createApiRouter } from '../server/api';
import { generateSampleDataset } from '../engine/adapters/sample-data';
import { PersistedFindingRecord } from '../server/types';

describe('AIDisCost MCP — Group C.1: Real Session Auth & HTTP E2E Test Suite', () => {
  let server: http.Server;
  let serverUrl: string;
  let mcpUrl: string;
  let storage: ServerStorage;

  // Separate session cookies for User A and User B (strict cookie jar isolation)
  let cookieUserA: string;
  let cookieUserB: string;
  let userAId: string;
  let userBId: string;

  const emailUserA = 'user-a-real-session@corp.test';
  const emailUserB = 'user-b-real-session@corp.test';
  const password = 'StrongPassword123!';

  // Standard MCP JSON-RPC Helper
  async function callMcpHttp(
    cookie: string | null,
    toolName: string,
    args: Record<string, any>,
    rpcId: number = 1
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (cookie) {
      headers['Cookie'] = cookie;
    }

    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    });

    const body = (await res.json()) as any;
    return { status: res.status, body };
  }

  // Sample telemetry producing valid Model Right-Sizing findings
  const sampleDataset = generateSampleDataset();
  const rightSizingEvents = sampleDataset.events
    .filter((e) => e.source_event_id.startsWith('sample_rs_'))
    .slice(0, 30)
    .map((e) => ({
      ...e,
      is_simulated: false,
    }));
  const validTelemetryJson = JSON.stringify(rightSizingEvents);

  before(async () => {
    storage = ServerStorage.getInstance('data', 'test-real-session-e2e.json');
    storage.setTestMode(true);
    storage.clearAll();

    const app = express();

    // Exactly replicate server.ts mounting architecture
    app.use(
      '/mcp',
      express.json({
        limit: '2mb',
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      }),
      cookieParser(),
      authenticate,
      createMcpRouter(storage)
    );

    app.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      })
    );
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser());
    app.use(authenticate);
    app.use('/api', createApiRouter());

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        mcpUrl = `${serverUrl}/mcp`;
        resolve();
      });
    });

    // 1. Register User A via real /api/auth/register endpoint
    const regResA = await fetch(`${serverUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailUserA, password }),
    });
    assert.strictEqual(regResA.status, 201, 'User A registration must succeed');
    const cookieHeaderA = regResA.headers.get('set-cookie');
    assert.ok(cookieHeaderA, 'User A Set-Cookie header must be present');
    cookieUserA = cookieHeaderA.split(';')[0];
    const dataA = (await regResA.json()) as any;
    userAId = dataA.user.id;

    // 2. Register User B via real /api/auth/register endpoint
    const regResB = await fetch(`${serverUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailUserB, password }),
    });
    assert.strictEqual(regResB.status, 201, 'User B registration must succeed');
    const cookieHeaderB = regResB.headers.get('set-cookie');
    assert.ok(cookieHeaderB, 'User B Set-Cookie header must be present');
    cookieUserB = cookieHeaderB.split(';')[0];
    const dataB = (await regResB.json()) as any;
    userBId = dataB.user.id;

    assert.notStrictEqual(cookieUserA, cookieUserB, 'User A and User B must have distinct session cookies');
    assert.notStrictEqual(userAId, userBId, 'User A and User B must have distinct user IDs');
  });

  after(async () => {
    storage.clearAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    resetRateLimitsForTesting();
  });

  // =========================================================================
  // SECTION 3: Real Session Authentication & Multi-Tenant Isolation
  // =========================================================================
  describe('Section 3: Real Session Authentication — User A and User B Isolation', () => {
    let auditIdUserA: string;
    let findingIdUserA: string;

    let auditIdUserB: string;
    let findingIdUserB: string;

    before(async () => {
      // User A runs an audit via /mcp HTTP
      const auditResA = await callMcpHttp(cookieUserA, 'run_cost_audit', {
        telemetry_data: validTelemetryJson,
        source_hint: 'custom_logs',
      });
      assert.strictEqual(auditResA.status, 200);
      const parsedAuditA = JSON.parse(auditResA.body.result.content[0].text);
      auditIdUserA = parsedAuditA.audit_id;
      findingIdUserA = parsedAuditA.findings[0].id;

      // User B runs an audit via /mcp HTTP
      const auditResB = await callMcpHttp(cookieUserB, 'run_cost_audit', {
        telemetry_data: validTelemetryJson,
        source_hint: 'custom_logs',
      });
      assert.strictEqual(auditResB.status, 200);
      const parsedAuditB = JSON.parse(auditResB.body.result.content[0].text);
      auditIdUserB = parsedAuditB.audit_id;
      findingIdUserB = parsedAuditB.findings[0].id;
    });

    test('1. User A can access their own Audit and Finding', async () => {
      const res = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: findingIdUserA,
        audit_id: auditIdUserA,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result?.isError, undefined);
      const data = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(data.finding_id, findingIdUserA);
      assert.strictEqual(data.audit_id, auditIdUserA);
    });

    test('2. User B can access their own Audit and Finding', async () => {
      const res = await callMcpHttp(cookieUserB, 'get_finding_details', {
        finding_id: findingIdUserB,
        audit_id: auditIdUserB,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result?.isError, undefined);
      const data = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(data.finding_id, findingIdUserB);
      assert.strictEqual(data.audit_id, auditIdUserB);
    });

    test('3. User B cannot retrieve User A Finding (fails closed with FINDING_NOT_FOUND)', async () => {
      const res = await callMcpHttp(cookieUserB, 'get_finding_details', {
        finding_id: findingIdUserA,
        audit_id: auditIdUserA,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result?.isError, true);
      const data = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(data.error, 'FINDING_NOT_FOUND');
      assert.ok(!JSON.stringify(res.body).includes(emailUserA), 'Must not leak User A email');
      assert.ok(!JSON.stringify(res.body).includes(userAId), 'Must not leak User A ID');
    });

    test('4. User B cannot register ownership of User A Finding', async () => {
      const regRes = await fetch(`${serverUrl}/api/findings/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookieUserB,
        },
        body: JSON.stringify({
          finding_ids: [findingIdUserA],
          audit_id: auditIdUserA,
        }),
      });
      // Audit belongs to User A -> 404 NOT_FOUND
      assert.strictEqual(regRes.status, 404);
      const json: any = await regRes.json();
      assert.strictEqual(json.error, 'NOT_FOUND');

      // Verify stored owner remains User A
      const owner = await storage.getFindingOwner(findingIdUserA, auditIdUserA);
      assert.strictEqual(owner, userAId, 'Stored owner must remain User A');
    });

    test('5. User B cannot execute Verification on User A Finding', async () => {
      // 5a. Via REST API
      const deployRes = await fetch(`${serverUrl}/api/findings/${findingIdUserA}/verification/deploy?audit_id=${auditIdUserA}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookieUserB,
        },
        body: JSON.stringify({
          baseline: {
            start: '2026-09-01T00:00:00Z',
            end: '2026-09-10T00:00:00Z',
            sample_count: 50,
            avg_cost_per_call_usd: 2.0,
          },
        }),
      });
      assert.strictEqual(deployRes.status, 404, 'Cross-user deploy must return 404');

      // 5b. Via MCP HTTP
      const verifyRes = await callMcpHttp(cookieUserB, 'evaluate_verification', {
        finding_id: findingIdUserA,
        audit_id: auditIdUserA,
        telemetry_data: validTelemetryJson,
      });
      assert.strictEqual(verifyRes.status, 200);
      assert.strictEqual(verifyRes.body.result?.isError, true);
      const verifyData = JSON.parse(verifyRes.body.result.content[0].text);
      assert.strictEqual(verifyData.error, 'FINDING_NOT_FOUND');
    });

    test('6. User B cannot use a fabricated Audit ID to claim a Finding', async () => {
      const fakeAuditId = 'aud_fabricated_nonexistent_999';
      const regRes = await fetch(`${serverUrl}/api/findings/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookieUserB,
        },
        body: JSON.stringify({
          finding_ids: [findingIdUserA],
          audit_id: fakeAuditId,
        }),
      });
      assert.strictEqual(regRes.status, 404);
      const json: any = await regRes.json();
      assert.strictEqual(json.error, 'NOT_FOUND');
    });

    test('7. User B cannot use an existing Finding ID with a nonexistent Audit ID', async () => {
      const nonexistentAuditId = 'aud_does_not_exist_at_all';
      const res = await callMcpHttp(cookieUserB, 'check_entitlement', {
        finding_id: findingIdUserB,
        audit_id: nonexistentAuditId,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result?.isError, true);
      const data = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(data.error, 'FINDING_NOT_FOUND');
    });

    test('8. User B cannot use User A Audit ID with another Finding ID', async () => {
      const res = await callMcpHttp(cookieUserB, 'check_entitlement', {
        finding_id: findingIdUserB,
        audit_id: auditIdUserA,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result?.isError, true);
      const data = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(data.error, 'FINDING_NOT_FOUND');
    });

    test('9. Logout invalidates the real session and clears cookie', async () => {
      // Create a temporary user session to test logout
      const tempEmail = 'temp-logout-test@corp.test';
      const regTemp = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: tempEmail, password }),
      });
      assert.strictEqual(regTemp.status, 201);
      const tempCookie = regTemp.headers.get('set-cookie')!.split(';')[0];

      // Verify authenticated
      const meBefore = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Cookie: tempCookie },
      });
      const meBeforeData: any = await meBefore.json();
      assert.strictEqual(meBeforeData.authenticated, true);

      // Perform logout
      const logoutRes = await fetch(`${serverUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: tempCookie },
      });
      assert.strictEqual(logoutRes.status, 200);

      // Verify session token is invalidated on server
      const meAfter = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Cookie: tempCookie },
      });
      const meAfterData: any = await meAfter.json();
      assert.strictEqual(meAfterData.authenticated, false);

      // Attempt protected MCP call with logged-out cookie
      const mcpRes = await callMcpHttp(tempCookie, 'check_entitlement', {
        finding_id: 'any_finding',
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result?.isError, true);
      const mcpData = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(mcpData.error, 'UNAUTHORIZED');
    });

    test('10. Expired sessions cannot access protected MCP operations', async () => {
      const expiredRawToken = crypto.randomBytes(32).toString('hex');
      const expiredCookie = `aidiscost_session=${expiredRawToken}`;

      // Insert expired session directly into storage
      await storage.createSession({
        token: expiredRawToken,
        user_id: userAId,
        expires_at: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
        created_at: new Date(Date.now() - 7200_000).toISOString(),
      });

      // Calling MCP tool with expired session must yield UNAUTHORIZED
      const res = await callMcpHttp(expiredCookie, 'get_finding_details', {
        finding_id: findingIdUserA,
        audit_id: auditIdUserA,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result?.isError, true);
      const data = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(data.error, 'UNAUTHORIZED');
    });
  });

  // =========================================================================
  // SECTION 4: Real MCP HTTP End-to-End Workflow
  // =========================================================================
  describe('Section 4: Real MCP HTTP End-to-End Workflow Pipeline', () => {
    let lifecycleAuditId: string;
    let lifecycleFindingId: string;

    test('Step 1: Authenticate User A and execute run_cost_audit through POST /mcp', async () => {
      const res = await callMcpHttp(cookieUserA, 'run_cost_audit', {
        telemetry_data: validTelemetryJson,
        source_hint: 'custom_logs',
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.jsonrpc, '2.0');
      assert.strictEqual(res.body.result?.isError, undefined);

      const payload = JSON.parse(res.body.result.content[0].text);
      assert.ok(payload.audit_id, 'Audit ID must be generated');
      assert.ok(payload.findings.length > 0, 'Audit must produce findings');
      assert.strictEqual(payload.persistence.status, 'SUCCESS');
      assert.strictEqual(payload.persistence.audit_saved, true);
      assert.strictEqual(payload.ownership.requesting_user_id, userAId);
      assert.strictEqual(payload.ownership.ownership_confirmed, true);

      lifecycleAuditId = payload.audit_id;
      lifecycleFindingId = payload.findings[0].id;
    });

    test('Step 2: Retrieve finding details using get_finding_details through POST /mcp (locked)', async () => {
      const res = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: lifecycleFindingId,
        audit_id: lifecycleAuditId,
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result?.isError, undefined);

      const payload = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(payload.finding_id, lifecycleFindingId);
      assert.strictEqual(payload.audit_id, lifecycleAuditId);
      assert.strictEqual(payload.entitlement.unlocked, false);
      assert.strictEqual(payload.entitlement.status, 'LOCKED');
      assert.strictEqual(payload.entitlement.price_usd, 49.0);
    });

    test('Step 3: Check entitlement status using check_entitlement through POST /mcp (locked)', async () => {
      const res = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: lifecycleFindingId,
        audit_id: lifecycleAuditId,
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result?.isError, undefined);

      const payload = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(payload.finding_id, lifecycleFindingId);
      assert.strictEqual(payload.is_owner, true);
      assert.strictEqual(payload.fix_package.unlocked, false);
      assert.strictEqual(payload.fix_package.price_usd, 49.0);
    });

    test('Step 4 & 5: Simulated Entitlement fixture unlocks fix package and verifies authorization (Section 5 distinction)', async () => {
      // Section 5 Requirement: Clearly distinguish between simulated Entitlement and real payment evidence.
      // This is a test fixture granting entitlement status to verify authorization logic; NO real payment occurred.
      const simulatedFixtureId = 'ent_simulated_test_fixture_01';
      await storage.createEntitlement({
        id: simulatedFixtureId,
        user_id: userAId,
        audit_id: lifecycleAuditId,
        finding_id: lifecycleFindingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'sim_test_fixture_tx_nodata', // Explicit test fixture identifier
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Verify entitlement status is now unlocked via check_entitlement
      const checkRes = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: lifecycleFindingId,
        audit_id: lifecycleAuditId,
      });
      const checkPayload = JSON.parse(checkRes.body.result.content[0].text);
      assert.strictEqual(checkPayload.fix_package.unlocked, true);
      assert.strictEqual(checkPayload.fix_package.entitlement_id, simulatedFixtureId);

      // Verify fix package code is unlocked via get_finding_details
      const detailsRes = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: lifecycleFindingId,
        audit_id: lifecycleAuditId,
      });
      const detailsPayload = JSON.parse(detailsRes.body.result.content[0].text);
      assert.strictEqual(detailsPayload.entitlement.unlocked, true);
      assert.strictEqual(detailsPayload.entitlement.status, 'PAID_ACTIVE');
      assert.ok(detailsPayload.fix_package);
    });

    test('Step 6: Exercise Verification workflow using evaluate_verification through POST /mcp', async () => {
      // Generate post-deployment telemetry events
      const postEvents = Array.from({ length: 25 }, (_, i) => ({
        id: `post_evt_mcp_${i}`,
        source: 'custom_logs',
        source_event_id: `post_src_${i}`,
        timestamp: new Date(Date.now() - (25 - i) * 60000).toISOString(),
        provider: 'openai',
        model: 'gpt-4o-mini',
        operation: 'chat',
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        cost_usd: 0.0001,
        latency_ms: 150,
        status: 'SUCCESS',
        is_simulated: false,
      }));

      const res = await callMcpHttp(cookieUserA, 'evaluate_verification', {
        finding_id: lifecycleFindingId,
        audit_id: lifecycleAuditId,
        telemetry_data: JSON.stringify(postEvents),
        source_hint: 'custom_logs',
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result?.isError, undefined);

      const payload = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(payload.finding_id, lifecycleFindingId);
      assert.strictEqual(payload.audit_id, lifecycleAuditId);
      assert.ok(payload.verification_stage);
      assert.strictEqual(typeof payload.is_authoritative, 'boolean');
    });

    test('Step 7 & 8: User B is denied cross-account access to User A finding through POST /mcp', async () => {
      // 1. get_finding_details denied
      const detailsDenied = await callMcpHttp(cookieUserB, 'get_finding_details', {
        finding_id: lifecycleFindingId,
        audit_id: lifecycleAuditId,
      });
      assert.strictEqual(detailsDenied.status, 200);
      assert.strictEqual(detailsDenied.body.result?.isError, true);
      const detailsData = JSON.parse(detailsDenied.body.result.content[0].text);
      assert.strictEqual(detailsData.error, 'FINDING_NOT_FOUND');

      // 2. check_entitlement denied
      const entDenied = await callMcpHttp(cookieUserB, 'check_entitlement', {
        finding_id: lifecycleFindingId,
        audit_id: lifecycleAuditId,
      });
      assert.strictEqual(entDenied.status, 200);
      assert.strictEqual(entDenied.body.result?.isError, true);
      const entData = JSON.parse(entDenied.body.result.content[0].text);
      assert.strictEqual(entData.error, 'FINDING_NOT_FOUND');

      // 3. evaluate_verification denied
      const verifyDenied = await callMcpHttp(cookieUserB, 'evaluate_verification', {
        finding_id: lifecycleFindingId,
        audit_id: lifecycleAuditId,
        telemetry_data: validTelemetryJson,
      });
      assert.strictEqual(verifyDenied.status, 200);
      assert.strictEqual(verifyDenied.body.result?.isError, true);
      const verifyData = JSON.parse(verifyDenied.body.result.content[0].text);
      assert.strictEqual(verifyData.error, 'FINDING_NOT_FOUND');
    });

    test('Missing Ownership record edge case (Section 2.3): Persisted finding with parent audit repairs safely', async () => {
      // Setup finding in User A's audit, but deliberately omit findingOwnerships row
      const auditId = 'aud_repair_test_01';
      const findingId = 'fnd_repair_test_01';

      await storage.saveAudit({
        audit_id: auditId,
        user_id: userAId,
        source: 'langfuse',
        total_spend_usd: 500.0,
        potential_savings_usd: 100.0,
        annualized_savings_projection_usd: 1200.0,
        is_sample_data: false,
        findings_count: 1,
        created_at: new Date().toISOString(),
      });

      const findingRecord: PersistedFindingRecord = {
        audit_id: auditId,
        finding_id: findingId,
        user_id: userAId,
        rule_id: 'MODEL_RIGHT_SIZING',
        title: 'Repair Test Finding',
        summary: 'Repair Test Summary',
        baseline_spend_usd: 500.0,
        estimated_savings_usd: 100.0,
        annualized_projection_usd: 1200.0,
        eligible_event_count: 30,
        status: 'DETECTED',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      };
      await storage.saveFinding(findingRecord);

      // Verify no ownership row exists initially
      delete (storage as any).data.findingOwnerships[findingId];
      const initialOwnershipKey = `${userAId}:${auditId}:${findingId}`;
      delete (storage as any).data.findingOwnerships[initialOwnershipKey];

      // 1. User B attempts to access it -> MUST FAIL (cannot claim another user's unindexed finding)
      const resB = await callMcpHttp(cookieUserB, 'get_finding_details', {
        finding_id: findingId,
        audit_id: auditId,
      });
      assert.strictEqual(resB.body.result?.isError, true);
      const dataB = JSON.parse(resB.body.result.content[0].text);
      assert.strictEqual(dataB.error, 'FINDING_NOT_FOUND');

      // 2. User A accesses it -> Authoritative repair path verifies audit ownership and resolves
      const resA = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: findingId,
        audit_id: auditId,
      });
      assert.strictEqual(resA.body.result?.isError, undefined);
      const dataA = JSON.parse(resA.body.result.content[0].text);
      assert.strictEqual(dataA.finding_id, findingId);
      assert.strictEqual(dataA.title, 'Repair Test Finding');

      // Verify ownership was safely persisted to User A
      const verifiedOwner = await storage.getFindingOwner(findingId, auditId);
      assert.strictEqual(verifiedOwner, userAId);
    });

    test('Protocol & Edge Case Errors: Non-POST 405, missing session, malformed JSON-RPC', async () => {
      // 1. Non-POST method returns 405
      const getRes = await fetch(mcpUrl, { method: 'GET' });
      assert.strictEqual(getRes.status, 405);
      const getJson: any = await getRes.json();
      assert.strictEqual(getJson.error, 'METHOD_NOT_ALLOWED');

      // 2. Missing session cookie returns UNAUTHORIZED in tool response
      const anonRes = await callMcpHttp(null, 'get_finding_details', {
        finding_id: lifecycleFindingId,
      });
      assert.strictEqual(anonRes.body.result?.isError, true);
      const anonData = JSON.parse(anonRes.body.result.content[0].text);
      assert.strictEqual(anonData.error, 'UNAUTHORIZED');

      // 3. Invalid Audit ID returns FINDING_NOT_FOUND
      const badAuditRes = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: lifecycleFindingId,
        audit_id: 'aud_invalid_random_9999',
      });
      assert.strictEqual(badAuditRes.body.result?.isError, true);
      const badAuditData = JSON.parse(badAuditRes.body.result.content[0].text);
      assert.strictEqual(badAuditData.error, 'FINDING_NOT_FOUND');

      // 4. Invalid Finding ID returns FINDING_NOT_FOUND
      const badFindingRes = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: 'fnd_nonexistent_xyz',
        audit_id: lifecycleAuditId,
      });
      assert.strictEqual(badFindingRes.body.result?.isError, true);
      const badFindingData = JSON.parse(badFindingRes.body.result.content[0].text);
      assert.strictEqual(badFindingData.error, 'FINDING_NOT_FOUND');
    });
  });
});
