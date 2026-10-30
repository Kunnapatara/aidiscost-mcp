/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient, Client } from '@libsql/client';
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema';

export interface DatabaseConfig {
  url?: string;
  authToken?: string;
}

export interface DatabaseInstance {
  client: Client;
  db: LibSQLDatabase<typeof schema>;
}

export function createDatabaseConnection(config?: DatabaseConfig): DatabaseInstance {
  const url =
    config?.url ||
    process.env.TURSO_DATABASE_URL ||
    (process.env.NODE_ENV === 'test' ? ':memory:' : 'file:data/aidiscost.db');

  const authToken = config?.authToken || process.env.TURSO_AUTH_TOKEN;

  const client = createClient({
    url,
    authToken,
  });

  const db = drizzle(client, { schema });

  return { client, db };
}

/**
 * Initializes database tables and indexes if they do not already exist.
 * Ensures local development, testing, and new instances work reliably.
 */
export async function initializeDatabaseSchema(client: Client): Promise<void> {
  try {
    await client.execute('PRAGMA busy_timeout = 5000;');
    await client.execute('PRAGMA journal_mode = WAL;');
  } catch {
    // In-memory or remote Turso may ignore or reject some PRAGMAs gracefully
  }

  await client.batch(
    [
      `CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY NOT NULL,
        email text NOT NULL,
        password_hash text NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );`,
      `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token text PRIMARY KEY NOT NULL,
        user_id text NOT NULL,
        expires_at text NOT NULL,
        created_at text NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE cascade
      );`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);`,
      `CREATE TABLE IF NOT EXISTS audits (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL,
        source text NOT NULL,
        total_spend_usd real NOT NULL,
        potential_savings_usd real NOT NULL,
        annualized_savings_projection_usd real NOT NULL,
        is_sample_data integer DEFAULT false NOT NULL,
        health_grade text,
        health_report_json text,
        findings_count integer DEFAULT 0 NOT NULL,
        created_at text NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE cascade
      );`,
      `CREATE INDEX IF NOT EXISTS idx_audits_user_id ON audits (user_id);`,
      `CREATE TABLE IF NOT EXISTS finding_ownerships (
        finding_id text PRIMARY KEY NOT NULL,
        audit_id text,
        owner_id text NOT NULL,
        created_at text NOT NULL,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (audit_id) REFERENCES audits(id) ON UPDATE no action ON DELETE cascade
      );`,
      `CREATE INDEX IF NOT EXISTS idx_finding_ownerships_owner_id ON finding_ownerships (owner_id);`,
      `CREATE INDEX IF NOT EXISTS idx_finding_ownerships_audit_id ON finding_ownerships (audit_id);`,
      `CREATE TABLE IF NOT EXISTS entitlements (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL,
        finding_id text NOT NULL,
        type text NOT NULL,
        status text NOT NULL,
        provider text NOT NULL,
        provider_transaction_id text NOT NULL,
        amount_usd real NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE cascade
      );`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_user_finding ON entitlements (user_id, finding_id);`,
      `CREATE INDEX IF NOT EXISTS idx_entitlements_user_id ON entitlements (user_id);`,
      `CREATE TABLE IF NOT EXISTS webhook_events (
        event_id text PRIMARY KEY NOT NULL,
        provider text NOT NULL,
        event_name text NOT NULL,
        user_id text,
        finding_id text,
        order_id text,
        processed_at text NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS findings (
        id text PRIMARY KEY NOT NULL,
        audit_id text NOT NULL,
        finding_id text NOT NULL,
        user_id text NOT NULL,
        rule_id text NOT NULL,
        title text NOT NULL,
        summary text NOT NULL,
        affected_scope text,
        detection_confidence text,
        baseline_spend_usd real NOT NULL,
        candidate_spend_usd real,
        estimated_savings_usd real NOT NULL,
        potential_savings_pct real,
        annualized_projection_usd real NOT NULL,
        eligible_event_count integer NOT NULL,
        calculation_method text,
        assumptions_json text,
        evidence_json text,
        status text DEFAULT 'DETECTED' NOT NULL,
        is_sample_data integer DEFAULT false NOT NULL,
        created_at text NOT NULL,
        FOREIGN KEY (audit_id) REFERENCES audits(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE cascade
      );`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_audit_finding ON findings (audit_id, finding_id);`,
      `CREATE INDEX IF NOT EXISTS idx_findings_user_id ON findings (user_id);`,
      `CREATE INDEX IF NOT EXISTS idx_findings_finding_id ON findings (finding_id);`,
      `CREATE TABLE IF NOT EXISTS verifications (
        id text PRIMARY KEY NOT NULL,
        audit_id text,
        finding_id text NOT NULL,
        user_id text NOT NULL,
        stage text NOT NULL,
        is_authoritative integer DEFAULT false NOT NULL,
        is_simulated integer DEFAULT false NOT NULL,
        baseline_start text NOT NULL,
        baseline_end text NOT NULL,
        baseline_sample_count integer NOT NULL,
        baseline_avg_cost_usd real NOT NULL,
        deployment_timestamp text,
        observation_start text,
        observation_end text,
        observation_sample_count integer DEFAULT 0 NOT NULL,
        post_avg_cost_usd real DEFAULT 0 NOT NULL,
        observed_reduction_pct real DEFAULT 0 NOT NULL,
        verified_annualized_savings_usd real DEFAULT 0 NOT NULL,
        original_estimated_annualized_usd real,
        verification_confidence text DEFAULT 'INSUFFICIENT_OBSERVATION' NOT NULL,
        verification_notes text,
        post_deployment_file_name text,
        verified_at text,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        FOREIGN KEY (audit_id) REFERENCES audits(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE cascade
      );`,
      `CREATE INDEX IF NOT EXISTS idx_verifications_finding_id ON verifications (finding_id);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_verifications_user_audit_finding ON verifications (user_id, audit_id, finding_id);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_verifications_user_finding_null_audit ON verifications (user_id, finding_id) WHERE audit_id IS NULL;`,
      `CREATE INDEX IF NOT EXISTS idx_verifications_user_id ON verifications (user_id);`,
      `CREATE TABLE IF NOT EXISTS outcome_fee_obligations (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL,
        audit_id text,
        finding_id text NOT NULL,
        verification_id text NOT NULL,
        verified_annualized_savings_usd real NOT NULL,
        fee_amount_usd real NOT NULL,
        currency text DEFAULT 'USD' NOT NULL,
        status text NOT NULL,
        provider text DEFAULT 'LEMON_SQUEEZY' NOT NULL,
        checkout_url text,
        provider_order_id text,
        provider_transaction_id text,
        paid_at text,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (audit_id) REFERENCES audits(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (verification_id) REFERENCES verifications(id) ON UPDATE no action ON DELETE cascade
      );`,
      `CREATE INDEX IF NOT EXISTS idx_outcome_fee_finding_id ON outcome_fee_obligations (finding_id);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_fee_user_audit_finding ON outcome_fee_obligations (user_id, audit_id, finding_id);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_fee_user_finding_null_audit ON outcome_fee_obligations (user_id, finding_id) WHERE audit_id IS NULL;`,
      `CREATE INDEX IF NOT EXISTS idx_outcome_fee_user_id ON outcome_fee_obligations (user_id);`,
    ],
    'write'
  );

  // Upgrade finding_ownerships schema if it was created under the legacy schema without 'audit_id'
  try {
    const tableInfo = await client.execute("PRAGMA table_info('finding_ownerships')");
    const cols = (tableInfo.rows || []).map((r: any) => String(r.name || r[1]));
    if (cols.length > 0 && !cols.includes('audit_id')) {
      await client.batch(
        [
          `ALTER TABLE finding_ownerships ADD COLUMN audit_id text REFERENCES audits(id) ON UPDATE no action ON DELETE cascade;`,
          `CREATE INDEX IF NOT EXISTS idx_finding_ownerships_audit_id ON finding_ownerships (audit_id);`,
        ],
        'write'
      );
    }
  } catch (err) {
    // Non-fatal if table doesn't exist yet or already upgraded
  }

  // Safely reconcile legacy records with NULL audit_id ONLY when there is exactly 1 distinct audit
  try {
    await client.batch(
      [
        `UPDATE verifications
         SET audit_id = (
           SELECT f.audit_id
           FROM findings f
           JOIN audits a ON a.id = f.audit_id
           WHERE f.finding_id = verifications.finding_id
             AND a.user_id = verifications.user_id
           LIMIT 1
         )
         WHERE audit_id IS NULL
           AND (
             SELECT COUNT(DISTINCT f.audit_id)
             FROM findings f
             JOIN audits a ON a.id = f.audit_id
             WHERE f.finding_id = verifications.finding_id
               AND a.user_id = verifications.user_id
           ) = 1;`,
        `UPDATE outcome_fee_obligations
         SET audit_id = (
           SELECT f.audit_id
           FROM findings f
           JOIN audits a ON a.id = f.audit_id
           WHERE f.finding_id = outcome_fee_obligations.finding_id
             AND a.user_id = outcome_fee_obligations.user_id
           LIMIT 1
         )
         WHERE audit_id IS NULL
           AND (
             SELECT COUNT(DISTINCT f.audit_id)
             FROM findings f
             JOIN audits a ON a.id = f.audit_id
             WHERE f.finding_id = outcome_fee_obligations.finding_id
               AND a.user_id = outcome_fee_obligations.user_id
           ) = 1;`,
        `UPDATE finding_ownerships
         SET audit_id = (
           SELECT f.audit_id
           FROM findings f
           JOIN audits a ON a.id = f.audit_id
           WHERE f.finding_id = finding_ownerships.finding_id
             AND a.user_id = finding_ownerships.owner_id
           LIMIT 1
         )
         WHERE audit_id IS NULL
           AND (
             SELECT COUNT(DISTINCT f.audit_id)
             FROM findings f
             JOIN audits a ON a.id = f.audit_id
             WHERE f.finding_id = finding_ownerships.finding_id
               AND a.user_id = finding_ownerships.owner_id
           ) = 1;`,
      ],
      'write'
    );
  } catch (err) {
    // Non-fatal if tables do not exist yet
  }
}
