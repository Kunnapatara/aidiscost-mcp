/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { ServerStorage, setStorage } from '../server/storage';
import { createDatabaseConnection, initializeDatabaseSchema } from '../server/db/index';
import { DrizzleStorageAdapter } from '../server/db/adapter';
import { authenticate } from '../server/auth';
import { createApiRouter } from '../server/api';
import { createMcpRouter, resetRateLimitsForTesting, getClientIdentifier } from '../server/mcp/router';
import { User, FindingOwnership, OutcomeFeeObligation } from '../server/types';

describe('AIDisCost — Production Readiness Verification Suite', () => {
  let server: http.Server;
  let serverUrl: string;
  const testSecret = 'readiness_suite_webhook_secret_123';
  const testStorage = ServerStorage.getInstance('data', 'test-readiness-db.json');

  before(async () => {
    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = testSecret;
    process.env.LEMON_SQUEEZY_VARIANT_ID = 'var_fix_pkg_49';
    process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = 'var_outcome_fee_variable';

    testStorage.setTestMode(true);
    testStorage.clearAll();
    setStorage(testStorage);

    const app = express();
    app.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      })
    );
    app.use(cookieParser());
    app.use(authenticate);
    app.use('/api', createApiRouter());
    app.use('/mcp', createMcpRouter(testStorage));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    testStorage.clearAll();
    setStorage(null);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    testStorage.clearAll();
    setStorage(testStorage);
    resetRateLimitsForTesting();
  });

  function signPayload(body: string, secret: string = testSecret): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  // =========================================================================
  // Finding 1: Health & Readiness Endpoint Verification
  // =========================================================================
  describe('Finding 1: Health & Database Readiness Verification', () => {
    test('GET /api/health returns 200 with database: connected when healthy', async () => {
      const res = await fetch(`${serverUrl}/api/health`);
      assert.strictEqual(res.status, 200);

      const json: any = await res.json();
      assert.strictEqual(json.status, 'ok');
      assert.strictEqual(json.service, 'aidiscost');
      assert.strictEqual(json.database, 'connected');
      assert.ok(json.timestamp);
      // Ensure no internal connection strings, credentials, or SQL details leaked
      assert.strictEqual(json.connectionString, undefined);
      assert.strictEqual(json.authToken, undefined);
      assert.strictEqual(json.stack, undefined);
    });

    test('GET /api/health returns 503 Service Unavailable when database readiness check fails', async () => {
      // Mock storage where checkReadiness returns false
      const brokenStorage: any = {
        ...testStorage,
        checkReadiness: async () => false,
      };
      setStorage(brokenStorage);

      const res = await fetch(`${serverUrl}/api/health`);
      assert.strictEqual(res.status, 503);

      const json: any = await res.json();
      assert.strictEqual(json.status, 'error');
      assert.strictEqual(json.database, 'disconnected');
      // Ensure no sensitive internal details leaked
      assert.strictEqual(json.stack, undefined);
      assert.strictEqual(json.url, undefined);
    });

    test('GET /api/health returns 503 when checkReadiness throws an error', async () => {
      const errorStorage: any = {
        ...testStorage,
        checkReadiness: async () => {
          throw new Error('FATAL_DATABASE_CONNECTION_REFUSED');
        },
      };
      setStorage(errorStorage);

      const res = await fetch(`${serverUrl}/api/health`);
      assert.strictEqual(res.status, 503);

      const json: any = await res.json();
      assert.strictEqual(json.status, 'error');
      assert.strictEqual(json.database, 'disconnected');
      // Error message should NOT leak the internal exception message
      assert.strictEqual(JSON.stringify(json).includes('FATAL_DATABASE_CONNECTION_REFUSED'), false);
    });

    test('GET /api/health/live returns 200 lightweight liveness probe without DB query', async () => {
      // Even if database is failing, liveness probe succeeds to prevent unnecessary container restart loops
      const brokenStorage: any = {
        ...testStorage,
        checkReadiness: async () => false,
      };
      setStorage(brokenStorage);

      const res = await fetch(`${serverUrl}/api/health/live`);
      assert.strictEqual(res.status, 200);

      const json: any = await res.json();
      assert.strictEqual(json.status, 'live');
      assert.strictEqual(json.service, 'aidiscost');
    });

    test('GET /api/health/ready returns 200 when ready and 503 when disconnected', async () => {
      setStorage(testStorage);
      const resReady = await fetch(`${serverUrl}/api/health/ready`);
      assert.strictEqual(resReady.status, 200);
      const jsonReady: any = await resReady.json();
      assert.strictEqual(jsonReady.status, 'ready');
      assert.strictEqual(jsonReady.database, 'connected');

      // Now with failing readiness
      const brokenStorage: any = {
        ...testStorage,
        checkReadiness: async () => false,
      };
      setStorage(brokenStorage);
      const resBroken = await fetch(`${serverUrl}/api/health/ready`);
      assert.strictEqual(resBroken.status, 503);
      const jsonBroken: any = await resBroken.json();
      assert.strictEqual(jsonBroken.status, 'unavailable');
      assert.strictEqual(jsonBroken.database, 'disconnected');
    });

    test('GET /api/health returns 503 Service Unavailable when storage.checkReadiness is missing or not a function', async () => {
      const noReadinessStorage: any = {
        ...testStorage,
        checkReadiness: undefined,
      };
      setStorage(noReadinessStorage);

      const res = await fetch(`${serverUrl}/api/health`);
      assert.strictEqual(res.status, 503);

      const json: any = await res.json();
      assert.strictEqual(json.status, 'error');
      assert.strictEqual(json.database, 'disconnected');
      assert.strictEqual(json.stack, undefined);
    });

    test('GET /api/health/ready returns 503 when storage.checkReadiness is missing or not a function', async () => {
      const noReadinessStorage: any = {
        ...testStorage,
        checkReadiness: undefined,
      };
      setStorage(noReadinessStorage);

      const res = await fetch(`${serverUrl}/api/health/ready`);
      assert.strictEqual(res.status, 503);

      const json: any = await res.json();
      assert.strictEqual(json.status, 'unavailable');
      assert.strictEqual(json.database, 'disconnected');
    });

    test('GET /api/health/ready returns 503 when checkReadiness throws an error', async () => {
      const errorStorage: any = {
        ...testStorage,
        checkReadiness: async () => {
          throw new Error('DATABASE_CONNECTION_RESET');
        },
      };
      setStorage(errorStorage);

      const res = await fetch(`${serverUrl}/api/health/ready`);
      assert.strictEqual(res.status, 503);

      const json: any = await res.json();
      assert.strictEqual(json.status, 'unavailable');
      assert.strictEqual(json.database, 'disconnected');
      assert.strictEqual(JSON.stringify(json).includes('DATABASE_CONNECTION_RESET'), false);
    });

    test('DrizzleStorageAdapter.checkReadiness executes lightweight SELECT 1 query', async () => {
      const conn = createDatabaseConnection({ url: ':memory:' });
      await initializeDatabaseSchema(conn.client);
      const adapter = new DrizzleStorageAdapter(conn.db, conn.client);

      const isReady = await adapter.checkReadiness();
      assert.strictEqual(isReady, true);

      // Close client to simulate database failure
      conn.client.close();
      const isReadyAfterClose = await adapter.checkReadiness();
      assert.strictEqual(isReadyAfterClose, false);
    });
  });

  // =========================================================================
  // Finding 2: Outcome Fee Webhook Configuration Fail-Closed
  // =========================================================================
  describe('Finding 2: Outcome Fee Webhook Configuration Fail-Closed', () => {
    const user: User = {
      id: 'usr_outcome_conf_01',
      email: 'outcome-user@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const findingId = 'finding_outcome_conf_01';

    beforeEach(async () => {
      await testStorage.createUser(user);
      await testStorage.registerFindingOwnership(findingId, user.id);

      const obligation: OutcomeFeeObligation = {
        id: 'of_conf_test_01',
        user_id: user.id,
        finding_id: findingId,
        verification_id: 'ver_conf_01',
        verified_annualized_savings_usd: 5000,
        fee_amount_usd: 1000,
        currency: 'USD',
        status: 'CHECKOUT_CREATED',
        provider: 'LEMON_SQUEEZY',
        provider_order_id: 'ord_outcome_conf_01',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await testStorage.createOutcomeFeeObligation(obligation);
    });

    test('1. Valid configured Outcome Fee event is accepted and transitions to PAID', async () => {
      process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = 'var_outcome_fee_variable';

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_valid_outcome_fee_01',
          custom_data: {
            user_id: user.id,
            finding_id: findingId,
            obligation_id: 'of_conf_test_01',
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_outcome_conf_01',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: 'var_outcome_fee_variable',
          },
        },
      };

      const payloadStr = JSON.stringify(payload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(payloadStr),
        },
        body: payloadStr,
      });

      assert.strictEqual(res.status, 200);
      const body: any = await res.json();
      assert.strictEqual(body.status, 'SUCCESS');
      assert.strictEqual(body.outcome_fee_status, 'PAID');

      const updated = await testStorage.getOutcomeFeeObligation(findingId);
      assert.strictEqual(updated?.status, 'PAID');
    });

    test('2. Missing Outcome Fee variant configuration fails closed with 503 OUTCOME_FEE_NOT_CONFIGURED', async () => {
      // Unset outcome fee variant environment variable
      delete process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID;

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_missing_conf_01',
          custom_data: {
            user_id: user.id,
            finding_id: findingId,
            obligation_id: 'of_conf_test_01',
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_missing_conf_01',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: 'any_incoming_variant_id',
          },
        },
      };

      const payloadStr = JSON.stringify(payload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(payloadStr),
        },
        body: payloadStr,
      });

      assert.strictEqual(res.status, 503);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'OUTCOME_FEE_NOT_CONFIGURED');

      // Obligation must NOT be modified
      const ob = await testStorage.getOutcomeFeeObligation(findingId);
      assert.strictEqual(ob?.status, 'CHECKOUT_CREATED');

      // Restore configuration
      process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = 'var_outcome_fee_variable';
    });

    test('3. Incorrect Outcome Fee variant ID is rejected with 400 WRONG_VARIANT', async () => {
      process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = 'var_outcome_fee_variable';

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_wrong_variant_01',
          custom_data: {
            user_id: user.id,
            finding_id: findingId,
            obligation_id: 'of_conf_test_01',
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_wrong_var_01',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: 'var_unrecognized_999',
          },
        },
      };

      const payloadStr = JSON.stringify(payload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(payloadStr),
        },
        body: payloadStr,
      });

      assert.strictEqual(res.status, 400);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'WRONG_VARIANT');

      const ob = await testStorage.getOutcomeFeeObligation(findingId);
      assert.strictEqual(ob?.status, 'CHECKOUT_CREATED');
    });

    test('4. Fix Package event still follows its existing valid path even if Outcome Fee variant is not configured', async () => {
      // Unset Outcome Fee variant
      delete process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID;
      process.env.LEMON_SQUEEZY_VARIANT_ID = 'var_fix_pkg_49';

      const fixFindingId = 'finding_fix_pkg_test';
      await testStorage.registerFindingOwnership(fixFindingId, user.id);

      const fixPayload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_fix_pkg_valid_01',
          custom_data: {
            user_id: user.id,
            finding_id: fixFindingId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'ord_fix_pkg_valid_01',
          attributes: {
            status: 'paid',
            total: 4900,
            first_order_item: {
              variant_id: 'var_fix_pkg_49',
            },
          },
        },
      };

      const payloadStr = JSON.stringify(fixPayload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(payloadStr),
        },
        body: payloadStr,
      });

      assert.strictEqual(res.status, 200);
      const body: any = await res.json();
      assert.strictEqual(body.status, 'SUCCESS');
      assert.strictEqual(body.finding_id, fixFindingId);

      assert.strictEqual(await testStorage.hasActivePaidEntitlement(user.id, fixFindingId), true);

      // Restore configuration
      process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = 'var_outcome_fee_variable';
    });

    test('5. Invalid webhook signature remains rejected with 401', async () => {
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_invalid_sig_test',
          custom_data: {
            user_id: user.id,
            finding_id: findingId,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_inv_sig',
          attributes: { status: 'paid' },
        },
      };

      const payloadStr = JSON.stringify(payload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': 'invalid_hmac_hex_value',
        },
        body: payloadStr,
      });

      assert.strictEqual(res.status, 401);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'INVALID_SIGNATURE');
    });

    test('6. Duplicate event does not re-process or create duplicate charges (returns IDEMPOTENT_DUPLICATE)', async () => {
      process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = 'var_outcome_fee_variable';

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_duplicate_test_01',
          custom_data: {
            user_id: user.id,
            finding_id: findingId,
            obligation_id: 'of_conf_test_01',
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_outcome_conf_01',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: 'var_outcome_fee_variable',
          },
        },
      };

      const payloadStr = JSON.stringify(payload);
      const signature = signPayload(payloadStr);

      // First delivery
      const res1 = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: payloadStr,
      });
      assert.strictEqual(res1.status, 200);

      // Replayed delivery
      const res2 = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: payloadStr,
      });
      assert.strictEqual(res2.status, 200);
      const body2: any = await res2.json();
      assert.strictEqual(body2.status, 'IDEMPOTENT_DUPLICATE');
    });
  });

  // =========================================================================
  // Finding 3: Fix Package Webhook Variant Configuration Fail-Closed
  // =========================================================================
  describe('Finding 3: Fix Package Webhook Variant Configuration Fail-Closed', () => {
    const fixUser: User = {
      id: 'usr_fix_pkg_conf_01',
      email: 'fix-user@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const fixFindingId = 'finding_fix_pkg_variant_01';

    beforeEach(async () => {
      await testStorage.createUser(fixUser);
      await testStorage.registerFindingOwnership(fixFindingId, fixUser.id);
    });

    test('1. Fix Package variant configuration is missing -> fails closed with 503 FIX_PACKAGE_NOT_CONFIGURED', async () => {
      delete process.env.LEMON_SQUEEZY_VARIANT_ID;

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_fix_missing_conf_01',
          custom_data: {
            user_id: fixUser.id,
            finding_id: fixFindingId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'ord_fix_missing_01',
          attributes: {
            status: 'paid',
            total: 4900,
            first_order_item: {
              variant_id: 'any_variant_id',
            },
          },
        },
      };

      const payloadStr = JSON.stringify(payload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(payloadStr),
        },
        body: payloadStr,
      });

      assert.strictEqual(res.status, 503);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'FIX_PACKAGE_NOT_CONFIGURED');

      // Entitlement must NOT be created
      const hasEntitlement = await testStorage.hasActivePaidEntitlement(fixUser.id, fixFindingId);
      assert.strictEqual(hasEntitlement, false);
    });

    test('2. Fix Package variant configuration is an empty string -> fails closed with 503 FIX_PACKAGE_NOT_CONFIGURED', async () => {
      process.env.LEMON_SQUEEZY_VARIANT_ID = '   ';

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_fix_empty_conf_01',
          custom_data: {
            user_id: fixUser.id,
            finding_id: fixFindingId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'ord_fix_empty_01',
          attributes: {
            status: 'paid',
            total: 4900,
            first_order_item: {
              variant_id: 'some_variant_id',
            },
          },
        },
      };

      const payloadStr = JSON.stringify(payload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(payloadStr),
        },
        body: payloadStr,
      });

      assert.strictEqual(res.status, 503);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'FIX_PACKAGE_NOT_CONFIGURED');

      const hasEntitlement = await testStorage.hasActivePaidEntitlement(fixUser.id, fixFindingId);
      assert.strictEqual(hasEntitlement, false);
    });

    test('3. Incoming variant ID does not match configured ID -> rejected with 400 WRONG_VARIANT', async () => {
      process.env.LEMON_SQUEEZY_VARIANT_ID = 'var_fix_pkg_49';

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_fix_wrong_var_01',
          custom_data: {
            user_id: fixUser.id,
            finding_id: fixFindingId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'ord_fix_wrong_var_01',
          attributes: {
            status: 'paid',
            total: 4900,
            first_order_item: {
              variant_id: 'var_unrecognized_variant_999',
            },
          },
        },
      };

      const payloadStr = JSON.stringify(payload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(payloadStr),
        },
        body: payloadStr,
      });

      assert.strictEqual(res.status, 400);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'WRONG_VARIANT');

      const hasEntitlement = await testStorage.hasActivePaidEntitlement(fixUser.id, fixFindingId);
      assert.strictEqual(hasEntitlement, false);
    });

    test('4. Incoming variant ID matches configured ID -> accepted with 200 SUCCESS and creates entitlement', async () => {
      process.env.LEMON_SQUEEZY_VARIANT_ID = 'var_fix_pkg_49';

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_fix_match_var_01',
          custom_data: {
            user_id: fixUser.id,
            finding_id: fixFindingId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'ord_fix_match_var_01',
          attributes: {
            status: 'paid',
            total: 4900,
            first_order_item: {
              variant_id: 'var_fix_pkg_49',
            },
          },
        },
      };

      const payloadStr = JSON.stringify(payload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(payloadStr),
        },
        body: payloadStr,
      });

      assert.strictEqual(res.status, 200);
      const body: any = await res.json();
      assert.strictEqual(body.status, 'SUCCESS');
      assert.strictEqual(body.finding_id, fixFindingId);

      const hasEntitlement = await testStorage.hasActivePaidEntitlement(fixUser.id, fixFindingId);
      assert.strictEqual(hasEntitlement, true);
    });

    test('5. Validly signed webhook with missing variant configuration is not accepted as a successful purchase', async () => {
      delete process.env.LEMON_SQUEEZY_VARIANT_ID;

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_fix_valid_sig_missing_conf',
          custom_data: {
            user_id: fixUser.id,
            finding_id: fixFindingId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'ord_fix_valid_sig_missing_conf_01',
          attributes: {
            status: 'paid',
            total: 4900,
            variant_id: 'some_incoming_variant_id',
          },
        },
      };

      const payloadStr = JSON.stringify(payload);
      const validSignature = signPayload(payloadStr);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': validSignature,
        },
        body: payloadStr,
      });

      // Must NOT be accepted as success (status 200)
      assert.notStrictEqual(res.status, 200);
      assert.strictEqual(res.status, 503);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'FIX_PACKAGE_NOT_CONFIGURED');

      const hasEntitlement = await testStorage.hasActivePaidEntitlement(fixUser.id, fixFindingId);
      assert.strictEqual(hasEntitlement, false);

      // Restore configuration
      process.env.LEMON_SQUEEZY_VARIANT_ID = 'var_fix_pkg_49';
    });
  });

  // =========================================================================
  // Finding 4: MCP Rate Limiter & Client Identifier Verification
  // =========================================================================
  describe('Finding 4: MCP Rate Limiting & Client Identity Resolution', () => {
    test('getClientIdentifier uses authenticated user ID when session exists', () => {
      const mockReq: any = {
        user: { id: 'usr_auth_lead_123', email: 'lead@corp.internal' },
        ip: '192.168.1.100',
        headers: { 'x-forwarded-for': '10.0.0.1' },
      };

      const key = getClientIdentifier(mockReq);
      assert.strictEqual(key, 'user:usr_auth_lead_123');
    });

    test('getClientIdentifier safely keys by req.ip / socket for anonymous requests without trusting spoofable headers directly', () => {
      const mockReq: any = {
        ip: '203.0.113.195',
        socket: { remoteAddress: '203.0.113.195' },
        headers: { 'x-forwarded-for': 'spoofed.evil.attacker.com' },
      };

      const key = getClientIdentifier(mockReq);
      assert.strictEqual(key, 'ip:203.0.113.195');
    });

    test('MCP rate limiter rejects requests with 429 when exceeding threshold', async () => {
      resetRateLimitsForTesting();

      // Make 60 requests (within limit)
      const testUser: User = {
        id: 'usr_rate_limit_test',
        email: 'ratelimit@example.com',
        password_hash: 'hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await testStorage.createUser(testUser);

      // Test rate limiting via POST /mcp endpoint
      const makeRequest = () =>
        fetch(`${serverUrl}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
          }),
        });

      // Rapidly send requests
      let rateLimited = false;
      for (let i = 0; i < 65; i++) {
        const res = await makeRequest();
        if (res.status === 429) {
          rateLimited = true;
          const body: any = await res.json();
          assert.strictEqual(body.error, 'RATE_LIMIT_EXCEEDED');
          break;
        }
      }

      assert.strictEqual(rateLimited, true, 'Rate limiter must trigger 429 after 60 requests');
    });
  });
});
