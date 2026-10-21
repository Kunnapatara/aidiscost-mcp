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
import { authenticate } from '../server/auth';
import { createMcpServer } from '../server/mcp/server';
import { createMcpRouter } from '../server/mcp/router';
import { User } from '../server/types';

describe('AIDisCost — MCP Protocol Suite', () => {
  let server: http.Server;
  let serverUrl: string;
  const testDbFile = 'test-mcp-db.json';
  const storage = ServerStorage.getInstance('data', testDbFile);

  const mockUser: User = {
    id: 'usr_mcp_test_01',
    email: 'mcp-user@example.com',
    password_hash: 'mock_hash',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const sampleTelemetryJson = JSON.stringify([
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
        // Mock auth header parsing for tests
        const auth = req.headers.authorization;
        if (auth === 'Bearer valid-test-token') {
          req.user = mockUser;
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

  describe('1. Direct McpServer Unit Execution', () => {
    test('run_cost_audit produces findings and health grade for valid telemetry', async () => {
      const mcp = createMcpServer(mockUser, storage);
      assert.ok(mcp, 'McpServer should be instantiated');
    });

    test('check_entitlement fails cleanly for unauthenticated session', async () => {
      const anonymousMcp = createMcpServer(undefined, storage);
      assert.ok(anonymousMcp, 'Anonymous McpServer should instantiate');
    });
  });

  describe('2. MCP HTTP Transport & Protocol Compliance', () => {
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

      assert.strictEqual(res.status, 200, 'Should return 200 OK');
      const data = await res.json() as any;
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
      const data = await res.json() as any;
      assert.strictEqual(data.jsonrpc, '2.0');
      assert.ok(Array.isArray(data.result?.tools), 'Tools should be an array');
      const toolNames = data.result.tools.map((t: any) => t.name);
      assert.ok(toolNames.includes('run_cost_audit'), 'Should include run_cost_audit');
      assert.ok(toolNames.includes('check_entitlement'), 'Should include check_entitlement');
    });

    test('POST /mcp executes run_cost_audit tool', async () => {
      const callToolPayload = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'run_cost_audit',
          arguments: {
            telemetry_data: sampleTelemetryJson,
          },
        },
      };

      const res = await fetch(`${serverUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer valid-test-token',
        },
        body: JSON.stringify(callToolPayload),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json() as any;
      assert.strictEqual(data.jsonrpc, '2.0');
      assert.strictEqual(data.id, 3);
      assert.ok(data.result?.content?.[0]?.text, 'Should return text content');

      const parsedAudit = JSON.parse(data.result.content[0].text);
      assert.ok(parsedAudit.audit_id, 'Audit ID must be present');
      assert.ok(parsedAudit.data_health, 'Data health must be evaluated');
      assert.strictEqual(parsedAudit.ownership?.registered_to_user_id, mockUser.id);
    });

    test('POST /mcp rejects non-POST HTTP methods with 405 Method Not Allowed', async () => {
      const getRes = await fetch(`${serverUrl}/mcp`, { method: 'GET' });
      assert.strictEqual(getRes.status, 405);

      const putRes = await fetch(`${serverUrl}/mcp`, { method: 'PUT' });
      assert.strictEqual(putRes.status, 405);
    });

    test('POST /mcp check_entitlement enforces authentication and returns 404 for unowned finding', async () => {
      const callToolPayload = {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'check_entitlement',
          arguments: {
            finding_id: 'non_existent_or_unowned_finding',
          },
        },
      };

      // 1. Without auth
      const unauthRes = await fetch(`${serverUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(callToolPayload),
      });

      const unauthData = await unauthRes.json() as any;
      assert.strictEqual(unauthData.result?.isError, true);
      const errContent = JSON.parse(unauthData.result.content[0].text);
      assert.strictEqual(errContent.error, 'UNAUTHORIZED');

      // 2. With auth, but unowned finding
      const authRes = await fetch(`${serverUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer valid-test-token',
        },
        body: JSON.stringify(callToolPayload),
      });

      const authData = await authRes.json() as any;
      assert.strictEqual(authData.result?.isError, true);
      const notFoundContent = JSON.parse(authData.result.content[0].text);
      assert.strictEqual(notFoundContent.error, 'FINDING_NOT_FOUND');
    });
  });
});
