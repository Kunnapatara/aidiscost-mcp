/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { createDatabaseConnection, initializeDatabaseSchema } from '../server/db/index';
import { DrizzleStorageAdapter } from '../server/db/adapter';
import { migrateJsonToSql } from '../server/db/migrate-json';
import * as schema from '../server/db/schema';
import { User, UserSession, FindingOwnership, Entitlement, ProcessedWebhookEvent } from '../server/types';

describe('Turso/libSQL & Drizzle Persistence Test Suite', () => {
  let db: any;
  let client: any;
  let adapter: DrizzleStorageAdapter;

  beforeEach(async () => {
    const conn = createDatabaseConnection({ url: ':memory:' });
    db = conn.db;
    client = conn.client;
    await initializeDatabaseSchema(client);
    adapter = new DrizzleStorageAdapter(db, client);
  });

  afterEach(async () => {
    if (client) {
      client.close();
    }
  });

  describe('Database Schema & Constraints', () => {
    test('enforces user email uniqueness at database level', async () => {
      const user1: User = {
        id: 'usr_1',
        email: 'dev@aidiscost.io',
        password_hash: 'salt:hash1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user1);

      const user2: User = {
        id: 'usr_2',
        email: 'DEV@aidiscost.io', // case-insensitive duplicate
        password_hash: 'salt:hash2',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await assert.rejects(
        async () => {
          await adapter.createUser(user2);
        },
        /already exists/
      );
    });

    test('enforces finding ownership uniqueness (primary key) at database level', async () => {
      const user: User = {
        id: 'usr_owner_1',
        email: 'owner1@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const ownership1 = await adapter.registerFindingOwnership('fnd_unique_01', user.id);
      assert.strictEqual(ownership1.owner_id, user.id);

      // Attempting to register by another user returns the existing owner
      const ownership2 = await adapter.registerFindingOwnership('fnd_unique_01', 'usr_other');
      assert.strictEqual(ownership2.owner_id, user.id, 'Original owner must be preserved');
    });

    test('enforces composite uniqueness on entitlements (user_id, finding_id)', async () => {
      const user: User = {
        id: 'usr_ent_1',
        email: 'ent1@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const ent1: Entitlement = {
        id: 'ent_1',
        user_id: user.id,
        finding_id: 'fnd_ent_01',
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'order_1',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createEntitlement(ent1);

      // Updating with new order ID preserves natural uniqueness
      const ent2: Entitlement = {
        id: 'ent_2',
        user_id: user.id,
        finding_id: 'fnd_ent_01',
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'order_2_retry',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createEntitlement(ent2);

      const rows = await db.select().from(schema.entitlements);
      assert.strictEqual(rows.length, 1, 'Must contain exactly 1 entitlement row for user+finding');
      assert.strictEqual(rows[0].providerTransactionId, 'order_2_retry');
    });
  });

  describe('Storage CRUD & Session Operations', () => {
    test('user creation and lookup by ID and email', async () => {
      const user: User = {
        id: 'usr_lookup_1',
        email: 'test@aidiscost.io',
        password_hash: 'salt:hash123',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const byEmail = await adapter.getUserByEmail('test@aidiscost.io');
      assert.ok(byEmail);
      assert.strictEqual(byEmail?.id, 'usr_lookup_1');

      const byId = await adapter.getUserById('usr_lookup_1');
      assert.ok(byId);
      assert.strictEqual(byId?.email, 'test@aidiscost.io');
    });

    test('session creation, retrieval, and expiration purge', async () => {
      const user: User = {
        id: 'usr_session_1',
        email: 'session@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const validToken = 'token_valid_123';
      const validSession: UserSession = {
        token: validToken,
        user_id: user.id,
        expires_at: new Date(Date.now() + 100000).toISOString(),
        created_at: new Date().toISOString(),
      };
      await adapter.createSession(validSession);

      const sessionLookup = await adapter.getSession(validToken);
      assert.ok(sessionLookup);
      assert.strictEqual(sessionLookup?.user.id, user.id);

      // Expired session
      const expiredToken = 'token_expired_123';
      const expiredSession: UserSession = {
        token: expiredToken,
        user_id: user.id,
        expires_at: new Date(Date.now() - 1000).toISOString(),
        created_at: new Date().toISOString(),
      };
      await adapter.createSession(expiredSession);

      const expiredLookup = await adapter.getSession(expiredToken);
      assert.strictEqual(expiredLookup, null, 'Expired session must return null and be purged');
    });

    test('session deletion on logout', async () => {
      const user: User = {
        id: 'usr_logout_1',
        email: 'logout@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const token = 'token_logout_123';
      await adapter.createSession({
        token,
        user_id: user.id,
        expires_at: new Date(Date.now() + 100000).toISOString(),
        created_at: new Date().toISOString(),
      });

      const deleted = await adapter.deleteSession(token);
      assert.strictEqual(deleted, true);

      const lookup = await adapter.getSession(token);
      assert.strictEqual(lookup, null);
    });
  });

  describe('Transactional Webhook Idempotency & Commercial Invariants', () => {
    test('transaction commits event and entitlement atomically on valid order_created', async () => {
      const user: User = {
        id: 'usr_pay_1',
        email: 'pay1@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const event: ProcessedWebhookEvent = {
        event_id: 'ls_evt_atom_01',
        provider: 'LEMON_SQUEEZY',
        event_name: 'order_created',
        user_id: user.id,
        finding_id: 'fnd_atom_01',
        order_id: 'order_atom_01',
        processed_at: new Date().toISOString(),
      };

      const entitlement: Entitlement = {
        id: 'ent_atom_01',
        user_id: user.id,
        finding_id: 'fnd_atom_01',
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'order_atom_01',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const result = await adapter.processOrderCreatedWebhookTransaction({ event, entitlement });
      assert.strictEqual(result.status, 'SUCCESS');

      // Verify both records exist
      const isProcessed = await adapter.isWebhookEventProcessed(event.event_id);
      assert.strictEqual(isProcessed, true);

      const hasPaid = await adapter.hasActivePaidEntitlement(user.id, 'fnd_atom_01');
      assert.strictEqual(hasPaid, true);
    });

    test('sequential duplicate webhook returns DUPLICATE and does not create second entitlement', async () => {
      const user: User = {
        id: 'usr_dup_1',
        email: 'dup1@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const event: ProcessedWebhookEvent = {
        event_id: 'ls_evt_seq_dup_01',
        provider: 'LEMON_SQUEEZY',
        event_name: 'order_created',
        user_id: user.id,
        finding_id: 'fnd_seq_dup_01',
        order_id: 'order_seq_dup_01',
        processed_at: new Date().toISOString(),
      };

      const entitlement: Entitlement = {
        id: 'ent_seq_dup_01',
        user_id: user.id,
        finding_id: 'fnd_seq_dup_01',
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'order_seq_dup_01',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const res1 = await adapter.processOrderCreatedWebhookTransaction({ event, entitlement });
      assert.strictEqual(res1.status, 'SUCCESS');

      // Second identical request
      const res2 = await adapter.processOrderCreatedWebhookTransaction({ event, entitlement });
      assert.strictEqual(res2.status, 'DUPLICATE');

      const entRows = await db.select().from(schema.entitlements);
      assert.strictEqual(entRows.length, 1);
    });

    test('concurrent duplicate webhooks (N=5) result in exactly 1 SUCCESS and 4 DUPLICATES', async () => {
      const user: User = {
        id: 'usr_conc_1',
        email: 'concurrent@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const sharedEventId = `ls_evt_conc_n5_${Date.now()}`;
      const makeRequest = () => {
        const event: ProcessedWebhookEvent = {
          event_id: sharedEventId,
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_created',
          user_id: user.id,
          finding_id: 'fnd_conc_n5',
          order_id: 'order_conc_n5',
          processed_at: new Date().toISOString(),
        };

        const entitlement: Entitlement = {
          id: `ent_conc_${Math.random()}`,
          user_id: user.id,
          finding_id: 'fnd_conc_n5',
          type: 'PAID_FIX_PACKAGE',
          status: 'ACTIVE',
          provider: 'LEMON_SQUEEZY',
          provider_transaction_id: 'order_conc_n5',
          amount_usd: 49.0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        const claim = adapter.claimWebhookEvent(sharedEventId);
        if (claim === 'DUPLICATE' || claim === 'IN_FLIGHT') {
          return { status: 'DUPLICATE' as const };
        }

        return adapter.processOrderCreatedWebhookTransaction({ event, entitlement });
      };

      // Dispatch 5 concurrent requests
      const results = await Promise.all([
        makeRequest(),
        makeRequest(),
        makeRequest(),
        makeRequest(),
        makeRequest(),
      ]);

      const successCount = results.filter((r) => r.status === 'SUCCESS').length;
      const duplicateCount = results.filter((r) => r.status === 'DUPLICATE').length;

      assert.strictEqual(successCount, 1, 'Exactly one concurrent request must succeed');
      assert.strictEqual(duplicateCount, 4, 'Remaining concurrent requests must return DUPLICATE');

      const entRows = await db.select().from(schema.entitlements);
      assert.strictEqual(entRows.length, 1, 'Only 1 entitlement record must exist in DB');
    });

    test('transaction failure rollback leaves no partial state', async () => {
      const user: User = {
        id: 'usr_rollback_1',
        email: 'rollback@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const badEventId = 'ls_evt_rollback_fail_01';

      // Deliberately trigger transaction failure during transaction
      await assert.rejects(
        async () => {
          await db.transaction(async (tx: any) => {
            await tx.insert(schema.webhookEvents).values({
              eventId: badEventId,
              provider: 'LEMON_SQUEEZY',
              eventName: 'order_created',
              userId: user.id,
              findingId: 'fnd_fail',
              orderId: 'order_fail',
              processedAt: new Date().toISOString(),
            });

            // Force simulated exception
            throw new Error('Simulated transaction failure after event insert');
          });
        },
        /Simulated transaction failure/
      );

      // Verify webhook event was rolled back and is NOT in the database
      const webhookRows = await db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.eventId, badEventId));
      assert.strictEqual(webhookRows.length, 0, 'Webhook event must have been rolled back');
    });

    test('distinct events for same finding update entitlement without duplicating rows', async () => {
      const user: User = {
        id: 'usr_distinct_1',
        email: 'distinct@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      // Event 1
      const res1 = await adapter.processOrderCreatedWebhookTransaction({
        event: {
          event_id: 'ls_evt_distinct_01',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_created',
          user_id: user.id,
          finding_id: 'fnd_distinct_01',
          order_id: 'order_101',
          processed_at: new Date().toISOString(),
        },
        entitlement: {
          id: 'ent_dist_1',
          user_id: user.id,
          finding_id: 'fnd_distinct_01',
          type: 'PAID_FIX_PACKAGE',
          status: 'ACTIVE',
          provider: 'LEMON_SQUEEZY',
          provider_transaction_id: 'order_101',
          amount_usd: 49.0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });
      assert.strictEqual(res1.status, 'SUCCESS');

      // Event 2 (distinct event_id for same user & finding)
      const res2 = await adapter.processOrderCreatedWebhookTransaction({
        event: {
          event_id: 'ls_evt_distinct_02',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_created',
          user_id: user.id,
          finding_id: 'fnd_distinct_01',
          order_id: 'order_102',
          processed_at: new Date().toISOString(),
        },
        entitlement: {
          id: 'ent_dist_2',
          user_id: user.id,
          finding_id: 'fnd_distinct_01',
          type: 'PAID_FIX_PACKAGE',
          status: 'ACTIVE',
          provider: 'LEMON_SQUEEZY',
          provider_transaction_id: 'order_102',
          amount_usd: 49.0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });
      assert.strictEqual(res2.status, 'SUCCESS');

      const entRows = await db.select().from(schema.entitlements);
      assert.strictEqual(entRows.length, 1, 'Natural uniqueness must preserve exactly 1 entitlement row');
      assert.strictEqual(entRows[0].providerTransactionId, 'order_102');

      const eventRows = await db.select().from(schema.webhookEvents);
      assert.strictEqual(eventRows.length, 2, 'Both distinct webhook events must be recorded');
    });
  });

  describe('JSON to SQL Migration Utility', () => {
    const testJsonDir = path.resolve(process.cwd(), 'data', 'test-migration');
    const testJsonPath = path.resolve(testJsonDir, 'test-db.json');

    beforeEach(() => {
      if (!fs.existsSync(testJsonDir)) {
        fs.mkdirSync(testJsonDir, { recursive: true });
      }
    });

    afterEach(() => {
      if (fs.existsSync(testJsonDir)) {
        fs.rmSync(testJsonDir, { recursive: true, force: true });
      }
    });

    test('migrates valid JSON database with count and referential validation', async () => {
      const sampleData = {
        users: {
          'migrated@aidiscost.io': {
            id: 'usr_mig_1',
            email: 'migrated@aidiscost.io',
            password_hash: 'salt:hash',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        },
        usersById: {
          usr_mig_1: 'migrated@aidiscost.io',
        },
        sessions: {
          token_mig_1: {
            token: 'token_mig_1',
            user_id: 'usr_mig_1',
            expires_at: new Date(Date.now() + 100000).toISOString(),
            created_at: new Date().toISOString(),
          },
        },
        findingOwnerships: {
          fnd_mig_1: {
            finding_id: 'fnd_mig_1',
            owner_id: 'usr_mig_1',
            created_at: new Date().toISOString(),
          },
        },
        entitlements: {
          'usr_mig_1:fnd_mig_1': {
            id: 'ent_mig_1',
            user_id: 'usr_mig_1',
            finding_id: 'fnd_mig_1',
            type: 'PAID_FIX_PACKAGE',
            status: 'ACTIVE',
            provider: 'LEMON_SQUEEZY',
            provider_transaction_id: 'order_mig_1',
            amount_usd: 49.0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        },
        processedWebhooks: {
          ls_mig_evt_1: {
            event_id: 'ls_mig_evt_1',
            provider: 'LEMON_SQUEEZY',
            event_name: 'order_created',
            user_id: 'usr_mig_1',
            finding_id: 'fnd_mig_1',
            order_id: 'order_mig_1',
            processed_at: new Date().toISOString(),
          },
        },
      };

      fs.writeFileSync(testJsonPath, JSON.stringify(sampleData, null, 2), 'utf-8');

      const migrationResult = await migrateJsonToSql(db, client, testJsonPath);
      assert.strictEqual(migrationResult.success, true);
      assert.strictEqual(migrationResult.migratedCounts.users, 1);
      assert.strictEqual(migrationResult.migratedCounts.sessions, 1);
      assert.strictEqual(migrationResult.migratedCounts.findingOwnerships, 1);
      assert.strictEqual(migrationResult.migratedCounts.entitlements, 1);
      assert.strictEqual(migrationResult.migratedCounts.processedWebhooks, 1);
      assert.ok(migrationResult.backupPath && fs.existsSync(migrationResult.backupPath));
    });

    test('aborts migration cleanly and reports error on malformed JSON', async () => {
      fs.writeFileSync(testJsonPath, '{ invalid json structure ...', 'utf-8');
      const result = await migrateJsonToSql(db, client, testJsonPath);
      assert.strictEqual(result.success, false);
      assert.ok(result.validationErrors.length > 0);
    });

    test('aborts migration and fails closed if orphaned records violate referential integrity', async () => {
      const orphanedData = {
        users: {}, // No users
        sessions: {
          token_orphan: {
            token: 'token_orphan',
            user_id: 'usr_nonexistent',
            expires_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        },
      };
      fs.writeFileSync(testJsonPath, JSON.stringify(orphanedData, null, 2), 'utf-8');

      const result = await migrateJsonToSql(db, client, testJsonPath);
      assert.strictEqual(result.success, false);
      assert.ok(result.validationErrors.some((e) => e.includes('orphaned user_id')));
    });
  });

  describe('Production Storage Fail-Closed Invariants', () => {
    const originalEnv = { ...process.env };

    afterEach(async () => {
      process.env = { ...originalEnv };
      const { setStorage } = await import('../server/storage');
      setStorage(null);
    });

    test('getStorage throws fatal error in production if TURSO_DATABASE_URL is missing', async () => {
      const { getStorage, setStorage } = await import('../server/storage');
      setStorage(null);
      process.env.NODE_ENV = 'production';
      delete process.env.TURSO_DATABASE_URL;
      delete process.env.TURSO_AUTH_TOKEN;

      assert.throws(
        () => {
          getStorage();
        },
        /FATAL PRODUCTION CONFIGURATION ERROR/
      );
    });

    test('getStorage throws fatal error in production if remote TURSO_AUTH_TOKEN is missing', async () => {
      const { getStorage, setStorage } = await import('../server/storage');
      setStorage(null);
      process.env.NODE_ENV = 'production';
      process.env.TURSO_DATABASE_URL = 'libsql://aidiscost-prod.turso.io';
      delete process.env.TURSO_AUTH_TOKEN;

      assert.throws(
        () => {
          getStorage();
        },
        /TURSO_AUTH_TOKEN is required/
      );
    });
  });

  describe('Commercial Transaction Rollback & Unpoisoned Cache Invariant', () => {
    test('processOrderCreatedWebhookTransaction rolls back, clears claim, leaves cache unpoisoned, and permits retry', async () => {
      const user: User = {
        id: 'usr_strict_rb_1',
        email: 'strictrb@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const eventId = `ls_evt_strictrb_${Date.now()}`;
      const findingId = 'fnd_strictrb_01';

      // We simulate an entitlement write failure by making entitlement insertion fail
      // We can temporarily alter table or pass an entitlement that causes an error
      // In SQLite, inserting with non-null violation or invalid column throws
      const failingAdapter = new DrizzleStorageAdapter(db, client);

      // Force an error inside the transaction during entitlement upsert by overriding transaction
      const origTransaction = db.transaction.bind(db);
      let injectFailure = true;

      // Mock a failure inside the transaction right after event insert
      db.transaction = async function (cb: any) {
        return origTransaction(async (tx: any) => {
          const origInsert = tx.insert.bind(tx);
          tx.insert = function (table: any) {
            if (table === schema.entitlements && injectFailure) {
              throw new Error('SIMULATED_ENTITLEMENT_WRITE_FAILURE');
            }
            return origInsert(table);
          };
          return cb(tx);
        });
      };

      const event: ProcessedWebhookEvent = {
        event_id: eventId,
        provider: 'LEMON_SQUEEZY',
        event_name: 'order_created',
        user_id: user.id,
        finding_id: findingId,
        order_id: 'order_rb_fail',
        processed_at: new Date().toISOString(),
      };

      const entitlement: Entitlement = {
        id: 'ent_rb_fail',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'order_rb_fail',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // 1. Transaction fails
      await assert.rejects(
        async () => {
          await failingAdapter.processOrderCreatedWebhookTransaction({ event, entitlement });
        },
        /SIMULATED_ENTITLEMENT_WRITE_FAILURE/
      );

      // 2. Verify state is NOT committed in database
      const dbEvents = await db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.eventId, eventId));
      assert.strictEqual(dbEvents.length, 0, 'Webhook event must not be committed');

      const dbEnts = await db
        .select()
        .from(schema.entitlements)
        .where(eq(schema.entitlements.findingId, findingId));
      assert.strictEqual(dbEnts.length, 0, 'Entitlement must not be committed');

      // 3. Verify cache is NOT poisoned and in-flight claim was released
      const isProcessed = await failingAdapter.isWebhookEventProcessed(eventId);
      assert.strictEqual(isProcessed, false, 'Event must not be marked as processed');

      // 4. Retry succeeds now that simulated failure is cleared
      injectFailure = false;
      const retryResult = await failingAdapter.processOrderCreatedWebhookTransaction({ event, entitlement });
      assert.strictEqual(retryResult.status, 'SUCCESS', 'Retry must succeed after previous failure');

      // Restore original transaction
      db.transaction = origTransaction;

      // 5. Verify database now has both committed
      const committedEvents = await db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.eventId, eventId));
      assert.strictEqual(committedEvents.length, 1);

      const committedEnts = await db
        .select()
        .from(schema.entitlements)
        .where(eq(schema.entitlements.findingId, findingId));
      assert.strictEqual(committedEnts.length, 1);
    });
  });

  describe('Multi-Instance Concurrency (Independent Adapters, Shared DB)', () => {
    const sharedDbFile = path.resolve(process.cwd(), 'data', `test-multi-instance-${Date.now()}.db`);

    afterEach(() => {
      if (fs.existsSync(sharedDbFile)) {
        fs.rmSync(sharedDbFile, { force: true });
      }
    });

    test('two independent adapters with separate in-memory caches resolve concurrent webhooks safely', async () => {
      // Connect Adapter A and Adapter B to the exact same database file
      const connA = createDatabaseConnection({ url: `file:${sharedDbFile}` });
      await initializeDatabaseSchema(connA.client);
      const connB = createDatabaseConnection({ url: `file:${sharedDbFile}` });
      await connB.client.execute('PRAGMA busy_timeout = 5000;');

      const adapterA = new DrizzleStorageAdapter(connA.db, connA.client);
      const adapterB = new DrizzleStorageAdapter(connB.db, connB.client);

      const user: User = {
        id: 'usr_multi_inst',
        email: 'multi_inst@aidiscost.io',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapterA.createUser(user);

      const sharedEventId = `ls_evt_multi_inst_${Date.now()}`;
      const findingId = 'fnd_multi_inst_01';

      const payloadA = {
        event: {
          event_id: sharedEventId,
          provider: 'LEMON_SQUEEZY' as const,
          event_name: 'order_created',
          user_id: user.id,
          finding_id: findingId,
          order_id: 'order_multi_A',
          processed_at: new Date().toISOString(),
        },
        entitlement: {
          id: 'ent_multi_A',
          user_id: user.id,
          finding_id: findingId,
          type: 'PAID_FIX_PACKAGE' as const,
          status: 'ACTIVE' as const,
          provider: 'LEMON_SQUEEZY' as const,
          provider_transaction_id: 'order_multi_A',
          amount_usd: 49.0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      };

      const payloadB = {
        event: {
          event_id: sharedEventId,
          provider: 'LEMON_SQUEEZY' as const,
          event_name: 'order_created',
          user_id: user.id,
          finding_id: findingId,
          order_id: 'order_multi_B',
          processed_at: new Date().toISOString(),
        },
        entitlement: {
          id: 'ent_multi_B',
          user_id: user.id,
          finding_id: findingId,
          type: 'PAID_FIX_PACKAGE' as const,
          status: 'ACTIVE' as const,
          provider: 'LEMON_SQUEEZY' as const,
          provider_transaction_id: 'order_multi_B',
          amount_usd: 49.0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      };

      // Helper that executes across independent adapters, retrying on local SQLite file lock contention
      const executeWithLockRetry = async (adapter: DrizzleStorageAdapter, payload: any) => {
        let attempts = 0;
        while (attempts < 5) {
          try {
            return await adapter.processOrderCreatedWebhookTransaction(payload);
          } catch (err: any) {
            attempts++;
            if ((err?.code === 'SQLITE_BUSY' || String(err?.message).includes('locked')) && attempts < 5) {
              // Local file SQLite limitation: file-level lock contention during concurrent write
              await new Promise((r) => setTimeout(r, 120));
              continue;
            }
            throw err;
          }
        }
        throw new Error('Lock retry exhausted');
      };

      // Execute across two independent adapter instances concurrently
      const [resA, resB] = await Promise.all([
        executeWithLockRetry(adapterA, payloadA),
        executeWithLockRetry(adapterB, payloadB),
      ]);

      const statuses = [resA.status, resB.status];
      assert.ok(statuses.includes('SUCCESS'), 'Exactly one adapter must succeed');
      assert.ok(statuses.includes('DUPLICATE'), 'The other adapter must return DUPLICATE');

      // Verify the shared database has exactly 1 event and 1 entitlement
      const eventRows = await connA.db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.eventId, sharedEventId));
      assert.strictEqual(eventRows.length, 1, 'Only 1 webhook event row must exist');

      const entRows = await connA.db
        .select()
        .from(schema.entitlements)
        .where(eq(schema.entitlements.findingId, findingId));
      assert.strictEqual(entRows.length, 1, 'Only 1 entitlement row must exist');

      connA.client.close();
      connB.client.close();
    });
  });

  describe('Real Turso Cloud Verification Status', () => {
    test('reports real Turso verification status honestly', async () => {
      const hasRealCredentials = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
      if (hasRealCredentials) {
        console.log('[Real Turso] Credentials detected. Running live test...');
        const conn = createDatabaseConnection();
        const testRes = await conn.client.execute('SELECT 1 as live_check');
        assert.strictEqual(testRes.rows[0]?.live_check, 1);
        conn.client.close();
      } else {
        console.log('[Real Turso] No credentials configured. Explicitly classified as NOT VERIFIED AGAINST REAL TURSO.');
        assert.strictEqual(hasRealCredentials, false);
      }
    });
  });
});
