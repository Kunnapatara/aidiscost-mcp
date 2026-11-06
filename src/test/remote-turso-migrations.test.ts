/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  validateTursoTestConfig,
  runRemoteTursoMigrationTest,
} from '../../scripts/test-remote-turso-migrations';

describe('AIDisCost MCP — Area 6 Remote Turso Migration Guard & Safety Tests', () => {
  test('1. Missing credentials report BLOCKED', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: '',
      TURSO_DATABASE_URL: '',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.blocked, true);

    const res = await runRemoteTursoMigrationTest(env);
    assert.strictEqual(res.status, 'BLOCKED');
  });

  test('2. Generic TURSO_DATABASE_URL is rejected from acting as remote test database', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_DATABASE_URL: 'libsql://primary-production-db.turso.io',
      TURSO_AUTH_TOKEN: 'prod_token',
      TURSO_TEST_DATABASE_URL: '', // Missing dedicated test URL
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.blocked, true);
    assert.ok(validation.reason?.includes('Generic TURSO_DATABASE_URL cannot be used'));

    const res = await runRemoteTursoMigrationTest(env);
    assert.strictEqual(res.status, 'BLOCKED');
  });

  test('3. TURSO_TEST_DATABASE_URL colliding with primary TURSO_DATABASE_URL is rejected with FAIL', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_DATABASE_URL: 'libsql://aidiscost-test-shared.turso.io',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-test-shared.turso.io', // Collision!
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.blocked, false);
    assert.ok(validation.reason?.includes('DATABASE ISOLATION VIOLATION'));

    const res = await runRemoteTursoMigrationTest(env);
    assert.strictEqual(res.status, 'FAIL');
  });

  test('4. Local file: URL is rejected from claiming Remote Turso verification', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'file:data/test.db',
      TURSO_TEST_AUTH_TOKEN: 'fake_token',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.blocked, true);
    assert.ok(validation.reason?.includes('Local database URL'));

    const res = await runRemoteTursoMigrationTest(env);
    assert.strictEqual(res.status, 'BLOCKED');
  });

  test('5. NODE_ENV=production strictly halts migration runner with FAIL', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-test.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.reason?.includes('production'));

    const res = await runRemoteTursoMigrationTest(env);
    assert.strictEqual(res.status, 'FAIL');
  });

  test('6. Production URL patterns (e.g. aidiscost-prod-db.turso.io) are rejected for safety with FAIL', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-prod-db.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.reason?.includes('POTENTIAL PRODUCTION TARGET DETECTED'));

    const res = await runRemoteTursoMigrationTest(env);
    assert.strictEqual(res.status, 'FAIL');
  });

  test('7. Database identity not in allowlist is rejected with FAIL even if URL contains "test" or "disposable"', async () => {
    // A: URL contains "test" but is not in allowlist
    const envWithTest: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://unauthorized-test-db.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valWithTest = validateTursoTestConfig(envWithTest);
    assert.strictEqual(valWithTest.valid, false);
    assert.ok(valWithTest.reason?.includes('UNAUTHORIZED DATABASE TARGET'));
    assert.ok(valWithTest.reason?.includes('not in the approved test database allowlist'));

    const resWithTest = await runRemoteTursoMigrationTest(envWithTest);
    assert.strictEqual(resWithTest.status, 'FAIL');

    // B: URL contains "disposable" but is not in allowlist
    const envWithDisposable: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://my-unknown-disposable.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valWithDisposable = validateTursoTestConfig(envWithDisposable);
    assert.strictEqual(valWithDisposable.valid, false);
    assert.ok(valWithDisposable.reason?.includes('UNAUTHORIZED DATABASE TARGET'));

    const resWithDisposable = await runRemoteTursoMigrationTest(envWithDisposable);
    assert.strictEqual(resWithDisposable.status, 'FAIL');
  });

  test('8. Valid isolated test database URL in approved allowlist is approved for execution', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_DATABASE_URL: 'libsql://aidiscost-primary.turso.io',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-disposable-test-db.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'test_token_valid',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.blocked, false);
    assert.strictEqual(validation.url, 'libsql://aidiscost-disposable-test-db.turso.io');
  });

  test('9. Database ID mismatch between TURSO_TEST_DATABASE_ID and target URL is rejected with FAIL', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-disposable-test-db.turso.io',
      TURSO_TEST_DATABASE_ID: 'different-test-db', // Does not match URL
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.reason?.includes('DATABASE IDENTITY MISMATCH'));

    const res = await runRemoteTursoMigrationTest(env);
    assert.strictEqual(res.status, 'FAIL');
  });

  test('10. Environment variable override attempts cannot bypass database identity check', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://unauthorized-test-db.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
      TURSO_ALLOW_TEST_MIGRATIONS: 'true', // Attempted override!
      ALLOW_UNVERIFIED_DATABASE: 'true', // Attempted override!
      BYPASS_TURSO_ALLOWLIST: 'true', // Attempted override!
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, false, 'Override flags must NOT grant access to unallowlisted target');
    assert.ok(validation.reason?.includes('UNAUTHORIZED DATABASE TARGET'));
    assert.ok(validation.reason?.includes('Security bypass attempt rejected'));

    const res = await runRemoteTursoMigrationTest(env);
    assert.strictEqual(res.status, 'FAIL');
  });

  test('11. Database URL with unparseable identity is rejected with FAIL', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, false);

    const res = await runRemoteTursoMigrationTest(env);
    assert.strictEqual(res.status, 'FAIL');
  });

  test('12. Custom database allowlist via TURSO_TEST_DATABASE_ALLOWLIST allows authorized custom test database', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://my-custom-test-env.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
      TURSO_TEST_DATABASE_ALLOWLIST: 'my-custom-test-env,other-test-db',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.url, 'libsql://my-custom-test-env.turso.io');
  });
});
