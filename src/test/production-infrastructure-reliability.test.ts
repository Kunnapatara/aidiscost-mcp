/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { createDatabaseConnection, initializeDatabaseSchema, verifyDatabaseSchemaPresence } from '../server/db/index';
import { DrizzleStorageAdapter } from '../server/db/adapter';
import { runDatabaseMigrations } from '../../scripts/migrate-db';
import { runProductionStartupPreflight, createServerApp } from '../../server';
import { createApiRouter } from '../server/api';
import { createMcpRouter, resetRateLimitsForTesting, getClientIdentifier } from '../server/mcp/router';
import { authenticate } from '../server/auth';
import { setStorage, getStorage } from '../server/storage';
import { User, Entitlement, ProcessedWebhookEvent } from '../server/types';

describe('AIDisCost MCP — Production Infrastructure & Reliability Readiness Suite', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
    resetRateLimitsForTesting();
  });

  afterEach(() => {
    process.env = { ...origEnv };
    setStorage(null);
  });

  // =========================================================================
  // Requirement 1 & 2: Production Startup Env Var Validation
  // =========================================================================
  describe('1 & 2. Production Startup Fail-Closed Validation', () => {
    it('1. Production startup without TURSO_DATABASE_URL fails closed with fatal error', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.TURSO_DATABASE_URL;
      delete process.env.TURSO_AUTH_TOKEN;

      await assert.rejects(
        async () => {
          await runProductionStartupPreflight();
        },
        (err: Error) => {
          assert.ok(err.message.includes('TURSO_DATABASE_URL is required'));
          assert.ok(err.message.includes('FATAL PRODUCTION CONFIGURATION ERROR'));
          return true;
        }
      );
    });

    it('2. Production remote Turso (libsql://) without TURSO_AUTH_TOKEN fails closed with fatal error', async () => {
      process.env.NODE_ENV = 'production';
      process.env.TURSO_DATABASE_URL = 'libsql://demo-app.turso.io';
      delete process.env.TURSO_AUTH_TOKEN;

      await assert.rejects(
        async () => {
          await runProductionStartupPreflight();
        },
        (err: Error) => {
          assert.ok(err.message.includes('TURSO_AUTH_TOKEN is required'));
          assert.ok(err.message.includes('FATAL PRODUCTION CONFIGURATION ERROR'));
          return true;
        }
      );
    });

    it('2b. Production remote Turso (https://) without TURSO_AUTH_TOKEN fails closed with fatal error', async () => {
      process.env.NODE_ENV = 'production';
      process.env.TURSO_DATABASE_URL = 'https://demo-app.turso.io';
      delete process.env.TURSO_AUTH_TOKEN;

      await assert.rejects(
        async () => {
          await runProductionStartupPreflight();
        },
        (err: Error) => {
          assert.ok(err.message.includes('TURSO_AUTH_TOKEN is required'));
          return true;
        }
      );
    });
  });

  // =========================================================================
  // Requirement 3 & 4: Database Unreachable & Incompatible/Missing Schema
  // =========================================================================
  describe('3 & 4. Database Reachability & Schema Preflight', () => {
    it('3. Database unreachable causes startup preflight failure', async () => {
      process.env.NODE_ENV = 'production';
      // Unreachable address
      process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:54321/non-existent-db';
      process.env.TURSO_AUTH_TOKEN = 'dummy_token';

      await assert.rejects(
        async () => {
          await runProductionStartupPreflight();
        },
        (err: Error) => {
          assert.ok(
            err.message.includes('Database preflight check failed') ||
            err.message.includes('unreachable')
          );
          return true;
        }
      );
    });

    it('4. Blank database without required tables fails readiness and preflight', async () => {
      const conn = createDatabaseConnection({ url: ':memory:' });
      // We do NOT call initializeDatabaseSchema or run migrations. It's completely blank.
      const adapter = new DrizzleStorageAdapter(conn.db, conn.client);

      // checkReadiness must return false because schema tables are missing
      const isReady = await adapter.checkReadiness();
      assert.strictEqual(isReady, false, 'Readiness must be false when tables are missing');

      const presence = await verifyDatabaseSchemaPresence(conn.client);
      assert.strictEqual(presence.ready, false);
      assert.strictEqual(presence.missingTables.length, 9);
      assert.ok(presence.missingTables.includes('audits'));
      assert.ok(presence.missingTables.includes('findings'));
      assert.ok(presence.missingTables.includes('entitlements'));

      conn.client.close();
    });

    it('4b. Database with initialized schema passes readiness check', async () => {
      const conn = createDatabaseConnection({ url: ':memory:' });
      await initializeDatabaseSchema(conn.client);
      const adapter = new DrizzleStorageAdapter(conn.db, conn.client);

      const isReady = await adapter.checkReadiness();
      assert.strictEqual(isReady, true);

      const presence = await verifyDatabaseSchemaPresence(conn.client);
      assert.strictEqual(presence.ready, true);
      assert.strictEqual(presence.missingTables.length, 0);

      conn.client.close();
    });
  });

  // =========================================================================
  // Requirement 5 & 6: Migration Re-run Safety & Failure Surfacing
  describe('5 & 6. Migration Re-run Safety and Error Surfacing', () => {
    it('5. Re-running database migrations on existing database is safe and idempotent', async () => {
      const dataDir = path.resolve(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const dbPath = path.resolve(dataDir, `test-migration-${Date.now()}.db`);
      process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
      delete process.env.TURSO_AUTH_TOKEN;

      try {
        // Run migrations first time
        await runDatabaseMigrations();

        // Run migrations second time (idempotency check)
        await runDatabaseMigrations();

        const conn = createDatabaseConnection({ url: `file:${dbPath}` });
        const presence = await verifyDatabaseSchemaPresence(conn.client);
        assert.strictEqual(presence.ready, true, 'All tables must remain intact after re-running migrations');
        conn.client.close();
      } finally {
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
        }
      }
    });

    it('6. Migration script fails closed when remote Turso lacks auth token in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.TURSO_DATABASE_URL = 'libsql://unauthenticated-db.turso.io';
      delete process.env.TURSO_AUTH_TOKEN;

      await assert.rejects(
        async () => {
          await runDatabaseMigrations();
        },
        /TURSO_AUTH_TOKEN is required/
      );
    });
  });

  // =========================================================================
  // Requirement 7: Database Write Failures Are Not Reported as Success
  // =========================================================================
  describe('7. Database Write Failure Propagation', () => {
    it('propagates database constraint violations and does not report them as successful writes', async () => {
      const conn = createDatabaseConnection({ url: ':memory:' });
      await initializeDatabaseSchema(conn.client);
      const adapter = new DrizzleStorageAdapter(conn.db, conn.client);

      const user: User = {
        id: 'usr_write_fail_1',
        email: 'user1@example.com',
        password_hash: 'hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      // Attempting to create duplicate user with same email must fail closed
      await assert.rejects(
        async () => {
          await adapter.createUser({ ...user, id: 'usr_write_fail_2' });
        },
        /already exists/
      );

      conn.client.close();
    });
  });

  // =========================================================================
  // Requirement 8, 9, 10: Webhook Concurrency, Replay, Delayed Events, Idempotency
  // =========================================================================
  describe('8, 9, 10. Webhook Idempotency Across Instances & Monotonic Revocation', () => {
    let conn: any;
    let adapter1: DrizzleStorageAdapter;
    let adapter2: DrizzleStorageAdapter;

    beforeEach(async () => {
      conn = createDatabaseConnection({ url: ':memory:' });
      await initializeDatabaseSchema(conn.client);
      // Simulate two independent application instances pointing to the same shared database
      adapter1 = new DrizzleStorageAdapter(conn.db, conn.client);
      adapter2 = new DrizzleStorageAdapter(conn.db, conn.client);
    });

    afterEach(() => {
      if (conn?.client) {
        conn.client.close();
      }
    });

    it('8. Webhook duplicate delivery across two separate adapter instances is handled safely', async () => {
      const user: User = {
        id: 'usr_wh_multi_1',
        email: 'wh_multi@example.com',
        password_hash: 'hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter1.createUser(user);

      const findingId = 'fnd_wh_multi_1';
      const event: ProcessedWebhookEvent = {
        event_id: 'evt_wh_concurrent_001',
        provider: 'LEMON_SQUEEZY',
        event_name: 'order_created',
        user_id: user.id,
        finding_id: findingId,
        order_id: 'ord_wh_multi_1',
        processed_at: new Date().toISOString(),
      };

      const entitlement: Entitlement = {
        id: 'ent_wh_multi_1',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_wh_multi_1',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Instance 1 processes the event
      const res1 = await adapter1.processOrderCreatedWebhookTransaction({ event, entitlement });
      assert.strictEqual(res1.status, 'SUCCESS');

      // Instance 2 (which has an empty in-memory cache) receives the exact same event
      const res2 = await adapter2.processOrderCreatedWebhookTransaction({ event, entitlement });
      assert.strictEqual(res2.status, 'DUPLICATE', 'Instance 2 must detect database duplicate');

      const isEntitled = await adapter2.hasActivePaidEntitlement(user.id, findingId);
      assert.strictEqual(isEntitled, true);
    });

    it('9. Webhook replay after process restart remains idempotent', async () => {
      const user: User = {
        id: 'usr_replay_1',
        email: 'replay@example.com',
        password_hash: 'hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter1.createUser(user);

      const findingId = 'fnd_replay_1';
      const event: ProcessedWebhookEvent = {
        event_id: 'evt_replay_100',
        provider: 'LEMON_SQUEEZY',
        event_name: 'order_created',
        user_id: user.id,
        finding_id: findingId,
        order_id: 'ord_replay_100',
        processed_at: new Date().toISOString(),
      };

      const entitlement: Entitlement = {
        id: 'ent_replay_1',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_replay_100',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await adapter1.processOrderCreatedWebhookTransaction({ event, entitlement });

      // Simulate a fresh restart: new adapter instance with no prior memory cache
      const restartedAdapter = new DrizzleStorageAdapter(conn.db, conn.client);

      // Replay the exact same webhook
      const replayRes = await restartedAdapter.processOrderCreatedWebhookTransaction({ event, entitlement });
      assert.strictEqual(replayRes.status, 'DUPLICATE');
    });

    it('10. Refund/revocation cannot be undone by delayed order_created events (monotonic revocation)', async () => {
      const user: User = {
        id: 'usr_monotonic_1',
        email: 'mono@example.com',
        password_hash: 'hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter1.createUser(user);

      const findingId = 'fnd_monotonic_1';
      const orderId = 'ord_monotonic_101';

      // 1. Initial purchase
      await adapter1.processOrderCreatedWebhookTransaction({
        event: {
          event_id: 'evt_mono_created',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_created',
          user_id: user.id,
          finding_id: findingId,
          order_id: orderId,
          processed_at: new Date().toISOString(),
        },
        entitlement: {
          id: 'ent_mono_1',
          user_id: user.id,
          finding_id: findingId,
          type: 'PAID_FIX_PACKAGE',
          status: 'ACTIVE',
          provider: 'LEMON_SQUEEZY',
          provider_transaction_id: orderId,
          amount_usd: 49.0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });

      assert.strictEqual(await adapter1.hasActivePaidEntitlement(user.id, findingId), true);

      // 2. Refund executed
      const refundRes = await adapter1.processOrderRefundedWebhookTransaction({
        event: {
          event_id: 'evt_mono_refunded',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_refunded',
          user_id: user.id,
          finding_id: findingId,
          order_id: orderId,
          processed_at: new Date().toISOString(),
        },
        userId: user.id,
        findingId,
        orderId,
      });
      assert.strictEqual(refundRes.status, 'SUCCESS');
      assert.strictEqual(await adapter1.hasActivePaidEntitlement(user.id, findingId), false);

      // 3. Delayed order_created re-delivered for the same transaction
      const delayedRes = await adapter1.processOrderCreatedWebhookTransaction({
        event: {
          event_id: 'evt_delayed_order_created',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_created',
          user_id: user.id,
          finding_id: findingId,
          order_id: orderId,
          processed_at: new Date().toISOString(),
        },
        entitlement: {
          id: 'ent_mono_delayed',
          user_id: user.id,
          finding_id: findingId,
          type: 'PAID_FIX_PACKAGE',
          status: 'ACTIVE',
          provider: 'LEMON_SQUEEZY',
          provider_transaction_id: orderId,
          amount_usd: 49.0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });
      assert.strictEqual(delayedRes.status, 'SUCCESS');

      // Crucial: Entitlement must remain REVOKED
      const ent = await adapter1.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'REVOKED');
      assert.strictEqual(await adapter1.hasActivePaidEntitlement(user.id, findingId), false);

      // 4. Duplicate refund with differing event ID on already-revoked entitlement is acknowledged as SUCCESS (idempotent)
      const secondRefundRes = await adapter1.processOrderRefundedWebhookTransaction({
        event: {
          event_id: 'evt_second_refund_diff_id',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_refunded',
          user_id: user.id,
          finding_id: findingId,
          order_id: orderId,
          processed_at: new Date().toISOString(),
        },
        userId: user.id,
        findingId,
        orderId,
      });
      assert.strictEqual(secondRefundRes.status, 'SUCCESS');
      assert.strictEqual(secondRefundRes.entitlement?.status, 'REVOKED');
    });
  });

  // =========================================================================
  // Requirement 11: Health Liveness and Readiness Behave Independently
  // =========================================================================
  describe('11. Independent Health Liveness and Readiness Probes', () => {
    let server: http.Server;
    let serverUrl: string;

    beforeEach(async () => {
      const app = express();
      app.use('/api', createApiRouter());
      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
          const addr = server.address() as any;
          serverUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('liveness returns 200 even when database is completely disconnected, while readiness returns 503', async () => {
      // Mock broken storage to simulate total database outage
      const failingStorage: any = {
        checkReadiness: async () => false,
      };
      setStorage(failingStorage);

      // 1. Liveness must return 200 OK (process is running)
      const liveRes = await fetch(`${serverUrl}/api/health/live`);
      assert.strictEqual(liveRes.status, 200);
      const liveJson: any = await liveRes.json();
      assert.strictEqual(liveJson.status, 'live');

      // 2. Readiness must return 503 Service Unavailable (cannot accept traffic)
      const readyRes = await fetch(`${serverUrl}/api/health/ready`);
      assert.strictEqual(readyRes.status, 503);
      const readyJson: any = await readyRes.json();
      assert.strictEqual(readyJson.status, 'unavailable');
      assert.strictEqual(readyJson.database, 'disconnected');
    });
  });

  // =========================================================================
  // Requirement 12: MCP Rate-Limit Behavior & Client Identification
  // =========================================================================
  describe('12. MCP Rate Limiter Accuracy', () => {
    it('accurately resolves authenticated user vs anonymous IP identifier', () => {
      const authReq: any = {
        user: { id: 'usr_auth_rate_test', email: 'test@example.com' },
        ip: '10.0.0.5',
      };
      assert.strictEqual(getClientIdentifier(authReq), 'user:usr_auth_rate_test');

      const anonReq: any = {
        ip: '198.51.100.42',
      };
      assert.strictEqual(getClientIdentifier(anonReq), 'ip:198.51.100.42');
    });
  });

  // =========================================================================
  // Requirement 13: Graceful Shutdown Releases Resources
  // =========================================================================
  describe('13. Resource Cleanup and Graceful Shutdown', () => {
    it('DrizzleStorageAdapter close() safely shuts down connection client', async () => {
      const conn = createDatabaseConnection({ url: ':memory:' });
      await initializeDatabaseSchema(conn.client);
      const adapter = new DrizzleStorageAdapter(conn.db, conn.client);

      assert.strictEqual(await adapter.checkReadiness(), true);

      // Execute close
      adapter.close();

      // Subsequent query should fail because client is closed
      assert.strictEqual(await adapter.checkReadiness(), false);
    });
  });
});
