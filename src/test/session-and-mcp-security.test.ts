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
import { createDatabaseConnection, initializeDatabaseSchema } from '../server/db/index';
import { DrizzleStorageAdapter } from '../server/db/adapter';
import * as schema from '../server/db/schema';
import { eq } from 'drizzle-orm';
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS,
  getSessionCookieOptions,
  authenticate,
} from '../server/auth';
import { createMcpServer } from '../server/mcp/server';
import { createMcpRouter, resetRateLimitsForTesting } from '../server/mcp/router';
import { createApiRouter } from '../server/api';
import { User } from '../server/types';
import { generateSampleDataset } from '../engine/adapters/sample-data';

describe('AIDisCost MCP — Group C: Session Security, Auth Isolation & MCP E2E Suite', () => {
  // Test users
  const userA: User = {
    id: 'usr_grpc_user_a',
    email: 'user-a@secops.corp',
    password_hash: 'mock_pw_hash_a',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const userB: User = {
    id: 'usr_grpc_user_b',
    email: 'user-b@secops.corp',
    password_hash: 'mock_pw_hash_b',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  let jsonStorage: ServerStorage;
  let drizzleStorage: DrizzleStorageAdapter;
  let drizzleClient: any;

  beforeEach(async () => {
    // 1. JSON storage setup
    jsonStorage = ServerStorage.getInstance('data', 'test-group-c-db.json');
    jsonStorage.setTestMode(true);
    jsonStorage.clearAll();
    await jsonStorage.createUser(userA);
    await jsonStorage.createUser(userB);

    // 2. Drizzle (LibSQL in-memory) setup
    const conn = createDatabaseConnection({ url: ':memory:' });
    drizzleClient = conn.client;
    await initializeDatabaseSchema(drizzleClient);
    drizzleStorage = new DrizzleStorageAdapter(conn.db, drizzleClient);
    drizzleStorage.setTestMode(true);
    await drizzleStorage.createUser(userA);
    await drizzleStorage.createUser(userB);
  });

  // =========================================================================
  // SECTION 1: Session Security Invariants
  // =========================================================================
  describe('1. Session Security & Token Cryptography', () => {
    test('generateSessionToken produces 32 cryptographically secure random bytes (64 hex characters)', () => {
      const token1 = generateSessionToken();
      const token2 = generateSessionToken();

      assert.strictEqual(typeof token1, 'string');
      assert.strictEqual(token1.length, 64, 'Token must be 64 hex characters (32 bytes entropy)');
      assert.match(token1, /^[0-9a-f]{64}$/, 'Token must be hexadecimal format');
      assert.notStrictEqual(token1, token2, 'Consecutive tokens must be distinct');
    });

    test('hashSessionToken computes consistent SHA-256 hex digest', () => {
      const rawToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const actualHash = hashSessionToken(rawToken);

      assert.strictEqual(actualHash, expectedHash);
      assert.strictEqual(actualHash.length, 64);
    });

    test('getSessionCookieOptions returns strict security attributes', () => {
      const devOpts = getSessionCookieOptions(false);
      assert.strictEqual(devOpts.httpOnly, true, 'HttpOnly must always be true');
      assert.strictEqual(devOpts.secure, false, 'Secure is false in development');
      assert.strictEqual(devOpts.sameSite, 'lax');
      assert.strictEqual(devOpts.path, '/');
      assert.strictEqual(devOpts.maxAge, SESSION_DURATION_MS);

      const prodOpts = getSessionCookieOptions(true);
      assert.strictEqual(prodOpts.httpOnly, true, 'HttpOnly must always be true');
      assert.strictEqual(prodOpts.secure, true, 'Secure must be true in production');
      assert.strictEqual(prodOpts.sameSite, 'lax');
      assert.strictEqual(prodOpts.path, '/');
      assert.strictEqual(prodOpts.maxAge, 7 * 24 * 60 * 60 * 1000);
    });

    for (const [storageName, getStorage] of [
      ['ServerStorage (JSON)', () => jsonStorage],
      ['DrizzleStorageAdapter (LibSQL)', () => drizzleStorage],
    ] as const) {
      describe(`Storage backend: ${storageName}`, () => {
        test('stores session hashed at rest; raw token is NEVER stored', async () => {
          const storage = getStorage();
          const rawToken = generateSessionToken();
          const hashedToken = hashSessionToken(rawToken);
          const now = new Date().toISOString();
          const expiresAt = new Date(Date.now() + 3600_000).toISOString();

          await storage.createSession({
            token: rawToken,
            user_id: userA.id,
            expires_at: expiresAt,
            created_at: now,
          });

          // Verify retrieval via original raw token succeeds
          const resolved = await storage.getSession(rawToken);
          assert.ok(resolved, 'Should resolve session using raw token');
          assert.strictEqual(resolved.user.id, userA.id);

          // Verify that raw token is NOT stored as a key/field
          if (storage instanceof ServerStorage) {
            const rawSessions = (storage as any).data.sessions;
            assert.strictEqual(rawSessions[rawToken], undefined, 'Raw token must not exist in sessions table');
            assert.ok(rawSessions[hashedToken], 'Hashed token must exist in sessions table');
            assert.strictEqual(rawSessions[hashedToken].token, hashedToken, 'Stored record token must be hashed');
          }
        });

        test('expired session is rejected and removed from storage', async () => {
          const storage = getStorage();
          const rawToken = generateSessionToken();
          const now = new Date().toISOString();
          // Expired 10 minutes ago
          const expiredAt = new Date(Date.now() - 600_000).toISOString();

          await storage.createSession({
            token: rawToken,
            user_id: userA.id,
            expires_at: expiredAt,
            created_at: now,
          });

          const resolved = await storage.getSession(rawToken);
          assert.strictEqual(resolved, null, 'Expired session must return null');

          // Ensure it was cleaned up
          const secondCheck = await storage.getSession(rawToken);
          assert.strictEqual(secondCheck, null);
        });

        test('deleteSession invalidates session immediately', async () => {
          const storage = getStorage();
          const rawToken = generateSessionToken();
          const now = new Date().toISOString();
          const expiresAt = new Date(Date.now() + 3600_000).toISOString();

          await storage.createSession({
            token: rawToken,
            user_id: userA.id,
            expires_at: expiresAt,
            created_at: now,
          });

          const beforeDelete = await storage.getSession(rawToken);
          assert.ok(beforeDelete);

          const deleted = await storage.deleteSession(rawToken);
          assert.strictEqual(deleted, true);

          const afterDelete = await storage.getSession(rawToken);
          assert.strictEqual(afterDelete, null, 'Session must not resolve after deletion');
        });

        test('session for non-existent user safely fails and purges session record', async () => {
          const storage = getStorage();
          const rawToken = generateSessionToken();
          const now = new Date().toISOString();
          const expiresAt = new Date(Date.now() + 3600_000).toISOString();

          const tempUser: User = {
            id: `usr_temp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            email: `temp_${Date.now()}@test.org`,
            password_hash: 'temp_hash',
            created_at: now,
            updated_at: now,
          };
          await storage.createUser(tempUser);

          await storage.createSession({
            token: rawToken,
            user_id: tempUser.id,
            expires_at: expiresAt,
            created_at: now,
          });

          // Simulate user deletion behind the session
          if (storage instanceof ServerStorage) {
            delete (storage as any).data.users[tempUser.email];
            delete (storage as any).data.usersById[tempUser.id];
          } else {
            await drizzleClient.execute('PRAGMA foreign_keys = OFF;');
            await drizzleClient.execute({
              sql: 'DELETE FROM users WHERE id = ?;',
              args: [tempUser.id],
            });
            await drizzleClient.execute('PRAGMA foreign_keys = ON;');
          }

          const resolved = await storage.getSession(rawToken);
          assert.strictEqual(resolved, null, 'Orphaned session without valid user must return null');
        });
      });
    }
  });

  // =========================================================================
  // SECTION 2: Legacy Session Migration & In-Flight Upgrade
  // =========================================================================
  describe('2. Legacy Session Migration & In-Flight Upgrade', () => {
    test('ServerStorage migrates legacy unhashed session to hashed key on first access', async () => {
      const storage = jsonStorage;
      const legacyRawToken = 'legacy_unhashed_token_abcdef0123456789';
      const hashedToken = hashSessionToken(legacyRawToken);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();

      // Simulate existing legacy session stored with unhashed token key
      (storage as any).data.sessions[legacyRawToken] = {
        token: legacyRawToken,
        user_id: userA.id,
        expires_at: expiresAt,
        created_at: now,
      };

      assert.ok((storage as any).data.sessions[legacyRawToken], 'Legacy key exists prior to access');
      assert.strictEqual((storage as any).data.sessions[hashedToken], undefined, 'Hashed key does not exist yet');

      // Accessing session should trigger in-flight migration
      const result = await storage.getSession(legacyRawToken);
      assert.ok(result, 'Legacy session should be successfully resolved');
      assert.strictEqual(result.user.id, userA.id);

      // Verify migration state: raw key is removed, hashed key is stored
      assert.strictEqual((storage as any).data.sessions[legacyRawToken], undefined, 'Raw token key must be deleted');
      assert.ok((storage as any).data.sessions[hashedToken], 'Hashed token key must now be present');
      assert.strictEqual((storage as any).data.sessions[hashedToken].token, hashedToken, 'Stored session token must be hashed');

      // Subsequent access works idempotently via hashed key lookup
      const secondAccess = await storage.getSession(legacyRawToken);
      assert.ok(secondAccess, 'Subsequent access with same raw token should continue to resolve');
      assert.strictEqual(secondAccess.user.id, userA.id);
    });

    test('DrizzleStorageAdapter migrates legacy unhashed session to hashed token on first access', async () => {
      const storage = drizzleStorage;
      const legacyRawToken = 'legacy_drizzle_unhashed_token_987654321';
      const hashedToken = hashSessionToken(legacyRawToken);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();

      // Directly insert unhashed token into sessions table
      await (storage as any).db.insert(schema.sessions).values({
        token: legacyRawToken,
        userId: userB.id,
        expiresAt: expiresAt,
        createdAt: now,
      });

      // Query via getSession should detect legacy token and update to hashed token
      const resolved = await storage.getSession(legacyRawToken);
      assert.ok(resolved, 'Drizzle adapter should resolve legacy session');
      assert.strictEqual(resolved.user.id, userB.id);

      // Verify row in DB was updated to hashed token
      const rows = await (storage as any).db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.token, hashedToken));
      assert.strictEqual(rows.length, 1);

      // Subsequent access works via hashedToken query
      const resolvedAgain = await storage.getSession(legacyRawToken);
      assert.ok(resolvedAgain);
      assert.strictEqual(resolvedAgain.user.id, userB.id);
    });

    test('expired legacy session is deleted and NEVER migrated', async () => {
      const storage = jsonStorage;
      const expiredRawToken = 'legacy_expired_token_000000000000';
      const hashedToken = hashSessionToken(expiredRawToken);
      const now = new Date().toISOString();
      const expiredAt = new Date(Date.now() - 3600_000).toISOString();

      // Insert expired legacy session
      (storage as any).data.sessions[expiredRawToken] = {
        token: expiredRawToken,
        user_id: userA.id,
        expires_at: expiredAt,
        created_at: now,
      };

      const result = await storage.getSession(expiredRawToken);
      assert.strictEqual(result, null, 'Expired legacy session must return null');
      assert.strictEqual((storage as any).data.sessions[expiredRawToken], undefined, 'Expired legacy session must be purged');
      assert.strictEqual((storage as any).data.sessions[hashedToken], undefined, 'Expired legacy session must not be migrated');
    });

    test('legacy session for deleted user is purged and returns null', async () => {
      const storage = jsonStorage;
      const orphanedRawToken = 'legacy_orphaned_token_111111111111';
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();

      (storage as any).data.sessions[orphanedRawToken] = {
        token: orphanedRawToken,
        user_id: 'usr_ghost_user_999',
        expires_at: expiresAt,
        created_at: now,
      };

      const result = await storage.getSession(orphanedRawToken);
      assert.strictEqual(result, null);
      assert.strictEqual((storage as any).data.sessions[orphanedRawToken], undefined);
    });
  });

  // =========================================================================
  // SECTION 3: Authentication & Multi-Tenant Authorization Enforcement
  // =========================================================================
  describe('3. Multi-Tenant Authorization & Protected Routes', () => {
    let server: http.Server;
    let serverUrl: string;

    before(async () => {
      const app = express();
      app.use(express.json());
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
    });

    after(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    test('public routes allow unauthenticated access without 401', async () => {
      const livenessRes = await fetch(`${serverUrl}/api/health/live`);
      assert.strictEqual(livenessRes.status, 200);

      const meRes = await fetch(`${serverUrl}/api/auth/me`);
      assert.strictEqual(meRes.status, 200);
      const meData: any = await meRes.json();
      assert.strictEqual(meData.authenticated, false);
      assert.strictEqual(meData.user, null);
    });

    test('protected routes strictly return 401 UNAUTHORIZED without valid session', async () => {
      const protectedEndpoints = [
        { path: '/api/findings/register', method: 'POST', body: { finding_ids: ['fnd_1'] } },
        { path: '/api/findings/fnd_test_id/entitlement', method: 'GET' },
        { path: '/api/findings/fnd_test_id/verification', method: 'GET' },
        { path: '/api/findings/fnd_test_id/verification/deploy', method: 'POST', body: {} },
        { path: '/api/findings/fnd_test_id/verification/evaluate', method: 'POST', body: {} },
        { path: '/api/billing/fix-package/checkout', method: 'POST', body: { finding_id: 'fnd_1' } },
        { path: '/api/findings/fnd_test_id/outcome-fee', method: 'POST', body: {} },
        { path: '/api/findings/fnd_test_id/outcome-fee/checkout', method: 'POST', body: {} },
      ];

      for (const endpoint of protectedEndpoints) {
        const res = await fetch(`${serverUrl}${endpoint.path}`, {
          method: endpoint.method,
          headers: { 'Content-Type': 'application/json' },
          body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
        });

        assert.strictEqual(
          res.status,
          401,
          `Expected 401 for unauthenticated request to ${endpoint.method} ${endpoint.path}`
        );
        const data: any = await res.json();
        assert.strictEqual(data.error, 'UNAUTHORIZED');
      }
    });

    test('cross-account finding access fails closed: User B cannot query or modify User A findings', async () => {
      // Register password for login test
      await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user-a-test@secops.corp', password: 'Password123!' }),
      });
      const cookieUserA = (
        await fetch(`${serverUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'user-a-test@secops.corp', password: 'Password123!' }),
        })
      ).headers.get('set-cookie')!.split(';')[0];

      // Register User B
      await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user-b-test@secops.corp', password: 'Password123!' }),
      });
      const cookieUserB = (
        await fetch(`${serverUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'user-b-test@secops.corp', password: 'Password123!' }),
        })
      ).headers.get('set-cookie')!.split(';')[0];

      // User A registers finding
      const findingId = 'fnd_cross_isolation_test_01';
      const regRes = await fetch(`${serverUrl}/api/findings/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserA },
        body: JSON.stringify({ finding_ids: [findingId] }),
      });
      assert.strictEqual(regRes.status, 200);

      // User B attempts to access User A's finding entitlement -> MUST FAIL with 404 (preventing existence leak)
      const accessRes = await fetch(`${serverUrl}/api/findings/${findingId}/entitlement`, {
        headers: { Cookie: cookieUserB },
      });
      assert.strictEqual(accessRes.status, 404);

      // User B attempts to checkout Fix Package for User A's finding -> MUST FAIL with 404
      const checkoutRes = await fetch(`${serverUrl}/api/billing/fix-package/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserB },
        body: JSON.stringify({ finding_id: findingId }),
      });
      assert.strictEqual(checkoutRes.status, 404);

      // User B attempts to checkout Outcome Fee for User A's finding -> MUST FAIL with 404
      const outcomeRes = await fetch(`${serverUrl}/api/findings/${findingId}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieUserB },
        body: JSON.stringify({}),
      });
      assert.strictEqual(outcomeRes.status, 404);
    });

    test('logout invalidates session token and clears session cookie', async () => {
      // Register and login a user
      const registerRes = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'logout-test@secops.corp', password: 'Password123!' }),
      });
      assert.strictEqual(registerRes.status, 201);
      const sessionCookie = registerRes.headers.get('set-cookie')!.split(';')[0];

      // Verify authenticated
      const meBefore = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Cookie: sessionCookie },
      });
      const meBeforeData: any = await meBefore.json();
      assert.strictEqual(meBeforeData.authenticated, true);

      // Call logout
      const logoutRes = await fetch(`${serverUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: sessionCookie },
      });
      assert.strictEqual(logoutRes.status, 200);

      const clearCookieHeader = logoutRes.headers.get('set-cookie');
      assert.ok(clearCookieHeader, 'Set-Cookie must be returned on logout');
      assert.ok(
        clearCookieHeader.includes('aidiscost_session=;') || clearCookieHeader.includes('Max-Age=0') || clearCookieHeader.includes('Expires='),
        'Session cookie must be cleared'
      );

      // Verify subsequent request with old cookie fails
      const meAfter = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Cookie: sessionCookie },
      });
      const meAfterData: any = await meAfter.json();
      assert.strictEqual(meAfterData.authenticated, false);
      assert.strictEqual(meAfterData.user, null);
    });
  });

  // =========================================================================
  // SECTION 4: MCP Protocol & Streamable HTTP Verification
  // =========================================================================
  describe('4. MCP Protocol & Streamable HTTP Transport', () => {
    let mcpHttpServer: http.Server;
    let mcpUrl: string;

    before(async () => {
      const app = express();
      app.use(
        '/mcp',
        express.json({ limit: '2mb' }),
        cookieParser(),
        (req: any, _res, next) => {
          const auth = req.headers.authorization;
          if (auth === 'Bearer token-user-a') {
            req.user = userA;
          } else if (auth === 'Bearer token-user-b') {
            req.user = userB;
          }
          next();
        },
        createMcpRouter(jsonStorage)
      );

      await new Promise<void>((resolve) => {
        mcpHttpServer = app.listen(0, '127.0.0.1', () => {
          const addr = mcpHttpServer.address() as any;
          mcpUrl = `http://127.0.0.1:${addr.port}/mcp`;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise<void>((resolve) => {
        mcpHttpServer.close(() => resolve());
      });
    });

    beforeEach(() => {
      resetRateLimitsForTesting();
    });

    test('rejects non-POST HTTP methods with 405 Method Not Allowed', async () => {
      const resGet = await fetch(mcpUrl, { method: 'GET' });
      assert.strictEqual(resGet.status, 405);
      const body: any = await resGet.json();
      assert.strictEqual(body.error, 'METHOD_NOT_ALLOWED');

      const resPut = await fetch(mcpUrl, { method: 'PUT' });
      assert.strictEqual(resPut.status, 405);

      const resDelete = await fetch(mcpUrl, { method: 'DELETE' });
      assert.strictEqual(resDelete.status, 405);
    });

    test('rate limiter enforces max requests per minute and returns 429', async () => {
      resetRateLimitsForTesting();

      // Make 60 requests with same client key (simulated loop)
      const promises: Promise<Response>[] = [];
      for (let i = 0; i < 60; i++) {
        promises.push(
          fetch(mcpUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json, text/event-stream',
              'Authorization': 'Bearer token-user-a',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: i + 1,
              method: 'tools/list',
              params: {},
            }),
          })
        );
      }
      const responses = await Promise.all(promises);
      assert.strictEqual(responses[0].status, 200);

      // The 61st request must trigger 429 RATE_LIMIT_EXCEEDED
      const rateLimitedRes = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': 'Bearer token-user-a',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 61,
          method: 'tools/list',
          params: {},
        }),
      });

      assert.strictEqual(rateLimitedRes.status, 429);
      const resBody: any = await rateLimitedRes.json();
      assert.strictEqual(resBody.error, 'RATE_LIMIT_EXCEEDED');

      // Distinct user (User B) is NOT rate limited by User A's traffic
      const userBRes = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': 'Bearer token-user-b',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 100,
          method: 'tools/list',
          params: {},
        }),
      });
      assert.strictEqual(userBRes.status, 200, 'User B must not be throttled by User A rate limit bucket');
    });

    test('tools/list exposes all 4 canonical tools with complete schemas', async () => {
      resetRateLimitsForTesting();

      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });

      assert.strictEqual(res.status, 200);
      const data: any = await res.json();
      assert.ok(data.result?.tools, 'Tools list must be returned');

      const toolNames = data.result.tools.map((t: any) => t.name);
      assert.ok(toolNames.includes('run_cost_audit'));
      assert.ok(toolNames.includes('get_finding_details'));
      assert.ok(toolNames.includes('check_entitlement'));
      assert.ok(toolNames.includes('evaluate_verification'));

      // Validate schema properties
      const auditTool = data.result.tools.find((t: any) => t.name === 'run_cost_audit');
      assert.strictEqual(auditTool.inputSchema.properties.telemetry_data.type, 'string');

      const entitlementTool = data.result.tools.find((t: any) => t.name === 'check_entitlement');
      assert.strictEqual(entitlementTool.inputSchema.properties.finding_id.type, 'string');

      const detailsTool = data.result.tools.find((t: any) => t.name === 'get_finding_details');
      assert.strictEqual(detailsTool.inputSchema.properties.finding_id.type, 'string');

      const verifyTool = data.result.tools.find((t: any) => t.name === 'evaluate_verification');
      assert.strictEqual(verifyTool.inputSchema.properties.telemetry_data.type, 'string');
      assert.strictEqual(verifyTool.inputSchema.properties.finding_id.type, 'string');
    });
  });

  // =========================================================================
  // SECTION 5: MCP End-to-End Workflow & Verification Lifecycle
  // =========================================================================
  describe('5. MCP Complete End-to-End Workflow Pipeline', () => {
    // Generate valid sample telemetry that produces Model Right-Sizing findings
    const dataset = generateSampleDataset();
    const rightSizingEvents = dataset.events
      .filter((e) => e.source_event_id.startsWith('sample_rs_'))
      .slice(0, 30)
      .map((e) => ({
        ...e,
        is_simulated: false,
      }));
    const validTelemetryJson = JSON.stringify(rightSizingEvents);

    test('anonymous run_cost_audit performs free audit but skips database persistence', async () => {
      const server = createMcpServer(undefined, jsonStorage);
      const auditTool = (server as any)._registeredTools['run_cost_audit'];

      const result = await auditTool.handler({
        telemetry_data: validTelemetryJson,
        source_hint: 'custom_logs',
      });

      assert.strictEqual(result.isError, undefined);
      const payload = JSON.parse(result.content[0].text);

      assert.ok(payload.audit_id);
      assert.strictEqual(payload.persistence.status, 'SKIPPED_ANONYMOUS');
      assert.strictEqual(payload.ownership.is_anonymous, true);

      // Verify nothing was persisted in storage
      const persistedAudit = await jsonStorage.getAudit(payload.audit_id);
      assert.strictEqual(persistedAudit, null, 'Anonymous audit must not be saved to disk');
    });

    test('anonymous access to check_entitlement, get_finding_details, evaluate_verification is rejected (401 UNAUTHORIZED)', async () => {
      const server = createMcpServer(undefined, jsonStorage);

      const checkTool = (server as any)._registeredTools['check_entitlement'];
      const checkRes = await checkTool.handler({ finding_id: 'fnd_1' });
      assert.strictEqual(checkRes.isError, true);
      assert.strictEqual(JSON.parse(checkRes.content[0].text).error, 'UNAUTHORIZED');

      const detailsTool = (server as any)._registeredTools['get_finding_details'];
      const detailsRes = await detailsTool.handler({ finding_id: 'fnd_1' });
      assert.strictEqual(detailsRes.isError, true);
      assert.strictEqual(JSON.parse(detailsRes.content[0].text).error, 'UNAUTHORIZED');

      const verifyTool = (server as any)._registeredTools['evaluate_verification'];
      const verifyRes = await verifyTool.handler({ finding_id: 'fnd_1', telemetry_data: 'test' });
      assert.strictEqual(verifyRes.isError, true);
      assert.strictEqual(JSON.parse(verifyRes.content[0].text).error, 'UNAUTHORIZED');
    });

    test('full end-to-end lifecycle: Audit → Finding → Entitlement → Verification', async () => {
      const serverA = createMcpServer(userA, jsonStorage);

      // STEP 1: run_cost_audit as User A
      const auditTool = (serverA as any)._registeredTools['run_cost_audit'];
      const auditRes = await auditTool.handler({
        telemetry_data: validTelemetryJson,
        source_hint: 'custom_logs',
      });

      assert.strictEqual(auditRes.isError, undefined);
      const auditPayload = JSON.parse(auditRes.content[0].text);
      assert.strictEqual(auditPayload.persistence.status, 'SUCCESS');
      assert.strictEqual(auditPayload.ownership.requesting_user_id, userA.id);
      assert.ok(auditPayload.findings_count > 0, 'Audit must produce at least 1 finding');

      const finding = auditPayload.findings[0];
      const auditId = auditPayload.audit_id;
      const findingId = finding.id;

      // STEP 2: get_finding_details as User A (initial locked state)
      const detailsTool = (serverA as any)._registeredTools['get_finding_details'];
      const detailsRes = await detailsTool.handler({
        finding_id: findingId,
        audit_id: auditId,
      });

      assert.strictEqual(detailsRes.isError, undefined);
      const detailsPayload = JSON.parse(detailsRes.content[0].text);
      assert.strictEqual(detailsPayload.entitlement.unlocked, false);
      assert.strictEqual(detailsPayload.entitlement.status, 'LOCKED');
      assert.strictEqual(detailsPayload.entitlement.price_usd, 49.0);

      // STEP 3: check_entitlement as User A (initial locked state)
      const entitlementTool = (serverA as any)._registeredTools['check_entitlement'];
      const entResBefore = await entitlementTool.handler({
        finding_id: findingId,
        audit_id: auditId,
      });
      assert.strictEqual(entResBefore.isError, undefined);
      const entPayloadBefore = JSON.parse(entResBefore.content[0].text);
      assert.strictEqual(entPayloadBefore.fix_package.unlocked, false);
      assert.strictEqual(entPayloadBefore.fix_package.price_usd, 49.0);

      // STEP 4: Purchase Fix Package ($49) -> Grant entitlement to User A
      await jsonStorage.createEntitlement({
        id: 'ent_mcp_e2e_01',
        user_id: userA.id,
        audit_id: auditId,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_mcp_e2e_123',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Re-check entitlement -> Unlocked
      const entResAfter = await entitlementTool.handler({
        finding_id: findingId,
        audit_id: auditId,
      });
      const entPayloadAfter = JSON.parse(entResAfter.content[0].text);
      assert.strictEqual(entPayloadAfter.fix_package.unlocked, true);
      assert.strictEqual(entPayloadAfter.fix_package.entitlement_id, 'ent_mcp_e2e_01');

      // Re-check finding details -> Fix package code & tests are unlocked
      const detailsResAfter = await detailsTool.handler({
        finding_id: findingId,
        audit_id: auditId,
      });
      const detailsPayloadAfter = JSON.parse(detailsResAfter.content[0].text);
      assert.strictEqual(detailsPayloadAfter.entitlement.unlocked, true);
      assert.strictEqual(detailsPayloadAfter.entitlement.status, 'PAID_ACTIVE');

      // STEP 5: evaluate_verification with post-deployment telemetry
      const postDeploymentEvents = Array.from({ length: 25 }, (_, i) => ({
        id: `evt_post_${i}`,
        source: 'custom_logs',
        source_event_id: `post_${i}`,
        timestamp: new Date(Date.now() - (25 - i) * 60000).toISOString(),
        provider: 'openai',
        model: 'gpt-4o-mini',
        operation: 'chat',
        input_tokens: 120,
        output_tokens: 22,
        total_tokens: 142,
        cost_usd: 0.0001,
        latency_ms: 200,
        status: 'SUCCESS',
        is_simulated: false,
      }));

      const verifyTool = (serverA as any)._registeredTools['evaluate_verification'];
      const verifyRes = await verifyTool.handler({
        finding_id: findingId,
        audit_id: auditId,
        telemetry_data: JSON.stringify(postDeploymentEvents),
        source_hint: 'custom_logs',
      });

      assert.strictEqual(verifyRes.isError, undefined);
      const verifyPayload = JSON.parse(verifyRes.content[0].text);
      assert.strictEqual(verifyPayload.finding_id, findingId);
      assert.strictEqual(verifyPayload.audit_id, auditId);
      assert.ok(verifyPayload.verification_stage);

      // STEP 6: Multi-tenant safety: User B CANNOT access User A's finding or evaluation
      const serverB = createMcpServer(userB, jsonStorage);
      const detailsToolB = (serverB as any)._registeredTools['get_finding_details'];
      const crossDetailsRes = await detailsToolB.handler({
        finding_id: findingId,
        audit_id: auditId,
      });
      assert.strictEqual(crossDetailsRes.isError, true);
      assert.strictEqual(JSON.parse(crossDetailsRes.content[0].text).error, 'FINDING_NOT_FOUND');

      const verifyToolB = (serverB as any)._registeredTools['evaluate_verification'];
      const crossVerifyRes = await verifyToolB.handler({
        finding_id: findingId,
        audit_id: auditId,
        telemetry_data: JSON.stringify(postDeploymentEvents),
      });
      assert.strictEqual(crossVerifyRes.isError, true);
      assert.strictEqual(JSON.parse(crossVerifyRes.content[0].text).error, 'FINDING_NOT_FOUND');
    });

    test('simulation isolation: simulated post-deployment telemetry is NEVER marked authoritative', async () => {
      const server = createMcpServer(userA, jsonStorage);

      // Setup finding
      const auditId = 'aud_sim_isolation_01';
      const findingId = 'fnd_sim_isolation_01';
      await jsonStorage.saveAudit({
        audit_id: auditId,
        user_id: userA.id,
        source: 'langfuse',
        total_spend_usd: 1000,
        potential_savings_usd: 200,
        annualized_savings_projection_usd: 2400,
        is_sample_data: false,
        findings_count: 1,
        created_at: new Date().toISOString(),
      });

      await jsonStorage.saveFinding({
        audit_id: auditId,
        finding_id: findingId,
        user_id: userA.id,
        rule_id: 'MODEL_RIGHT_SIZING',
        title: 'Title',
        summary: 'Summary',
        baseline_spend_usd: 1000,
        estimated_savings_usd: 200,
        annualized_projection_usd: 2400,
        eligible_event_count: 50,
        status: 'DETECTED',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      });

      // Post-deployment events marked with simulated data
      const simulatedTelemetryJson = JSON.stringify(
        Array.from({ length: 20 }, (_, i) => ({
          timestamp: new Date(Date.now() - (20 - i) * 60000).toISOString(),
          model: 'gpt-4o-mini',
          cost_usd: 0.001,
          is_simulated: true, // Marked simulated
        }))
      );

      const verifyTool = (server as any)._registeredTools['evaluate_verification'];
      const result = await verifyTool.handler({
        finding_id: findingId,
        audit_id: auditId,
        telemetry_data: simulatedTelemetryJson,
      });

      assert.strictEqual(result.isError, undefined);
      const payload = JSON.parse(result.content[0].text);

      // Critical commercial invariant: is_authoritative must be false!
      assert.strictEqual(payload.is_authoritative, false);
      assert.strictEqual(payload.annualized_realized_savings_usd, 0);
      assert.strictEqual(payload.outcome_fee, null);
    });
  });
});
