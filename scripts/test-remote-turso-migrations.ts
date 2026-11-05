/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AIDisCost MCP — Remote Turso Migrations Verification Runner (0000 -> 0008)
 *
 * Verifies versioned Drizzle migrations against a dedicated remote Turso test database.
 *
 * SAFETY INVARIANTS:
 * 1. Strictly refuses to execute against production databases or in production environments.
 * 2. Requires positive verification of test database target (URL containing test/dev/sandbox
 *    or explicit TURSO_ALLOW_TEST_MIGRATIONS=true).
 * 3. Never claims Turso verification based on local SQLite or file: URLs.
 * 4. Exits with code 2 on BLOCKED, code 1 on FAIL, code 0 on PASS.
 */

import path from 'path';
import crypto from 'crypto';
import { createClient, Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from '../src/server/db/schema';
import { DrizzleStorageAdapter } from '../src/server/db/adapter';

export type TursoTestStatus = 'PASS' | 'BLOCKED' | 'FAIL';

export interface TursoValidationResult {
  valid: boolean;
  blocked: boolean;
  reason?: string;
  url?: string;
  authToken?: string;
}

export function validateTursoTestConfig(env: NodeJS.ProcessEnv = process.env): TursoValidationResult {
  const isProduction = (env.NODE_ENV || '').toLowerCase() === 'production';
  if (isProduction) {
    return {
      valid: false,
      blocked: false,
      reason: 'NODE_ENV is set to "production". Destructive migration verification is strictly prohibited in production.',
    };
  }

  const url = (env.TURSO_TEST_DATABASE_URL || env.TURSO_DATABASE_URL || '').trim();
  const authToken = (env.TURSO_TEST_AUTH_TOKEN || env.TURSO_AUTH_TOKEN || '').trim();

  if (!url) {
    return {
      valid: false,
      blocked: true,
      reason: 'TURSO_TEST_DATABASE_URL (or TURSO_DATABASE_URL) is not configured in the environment.',
    };
  }

  // File URLs are local SQLite, not remote Turso
  if (url.startsWith('file:') || url === ':memory:') {
    return {
      valid: false,
      blocked: true,
      reason: `Local database URL "${url}" detected. Remote Turso verification requires a live remote endpoint starting with libsql:// or https://.`,
    };
  }

  if (!url.startsWith('libsql://') && !url.startsWith('https://')) {
    return {
      valid: false,
      blocked: true,
      reason: `Invalid database protocol in "${url}". Remote Turso URLs must start with libsql:// or https://.`,
    };
  }

  if (!authToken) {
    return {
      valid: false,
      blocked: true,
      reason: 'TURSO_AUTH_TOKEN (or TURSO_TEST_AUTH_TOKEN) is required for remote Turso access.',
    };
  }

  // Safety preflight: target database must be identifiable as a test database
  const lowerUrl = url.toLowerCase();
  const hasTestIndicator =
    lowerUrl.includes('test') ||
    lowerUrl.includes('dev') ||
    lowerUrl.includes('sandbox') ||
    lowerUrl.includes('temp') ||
    lowerUrl.includes('disposable') ||
    env.TURSO_ALLOW_TEST_MIGRATIONS === 'true';

  const hasProdIndicator =
    lowerUrl.includes('prod') ||
    lowerUrl.includes('production') ||
    lowerUrl.includes('live');

  if (hasProdIndicator && env.TURSO_ALLOW_TEST_MIGRATIONS !== 'true') {
    return {
      valid: false,
      blocked: false,
      reason: `POTENTIAL PRODUCTION TARGET DETECTED: Database URL "${url}" matches production naming patterns. Verification aborted for safety.`,
    };
  }

  if (!hasTestIndicator) {
    return {
      valid: false,
      blocked: false,
      reason: `UNVERIFIED DATABASE TARGET: Database URL "${url}" does not contain test/dev indicator. Set TURSO_ALLOW_TEST_MIGRATIONS=true if you have verified this database is disposable.`,
    };
  }

  return {
    valid: true,
    blocked: false,
    url,
    authToken,
  };
}

export async function runRemoteTursoMigrationTest(env: NodeJS.ProcessEnv = process.env): Promise<{
  status: TursoTestStatus;
  reason?: string;
  tablesVerified?: string[];
}> {
  const validation = validateTursoTestConfig(env);

  if (validation.blocked) {
    return {
      status: 'BLOCKED',
      reason: validation.reason,
    };
  }

  if (!validation.valid || !validation.url || !validation.authToken) {
    return {
      status: 'FAIL',
      reason: validation.reason,
    };
  }

  console.log(`[Turso Test] Connecting to verified test database: ${validation.url.replace(/\/\/[^@]+@/, '//***@')}...`);
  const client: Client = createClient({
    url: validation.url,
    authToken: validation.authToken,
  });

  try {
    // 1. Connectivity probe
    await client.execute('SELECT 1 as ping;');
    console.log('[Turso Test] Remote connection established.');

    // 2. Execute migrations from drizzle/migrations
    const db = drizzle(client, { schema });
    const migrationsFolder = path.resolve(process.cwd(), 'drizzle', 'migrations');
    console.log(`[Turso Test] Executing versioned migrations (0000 -> 0008) from ${migrationsFolder}...`);

    await client.execute('PRAGMA foreign_keys = OFF;');
    await migrate(db, { migrationsFolder });
    await client.execute('PRAGMA foreign_keys = ON;');
    console.log('[Turso Test] Migrations applied.');

    // 3. Schema verification
    const tablesRes = await client.execute(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`);
    const tableNames = tablesRes.rows.map((r: any) => String(r.name));

    const requiredTables = [
      'users',
      'sessions',
      'audits',
      'findings',
      'finding_ownerships',
      'entitlements',
      'verifications',
      'outcome_fee_obligations',
      'webhook_events',
      'checkout_attempts',
      'payment_reconciliations',
    ];

    for (const table of requiredTables) {
      if (!tableNames.includes(table)) {
        throw new Error(`Missing expected table "${table}" after migrations.`);
      }
    }
    console.log(`[Turso Test] Verified ${requiredTables.length} required tables in remote Turso.`);

    // 4. Verify migration 0008 columns
    const columnsRes = await client.execute(`PRAGMA table_info(outcome_fee_obligations);`);
    const columnNames = columnsRes.rows.map((r: any) => String(r.name));
    if (!columnNames.includes('checkout_id')) {
      throw new Error('Column "checkout_id" missing in "outcome_fee_obligations" table.');
    }

    // 5. Verify CRUD persistence with Drizzle adapter on remote Turso
    const adapter = new DrizzleStorageAdapter(db, client);
    const testUserId = `usr_turso_${crypto.randomUUID()}`;
    const testFindingId = `fnd_turso_${crypto.randomUUID()}`;

    await adapter.createUser({
      id: testUserId,
      email: `turso-${testUserId}@aidiscost.io`,
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await adapter.saveCheckoutAttempt({
      id: `att_turso_${crypto.randomUUID()}`,
      user_id: testUserId,
      finding_id: testFindingId,
      product: 'FIX_PACKAGE',
      checkout_url: 'https://aidiscost.lemonsqueezy.com/buy/turso-test',
      status: 'PENDING',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const attempt = await adapter.getActiveCheckoutAttempt(testUserId, testFindingId, 'FIX_PACKAGE');
    if (!attempt || attempt.checkout_url !== 'https://aidiscost.lemonsqueezy.com/buy/turso-test') {
      throw new Error('Checkout attempt verification failed on remote Turso.');
    }

    // 6. Test Migration Idempotency (re-running migrations must not error or corrupt schema)
    await migrate(db, { migrationsFolder });
    console.log('[Turso Test] Migration idempotency verified.');

    return {
      status: 'PASS',
      tablesVerified: requiredTables,
    };
  } finally {
    client.close();
  }
}

// CLI Execution Entry Point
const isDirectRun = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith('test-remote-turso-migrations.ts') || process.argv[1].endsWith('test-remote-turso-migrations.js'))
);

if (isDirectRun) {
  console.log('===============================================================');
  console.log('AIDisCost MCP — Remote Turso Migrations Verification Runner');
  console.log('===============================================================\n');

  runRemoteTursoMigrationTest()
    .then((result) => {
      console.log(`STATUS: ${result.status}`);
      if (result.status === 'BLOCKED') {
        console.log(`Reason: ${result.reason}\n`);
        console.log('Setup instructions for disposable Remote Turso test database:');
        console.log('  1. Install Turso CLI: curl -sSfL https://get.tur.so/install.sh | bash');
        console.log('  2. Create a disposable test database:');
        console.log('     turso db create aidiscost-test-disposable');
        console.log('  3. Generate test credentials:');
        console.log('     turso db show aidiscost-test-disposable --url');
        console.log('     turso db tokens create aidiscost-test-disposable');
        console.log('  4. Export credentials in environment:');
        console.log('     export TURSO_TEST_DATABASE_URL=libsql://aidiscost-test-disposable-<org>.turso.io');
        console.log('     export TURSO_TEST_AUTH_TOKEN=<token>');
        console.log('  5. Re-run: npm run test:turso');
        console.log('  6. Delete test database when complete:');
        console.log('     turso db destroy aidiscost-test-disposable\n');
        console.log('===============================================================');
        process.exit(2);
      } else if (result.status === 'FAIL') {
        console.error(`Error: ${result.reason}`);
        console.log('===============================================================');
        process.exit(1);
      } else {
        console.log(`Migrations 0000 -> 0008 successfully applied and verified on Remote Turso.`);
        console.log(`Tables verified: ${result.tablesVerified?.join(', ')}`);
        console.log('===============================================================');
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error('Fatal error during Remote Turso verification:', err);
      process.exit(1);
    });
}
