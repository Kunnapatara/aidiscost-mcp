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
import { authenticate } from '../server/auth';
import { createMcpRouter, resetRateLimitsForTesting } from '../server/mcp/router';
import { createApiRouter } from '../server/api';
import { PersistedAuditRecord, PersistedFindingRecord, User } from '../server/types';
import { createDatabaseConnection, initializeDatabaseSchema } from '../server/db/index';
import { DrizzleStorageAdapter } from '../server/db/adapter';

describe('AIDisCost MCP — Orphaned Ownership & Security Data Integrity Hardening', () => {
  let server: http.Server;
  let serverUrl: string;
  let mcpUrl: string;
  let storage: ServerStorage;

  let cookieUserA: string;
  let cookieUserB: string;
  let userAId: string;
  let userBId: string;

  const emailUserA = 'user-a-orphaned@corp.test';
  const emailUserB = 'user-b-orphaned@corp.test';
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

  // Pre-seed IDs
  const validAuditA1 = 'audit_valid_a1';
  const validFindingA1 = 'finding_valid_a1';
  const validAuditA2 = 'audit_valid_a2';
  const duplicateFindingId = 'finding_shared_id';

  const orphanedFindingId = 'finding_orphaned_no_record';
  const missingAuditFindingId = 'finding_with_missing_parent_audit';
  const missingAuditId = 'audit_that_does_not_exist';

  before(async () => {
    storage = ServerStorage.getInstance('data', 'test-orphaned-ownership.json');
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

    // 1. Register User A
    const regResA = await fetch(`${serverUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailUserA, password }),
    });
    assert.strictEqual(regResA.status, 201);
    cookieUserA = regResA.headers.get('set-cookie')!.split(';')[0];
    const dataA = (await regResA.json()) as any;
    userAId = dataA.user.id;

    // 2. Register User B
    const regResB = await fetch(`${serverUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailUserB, password }),
    });
    assert.strictEqual(regResB.status, 201);
    cookieUserB = regResB.headers.get('set-cookie')!.split(';')[0];
    const dataB = (await regResB.json()) as any;
    userBId = dataB.user.id;

    // 3. Seed Valid Audit A1 & Valid Finding A1 for User A
    const auditRecordA1: PersistedAuditRecord = {
      audit_id: validAuditA1,
      user_id: userAId,
      source: 'custom_logs',
      total_spend_usd: 1200,
      potential_savings_usd: 350,
      annualized_savings_projection_usd: 4200,
      is_sample_data: false,
      health_grade: 'A',
      health_report: {} as any,
      findings_count: 2,
      created_at: new Date().toISOString(),
    };
    await storage.saveAudit(auditRecordA1);

    const findingRecordA1: PersistedFindingRecord = {
      audit_id: validAuditA1,
      finding_id: validFindingA1,
      user_id: userAId,
      rule_id: 'RULE_MODEL_RIGHT_SIZING',
      title: 'Model Right-Sizing Opportunity',
      summary: 'Replace heavyweight model with flash model',
      affected_scope: 'chat-service',
      detection_confidence: 'HIGH',
      baseline_spend_usd: 1200,
      candidate_spend_usd: 850,
      estimated_savings_usd: 350,
      potential_savings_pct: 29.1,
      annualized_projection_usd: 4200,
      eligible_event_count: 50,
      calculation_method: 'DIFFERENTIAL_RATE',
      assumptions: ['100% replacement'],
      evidence: { affected_event_count: 50 } as any,
      status: 'DETECTED',
      is_sample_data: false,
      created_at: new Date().toISOString(),
    };
    await storage.saveFinding(findingRecordA1);
    await storage.registerFindingOwnership(validFindingA1, userAId, validAuditA1);

    // Seed Finding with duplicate ID in Audit A1
    const duplicateInA1: PersistedFindingRecord = {
      ...findingRecordA1,
      finding_id: duplicateFindingId,
      title: 'Duplicate finding in Audit 1',
    };
    await storage.saveFinding(duplicateInA1);
    await storage.registerFindingOwnership(duplicateFindingId, userAId, validAuditA1);

    // 4. Seed Valid Audit A2 for User A with finding sharing duplicateFindingId
    const auditRecordA2: PersistedAuditRecord = {
      ...auditRecordA1,
      audit_id: validAuditA2,
    };
    await storage.saveAudit(auditRecordA2);

    const duplicateInA2: PersistedFindingRecord = {
      ...findingRecordA1,
      audit_id: validAuditA2,
      finding_id: duplicateFindingId,
      title: 'Duplicate finding in Audit 2',
    };
    await storage.saveFinding(duplicateInA2);
    await storage.registerFindingOwnership(duplicateFindingId, userAId, validAuditA2);

    // 5. Create an ORPHANED Ownership record for User A
    // (Ownership record exists in storage, but NO finding record exists in `findings`)
    await storage.registerFindingOwnership(orphanedFindingId, userAId, validAuditA1);

    // 6. Create a Finding whose parent Audit does NOT exist
    const findingMissingAudit: PersistedFindingRecord = {
      ...findingRecordA1,
      audit_id: missingAuditId,
      finding_id: missingAuditFindingId,
    };
    await storage.saveFinding(findingMissingAudit);
    await storage.registerFindingOwnership(missingAuditFindingId, userAId, missingAuditId);
  });

  after(() => {
    if (server) {
      server.close();
    }
  });

  // ==========================================
  // Section 1: Orphaned Ownership (Ownership exists, Finding does NOT exist)
  // ==========================================
  describe('Orphaned Ownership: No Persisted Finding Record', () => {
    test('REST GET /api/findings/:id/entitlement fails closed (404) for orphaned ownership', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${orphanedFindingId}/entitlement?audit_id=${validAuditA1}`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(res.status, 404);
      const data = (await res.json()) as any;
      assert.strictEqual(data.error, 'NOT_FOUND');
    });

    test('REST GET /api/findings/:id/entitlement fails closed (404) without audit_id for orphaned ownership', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${orphanedFindingId}/entitlement`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(res.status, 404);
      const data = (await res.json()) as any;
      assert.strictEqual(data.error, 'NOT_FOUND');
    });

    test('REST POST /api/billing/fix-package/checkout fails closed (404) and creates no order for orphaned ownership', async () => {
      const res = await fetch(`${serverUrl}/api/billing/fix-package/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserA },
        body: JSON.stringify({ finding_id: orphanedFindingId, audit_id: validAuditA1 }),
      });
      assert.strictEqual(res.status, 404);
      const data = (await res.json()) as any;
      assert.strictEqual(data.error, 'NOT_FOUND');
    });

    test('REST GET /api/findings/:id/verification fails closed (404) for orphaned ownership', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${orphanedFindingId}/verification?audit_id=${validAuditA1}`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(res.status, 404);
      const data = (await res.json()) as any;
      assert.strictEqual(data.error, 'NOT_FOUND');
    });

    test('REST POST /api/findings/:id/verification/deploy fails closed (404) for orphaned ownership', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${orphanedFindingId}/verification/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserA },
        body: JSON.stringify({ audit_id: validAuditA1 }),
      });
      assert.strictEqual(res.status, 404);
    });

    test('REST POST /api/findings/:id/verification/evaluate fails closed (404) for orphaned ownership', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${orphanedFindingId}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserA },
        body: JSON.stringify({
          audit_id: validAuditA1,
          telemetry_data: JSON.stringify([{ event_id: 'e1', cost_usd: 0.01 }]),
        }),
      });
      assert.strictEqual(res.status, 404);
    });

    test('REST POST /api/findings/:id/outcome-fee fails closed (404) and creates no obligation for orphaned ownership', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${orphanedFindingId}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserA },
        body: JSON.stringify({ audit_id: validAuditA1 }),
      });
      assert.strictEqual(res.status, 404);
    });

    test('REST GET /api/findings/:id/outcome-fee fails closed (404) for orphaned ownership', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${orphanedFindingId}/outcome-fee?audit_id=${validAuditA1}`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(res.status, 404);
    });

    test('REST POST /api/findings/:id/outcome-fee/checkout fails closed (404) for orphaned ownership', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${orphanedFindingId}/outcome-fee/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserA },
        body: JSON.stringify({ audit_id: validAuditA1 }),
      });
      assert.strictEqual(res.status, 404);
    });

    test('MCP check_entitlement fails closed (FINDING_NOT_FOUND) for orphaned ownership', async () => {
      resetRateLimitsForTesting();
      const res = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: orphanedFindingId,
        audit_id: validAuditA1,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result.isError, true);
      const err = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(err.error, 'FINDING_NOT_FOUND');
    });

    test('MCP check_entitlement fails closed (FINDING_NOT_FOUND) without audit_id for orphaned ownership', async () => {
      resetRateLimitsForTesting();
      const res = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: orphanedFindingId,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result.isError, true);
      const err = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(err.error, 'FINDING_NOT_FOUND');
    });

    test('MCP get_finding_details fails closed (FINDING_NOT_FOUND) for orphaned ownership', async () => {
      resetRateLimitsForTesting();
      const res = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: orphanedFindingId,
        audit_id: validAuditA1,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result.isError, true);
      const err = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(err.error, 'FINDING_NOT_FOUND');
    });

    test('MCP evaluate_verification fails closed (FINDING_NOT_FOUND) for orphaned ownership', async () => {
      resetRateLimitsForTesting();
      const res = await callMcpHttp(cookieUserA, 'evaluate_verification', {
        finding_id: orphanedFindingId,
        audit_id: validAuditA1,
        telemetry_data: JSON.stringify([{ event_id: 'e1', cost_usd: 0.01 }]),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result.isError, true);
      const err = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(err.error, 'FINDING_NOT_FOUND');
    });
  });

  // ==========================================
  // Section 2: Missing Parent Audit (Finding exists, Audit does NOT exist)
  // ==========================================
  describe('Missing Parent Audit: Finding Exists but Audit Does Not Exist', () => {
    test('REST GET /api/findings/:id/entitlement returns 404 when parent audit is missing', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${missingAuditFindingId}/entitlement?audit_id=${missingAuditId}`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(res.status, 404);
      const data = (await res.json()) as any;
      assert.strictEqual(data.error, 'NOT_FOUND');
    });

    test('REST POST /api/billing/fix-package/checkout returns 404 when parent audit is missing', async () => {
      const res = await fetch(`${serverUrl}/api/billing/fix-package/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserA },
        body: JSON.stringify({ finding_id: missingAuditFindingId, audit_id: missingAuditId }),
      });
      assert.strictEqual(res.status, 404);
    });

    test('REST POST /api/findings/:id/verification/evaluate returns 404 when parent audit is missing', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${missingAuditFindingId}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserA },
        body: JSON.stringify({
          audit_id: missingAuditId,
          telemetry_data: JSON.stringify([{ event_id: 'e1', cost_usd: 0.01 }]),
        }),
      });
      assert.strictEqual(res.status, 404);
    });

    test('REST POST /api/findings/:id/outcome-fee returns 404 when parent audit is missing', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${missingAuditFindingId}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserA },
        body: JSON.stringify({ audit_id: missingAuditId }),
      });
      assert.strictEqual(res.status, 404);
    });

    test('MCP check_entitlement fails closed (FINDING_NOT_FOUND) when parent audit is missing', async () => {
      resetRateLimitsForTesting();
      const res = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: missingAuditFindingId,
        audit_id: missingAuditId,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result.isError, true);
      const err = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(err.error, 'FINDING_NOT_FOUND');
    });

    test('MCP get_finding_details fails closed (FINDING_NOT_FOUND) when parent audit is missing', async () => {
      resetRateLimitsForTesting();
      const res = await callMcpHttp(cookieUserA, 'get_finding_details', {
        finding_id: missingAuditFindingId,
        audit_id: missingAuditId,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result.isError, true);
      const err = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(err.error, 'FINDING_NOT_FOUND');
    });

    test('MCP evaluate_verification fails closed (FINDING_NOT_FOUND) when parent audit is missing', async () => {
      resetRateLimitsForTesting();
      const res = await callMcpHttp(cookieUserA, 'evaluate_verification', {
        finding_id: missingAuditFindingId,
        audit_id: missingAuditId,
        telemetry_data: JSON.stringify([{ event_id: 'e1', cost_usd: 0.01 }]),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result.isError, true);
      const err = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(err.error, 'FINDING_NOT_FOUND');
    });
  });

  // ==========================================
  // Section 3: Cross-User & Cross-Audit Access Isolation
  // ==========================================
  describe('Cross-User & Cross-Audit Access Isolation', () => {
    test('User B cannot view or checkout User A finding (returns 404, does not leak existence)', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${validFindingA1}/entitlement?audit_id=${validAuditA1}`, {
        headers: { Cookie: cookieUserB },
      });
      assert.strictEqual(res.status, 404);

      const checkoutRes = await fetch(`${serverUrl}/api/billing/fix-package/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserB },
        body: JSON.stringify({ finding_id: validFindingA1, audit_id: validAuditA1 }),
      });
      assert.strictEqual(checkoutRes.status, 404);
    });

    test('User B MCP check_entitlement fails closed (FINDING_NOT_FOUND) for User A finding', async () => {
      resetRateLimitsForTesting();
      const res = await callMcpHttp(cookieUserB, 'check_entitlement', {
        finding_id: validFindingA1,
        audit_id: validAuditA1,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result.isError, true);
      const err = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(err.error, 'FINDING_NOT_FOUND');
    });

    test('Mismatched audit_id (Audit A2 specified for finding in Audit A1) fails closed with 404', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${validFindingA1}/entitlement?audit_id=${validAuditA2}`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(res.status, 404);

      resetRateLimitsForTesting();
      const mcpRes = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: validFindingA1,
        audit_id: validAuditA2,
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const err = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(err.error, 'FINDING_NOT_FOUND');
    });
  });

  // ==========================================
  // Section 4: Duplicate Finding IDs & Blank/Whitespace Audit ID Validation
  // ==========================================
  describe('Duplicate Finding IDs & Input Validation', () => {
    test('Omission of audit_id when finding exists in multiple audits returns 400 AMBIGUOUS_FINDING', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${duplicateFindingId}/entitlement`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(res.status, 400);
      const data = (await res.json()) as any;
      assert.strictEqual(data.error, 'AMBIGUOUS_FINDING');

      resetRateLimitsForTesting();
      const mcpRes = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: duplicateFindingId,
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const err = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(err.error, 'AMBIGUOUS_FINDING');
    });

    test('Providing exact audit_id disambiguates duplicate finding ID and succeeds (200)', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${duplicateFindingId}/entitlement?audit_id=${validAuditA1}`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as any;
      assert.strictEqual(data.finding_id, duplicateFindingId);
      assert.strictEqual(data.audit_id, validAuditA1);
      assert.strictEqual(data.is_paid, false);

      resetRateLimitsForTesting();
      const mcpRes = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: duplicateFindingId,
        audit_id: validAuditA1,
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, undefined);
      const mcpData = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(mcpData.is_owner, true);
      assert.strictEqual(mcpData.fix_package.unlocked, false);
    });

    test('Blank audit_id ("") is rejected with 400 INVALID_AUDIT / INVALID_INPUT', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${validFindingA1}/entitlement?audit_id=`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(res.status, 400);
      const data = (await res.json()) as any;
      assert.strictEqual(data.error, 'INVALID_AUDIT');

      resetRateLimitsForTesting();
      const mcpRes = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: validFindingA1,
        audit_id: '',
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const err = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(err.error, 'INVALID_INPUT');
    });

    test('Whitespace audit_id ("   ") is rejected with 400 INVALID_AUDIT / INVALID_INPUT', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${validFindingA1}/entitlement?audit_id=%20%20%20`, {
        headers: { Cookie: cookieUserA },
      });
      assert.strictEqual(res.status, 400);
      const data = (await res.json()) as any;
      assert.strictEqual(data.error, 'INVALID_AUDIT');

      resetRateLimitsForTesting();
      const mcpRes = await callMcpHttp(cookieUserA, 'check_entitlement', {
        finding_id: validFindingA1,
        audit_id: '   ',
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.result.isError, true);
      const err = JSON.parse(mcpRes.body.result.content[0].text);
      assert.strictEqual(err.error, 'INVALID_INPUT');
    });
  });

  // ==========================================
  // Section 5: DrizzleStorageAdapter / LibSQL In-Memory Verification
  // ==========================================
  describe('DrizzleStorageAdapter LibSQL In-Memory Invariant Verification', () => {
    let db: any;
    let client: any;
    let adapter: DrizzleStorageAdapter;

    before(async () => {
      const conn = createDatabaseConnection({ url: ':memory:' });
      db = conn.db;
      client = conn.client;
      await initializeDatabaseSchema(client);
      adapter = new DrizzleStorageAdapter(db, client);

      const testUser: User = {
        id: 'usr_drizzle_1',
        email: 'drizzle_test@corp.test',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(testUser);
    });

    after(() => {
      if (client) {
        client.close();
      }
    });

    test('getFindingOwner returns null for non-existent finding when no audit is provided', async () => {
      const owner = await adapter.getFindingOwner('non_existent_finding_xyz');
      assert.strictEqual(owner, null);
    });

    test('getFindingOwner returns null for non-existent finding even if auditId is provided', async () => {
      const owner = await adapter.getFindingOwner('non_existent_finding_xyz', 'some_audit_id');
      assert.strictEqual(owner, null);
    });

    test('getFindingOwner fails closed when finding exists under a different auditId', async () => {
      const auditRec: PersistedAuditRecord = {
        audit_id: 'drizzle_audit_1',
        user_id: 'usr_drizzle_1',
        source: 'custom_logs',
        total_spend_usd: 100,
        potential_savings_usd: 20,
        annualized_savings_projection_usd: 240,
        is_sample_data: false,
        health_grade: 'A',
        health_report: {} as any,
        findings_count: 1,
        created_at: new Date().toISOString(),
      };
      await adapter.saveAudit(auditRec);

      const findingRec: PersistedFindingRecord = {
        audit_id: 'drizzle_audit_1',
        finding_id: 'drizzle_finding_1',
        user_id: 'usr_drizzle_1',
        rule_id: 'RULE_MODEL_RIGHT_SIZING',
        title: 'Title',
        summary: 'Summary',
        affected_scope: 'scope',
        detection_confidence: 'HIGH',
        baseline_spend_usd: 100,
        candidate_spend_usd: 80,
        estimated_savings_usd: 20,
        potential_savings_pct: 20,
        annualized_projection_usd: 240,
        eligible_event_count: 10,
        calculation_method: 'DIFFERENTIAL',
        assumptions: [],
        evidence: {} as any,
        status: 'DETECTED',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      };
      await adapter.saveFinding(findingRec);
      await adapter.registerFindingOwnership('drizzle_finding_1', 'usr_drizzle_1', 'drizzle_audit_1');

      // Queried with incorrect audit_id
      const mismatchedOwner = await adapter.getFindingOwner('drizzle_finding_1', 'wrong_audit_id');
      assert.strictEqual(mismatchedOwner, null);

      // Queried with correct audit_id
      const correctOwner = await adapter.getFindingOwner('drizzle_finding_1', 'drizzle_audit_1');
      assert.strictEqual(correctOwner, 'usr_drizzle_1');
    });
  });
});
