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

  test('13. Prefix variant of allowed database name is strictly rejected with FAIL (exact match required)', async () => {
    // aidiscost-test-disposable-production must NOT be allowed merely because it starts with aidiscost-test-disposable
    const envPrefixProd: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-test-disposable-production.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valPrefixProd = validateTursoTestConfig(envPrefixProd);
    assert.strictEqual(valPrefixProd.valid, false, 'Prefix variant with -production must fail');
    assert.ok(valPrefixProd.reason?.includes('UNAUTHORIZED DATABASE TARGET') || valPrefixProd.reason?.includes('POTENTIAL PRODUCTION TARGET'));

    const resPrefixProd = await runRemoteTursoMigrationTest(envPrefixProd);
    assert.strictEqual(resPrefixProd.status, 'FAIL');

    // aidiscost-test-disposable-extra must also fail (non-prod prefix variant)
    const envPrefixExtra: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-test-disposable-extra.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valPrefixExtra = validateTursoTestConfig(envPrefixExtra);
    assert.strictEqual(valPrefixExtra.valid, false, 'Prefix variant with -extra must fail');
    assert.ok(valPrefixExtra.reason?.includes('Exact match against approved test database identifiers is strictly required'));

    const resPrefixExtra = await runRemoteTursoMigrationTest(envPrefixExtra);
    assert.strictEqual(resPrefixExtra.status, 'FAIL');
  });

  test('14. Suffix variant of allowed database name is strictly rejected with FAIL', async () => {
    const envSuffix: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://staging-aidiscost-ci-test.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valSuffix = validateTursoTestConfig(envSuffix);
    assert.strictEqual(valSuffix.valid, false, 'Suffix/prefix prepended variant must fail');
    assert.ok(valSuffix.reason?.includes('UNAUTHORIZED DATABASE TARGET'));

    const resSuffix = await runRemoteTursoMigrationTest(envSuffix);
    assert.strictEqual(resSuffix.status, 'FAIL');
  });

  test('15. Missing or empty database ID is strictly rejected with FAIL', async () => {
    // Case A: TURSO_TEST_DATABASE_ID provided but empty string
    const envEmptyId: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-disposable-test-db.turso.io',
      TURSO_TEST_DATABASE_ID: '   ', // whitespace / empty
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valEmptyId = validateTursoTestConfig(envEmptyId);
    assert.strictEqual(valEmptyId.valid, false);
    assert.ok(valEmptyId.reason?.includes('DATABASE IDENTITY INVALID'));

    const resEmptyId = await runRemoteTursoMigrationTest(envEmptyId);
    assert.strictEqual(resEmptyId.status, 'FAIL');

    // Case B: URL missing database ID entirely
    const envNoSubdomain: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valNoSubdomain = validateTursoTestConfig(envNoSubdomain);
    assert.strictEqual(valNoSubdomain.valid, false);

    const resNoSubdomain = await runRemoteTursoMigrationTest(envNoSubdomain);
    assert.strictEqual(resNoSubdomain.status, 'FAIL');
  });

  test('16. Allowed first DNS label on an untrusted domain is strictly rejected with FAIL', async () => {
    // aidiscost-test-disposable is an approved database ID, but attacker.example is an untrusted domain
    const envUntrusted: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'https://aidiscost-test-disposable.attacker.example',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valUntrusted = validateTursoTestConfig(envUntrusted);
    assert.strictEqual(valUntrusted.valid, false, 'Untrusted domain must fail even with allowed first label');
    assert.ok(valUntrusted.reason?.includes('UNTRUSTED DOMAIN'));

    const resUntrusted = await runRemoteTursoMigrationTest(envUntrusted);
    assert.strictEqual(resUntrusted.status, 'FAIL');
  });

  test('17. Insecure HTTP protocol is strictly rejected with FAIL', async () => {
    const envHttp: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'http://aidiscost-disposable-test-db.turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valHttp = validateTursoTestConfig(envHttp);
    assert.strictEqual(valHttp.valid, false, 'Insecure http:// must fail');
    assert.ok(valHttp.reason?.includes('INVALID DATABASE PROTOCOL'));

    const resHttp = await runRemoteTursoMigrationTest(envHttp);
    assert.strictEqual(resHttp.status, 'FAIL');
  });

  test('18. Unexpected custom port is strictly rejected with FAIL', async () => {
    const envPort: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-disposable-test-db.turso.io:8080',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valPort = validateTursoTestConfig(envPort);
    assert.strictEqual(valPort.valid, false, 'Unexpected non-standard port must fail');
    assert.ok(valPort.reason?.includes('UNEXPECTED PORT'));

    const resPort = await runRemoteTursoMigrationTest(envPort);
    assert.strictEqual(resPort.status, 'FAIL');
  });

  test('19. Unexpected hostname suffix and lookalike domains are strictly rejected with FAIL', async () => {
    // Suffix domain attempt
    const envSuffixDomain: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-disposable-test-db.turso.io.attacker.com',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valSuffixDomain = validateTursoTestConfig(envSuffixDomain);
    assert.strictEqual(valSuffixDomain.valid, false);
    assert.ok(valSuffixDomain.reason?.includes('UNTRUSTED DOMAIN'));

    const resSuffixDomain = await runRemoteTursoMigrationTest(envSuffixDomain);
    assert.strictEqual(resSuffixDomain.status, 'FAIL');

    // Lookalike domain attempt (evil-turso.io)
    const envLookalike: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://aidiscost-test-disposable.evil-turso.io',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
    };
    const valLookalike = validateTursoTestConfig(envLookalike);
    assert.strictEqual(valLookalike.valid, false);
    assert.ok(valLookalike.reason?.includes('UNTRUSTED DOMAIN'));

    const resLookalike = await runRemoteTursoMigrationTest(envLookalike);
    assert.strictEqual(resLookalike.status, 'FAIL');
  });

  test('20. Custom-host allowlist via TURSO_TEST_CUSTOM_HOST_ALLOWLIST enables explicitly permitted custom hosts', async () => {
    // Case A: Without TURSO_TEST_CUSTOM_HOST_ALLOWLIST, custom domain is rejected
    const envWithoutAllowlist: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://my-custom-test-node.internal.example',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
      TURSO_TEST_DATABASE_ALLOWLIST: 'my-custom-test-node',
    };
    const valWithout = validateTursoTestConfig(envWithoutAllowlist);
    assert.strictEqual(valWithout.valid, false, 'Custom domain must fail without host allowlist');
    assert.ok(valWithout.reason?.includes('UNTRUSTED DOMAIN'));

    // Case B: With TURSO_TEST_CUSTOM_HOST_ALLOWLIST, custom domain is permitted
    const envWithAllowlist: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TURSO_TEST_DATABASE_URL: 'libsql://my-custom-test-node.internal.example',
      TURSO_TEST_AUTH_TOKEN: 'token_123',
      TURSO_TEST_DATABASE_ALLOWLIST: 'my-custom-test-node',
      TURSO_TEST_CUSTOM_HOST_ALLOWLIST: 'my-custom-test-node.internal.example,other-node.internal.example',
    };
    const valWith = validateTursoTestConfig(envWithAllowlist);
    assert.strictEqual(valWith.valid, true, 'Custom domain must pass with exact host allowlist');
    assert.strictEqual(valWith.url, 'libsql://my-custom-test-node.internal.example');
  });
});

