/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import { ServerStorage } from '../server/storage';
import { createMcpServer } from '../server/mcp/server';
import { createMcpRouter } from '../server/mcp/router';
import { User } from '../server/types';
import { generateSampleDataset } from '../engine/adapters/sample-data';
import { IStorage } from '../server/storage-interface';

describe('AIDisCost — MCP Protocol & Finding Ownership Suite', () => {
  let server: http.Server;
  let serverUrl: string;
  const testDbFile = 'test-mcp-db.json';
  const storage = ServerStorage.getInstance('data', testDbFile);

  const userA: User = {
    id: 'usr_mcp_test_a',
    email: 'user-a@example.com',
    password_hash: 'mock_hash_a',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const userB: User = {
    id: 'usr_mcp_test_b',
    email: 'user-b@example.com',
    password_hash: 'mock_hash_b',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Telemetry without findings (< 5 events)
  const minimalTelemetryJson = JSON.stringify([
    {
      timestamp: '2026-09-01T12:00:00Z',
      model: 'gpt-4o',
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      cost_usd: 0.01,
      latency_ms: 500,
    },
    {
      timestamp: '2026-09-01T12:05:00Z',
      model: 'gpt-4o',
      prompt_tokens: 1200,
      completion_tokens: 600,
      total_tokens: 1800,
      cost_usd: 0.012,
      latency_ms: 600,
    },
  ]);

  // Full dataset generating Model Right-Sizing & Retry Loop findings
  const sampleEvents = generateSampleDataset().events.map((e) => ({
    ...e,
    is_simulated: false,
  }));

  // Dataset generating only Model Right-Sizing finding
  const rightSizingEvents = sampleEvents
    .filter((e) => e.source_event_id.startsWith('sample_rs_'))
    .slice(0, 20);
  const singleFindingTelemetryJson = JSON.stringify(rightSizingEvents);

  // Combined dataset generating both Model Right-Sizing and Retry Loop findings
  const retryEvents = sampleEvents
    .filter((e) => e.source_event_id.startsWith('sample_retry_'))
    .slice(0, 20);
  const twoFindingsTelemetryJson = JSON.stringify([...rightSizingEvents.slice(0, 15), ...retryEvents]);

  before(async () => {
    if (!fs.existsSync('data')) {
      fs.mkdirSync('data', { recursive: true });
    }

    const app = express();
    app.use(
      '/mcp',
      express.json({ limit: '2mb' }),
      cookieParser(),
      (req: any, _res, next) => {
        const auth = req.headers.authorization;
        if (auth === 'Bearer token-user-a' || auth === 'Bearer valid-test-token') {
          req.user = userA;
        } else if (auth === 'Bearer token-user-b') {
          req.user = userB;
        }
        next();
      },
      createMcpRouter(storage)
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const filePath = `data/${testDbFile}`;
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
  });

  describe('1. MCP HTTP Transport & Protocol Compliance', () => {
    test('POST /mcp handles JSON-RPC initialize method', async () => {
      const initPayload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      };

      const res = await fetch(`${serverUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(initPayload),
      });

      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as any;
      assert.strictEqual(data.jsonrpc, '2.0');
      assert.strictEqual(data.id, 1);
      assert.ok(data.result?.serverInfo?.name === 'aidiscost-mcp');
    });

    test('POST /mcp lists available tools', async () => {
      const listToolsPayload = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      };

      const res = await fetch(`${serverUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(listToolsPayload),
      });

      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as any;
      assert.strictEqual(data.jsonrpc, '2.0');
      assert.ok(Array.isArray(data.result?.tools));
      const toolNames = data.result.tools.map((t: any) => t.name);
      assert.ok(toolNames.includes('run_cost_audit'));
      assert.ok(toolNames.includes('check_entitlement'));
    });

    test('POST /mcp rejects non-POST HTTP methods with 405 Method Not Allowed', async () => {
      const getRes = await fetch(`${serverUrl}/mcp`, { method: 'GET' });
      assert.strictEqual(getRes.status, 405);

      const putRes = await fetch(`${serverUrl}/mcp`, { method: 'PUT' });
      assert.strictEqual(putRes.status, 405);
    });

    test('POST /mcp executes run_cost_audit tool for minimal scan', async () => {
      const callToolPayload = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'run_cost_audit',
          arguments: {
            telemetry_data: minimalTelemetryJson,
          },
        },
      };

      const res = await fetch(`${serverUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer token-user-a',
        },
        body: JSON.stringify(callToolPayload),
      });

      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as any;
      assert.strictEqual(data.jsonrpc, '2.0');
      assert.strictEqual(data.id, 3);
      assert.ok(data.result?.content?.[0]?.text);

      const parsedAudit = JSON.parse(data.result.content[0].text);
      assert.ok(parsedAudit.audit_id);
      assert.ok(parsedAudit.data_health);
      assert.strictEqual(parsedAudit.ownership?.registered_to_user_id, userA.id);
      assert.strictEqual(parsedAudit.ownership?.ownership_confirmed, false);
      assert.strictEqual(parsedAudit.findings_count, 0);
    });
  });

  describe('2. Finding Ownership Safety & Verification (Scenarios A - F)', () => {
    // Scenario A: New Finding ownership
    test('Scenario A: User A runs an audit producing new findings -> registered and verified to User A', async () => {
      const callPayload = {
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
          name: 'run_cost_audit',
          arguments: {
            telemetry_data: singleFindingTelemetryJson,
          },
        },
      };

      const res = await fetch(`${serverUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer token-user-a',
        },
        body: JSON.stringify(callPayload),
      });

      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as any;
      const parsed = JSON.parse(data.result.content[0].text);

      assert.ok(parsed.findings_count >= 1, 'Should produce at least 1 finding');
      const findingId = parsed.findings[0].id;

      // Verify read-back from storage matches User A
      const storedOwner = await storage.getFindingOwner(findingId);
      assert.strictEqual(storedOwner, userA.id, 'Stored owner must be User A');

      // Verify response reports ownership confirmation accurately
      assert.strictEqual(parsed.ownership?.ownership_confirmed, true);
      assert.strictEqual(parsed.ownership?.registered_to_user_id, userA.id);
      assert.strictEqual(parsed.ownership?.confirmed_findings_count, parsed.findings_count);
      assert.strictEqual(parsed.ownership?.conflict_findings_count, 0);
      assert.strictEqual(parsed.ownership?.warning, undefined);
      assert.strictEqual(parsed.findings[0].is_owned_by_requesting_user, true);
    });

    // Scenario B: Finding already owned by another user
    test('Scenario B: Finding owned by User B -> User A audit does not transfer, claim ownership, or leak User B identity', async () => {
      // 1. Explicitly pre-register a finding to User B
      const foreignFindingId = 'fnd_foreign_model_test_b';
      await storage.registerFindingOwnership(foreignFindingId, userB.id);

      // Verify User B is the stored owner
      const initialOwner = await storage.getFindingOwner(foreignFindingId);
      assert.strictEqual(initialOwner, userB.id);

      // 2. Build a custom server where finding ID collision is encountered
      // We test via McpServer directly with a custom storage containing foreign finding
      const customStorage: IStorage = Object.assign(Object.create(storage), {
        async getFindingOwner(id: string) {
          if (id.startsWith('fnd_right_sizing_')) {
            return userB.id; // Owned by User B!
          }
          return storage.getFindingOwner(id);
        },
        async registerFindingOwnership(id: string, ownerId: string) {
          if (id.startsWith('fnd_right_sizing_')) {
            // Storage invariant: do not overwrite
            return { finding_id: id, owner_id: userB.id, created_at: new Date().toISOString() };
          }
          return storage.registerFindingOwnership(id, ownerId);
        },
      });

      const mcpUserA = createMcpServer(userA, customStorage);
      const callPayload = {
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: {
          name: 'run_cost_audit',
          arguments: {
            telemetry_data: singleFindingTelemetryJson,
          },
        },
      };

      // Call tool via HTTP endpoint mounted with customStorage
      const appB = express();
      appB.use(
        '/mcp',
        express.json({ limit: '2mb' }),
        cookieParser(),
        (req: any, _res, next) => {
          req.user = userA;
          next();
        },
        createMcpRouter(customStorage)
      );

      const serverB = appB.listen(0, '127.0.0.1');
      await new Promise<void>((r) => serverB.on('listening', r));
      const urlB = `http://127.0.0.1:${(serverB.address() as any).port}`;

      try {
        const res = await fetch(`${urlB}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(callPayload),
        });

        assert.strictEqual(res.status, 200);
        const rawText = await res.text();
        const data = JSON.parse(rawText);
        const parsed = JSON.parse(data.result.content[0].text);

        // Verify ownership was NOT transferred or claimed
        assert.strictEqual(parsed.ownership?.ownership_confirmed, false, 'ownership_confirmed must be false');
        assert.strictEqual(parsed.ownership?.registered_to_user_id, null, 'registered_to_user_id must be null');
        assert.ok(parsed.ownership?.conflict_findings_count >= 1, 'Conflict count must be >= 1');
        assert.ok(parsed.ownership?.warning, 'Warning message must be present');
        assert.ok(parsed.ownership?.warning.includes('already owned by another account'));

        // Non-disclosure verification: User B's identity must NOT appear anywhere in the response text
        assert.ok(!rawText.includes(userB.id), 'Must not leak User B ID');
        assert.ok(!rawText.includes(userB.email), 'Must not leak User B email');

        // Confirm stored owner remained User B
        const finalOwner = await customStorage.getFindingOwner('fnd_right_sizing_gpt-4o_gpt-4o-mini');
        assert.strictEqual(finalOwner, userB.id, 'Stored owner must remain User B');
      } finally {
        await new Promise<void>((r) => serverB.close(() => r()));
      }
    });

    // Scenario C: Multiple Findings and partial success
    test('Scenario C: Multiple findings with partial success -> reports partial outcome, no false total success', async () => {
      // Custom storage where finding 1 (right sizing) is owned by User B, but finding 2 (retry loop) is unowned
      let registeredRetryLoopOwner: string | null = null;
      const customStorage: IStorage = Object.assign(Object.create(storage), {
        async getFindingOwner(id: string) {
          if (id.startsWith('fnd_right_sizing_')) {
            return userB.id; // Owned by User B
          }
          if (id.startsWith('fnd_retry_loop_')) {
            return registeredRetryLoopOwner;
          }
          return storage.getFindingOwner(id);
        },
        async registerFindingOwnership(id: string, ownerId: string) {
          if (id.startsWith('fnd_right_sizing_')) {
            return { finding_id: id, owner_id: userB.id, created_at: new Date().toISOString() };
          }
          if (id.startsWith('fnd_retry_loop_')) {
            registeredRetryLoopOwner = ownerId;
            return { finding_id: id, owner_id: ownerId, created_at: new Date().toISOString() };
          }
          return storage.registerFindingOwnership(id, ownerId);
        },
      });

      const appC = express();
      appC.use(
        '/mcp',
        express.json({ limit: '2mb' }),
        cookieParser(),
        (req: any, _res, next) => {
          req.user = userA;
          next();
        },
        createMcpRouter(customStorage)
      );

      const serverC = appC.listen(0, '127.0.0.1');
      await new Promise<void>((r) => serverC.on('listening', r));
      const urlC = `http://127.0.0.1:${(serverC.address() as any).port}`;

      try {
        const callPayload = {
          jsonrpc: '2.0',
          id: 103,
          method: 'tools/call',
          params: {
            name: 'run_cost_audit',
            arguments: {
              telemetry_data: twoFindingsTelemetryJson,
            },
          },
        };

        const res = await fetch(`${urlC}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(callPayload),
        });

        assert.strictEqual(res.status, 200);
        const data = (await res.json()) as any;
        const parsed = JSON.parse(data.result.content[0].text);

        assert.strictEqual(parsed.findings_count, 2, 'Should produce 2 findings (right-sizing + retry loop)');
        assert.strictEqual(parsed.ownership?.ownership_confirmed, false, 'Partial success must NOT be confirmed as true');
        assert.strictEqual(parsed.ownership?.registered_to_user_id, null, 'Must not claim all findings registered to user');
        assert.strictEqual(parsed.ownership?.confirmed_findings_count, 1, '1 finding confirmed for User A');
        assert.strictEqual(parsed.ownership?.conflict_findings_count, 1, '1 finding conflicted with User B');
        assert.ok(parsed.ownership?.warning.includes('Partial ownership'));

        // Verify stored owners
        assert.strictEqual(registeredRetryLoopOwner, userA.id, 'Retry loop was registered to User A');
        const rightSizingOwner = await customStorage.getFindingOwner('fnd_right_sizing_gpt-4o_gpt-4o-mini');
        assert.strictEqual(rightSizingOwner, userB.id, 'Right sizing remains owned by User B');
      } finally {
        await new Promise<void>((r) => serverC.close(() => r()));
      }
    });

    // Scenario D: Entitlement cross-user access
    test('Scenario D: User B cannot access User A protected finding; User A access succeeds', async () => {
      const protectedFindingId = 'fnd_user_a_proprietary_999';
      await storage.registerFindingOwnership(protectedFindingId, userA.id);
      await storage.createEntitlement({
        id: 'ent_user_a_fix_package',
        user_id: userA.id,
        finding_id: protectedFindingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'tx_mock_123',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const checkPayload = {
        jsonrpc: '2.0',
        id: 104,
        method: 'tools/call',
        params: {
          name: 'check_entitlement',
          arguments: {
            finding_id: protectedFindingId,
          },
        },
      };

      // 1. User B attempts access -> Must be denied non-disclosingly
      const userBRes = await fetch(`${serverUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer token-user-b',
        },
        body: JSON.stringify(checkPayload),
      });

      assert.strictEqual(userBRes.status, 200);
      const userBData = (await userBRes.json()) as any;
      assert.strictEqual(userBData.result?.isError, true);
      const userBContent = JSON.parse(userBData.result.content[0].text);
      assert.strictEqual(userBContent.error, 'FINDING_NOT_FOUND');
      assert.strictEqual(userBContent.message, 'Finding not found or access denied.');
      assert.ok(!JSON.stringify(userBData).includes('ent_user_a_fix_package'), 'No entitlement ID leakage');

      // 2. User A attempts access -> Must succeed
      const userARes = await fetch(`${serverUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer token-user-a',
        },
        body: JSON.stringify(checkPayload),
      });

      assert.strictEqual(userARes.status, 200);
      const userAData = (await userARes.json()) as any;
      assert.strictEqual(userAData.result?.isError, undefined);
      const userAContent = JSON.parse(userAData.result.content[0].text);
      assert.strictEqual(userAContent.finding_id, protectedFindingId);
      assert.strictEqual(userAContent.is_owner, true);
      assert.strictEqual(userAContent.fix_package?.unlocked, true);
      assert.strictEqual(userAContent.fix_package?.entitlement_id, 'ent_user_a_fix_package');
    });

    // Scenario E: Concurrent request identity isolation
    test('Scenario E: Concurrent requests under distinct user identities do not cross-contaminate', async () => {
      const findingA = 'fnd_concurrent_a';
      const findingB = 'fnd_concurrent_b';
      await storage.registerFindingOwnership(findingA, userA.id);
      await storage.registerFindingOwnership(findingB, userB.id);

      const payloadA = {
        jsonrpc: '2.0',
        id: 201,
        method: 'tools/call',
        params: {
          name: 'check_entitlement',
          arguments: { finding_id: findingA },
        },
      };

      const payloadB = {
        jsonrpc: '2.0',
        id: 202,
        method: 'tools/call',
        params: {
          name: 'check_entitlement',
          arguments: { finding_id: findingB },
        },
      };

      // Execute concurrently
      const [resA, resB] = await Promise.all([
        fetch(`${serverUrl}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: 'Bearer token-user-a',
          },
          body: JSON.stringify(payloadA),
        }),
        fetch(`${serverUrl}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: 'Bearer token-user-b',
          },
          body: JSON.stringify(payloadB),
        }),
      ]);

      const dataA = (await resA.json()) as any;
      const dataB = (await resB.json()) as any;

      assert.strictEqual(dataA.id, 201);
      assert.strictEqual(dataB.id, 202);

      const contentA = JSON.parse(dataA.result.content[0].text);
      const contentB = JSON.parse(dataB.result.content[0].text);

      assert.strictEqual(contentA.finding_id, findingA);
      assert.strictEqual(contentA.is_owner, true);

      assert.strictEqual(contentB.finding_id, findingB);
      assert.strictEqual(contentB.is_owner, true);
    });

    // Scenario F: Ownership storage/verification failure
    test('Scenario F: Storage failure during ownership registration/verification reports truthful error and no confirmation', async () => {
      const failingStorage: IStorage = Object.assign(Object.create(storage), {
        async getFindingOwner() {
          return null; // Always says unowned
        },
        async registerFindingOwnership() {
          throw new Error('DATABASE_CONNECTION_LOST');
        },
      });

      const appF = express();
      appF.use(
        '/mcp',
        express.json({ limit: '2mb' }),
        cookieParser(),
        (req: any, _res, next) => {
          req.user = userA;
          next();
        },
        createMcpRouter(failingStorage)
      );

      const serverF = appF.listen(0, '127.0.0.1');
      await new Promise<void>((r) => serverF.on('listening', r));
      const urlF = `http://127.0.0.1:${(serverF.address() as any).port}`;

      try {
        const callPayload = {
          jsonrpc: '2.0',
          id: 105,
          method: 'tools/call',
          params: {
            name: 'run_cost_audit',
            arguments: {
              telemetry_data: singleFindingTelemetryJson,
            },
          },
        };

        const res = await fetch(`${urlF}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(callPayload),
        });

        assert.strictEqual(res.status, 200);
        const data = (await res.json()) as any;
        const parsed = JSON.parse(data.result.content[0].text);

        assert.strictEqual(parsed.ownership?.ownership_confirmed, false, 'Must not confirm ownership on failure');
        assert.strictEqual(parsed.ownership?.registered_to_user_id, null, 'Must not claim user registration');
        assert.ok(parsed.ownership?.failed_findings_count >= 1, 'Failed findings count must be recorded');
        assert.ok(parsed.ownership?.warning, 'Warning message must be present');
        assert.ok(parsed.ownership?.warning.includes('Ownership verification failed'));
      } finally {
        await new Promise<void>((r) => serverF.close(() => r()));
      }
    });
  });
});
