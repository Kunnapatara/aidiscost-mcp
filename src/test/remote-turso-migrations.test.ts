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

  test('2. Local file: URL is rejected from claiming Remote Turso verification', async () => {
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

  test('3. NODE_ENV=production strictly halts migration runner', async () => {
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

  test('4. Production URL patterns (e.g. aidiscost-prod.turso.io) are rejected for safety', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-prod-db.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.reason?.includes('PRODUCTION TARGET DETECTED'));
  });

  test('5. Non-test URL without explicit confirmation is rejected', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://customer-financial-data.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.reason?.includes('UNVERIFIED DATABASE TARGET'));
  });

  test('6. Valid test database URL is approved for execution', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-disposable-test-db.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'test_token_valid',
    };
    const validation = validateTursoTestConfig(env);
    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.blocked, false);
    assert.strictEqual(validation.url, 'libsql://aidiscost-disposable-test-db.turso.io');
  });
});
