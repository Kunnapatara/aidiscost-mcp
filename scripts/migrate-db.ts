/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createDatabaseConnection } from '../src/server/db/index';

export async function runDatabaseMigrations(): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (isProduction && !url) {
    throw new Error(
      '[FATAL MIGRATION ERROR] TURSO_DATABASE_URL is required to run migrations in production.'
    );
  }

  if (
    isProduction &&
    url &&
    (url.startsWith('libsql://') || url.startsWith('https://')) &&
    !authToken
  ) {
    throw new Error(
      '[FATAL MIGRATION ERROR] In production with a remote Turso database, TURSO_AUTH_TOKEN is required to run migrations.'
    );
  }

  console.log('[DB Migrate] Connecting to database...');
  const { db, client } = createDatabaseConnection({ url, authToken });

  // Preflight check: verify database is reachable before executing migrations
  try {
    await client.execute('SELECT 1 as ping;');
  } catch (pingErr: any) {
    client.close();
    throw new Error(`[FATAL MIGRATION ERROR] Unable to reach database: ${pingErr?.message || pingErr}`);
  }

  const migrationsFolder = path.resolve(process.cwd(), 'drizzle', 'migrations');
  console.log(`[DB Migrate] Applying versioned Drizzle migrations from ${migrationsFolder}...`);

  try {
    await client.execute('PRAGMA foreign_keys = OFF;');
    await migrate(db, { migrationsFolder });
    await client.execute('PRAGMA foreign_keys = ON;');
    console.log('[DB Migrate] All pending migrations applied successfully.');
  } catch (err: any) {
    console.error('[DB Migrate] Migration failed:', err.message);
    throw err;
  } finally {
    try {
      await client.execute('PRAGMA foreign_keys = ON;');
    } catch {
      // Ignore cleanup error if connection closed
    }
    client.close();
  }
}

// Execute directly if run via CLI
if (process.argv[1]?.endsWith('migrate-db.ts') || process.argv[1]?.endsWith('migrate-db.js')) {
  runDatabaseMigrations()
    .then(() => {
      console.log('[DB Migrate] Completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[DB Migrate] Fatal error:', err);
      process.exit(1);
    });
}
