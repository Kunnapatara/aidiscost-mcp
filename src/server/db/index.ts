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
      `CREATE TABLE IF NOT EXISTS finding_ownerships (
        finding_id text PRIMARY KEY NOT NULL,
        owner_id text NOT NULL,
        created_at text NOT NULL,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE no action ON DELETE cascade
      );`,
      `CREATE INDEX IF NOT EXISTS idx_finding_ownerships_owner_id ON finding_ownerships (owner_id);`,
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
    ],
    'write'
  );
}
