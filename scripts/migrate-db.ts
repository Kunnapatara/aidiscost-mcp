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

  console.log('[DB Migrate] Connecting to database...');
  const { db, client } = createDatabaseConnection({ url, authToken });

  const migrationsFolder = path.resolve(process.cwd(), 'drizzle', 'migrations');
  console.log(`[DB Migrate] Applying versioned Drizzle migrations from ${migrationsFolder}...`);

  try {
    await migrate(db, { migrationsFolder });
    console.log('[DB Migrate] All pending migrations applied successfully.');
  } catch (err: any) {
    console.error('[DB Migrate] Migration failed:', err.message);
    throw err;
  } finally {
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
