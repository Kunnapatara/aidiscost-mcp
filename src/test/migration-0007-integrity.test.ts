/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient, Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { initializeDatabaseSchema, createDatabaseConnection } from '../server/db/index';
import { DrizzleStorageAdapter } from '../server/db/adapter';
import * as schema from '../server/db/schema';

describe('Migration 0007 & Schema Integrity Verification Suite', () => {
  const migrationsFolder = path.resolve(process.cwd(), 'drizzle', 'migrations');
  const journalPath = path.resolve(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));

  let client: Client;
  let db: any;

  beforeEach(() => {
    client = createClient({ url: ':memory:' });
    db = drizzle(client, { schema });
  });

  afterEach(() => {
    if (client) {
      client.close();
    }
  });

  /**
   * Helper to apply migrations up to a specific index (0-indexed).
   */
  async function applyMigrationsUpTo(targetIdx: number): Promise<void> {
    await client.execute(
      `CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);`
    );

    for (let i = 0; i <= targetIdx; i++) {
      const entry = journal.entries[i];
      const sqlFile = path.join(migrationsFolder, `${entry.tag}.sql`);
      const sql = fs.readFileSync(sqlFile, 'utf8');
      const stmts = sql.split('--> statement-breakpoint').map((s: string) => s.trim()).filter(Boolean);
      for (const stmt of stmts) {
        await client.execute(stmt);
      }
      await client.execute({
        sql: 'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
        args: ['hash_' + entry.tag, entry.when],
      });
    }
  }

  describe('1. Upgrade From Empty Schema & Empty Tables', () => {
    test('upgrading empty tables from 0006 through 0007 succeeds without error', async () => {
      await applyMigrationsUpTo(6);
      await client.execute('PRAGMA foreign_keys = OFF;');
      await migrate(db, { migrationsFolder });
      await client.execute('PRAGMA foreign_keys = ON;');

      const tables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations';"
      );
      const tableNames = tables.rows.map((r: any) => String(r.name));

      assert.ok(tableNames.includes('finding_ownerships'));
      assert.ok(tableNames.includes('verifications'));
      assert.ok(tableNames.includes('outcome_fee_obligations'));
      assert.ok(tableNames.includes('entitlements'));

      // Check counts are zero
      const ownCount = await client.execute('SELECT COUNT(*) as c FROM finding_ownerships;');
      const verCount = await client.execute('SELECT COUNT(*) as c FROM verifications;');
      const ofoCount = await client.execute('SELECT COUNT(*) as c FROM outcome_fee_obligations;');
      const entCount = await client.execute('SELECT COUNT(*) as c FROM entitlements;');

      assert.strictEqual(Number(ownCount.rows[0].c), 0);
      assert.strictEqual(Number(verCount.rows[0].c), 0);
      assert.strictEqual(Number(ofoCount.rows[0].c), 0);
      assert.strictEqual(Number(entCount.rows[0].c), 0);
    });
  });

  describe('2. Legacy Finding Ownership Reconciliation & Ambiguity Invariant', () => {
    test('legacy ownership record matching exactly one audit is backfilled with that audit_id', async () => {
      await applyMigrationsUpTo(6);

      // Seed user, single audit, finding, and legacy ownership with NULL audit_id
      await client.execute(`INSERT INTO users VALUES ('usr_reconcile_1', 'rec1@test.com', 'h1', '2026-01-01', '2026-01-01');`);
      await client.execute(`INSERT INTO audits VALUES ('aud_rec_1', 'usr_reconcile_1', 'langfuse', 100, 10, 100, 0, 'A', '{}', 1, '2026-01-01');`);
      await client.execute(`INSERT INTO findings VALUES ('f_rec_1', 'aud_rec_1', 'fnd_rec_1', 'usr_reconcile_1', 'R1', 'Title', 'Summary', 'Scope', 'HIGH', 100, 90, 10, 10, 100, 5, 'method', '{}', '{}', 'DETECTED', 0, '2026-01-01');`);
      await client.execute(`INSERT INTO finding_ownerships (finding_id, owner_id, created_at, audit_id) VALUES ('fnd_rec_1', 'usr_reconcile_1', '2026-01-01', NULL);`);

      // Run migration 0007
      await client.execute('PRAGMA foreign_keys = OFF;');
      await migrate(db, { migrationsFolder });
      await client.execute('PRAGMA foreign_keys = ON;');

      const row = (await client.execute("SELECT * FROM finding_ownerships WHERE finding_id = 'fnd_rec_1';")).rows[0];
      assert.ok(row);
      // In 0006 the update ran, in 0007 the new id is owner:audit:finding
      assert.strictEqual(row.audit_id, 'aud_rec_1', 'Unambiguous single audit must be reconciled');
      assert.strictEqual(row.id, 'usr_reconcile_1:aud_rec_1:fnd_rec_1');
      assert.strictEqual(row.owner_id, 'usr_reconcile_1');
    });

    test('legacy ownership record matching multiple audits fails closed and is NOT assigned an arbitrary audit', async () => {
      await applyMigrationsUpTo(6);

      // Seed user with TWO audits both having the same finding_id
      await client.execute(`INSERT INTO users VALUES ('usr_multi_aud', 'multi@test.com', 'h1', '2026-01-01', '2026-01-01');`);
      await client.execute(`INSERT INTO audits VALUES ('aud_multi_1', 'usr_multi_aud', 'langfuse', 100, 10, 100, 0, 'A', '{}', 1, '2026-01-01');`);
      await client.execute(`INSERT INTO audits VALUES ('aud_multi_2', 'usr_multi_aud', 'langfuse', 150, 15, 150, 0, 'A', '{}', 1, '2026-01-02');`);
      await client.execute(`INSERT INTO findings VALUES ('f_multi_1', 'aud_multi_1', 'fnd_shared_dup', 'usr_multi_aud', 'R1', 'Title', 'Summary', 'Scope', 'HIGH', 100, 90, 10, 10, 100, 5, 'method', '{}', '{}', 'DETECTED', 0, '2026-01-01');`);
      await client.execute(`INSERT INTO findings VALUES ('f_multi_2', 'aud_multi_2', 'fnd_shared_dup', 'usr_multi_aud', 'R1', 'Title', 'Summary', 'Scope', 'HIGH', 150, 135, 15, 15, 150, 5, 'method', '{}', '{}', 'DETECTED', 0, '2026-01-02');`);

      // Legacy ownership record with NULL audit_id
      await client.execute(`INSERT INTO finding_ownerships (finding_id, owner_id, created_at, audit_id) VALUES ('fnd_shared_dup', 'usr_multi_aud', '2026-01-01', NULL);`);

      // Run migration 0007
      await client.execute('PRAGMA foreign_keys = OFF;');
      await migrate(db, { migrationsFolder });
      await client.execute('PRAGMA foreign_keys = ON;');

      const row = (await client.execute("SELECT * FROM finding_ownerships WHERE finding_id = 'fnd_shared_dup';")).rows[0];
      assert.ok(row);
      assert.strictEqual(row.audit_id, null, 'Ambiguous record across multiple audits MUST NOT be assigned to arbitrary audit');
      assert.strictEqual(row.id, 'usr_multi_aud:fnd_shared_dup', 'Legacy ID without audit must use owner:finding pattern');

      // Now verify that with 0007 schema, new records for specific audits can be registered independently without collision
      const adapter = new DrizzleStorageAdapter(db, client);
      const regAud1 = await adapter.registerFindingOwnership('fnd_shared_dup', 'usr_multi_aud', 'aud_multi_1');
      const regAud2 = await adapter.registerFindingOwnership('fnd_shared_dup', 'usr_multi_aud', 'aud_multi_2');

      assert.strictEqual(regAud1.audit_id, 'aud_multi_1');
      assert.strictEqual(regAud2.audit_id, 'aud_multi_2');

      // Verify lookups with audit_id return correct scoped owner
      assert.strictEqual(await adapter.getFindingOwner('fnd_shared_dup', 'aud_multi_1'), 'usr_multi_aud');
      assert.strictEqual(await adapter.getFindingOwner('fnd_shared_dup', 'aud_multi_2'), 'usr_multi_aud');
    });
  });

  describe('3. Legacy Entitlements Backfill & Isolation', () => {
    test('legacy entitlement with uniquely identifiable audit is backfilled with audit_id', async () => {
      await applyMigrationsUpTo(6);

      await client.execute(`INSERT INTO users VALUES ('usr_ent_rec', 'entrec@test.com', 'h1', '2026-01-01', '2026-01-01');`);
      await client.execute(`INSERT INTO audits VALUES ('aud_ent_rec', 'usr_ent_rec', 'langfuse', 100, 10, 100, 0, 'A', '{}', 1, '2026-01-01');`);
      await client.execute(`INSERT INTO findings VALUES ('f_ent_1', 'aud_ent_rec', 'fnd_ent_rec', 'usr_ent_rec', 'R1', 'Title', 'Summary', 'Scope', 'HIGH', 100, 90, 10, 10, 100, 5, 'method', '{}', '{}', 'DETECTED', 0, '2026-01-01');`);
      await client.execute(`INSERT INTO finding_ownerships (finding_id, owner_id, created_at, audit_id) VALUES ('fnd_ent_rec', 'usr_ent_rec', '2026-01-01', 'aud_ent_rec');`);

      // Legacy entitlement created without audit_id
      await client.execute(`INSERT INTO entitlements (
        id, user_id, finding_id, type, status, provider, provider_transaction_id, amount_usd, created_at, updated_at
      ) VALUES (
        'ent_legacy_01', 'usr_ent_rec', 'fnd_ent_rec', 'PAID_FIX_PACKAGE', 'ACTIVE', 'LEMON_SQUEEZY', 'tx_leg_01', 49.0, '2026-01-01', '2026-01-01'
      );`);

      // Run migration 0007
      await client.execute('PRAGMA foreign_keys = OFF;');
      await migrate(db, { migrationsFolder });
      await client.execute('PRAGMA foreign_keys = ON;');

      const row = (await client.execute("SELECT * FROM entitlements WHERE id = 'ent_legacy_01';")).rows[0];
      assert.ok(row);
      assert.strictEqual(row.audit_id, 'aud_ent_rec', 'Entitlement with unique audit must be backfilled');
      assert.strictEqual(row.status, 'ACTIVE');
      assert.strictEqual(row.provider_transaction_id, 'tx_leg_01');
      assert.strictEqual(row.amount_usd, 49.0);
    });

    test('legacy entitlement with ambiguous audits retains NULL audit_id and fails closed', async () => {
      await applyMigrationsUpTo(6);

      await client.execute(`INSERT INTO users VALUES ('usr_ent_amb', 'entamb@test.com', 'h1', '2026-01-01', '2026-01-01');`);
      await client.execute(`INSERT INTO audits VALUES ('aud_amb_1', 'usr_ent_amb', 'langfuse', 100, 10, 100, 0, 'A', '{}', 1, '2026-01-01');`);
      await client.execute(`INSERT INTO audits VALUES ('aud_amb_2', 'usr_ent_amb', 'langfuse', 200, 20, 200, 0, 'A', '{}', 1, '2026-01-02');`);
      await client.execute(`INSERT INTO findings VALUES ('f_amb_1', 'aud_amb_1', 'fnd_ent_amb', 'usr_ent_amb', 'R1', 'Title', 'Summary', 'Scope', 'HIGH', 100, 90, 10, 10, 100, 5, 'method', '{}', '{}', 'DETECTED', 0, '2026-01-01');`);
      await client.execute(`INSERT INTO findings VALUES ('f_amb_2', 'aud_amb_2', 'fnd_ent_amb', 'usr_ent_amb', 'R1', 'Title', 'Summary', 'Scope', 'HIGH', 200, 180, 20, 20, 200, 5, 'method', '{}', '{}', 'DETECTED', 0, '2026-01-02');`);

      await client.execute(`INSERT INTO entitlements (
        id, user_id, finding_id, type, status, provider, provider_transaction_id, amount_usd, created_at, updated_at
      ) VALUES (
        'ent_legacy_amb_01', 'usr_ent_amb', 'fnd_ent_amb', 'PAID_FIX_PACKAGE', 'ACTIVE', 'LEMON_SQUEEZY', 'tx_amb_01', 49.0, '2026-01-01', '2026-01-01'
      );`);

      // Run migration 0007
      await client.execute('PRAGMA foreign_keys = OFF;');
      await migrate(db, { migrationsFolder });
      await client.execute('PRAGMA foreign_keys = ON;');

      const row = (await client.execute("SELECT * FROM entitlements WHERE id = 'ent_legacy_amb_01';")).rows[0];
      assert.ok(row);
      assert.strictEqual(row.audit_id, null, 'Ambiguous entitlement MUST NOT be arbitrarily assigned');

      // Adapter check: getEntitlement without audit_id fails closed when multiple findings exist
      const adapter = new DrizzleStorageAdapter(db, client);
      const fetchedWithoutAudit = await adapter.getEntitlement('usr_ent_amb', 'fnd_ent_amb');
      assert.strictEqual(fetchedWithoutAudit, null, 'Lookup without audit_id must fail closed for ambiguous legacy entitlement');
    });
  });

  describe('4. Full Data Preservation Across Table Rebuilds (Phase B Verification)', () => {
    test('existing verification and outcome fee records preserve all exact column values without corruption or drop', async () => {
      await applyMigrationsUpTo(6);

      await client.execute(`INSERT INTO users VALUES ('usr_full_pres', 'fullpres@test.com', 'h1', '2026-01-01', '2026-01-01');`);
      await client.execute(`INSERT INTO audits VALUES ('aud_full_pres', 'usr_full_pres', 'langfuse', 500, 50, 500, 0, 'A', '{}', 1, '2026-01-01');`);
      await client.execute(`INSERT INTO findings VALUES ('f_full_pres', 'aud_full_pres', 'fnd_full_pres', 'usr_full_pres', 'MODEL_RIGHT_SIZING', 'Title', 'Summary', 'Scope', 'HIGH', 500, 450, 50, 10, 500, 10, 'method', '{}', '{}', 'DETECTED', 0, '2026-01-01');`);
      await client.execute(`INSERT INTO finding_ownerships (finding_id, owner_id, created_at, audit_id) VALUES ('fnd_full_pres', 'usr_full_pres', '2026-01-01', 'aud_full_pres');`);

      // Verification before 0007 (with original_estimated_annualized_usd and audit_id populated)
      await client.execute(`INSERT INTO verifications (
        id, finding_id, user_id, stage, is_authoritative, is_simulated,
        baseline_start, baseline_end, baseline_sample_count, baseline_avg_cost_usd,
        deployment_timestamp, observation_start, observation_end, observation_sample_count,
        post_avg_cost_usd, observed_reduction_pct, verified_annualized_savings_usd,
        verification_confidence, verification_notes, post_deployment_file_name,
        verified_at, created_at, updated_at, original_estimated_annualized_usd, audit_id
      ) VALUES (
        'ver_pres_01', 'fnd_full_pres', 'usr_full_pres', 'VERIFIED_RESULT', 1, 0,
        '2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z', 100, 2.50,
        '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z', '2026-09-18T00:00:00Z', 50,
        0.50, 80.0, 12000.0,
        'HIGH', 'Observation notes verified', 'post_telemetry.json',
        '2026-09-18T12:00:00Z', '2026-09-10T00:00:00Z', '2026-09-18T12:00:00Z', 15000.0, 'aud_full_pres'
      );`);

      // Outcome fee obligation before 0007
      await client.execute(`INSERT INTO outcome_fee_obligations (
        id, user_id, finding_id, verification_id, verified_annualized_savings_usd, fee_amount_usd,
        currency, status, provider, checkout_url, provider_order_id, provider_transaction_id,
        paid_at, created_at, updated_at, audit_id
      ) VALUES (
        'ofo_pres_01', 'usr_full_pres', 'fnd_full_pres', 'ver_pres_01', 12000.0, 2400.0,
        'USD', 'PAID', 'LEMON_SQUEEZY', 'https://lemonsqueezy.com/pay/123', 'order_ls_777', 'tx_ls_888',
        '2026-09-19T00:00:00Z', '2026-09-18T12:00:00Z', '2026-09-19T00:00:00Z', 'aud_full_pres'
      );`);

      // Run migration 0007
      await client.execute('PRAGMA foreign_keys = OFF;');
      await migrate(db, { migrationsFolder });
      await client.execute('PRAGMA foreign_keys = ON;');

      // Verify row preservation
      const verRow = (await client.execute("SELECT * FROM verifications WHERE id = 'ver_pres_01';")).rows[0];
      assert.ok(verRow, 'Verification row must be preserved');
      assert.strictEqual(verRow.id, 'ver_pres_01');
      assert.strictEqual(verRow.audit_id, 'aud_full_pres');
      assert.strictEqual(verRow.finding_id, 'fnd_full_pres');
      assert.strictEqual(verRow.user_id, 'usr_full_pres');
      assert.strictEqual(verRow.stage, 'VERIFIED_RESULT');
      assert.strictEqual(Number(verRow.is_authoritative), 1);
      assert.strictEqual(Number(verRow.is_simulated), 0);
      assert.strictEqual(verRow.baseline_start, '2026-09-01T00:00:00Z');
      assert.strictEqual(verRow.baseline_end, '2026-09-10T00:00:00Z');
      assert.strictEqual(Number(verRow.baseline_sample_count), 100);
      assert.strictEqual(Number(verRow.baseline_avg_cost_usd), 2.5);
      assert.strictEqual(verRow.deployment_timestamp, '2026-09-11T00:00:00Z');
      assert.strictEqual(Number(verRow.observation_sample_count), 50);
      assert.strictEqual(Number(verRow.post_avg_cost_usd), 0.5);
      assert.strictEqual(Number(verRow.observed_reduction_pct), 80.0);
      assert.strictEqual(Number(verRow.verified_annualized_savings_usd), 12000.0);
      assert.strictEqual(Number(verRow.original_estimated_annualized_usd), 15000.0);
      assert.strictEqual(verRow.verification_confidence, 'HIGH');
      assert.strictEqual(verRow.verification_notes, 'Observation notes verified');
      assert.strictEqual(verRow.post_deployment_file_name, 'post_telemetry.json');
      assert.strictEqual(verRow.verified_at, '2026-09-18T12:00:00Z');

      const ofoRow = (await client.execute("SELECT * FROM outcome_fee_obligations WHERE id = 'ofo_pres_01';")).rows[0];
      assert.ok(ofoRow, 'Outcome fee obligation row must be preserved');
      assert.strictEqual(ofoRow.id, 'ofo_pres_01');
      assert.strictEqual(ofoRow.user_id, 'usr_full_pres');
      assert.strictEqual(ofoRow.audit_id, 'aud_full_pres');
      assert.strictEqual(ofoRow.finding_id, 'fnd_full_pres');
      assert.strictEqual(ofoRow.verification_id, 'ver_pres_01');
      assert.strictEqual(Number(ofoRow.verified_annualized_savings_usd), 12000.0);
      assert.strictEqual(Number(ofoRow.fee_amount_usd), 2400.0);
      assert.strictEqual(ofoRow.currency, 'USD');
      assert.strictEqual(ofoRow.status, 'PAID');
      assert.strictEqual(ofoRow.provider, 'LEMON_SQUEEZY');
      assert.strictEqual(ofoRow.checkout_url, 'https://lemonsqueezy.com/pay/123');
      assert.strictEqual(ofoRow.provider_order_id, 'order_ls_777');
      assert.strictEqual(ofoRow.provider_transaction_id, 'tx_ls_888');
      assert.strictEqual(ofoRow.paid_at, '2026-09-19T00:00:00Z');
    });
  });

  describe('5. Post-Migration Schema, Indexes & Constraints Parity', () => {
    test('all required unique indexes and constraints exist after migration 0007', async () => {
      await applyMigrationsUpTo(7);

      const getIndexes = async (table: string) => {
        const res = await client.execute(`PRAGMA index_list('${table}');`);
        return res.rows.map((r: any) => String(r.name));
      };

      const ownIdx = await getIndexes('finding_ownerships');
      assert.ok(ownIdx.includes('idx_finding_ownerships_owner_audit_finding'));
      assert.ok(ownIdx.includes('idx_finding_ownerships_owner_finding_null_audit'));
      assert.ok(ownIdx.includes('idx_finding_ownerships_finding_id'));
      assert.ok(ownIdx.includes('idx_finding_ownerships_owner_id'));
      assert.ok(ownIdx.includes('idx_finding_ownerships_audit_id'));

      const verIdx = await getIndexes('verifications');
      assert.ok(verIdx.includes('idx_verifications_user_audit_finding'));
      assert.ok(verIdx.includes('idx_verifications_user_finding_null_audit'));
      assert.ok(verIdx.includes('idx_verifications_finding_id'));
      assert.ok(verIdx.includes('idx_verifications_user_id'));

      const ofoIdx = await getIndexes('outcome_fee_obligations');
      assert.ok(ofoIdx.includes('idx_outcome_fee_user_audit_finding'));
      assert.ok(ofoIdx.includes('idx_outcome_fee_user_finding_null_audit'));
      assert.ok(ofoIdx.includes('idx_outcome_fee_finding_id'));
      assert.ok(ofoIdx.includes('idx_outcome_fee_user_id'));

      const entIdx = await getIndexes('entitlements');
      assert.ok(entIdx.includes('idx_entitlements_user_audit_finding'));
      assert.ok(entIdx.includes('idx_entitlements_user_finding_null_audit'));
      assert.ok(entIdx.includes('idx_entitlements_finding_id'));
      assert.ok(entIdx.includes('idx_entitlements_audit_id'));
      assert.ok(!entIdx.includes('idx_entitlements_user_finding'), 'Old composite without audit_id must be dropped');
    });

    test('runtime initializeDatabaseSchema and formal migrations achieve schema parity', async () => {
      // DB A: initialized via initializeDatabaseSchema
      const clientA = createClient({ url: ':memory:' });
      await initializeDatabaseSchema(clientA);

      // DB B: migrated sequentially from 0000 to 0007
      const clientB = createClient({ url: ':memory:' });
      const dbB = drizzle(clientB);
      await clientB.execute('PRAGMA foreign_keys = OFF;');
      await migrate(dbB, { migrationsFolder });
      await clientB.execute('PRAGMA foreign_keys = ON;');

      const getTables = async (c: Client) => {
        const res = await c.execute(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name;"
        );
        return res.rows.map((r: any) => String(r.name));
      };

      const getCols = async (c: Client, table: string) => {
        const res = await c.execute(`PRAGMA table_info('${table}');`);
        // Map by name to verify all columns are present with matching type, notnull, and pk
        const map: Record<string, any> = {};
        for (const r of res.rows as any[]) {
          map[r.name] = { type: r.type, notnull: r.notnull, pk: r.pk };
        }
        return map;
      };

      const tablesA = await getTables(clientA);
      const tablesB = await getTables(clientB);
      assert.deepStrictEqual(tablesA.sort(), tablesB.sort(), 'Table lists must match exactly');

      for (const table of tablesA) {
        const colsA = await getCols(clientA, table);
        const colsB = await getCols(clientB, table);
        assert.deepStrictEqual(
          colsA,
          colsB,
          `Columns and types for table "${table}" must match between runtime DDL and migrations`
        );
      }

      clientA.close();
      clientB.close();
    });

    test('repeated initialization and migration execution is safe and idempotent', async () => {
      // 1. Multiple repeated calls to initializeDatabaseSchema on a clean database
      const client1 = createClient({ url: ':memory:' });
      await initializeDatabaseSchema(client1);
      await initializeDatabaseSchema(client1);
      await initializeDatabaseSchema(client1);
      const check1 = await client1.execute('SELECT 1 as healthy;');
      assert.strictEqual(check1.rows[0].healthy, 1);
      client1.close();

      // 2. Full sequential migration run followed by repeated initializeDatabaseSchema calls
      const client2 = createClient({ url: ':memory:' });
      const db2 = drizzle(client2);
      await client2.execute('PRAGMA foreign_keys = OFF;');
      await migrate(db2, { migrationsFolder });
      await client2.execute('PRAGMA foreign_keys = ON;');

      await initializeDatabaseSchema(client2);
      await initializeDatabaseSchema(client2);
      const check2 = await client2.execute('SELECT 1 as healthy;');
      assert.strictEqual(check2.rows[0].healthy, 1);
      client2.close();
    });
  });
});
