/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { DrizzleStorageAdapter } from '../server/db/adapter';
import * as schema from '../server/db/schema';
import { initializeDatabaseSchema } from '../server/db';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { User, Entitlement, ProcessedWebhookEvent, OutcomeFeeObligation } from '../server/types';

describe('AIDisCost MCP — Phase 3 Database & Webhook Recovery Suite', () => {
  const tempDir = path.resolve(process.cwd(), 'data', 'test-recovery');
  const sharedDbFile = path.resolve(tempDir, 'shared-recovery.db');
  const sharedDbUrl = `file:${sharedDbFile}`;

  before(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  after(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error on file lock
    }
  });

  // =========================================================================
  // 1. Two Independent DB Clients on Same SQLite File
  // =========================================================================
  describe('1. Multi-Client Database Concurrency & Isolation', () => {
    test('Two independent DB adapters pointing to same file observe committed state across clients', async () => {
      // Client A
      const clientA = createClient({ url: sharedDbUrl });
      const dbA = drizzle(clientA, { schema });
      await initializeDatabaseSchema(clientA);
      const adapterA = new DrizzleStorageAdapter(dbA, clientA);

      // Client B (completely independent in-memory adapter pointing to same file)
      const clientB = createClient({ url: sharedDbUrl });
      const dbB = drizzle(clientB, { schema });
      const adapterB = new DrizzleStorageAdapter(dbB, clientB);

      const user: User = {
        id: `usr_multi_${crypto.randomUUID()}`,
        email: 'multiclient@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Written via Adapter A
      await adapterA.createUser(user);

      // Immediately queryable via Adapter B
      const foundInB = await adapterB.getUserById(user.id);
      assert.ok(foundInB, 'Client B must observe user committed by Client A');
      assert.strictEqual(foundInB.email, user.email);

      // Process event via Adapter A
      const event: ProcessedWebhookEvent = {
        event_id: `evt_shared_${crypto.randomUUID()}`,
        provider: 'LEMON_SQUEEZY',
        event_name: 'order_created',
        user_id: user.id,
        finding_id: 'fnd_shared_01',
        order_id: 'ord_shared_01',
        processed_at: new Date().toISOString(),
      };
      const entitlement: Entitlement = {
        id: `ent_shared_${crypto.randomUUID()}`,
        user_id: user.id,
        finding_id: 'fnd_shared_01',
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_shared_01',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const resA = await adapterA.processOrderCreatedWebhookTransaction({ event, entitlement });
      assert.strictEqual(resA.status, 'SUCCESS');

      // Adapter B checks hasActivePaidEntitlement
      const hasPaidB = await adapterB.hasActivePaidEntitlement(user.id, 'fnd_shared_01');
      assert.strictEqual(hasPaidB, true, 'Client B must observe active entitlement committed by Client A');

      // Cleanup clients
      clientA.close();
      clientB.close();
    });
  });

  // =========================================================================
  // 2. Duplicate Event Delivery Across Connections
  // =========================================================================
  describe('2. Cross-Connection Webhook Deduplication', () => {
    test('Simultaneous delivery of identical event to separate DB adapter instances resolves safely with 1 SUCCESS and 1 DUPLICATE', async () => {
      const client1 = createClient({ url: sharedDbUrl });
      const db1 = drizzle(client1, { schema });
      const adapter1 = new DrizzleStorageAdapter(db1, client1);

      const client2 = createClient({ url: sharedDbUrl });
      const db2 = drizzle(client2, { schema });
      const adapter2 = new DrizzleStorageAdapter(db2, client2);

      const userId = `usr_concurrent_${crypto.randomUUID()}`;
      await adapter1.createUser({
        id: userId,
        email: 'concurrent@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const eventId = `evt_race_${crypto.randomUUID()}`;
      const event: ProcessedWebhookEvent = {
        event_id: eventId,
        provider: 'LEMON_SQUEEZY',
        event_name: 'order_created',
        user_id: userId,
        finding_id: 'fnd_race_01',
        order_id: 'ord_race_01',
        processed_at: new Date().toISOString(),
      };
      const entitlement: Entitlement = {
        id: `ent_race_${crypto.randomUUID()}`,
        user_id: userId,
        finding_id: 'fnd_race_01',
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_race_01',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Fire simultaneously to two separate adapters
      const [res1, res2] = await Promise.all([
        adapter1.processOrderCreatedWebhookTransaction({ event, entitlement }),
        adapter2.processOrderCreatedWebhookTransaction({ event, entitlement }),
      ]);

      const statuses = [res1.status, res2.status];
      assert.strictEqual(statuses.filter((s) => s === 'SUCCESS').length, 1, 'Exactly 1 adapter must commit SUCCESS');
      assert.strictEqual(statuses.filter((s) => s === 'DUPLICATE').length, 1, 'Exactly 1 adapter must return DUPLICATE');

      client1.close();
      client2.close();
    });
  });

  // =========================================================================
  // 3. Out-of-Order Webhook Event Delivery
  // =========================================================================
  describe('3. Out-of-Order Event Delivery Resilience', () => {
    test('Outcome Fee: order_settled arriving before order_created establishes SETTLED, and late order_created cannot regress it', async () => {
      const client = createClient({ url: sharedDbUrl });
      const db = drizzle(client, { schema });
      const adapter = new DrizzleStorageAdapter(db, client);

      const userId = `usr_ooo_${crypto.randomUUID()}`;
      const findingId = `fnd_ooo_${crypto.randomUUID()}`;

      await adapter.createUser({
        id: userId,
        email: 'ooo@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await adapter.registerFindingOwnership(findingId, userId);

      const verId = `ver_${crypto.randomUUID()}`;
      await adapter.saveVerification({
        id: verId,
        finding_id: findingId,
        user_id: userId,
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 20,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 12000.0,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const obligation: OutcomeFeeObligation = {
        id: `of_${crypto.randomUUID()}`,
        user_id: userId,
        finding_id: findingId,
        verification_id: verId,
        verified_annualized_savings_usd: 12000,
        fee_amount_usd: 1000,
        currency: 'USD',
        status: 'CHECKOUT_CREATED',
        provider: 'LEMON_SQUEEZY',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createOutcomeFeeObligation(obligation);

      // Event 1: order_settled arrives FIRST!
      const settleEvent: ProcessedWebhookEvent = {
        event_id: `evt_settle_early_${crypto.randomUUID()}`,
        provider: 'LEMON_SQUEEZY',
        event_name: 'order_settled',
        user_id: userId,
        finding_id: findingId,
        order_id: 'ord_settled_early_01',
        processed_at: new Date().toISOString(),
      };
      const resSettle = await adapter.processOutcomeFeeWebhookTransaction({
        event: settleEvent,
        obligation: {
          ...obligation,
          status: 'SETTLED',
          provider_order_id: 'ord_settled_early_01',
          provider_transaction_id: 'ord_settled_early_01',
        },
      });
      assert.strictEqual(resSettle.status, 'SUCCESS');

      const storedAfterSettle = await adapter.getOutcomeFeeObligation(findingId, userId);
      assert.strictEqual(storedAfterSettle?.status, 'SETTLED');

      // Event 2: delayed order_created arrives SECOND!
      const lateCreateEvent: ProcessedWebhookEvent = {
        event_id: `evt_create_late_${crypto.randomUUID()}`,
        provider: 'LEMON_SQUEEZY',
        event_name: 'order_created',
        user_id: userId,
        finding_id: findingId,
        order_id: 'ord_settled_early_01',
        processed_at: new Date().toISOString(),
      };
      const resLate = await adapter.processOutcomeFeeWebhookTransaction({
        event: lateCreateEvent,
        obligation: {
          ...obligation,
          status: 'PAID', // Late event claims status is PAID
          provider_order_id: 'ord_settled_early_01',
          provider_transaction_id: 'ord_settled_early_01',
        },
      });
      assert.strictEqual(resLate.status, 'SUCCESS');

      // Monotonic guard: status MUST REMAIN SETTLED!
      const storedAfterLate = await adapter.getOutcomeFeeObligation(findingId, userId);
      assert.strictEqual(storedAfterLate?.status, 'SETTLED', 'Delayed order_created must not regress SETTLED');

      client.close();
    });

    test('Fix Package: delayed order_created after order_refunded cannot reactivate REVOKED entitlement', async () => {
      const client = createClient({ url: sharedDbUrl });
      const db = drizzle(client, { schema });
      const adapter = new DrizzleStorageAdapter(db, client);

      const userId = `usr_rev_${crypto.randomUUID()}`;
      const findingId = `fnd_rev_${crypto.randomUUID()}`;

      await adapter.createUser({
        id: userId,
        email: 'rev@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Initially active
      await adapter.createEntitlement({
        id: `ent_rev_${crypto.randomUUID()}`,
        user_id: userId,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_refund_target_01',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Refund event arrives
      const refundEvent: ProcessedWebhookEvent = {
        event_id: `evt_refund_${crypto.randomUUID()}`,
        provider: 'LEMON_SQUEEZY',
        event_name: 'order_refunded',
        user_id: userId,
        finding_id: findingId,
        order_id: 'ord_refund_target_01',
        processed_at: new Date().toISOString(),
      };
      const refundRes = await adapter.processOrderRefundedWebhookTransaction({
        event: refundEvent,
        userId,
        findingId,
        orderId: 'ord_refund_target_01',
      });
      assert.strictEqual(refundRes.status, 'SUCCESS');

      const storedEnt = await adapter.getEntitlement(userId, findingId);
      assert.strictEqual(storedEnt?.status, 'REVOKED');

      // Delayed duplicate order_created arrives after refund
      const delayedEvent: ProcessedWebhookEvent = {
        event_id: `evt_delayed_create_${crypto.randomUUID()}`,
        provider: 'LEMON_SQUEEZY',
        event_name: 'order_created',
        user_id: userId,
        finding_id: findingId,
        order_id: 'ord_refund_target_01',
        processed_at: new Date().toISOString(),
      };
      await adapter.processOrderCreatedWebhookTransaction({
        event: delayedEvent,
        entitlement: {
          id: `ent_late_${crypto.randomUUID()}`,
          user_id: userId,
          finding_id: findingId,
          type: 'PAID_FIX_PACKAGE',
          status: 'ACTIVE',
          provider: 'LEMON_SQUEEZY',
          provider_transaction_id: 'ord_refund_target_01',
          amount_usd: 49.0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });

      // Must STAY REVOKED
      const finalEnt = await adapter.getEntitlement(userId, findingId);
      assert.strictEqual(finalEnt?.status, 'REVOKED', 'Delayed order_created must not reactivate REVOKED entitlement');

      client.close();
    });
  });

  // =========================================================================
  // 4. Server Restart & Disk Persistence Test
  // =========================================================================
  describe('4. Server Restart & Storage Idempotency', () => {
    test('State written to disk survives process restart and re-initialization', async () => {
      const dbFile = path.resolve(tempDir, 'restart-test.db');
      const dbUrl = `file:${dbFile}`;

      // Run instance 1
      const client1 = createClient({ url: dbUrl });
      const db1 = drizzle(client1, { schema });
      await initializeDatabaseSchema(client1);
      const adapter1 = new DrizzleStorageAdapter(db1, client1);

      const userId = `usr_restart_${crypto.randomUUID()}`;
      await adapter1.createUser({
        id: userId,
        email: 'restart@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      await adapter1.saveCheckoutAttempt({
        id: `att_${crypto.randomUUID()}`,
        user_id: userId,
        finding_id: 'fnd_restart_01',
        product: 'FIX_PACKAGE',
        checkout_url: 'https://aidiscost.lemonsqueezy.com/buy/session-restart',
        status: 'PENDING',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      client1.close();

      // Simulate process restart: Instance 2 opens same file
      const client2 = createClient({ url: dbUrl });
      const db2 = drizzle(client2, { schema });
      const adapter2 = new DrizzleStorageAdapter(db2, client2);

      const userRestored = await adapter2.getUserById(userId);
      assert.ok(userRestored, 'User must exist after restart');

      const attemptRestored = await adapter2.getActiveCheckoutAttempt(userId, 'fnd_restart_01', 'FIX_PACKAGE');
      assert.ok(attemptRestored, 'Checkout attempt must survive restart');
      assert.strictEqual(attemptRestored.checkout_url, 'https://aidiscost.lemonsqueezy.com/buy/session-restart');

      client2.close();
    });
  });

  // =========================================================================
  // 5. Disposable SQLite Migration Runner Test (0000 -> 0008)
  // =========================================================================
  describe('5. Disposable SQLite Migration Execution (0000 -> 0008)', () => {
    test('Versioned Drizzle migrations execute successfully from scratch on a brand-new disposable SQLite file', async () => {
      const disposableDbFile = path.resolve(tempDir, `disposable-migration-${Date.now()}.db`);
      const disposableClient = createClient({ url: `file:${disposableDbFile}` });
      const db = drizzle(disposableClient, { schema });
      const migrationsFolder = path.resolve(process.cwd(), 'drizzle', 'migrations');

      // Run versioned migrations from drizzle/migrations directory
      await disposableClient.execute('PRAGMA foreign_keys = OFF;');
      await migrate(db, { migrationsFolder });
      await disposableClient.execute('PRAGMA foreign_keys = ON;');

      // Verify tables exist in SQLite sqlite_master
      const tablesRes = await disposableClient.execute(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`
      );
      const tableNames = tablesRes.rows.map((r: any) => String(r.name));

      assert.ok(tableNames.includes('users'), 'users table must exist');
      assert.ok(tableNames.includes('entitlements'), 'entitlements table must exist');
      assert.ok(tableNames.includes('outcome_fee_obligations'), 'outcome_fee_obligations table must exist');
      assert.ok(tableNames.includes('webhook_events'), 'webhook_events table must exist');
      assert.ok(tableNames.includes('checkout_attempts'), 'checkout_attempts table must exist from migration 0008');
      assert.ok(tableNames.includes('payment_reconciliations'), 'payment_reconciliations table must exist from migration 0008');

      // Verify columns in outcome_fee_obligations include checkout_id
      const columnsRes = await disposableClient.execute(
        `PRAGMA table_info(outcome_fee_obligations);`
      );
      const columnNames = columnsRes.rows.map((r: any) => String(r.name));
      assert.ok(columnNames.includes('checkout_id'), 'checkout_id column must exist in outcome_fee_obligations');

      disposableClient.close();
    });
  });
});
