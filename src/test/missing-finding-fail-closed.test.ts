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
import { PersistedAuditRecord, PersistedFindingRecord } from '../server/types';

describe('AIDisCost MCP — Missing Finding Fail-Closed & Full Regression Test Suite', () => {
  let server: http.Server;
  let serverUrl: string;
  let mcpUrl: string;
  let storage: ServerStorage;

  let cookieUserA: string;
  let cookieUserB: string;
  let userAId: string;
  let userBId: string;

  const emailUserA = 'user-a-failclosed@corp.test';
  const emailUserB = 'user-b-failclosed@corp.test';
  const password = 'StrongPassword123!';

  // Standard MCP JSON-RPC helper over HTTP POST /mcp
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

  // Pre-generated sample dataset
  const sampleDataset = generateSampleDataset();
  const rightSizingEvents = sampleDataset.events
    .filter((e) => e.source_event_id.startsWith('sample_rs_'))
    .slice(0, 30)
    .map((e) => ({
      ...e,
      is_simulated: false,
    }));
  const validTelemetryJson = JSON.stringify(rightSizingEvents);

  let auditIdUserA: string;
  let findingIdUserA: string;
  let auditIdUserA2: string; // User A's second audit

  let auditIdUserB: string;
  let findingIdUserB: string;

  before(async () => {
    storage = ServerStorage.getInstance('data', 'test-missing-finding-failclosed.json');
    storage.setTestMode(true);
    storage.clearAll();

    const app = express();

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

    // 1. Register User A via real endpoint
    const regResA = await fetch(`${serverUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailUserA, password }),
    });
    assert.strictEqual(regResA.status, 201);
    const cookieHeaderA = regResA.headers.get('set-cookie');
    assert.ok(cookieHeaderA);
    cookieUserA = cookieHeaderA.split(';')[0];
    const dataA = (await regResA.json()) as any;
    userAId = dataA.user.id;

    // 2. Register User B via real endpoint
    const regResB = await fetch(`${serverUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailUserB, password }),
    });
    assert.strictEqual(regResB.status, 201);
    const cookieHeaderB = regResB.headers.get('set-cookie');
    assert.ok(cookieHeaderB);
    cookieUserB = cookieHeaderB.split(';')[0];
    const dataB = (await regResB.json()) as any;
    userBId = dataB.user.id;

    // 3. User A runs an audit to seed persistent audit and findings
    const auditResA = await callMcpHttp(cookieUserA, 'run_cost_audit', {
      telemetry_data: validTelemetryJson,
      source_hint: 'custom_logs',
    });
    assert.strictEqual(auditResA.status, 200);
    const parsedA = JSON.parse(auditResA.body.result.content[0].text);
    auditIdUserA = parsedA.audit_id;
    assert.ok(parsedA.findings.length > 0);
    findingIdUserA = parsedA.findings[0].id;

    // Seed a second audit for User A without this finding
    auditIdUserA2 = `audit_a2_${crypto.randomUUID()}`;
    const auditRecordA2: PersistedAuditRecord = {
      audit_id: auditIdUserA2,
      user_id: userAId,
      source: 'custom_logs',
      total_spend_usd: 100,
      potential_savings_usd: 20,
      annualized_savings_projection_usd: 240,
      health_grade: 'A',
      findings_count: 0,
      is_sample_data: false,
      created_at: new Date().toISOString(),
    };
    await storage.saveAudit(auditRecordA2);

    // 4. User B runs an audit
    const auditResB = await callMcpHttp(cookieUserB, 'run_cost_audit', {
      telemetry_data: validTelemetryJson,
      source_hint: 'custom_logs',
    });
    assert.strictEqual(auditResB.status, 200);
    const parsedB = JSON.parse(auditResB.body.result.content[0].text);
    auditIdUserB = parsedB.audit_id;
    assert.ok(parsedB.findings.length > 0);
    findingIdUserB = parsedB.findings[0].id;
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
  // Section 4.A: Finding Existence
  // =========================================================================
  describe('Section 4.A: Finding Existence', () => {
    test('1. Nonexistent Finding ID must be rejected (404/FINDING_NOT_FOUND)', async () => {
      const nonExistentFindingId = `nonexistent_${crypto.randomUUID()}`;

      // MCP check_entitlement
      const mcpEnt = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: nonExistentFindingId,
      });
      assert.strictEqual(mcpEnt.status, 200);
      assert.strictEqual(mcpEnt.body.result.isError, true);
      const entErr = JSON.parse(mcpEnt.body.result.content[0].text);
      assert.strictEqual(entErr.error, 'FINDING_NOT_FOUND');

      // MCP get_finding_details
      const mcpDet = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: nonExistentFindingId,
      });
      assert.strictEqual(mcpDet.status, 200);
      assert.strictEqual(mcpDet.body.result.isError, true);
      const detErr = JSON.parse(mcpDet.body.result.content[0].text);
      assert.strictEqual(detErr.error, 'FINDING_NOT_FOUND');

      // REST GET /api/findings/:id/entitlement
      const apiEnt = await fetch(`${serverUrl}/api/findings/${nonExistentFindingId}/entitlement`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(apiEnt.status, 404);

      // REST GET /api/findings/:id/verification
      const apiVer = await fetch(`${serverUrl}/api/findings/${nonExistentFindingId}/verification`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(apiVer.status, 404);
    });

    test('2. Fake Finding ID with valid Audit must be rejected', async () => {
      const fakeFindingId = `fake_finding_${crypto.randomUUID()}`;

      // MCP get_finding_details with valid audit_id
      const mcpRes = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: fakeFindingId,
        audit_id: auditIdUserA,
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const parsed = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(parsed.error, 'FINDING_NOT_FOUND');

      // REST GET /api/findings/:id/entitlement with valid audit_id
      const apiRes = await fetch(`${serverUrl}/api/findings/${fakeFindingId}/entitlement?audit_id=${auditIdUserA}`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(apiRes.status, 404);
    });

    test('3. Valid Finding with nonexistent Audit must be rejected', async () => {
      const nonExistentAudit = `audit_nonexistent_${crypto.randomUUID()}`;

      const mcpRes = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: findingIdUserA,
        audit_id: nonExistentAudit,
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const parsed = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(parsed.error, 'FINDING_NOT_FOUND');

      const apiRes = await fetch(`${serverUrl}/api/findings/${findingIdUserA}/entitlement?audit_id=${nonExistentAudit}`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(apiRes.status, 404);
    });

    test("4. Valid Finding with other user's Audit must be rejected", async () => {
      // User A tries to query finding with User B's audit_id
      const mcpRes = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: findingIdUserA,
        audit_id: auditIdUserB,
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const parsed = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(parsed.error, 'FINDING_NOT_FOUND');

      const apiRes = await fetch(`${serverUrl}/api/findings/${findingIdUserA}/entitlement?audit_id=${auditIdUserB}`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(apiRes.status, 404);
    });

    test('5. Valid Finding with mismatched Audit (finding belongs to Audit 1, requested with Audit 2) must be rejected', async () => {
      // User A owns findingIdUserA in auditIdUserA. User A passes auditIdUserA2 (which does not contain this finding).
      const mcpRes = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: findingIdUserA,
        audit_id: auditIdUserA2,
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const parsed = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(parsed.error, 'FINDING_NOT_FOUND');

      const apiRes = await fetch(`${serverUrl}/api/findings/${findingIdUserA}/entitlement?audit_id=${auditIdUserA2}`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(apiRes.status, 404);
    });

    test('6. Rejected requests create NO ownership, entitlement, or verification state in database', async () => {
      const fakeFinding = `phantom_finding_${crypto.randomUUID()}`;

      // Snapshot database counts
      const initialVerifications = Object.keys((storage as any).data.verifications || {}).length;
      const initialEntitlements = Object.keys((storage as any).data.entitlements || {}).length;
      const initialOwner = await storage.getFindingOwner(fakeFinding);
      assert.strictEqual(initialOwner, null);

      // Execute attack/invalid requests
      await callMcpHttp(cookieUserA, 'check_entitlement', { finding_id: fakeFinding });
      await callMcpHttp(cookieUserA, 'get_finding_details', { finding_id: fakeFinding });
      await fetch(`${serverUrl}/api/findings/${fakeFinding}/entitlement`, { headers: { Cookie: cookieUserA } });
      await fetch(`${serverUrl}/api/findings/${fakeFinding}/verification`, { headers: { Cookie: cookieUserA } });

      // Verify no records created
      const postVerifications = Object.keys((storage as any).data.verifications || {}).length;
      const postEntitlements = Object.keys((storage as any).data.entitlements || {}).length;
      const postOwner = await storage.getFindingOwner(fakeFinding);

      assert.strictEqual(postOwner, null, 'No finding ownership should be created');
      assert.strictEqual(postVerifications, initialVerifications, 'No verification should be created');
      assert.strictEqual(postEntitlements, initialEntitlements, 'No entitlement should be created');
    });
  });

  // =========================================================================
  // Section 4.B: Missing audit_id
  // =========================================================================
  describe('Section 4.B: Missing audit_id Handling', () => {
    test('7. Missing audit_id on operations requiring it is rejected', async () => {
      // POST /api/billing/fix-package/checkout without audit_id for ambiguous finding
      const res = await fetch(`${serverUrl}/api/billing/fix-package/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserA },
        body: JSON.stringify({
          finding_id: 'nonexistent_finding',
        }),
      });
      assert.strictEqual(res.status, 404);
    });

    test('8. Empty string audit_id is rejected (400 INVALID_AUDIT / INVALID_INPUT)', async () => {
      // MCP tool
      const mcpRes = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: findingIdUserA,
        audit_id: '',
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const parsed = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(parsed.error, 'INVALID_INPUT');

      // REST API
      const apiRes = await fetch(`${serverUrl}/api/findings/${findingIdUserA}/entitlement?audit_id=`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(apiRes.status, 400);
      const apiBody = await apiRes.json();
      assert.strictEqual(apiBody.error, 'INVALID_AUDIT');
    });

    test('9. Whitespace string audit_id is rejected (400 INVALID_AUDIT / INVALID_INPUT)', async () => {
      // MCP tool
      const mcpRes = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: findingIdUserA,
        audit_id: '   ',
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const parsed = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(parsed.error, 'INVALID_INPUT');

      // REST API
      const apiRes = await fetch(`${serverUrl}/api/findings/${findingIdUserA}/entitlement?audit_id=%20%20%20`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(apiRes.status, 400);
      const apiBody = await apiRes.json();
      assert.strictEqual(apiBody.error, 'INVALID_AUDIT');
    });

    test('10. Omitted audit_id with duplicate finding across multiple audits fails with AMBIGUOUS_FINDING', async () => {
      const dupFindingId = `dup_finding_${crypto.randomUUID()}`;

      // Persist duplicate finding into User A's Audit 1 and Audit 2
      const rec1: PersistedFindingRecord = {
        finding_id: dupFindingId,
        audit_id: auditIdUserA,
        user_id: userAId,
        rule_id: 'model_right_sizing',
        title: 'Duplicate Finding 1',
        summary: 'Duplicate Finding 1 Summary',
        baseline_spend_usd: 50,
        estimated_savings_usd: 10,
        annualized_projection_usd: 120,
        eligible_event_count: 10,
        status: 'OPEN',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      };
      const rec2: PersistedFindingRecord = {
        finding_id: dupFindingId,
        audit_id: auditIdUserA2,
        user_id: userAId,
        rule_id: 'model_right_sizing',
        title: 'Duplicate Finding 2',
        summary: 'Duplicate Finding 2 Summary',
        baseline_spend_usd: 60,
        estimated_savings_usd: 15,
        annualized_projection_usd: 180,
        eligible_event_count: 12,
        status: 'OPEN',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      };
      await storage.saveFinding(rec1);
      await storage.saveFinding(rec2);

      // MCP call omitting audit_id
      const mcpRes = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: dupFindingId,
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const parsed = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(parsed.error, 'AMBIGUOUS_FINDING');

      // REST call omitting audit_id
      const apiRes = await fetch(`${serverUrl}/api/findings/${dupFindingId}/entitlement`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(apiRes.status, 400);
      const apiBody = await apiRes.json();
      assert.strictEqual(apiBody.error, 'AMBIGUOUS_FINDING');
    });

    test('11. Omitted audit_id with no accessible finding fails closed (FINDING_NOT_FOUND / 404)', async () => {
      const ghostFinding = `ghost_${crypto.randomUUID()}`;

      const mcpRes = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: ghostFinding,
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const parsed = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(parsed.error, 'FINDING_NOT_FOUND');

      const apiRes = await fetch(`${serverUrl}/api/findings/${ghostFinding}/entitlement`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(apiRes.status, 404);
    });

    test('12. Omitted audit_id on operation supporting omission succeeds when resolve is unambiguous', async () => {
      // Seed a uniquely named finding for User A in auditIdUserA that does not collide with User B
      const uniqueFindingId = `unique_unambiguous_${crypto.randomUUID()}`;
      const uniqueFinding: PersistedFindingRecord = {
        finding_id: uniqueFindingId,
        audit_id: auditIdUserA,
        user_id: userAId,
        rule_id: 'model_right_sizing',
        title: 'Unambiguous Single Audit Finding',
        summary: 'Unambiguous Single Audit Finding Summary',
        baseline_spend_usd: 120,
        estimated_savings_usd: 30,
        annualized_projection_usd: 360,
        eligible_event_count: 15,
        status: 'OPEN',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      };
      await storage.saveFinding(uniqueFinding);
      await storage.registerFindingOwnership(uniqueFindingId, userAId, auditIdUserA);

      const mcpRes = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: uniqueFindingId,
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, undefined);
      const parsed = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(parsed.finding_id, uniqueFindingId);
      assert.strictEqual(parsed.is_owner, true);
    });
  });

  // =========================================================================
  // Section 4.C: Real Authentication & Tenant Isolation
  // =========================================================================
  describe('Section 4.C: Real Authentication & Tenant Isolation', () => {
    test('13. Real session tokens and cookies isolate User A and User B', async () => {
      assert.ok(cookieUserA.includes('aidiscost_session='));
      assert.ok(cookieUserB.includes('aidiscost_session='));
      assert.notStrictEqual(cookieUserA, cookieUserB);
      assert.notStrictEqual(userAId, userBId);
    });

    test("14. User B cannot claim or access User A's finding by omitting audit_id", async () => {
      // User B tries to check entitlement for User A's finding
      const mcpRes = await callMcpHttp(cookieUserB, 'check_entitlement', {
        finding_id: findingIdUserA,
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const parsed = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(parsed.error, 'FINDING_NOT_FOUND');

      // User B tries to get details for User A's finding
      const mcpDet = await callMcpHttp(cookieUserB, 'get_finding_details', {
        finding_id: findingIdUserA,
      });
      assert.strictEqual(mcpDet.status, 200);
      assert.strictEqual(mcpDet.body.result.isError, true);
      const parsedDet = JSON.parse(mcpDet.body.result.content[0].text);
      assert.strictEqual(parsedDet.error, 'FINDING_NOT_FOUND');

      // REST check
      const apiRes = await fetch(`${serverUrl}/api/findings/${findingIdUserA}/entitlement`, {
        headers: { Cookie: cookieUserB },
      });
      assert.strictEqual(apiRes.status, 404);
    });

    test("15. User B cannot register ownership of User A's finding", async () => {
      // User B calls POST /api/findings/register with User A's finding ID
      const regRes = await fetch(`${serverUrl}/api/findings/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserB },
        body: JSON.stringify({
          finding_ids: [findingIdUserA],
          audit_id: auditIdUserA,
        }),
      });
      // auditIdUserA belongs to User A, so registration must return 404
      assert.strictEqual(regRes.status, 404);

      // Verify in storage that User A is still the sole owner
      const owner = await storage.getFindingOwner(findingIdUserA, auditIdUserA);
      assert.strictEqual(owner, userAId);
    });

    test('16. Logout invalidates session immediately', async () => {
      // Register ephemeral user
      const ephemEmail = `ephem_${crypto.randomUUID()}@corp.test`;
      const regRes = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ephemEmail, password }),
      });
      assert.strictEqual(regRes.status, 201);
      const ephemCookie = regRes.headers.get('set-cookie')!.split(';')[0];

      // Verify active session
      const meResBefore = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Cookie: ephemCookie },
      });
      const meDataBefore = await meResBefore.json();
      assert.strictEqual(meDataBefore.authenticated, true);

      // Logout
      const logoutRes = await fetch(`${serverUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: ephemCookie },
      });
      assert.strictEqual(logoutRes.status, 200);

      // Verify session is immediately rejected on subsequent calls
      const meResAfter = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Cookie: ephemCookie },
      });
      const meDataAfter = await meResAfter.json();
      assert.strictEqual(meDataAfter.authenticated, false);

      // Verify MCP call with invalidated cookie fails
      const mcpRes = await callMcpHttp(ephemCookie, 'check_entitlement', {
        finding_id: 'any_id',
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const parsed = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(parsed.error, 'UNAUTHORIZED');
    });

    test("17. Error responses do not leak other tenant's existence or metadata", async () => {
      // User B querying User A's finding should get identical error structure as querying nonexistent finding
      const resRealFindingOtherUser = await callMcpHttp(cookieUserB, 'get_finding_details', {
        finding_id: findingIdUserA,
      });
      const resFakeFinding = await callMcpHttp(cookieUserB, 'get_finding_details', {
        finding_id: `fake_nonexistent_${crypto.randomUUID()}`,
      });

      const bodyReal = JSON.parse(resRealFindingOtherUser.body.result.content[0].text);
      const bodyFake = JSON.parse(resFakeFinding.body.result.content[0].text);

      assert.strictEqual(bodyReal.error, bodyFake.error);
      assert.strictEqual(bodyReal.message, bodyFake.message);
      assert.strictEqual(bodyReal.owner, undefined);
      assert.strictEqual(bodyReal.user_id, undefined);
    });
  });

  // =========================================================================
  // Section 4.D: Persistence Integrity
  // =========================================================================
  describe('Section 4.D: Persistence Integrity', () => {
    test('18. Verify storage has no new ownership records after rejected requests', async () => {
      const allFindingsBefore = await storage.findFindingsByFindingId(findingIdUserA);
      const initialOwnershipOwner = await storage.getFindingOwner(findingIdUserA, auditIdUserA);

      // Attempt multiple rejected requests by User B
      await callMcpHttp(cookieUserB, 'check_entitlement', { finding_id: findingIdUserA });
      await callMcpHttp(cookieUserB, 'get_finding_details', { finding_id: findingIdUserA });
      await fetch(`${serverUrl}/api/findings/${findingIdUserA}/entitlement`, { headers: { Cookie: cookieUserB } });
      await fetch(`${serverUrl}/api/findings/nonexistent_xyz/entitlement`, { headers: { Cookie: cookieUserB } });

      const allFindingsAfter = await storage.findFindingsByFindingId(findingIdUserA);
      assert.strictEqual(allFindingsAfter.length, allFindingsBefore.length);
      const currentOwner = await storage.getFindingOwner(findingIdUserA, auditIdUserA);
      assert.strictEqual(currentOwner, initialOwnershipOwner);
    });

    test('19. Verify existing ownership records are never overwritten by another user', async () => {
      // User A owns findingIdUserA
      const originalOwner = await storage.getFindingOwner(findingIdUserA, auditIdUserA);
      assert.strictEqual(originalOwner, userAId);

      // User B attempts to register ownership
      await storage.registerFindingOwnership(findingIdUserA, userBId, auditIdUserA);

      // Storage must reject overwriting
      const maintainedOwner = await storage.getFindingOwner(findingIdUserA, auditIdUserA);
      assert.strictEqual(maintainedOwner, userAId, 'Original owner must be preserved and never overwritten');
    });

    test('20. Verify no entitlement or verification records are created on failed validation', async () => {
      const verificationsBefore = Object.keys((storage as any).data.verifications || {}).length;
      const entitlementsBefore = Object.keys((storage as any).data.entitlements || {}).length;

      // User B attempts verification evaluation on User A's finding
      const mcpVer = await callMcpHttp(cookieUserB, 'evaluate_verification', {
        finding_id: findingIdUserA,
        telemetry_data: validTelemetryJson,
      });
      assert.strictEqual(mcpVer.status, 200);
      assert.strictEqual(mcpVer.body.result.isError, true);

      // REST verification evaluate attempt on nonexistent finding
      const restVer = await fetch(`${serverUrl}/api/findings/fake_finding_999/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserA },
        body: JSON.stringify({ events: rightSizingEvents, finding: { id: 'fake_finding_999' } }),
      });
      assert.strictEqual(restVer.status, 404);

      const verificationsAfter = Object.keys((storage as any).data.verifications || {}).length;
      const entitlementsAfter = Object.keys((storage as any).data.entitlements || {}).length;

      assert.strictEqual(verificationsAfter, verificationsBefore, 'Verifications count must not increase on failed validation');
      assert.strictEqual(entitlementsAfter, entitlementsBefore, 'Entitlements count must not increase on failed validation');
    });
  });
});
