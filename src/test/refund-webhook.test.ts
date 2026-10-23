/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { ServerStorage, setStorage } from '../server/storage';
import { createDatabaseConnection, initializeDatabaseSchema } from '../server/db/index';
import { DrizzleStorageAdapter } from '../server/db/adapter';
import { authenticate } from '../server/auth';
import { createApiRouter } from '../server/api';
import { User, Entitlement, FindingOwnership, OutcomeFeeObligation } from '../server/types';

describe('AIDisCost Server — Lemon Squeezy Refund Webhook & Revocation Tests', () => {
  let server: http.Server;
  let serverUrl: string;
  const testSecret = 'test_refund_webhook_secret_key_999';
  const serverStorage = ServerStorage.getInstance('data', 'test-refund-db.json');

  before(async () => {
    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = testSecret;
    process.env.LEMON_SQUEEZY_VARIANT_ID = 'variant_fix_49';

    serverStorage.setTestMode(true);
    serverStorage.clearAll();
    setStorage(serverStorage);

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

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    serverStorage.clearAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function signPayload(payloadString: string, secret: string = testSecret): string {
    return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
  }

  // --- Scenario 1: Valid full refund revokes Fix Package entitlement ---
  test('1. Valid full refund with an exact matching Order ID revokes the correct Fix Package entitlement', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_refund_1',
      email: 'customer1@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_revocation_1';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    const initialEntitlement: Entitlement = {
      id: 'ent_refund_1',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_1001',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createEntitlement(initialEntitlement);

    assert.strictEqual(await serverStorage.hasActivePaidEntitlement(user.id, findingId), true);

    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_refund_1001',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_1001',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: {
            variant_id: 'variant_fix_49',
          },
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const signature = signPayload(payloadString);

    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature,
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.strictEqual(body.status, 'SUCCESS');
    assert.strictEqual(body.action, 'REVOKED');
    assert.strictEqual(body.finding_id, findingId);

    const updatedEnt = await serverStorage.getEntitlement(user.id, findingId);
    assert.ok(updatedEnt);
    assert.strictEqual(updatedEnt.status, 'REVOKED');
    assert.strictEqual(await serverStorage.hasActivePaidEntitlement(user.id, findingId), false);
  });

  // --- Scenario 2: Null / undefined providerTransactionId does not revoke ---
  test('2. A null or undefined providerTransactionId does not revoke an entitlement (fail closed)', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_null_tx',
      email: 'nulltx@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_null_tx';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    // Entitlement with null/undefined transaction ID
    await serverStorage.createEntitlement({
      id: 'ent_null_tx',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: (null as unknown) as string,
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_null_tx_refund',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_some_order_id',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(payloadString),
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 400);
    const body: any = await res.json();
    assert.strictEqual(body.error, 'ORDER_MISMATCH');

    // Entitlement must remain ACTIVE
    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'ACTIVE');
  });

  // --- Scenario 3: Empty string providerTransactionId does not revoke ---
  test('3. An empty providerTransactionId does not revoke an entitlement (fail closed)', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_empty_tx',
      email: 'emptytx@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_empty_tx';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    // Entitlement with empty string transaction ID
    await serverStorage.createEntitlement({
      id: 'ent_empty_tx',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: '   ',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_empty_tx_refund',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_some_order_id',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(payloadString),
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 400);
    const body: any = await res.json();
    assert.strictEqual(body.error, 'ORDER_MISMATCH');

    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'ACTIVE');
  });

  // --- Scenario 4: Mismatched Order ID does not revoke ---
  test('4. A mismatched Order ID does not revoke an entitlement', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_mis_4',
      email: 'mismatch4@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_mis_4';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    await serverStorage.createEntitlement({
      id: 'ent_mis_4',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_actual_123',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_mis_order_id',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_wrong_order_456',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(payloadString),
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 400);
    const body: any = await res.json();
    assert.strictEqual(body.error, 'ORDER_MISMATCH');

    // Entitlement must remain ACTIVE
    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'ACTIVE');
  });

  // --- Scenario 5: Different user's entitlement cannot be revoked ---
  test('5. A different user entitlement cannot be revoked', async () => {
    serverStorage.clearAll();

    const userA: User = {
      id: 'usr_A_5',
      email: 'userA5@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const userB: User = {
      id: 'usr_B_5',
      email: 'userB5@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(userA);
    await serverStorage.createUser(userB);

    const findingA = 'finding_A_5';
    const findingB = 'finding_B_5';
    await serverStorage.registerFindingOwnership(findingA, userA.id);
    await serverStorage.registerFindingOwnership(findingB, userB.id);

    await serverStorage.createEntitlement({
      id: 'ent_userA_5',
      user_id: userA.id,
      finding_id: findingA,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_userA_5',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await serverStorage.createEntitlement({
      id: 'ent_userB_5',
      user_id: userB.id,
      finding_id: findingB,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_userB_5',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Mismatched payload claiming userA for findingB
    const mismatchPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_cross_user_5',
        custom_data: {
          user_id: userA.id,
          finding_id: findingB,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_userB_5',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const mismatchString = JSON.stringify(mismatchPayload);
    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(mismatchString),
      },
      body: mismatchString,
    });

    assert.strictEqual(res.status, 403);
    const body: any = await res.json();
    assert.strictEqual(body.error, 'FINDING_OWNERSHIP_MISMATCH');

    const entB = await serverStorage.getEntitlement(userB.id, findingB);
    assert.strictEqual(entB?.status, 'ACTIVE');
  });

  // --- Scenario 6: Different finding entitlement cannot be revoked ---
  test('6. A different finding entitlement cannot be revoked', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_findings_6',
      email: 'findings6@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingTarget = 'finding_target_6';
    const findingOther = 'finding_other_6';
    await serverStorage.registerFindingOwnership(findingTarget, user.id);
    await serverStorage.registerFindingOwnership(findingOther, user.id);

    await serverStorage.createEntitlement({
      id: 'ent_other_6',
      user_id: user.id,
      finding_id: findingOther,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_other_6',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Refund specifies findingTarget which has no entitlement
    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_diff_finding_6',
        custom_data: {
          user_id: user.id,
          finding_id: findingTarget,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_other_6',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(payloadString),
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 404);
    const body: any = await res.json();
    assert.strictEqual(body.error, 'ENTITLEMENT_NOT_FOUND');

    // Other finding's entitlement must remain ACTIVE
    const entOther = await serverStorage.getEntitlement(user.id, findingOther);
    assert.strictEqual(entOther?.status, 'ACTIVE');
  });

  // --- Scenario 7: Outcome Fee entitlement is not revoked by Fix Package refund ---
  test('7. An Outcome Fee entitlement is not revoked by Fix Package refund processing', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_outcome_7',
      email: 'outcome7@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_outcome_7';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    // Settled Outcome Fee obligation
    const obligation: OutcomeFeeObligation = {
      id: 'of_obligation_7',
      user_id: user.id,
      finding_id: findingId,
      verification_id: 'ver_7',
      verified_annualized_savings_usd: 8000,
      fee_amount_usd: 1600,
      currency: 'USD',
      status: 'SETTLED',
      provider: 'LEMON_SQUEEZY',
      provider_order_id: 'ord_outcome_7',
      paid_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createOutcomeFeeObligation(obligation);

    // Active fix package entitlement
    await serverStorage.createEntitlement({
      id: 'ent_fix_7',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_fix_7',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Refund Fix Package order
    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_refund_fix_7',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_fix_7',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(payloadString),
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 200);

    // Fix Package is revoked
    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'REVOKED');

    // Outcome Fee obligation remains SETTLED
    const savedOb = await serverStorage.getOutcomeFeeObligation(findingId);
    assert.ok(savedOb);
    assert.strictEqual(savedOb.status, 'SETTLED');
    assert.strictEqual(savedOb.fee_amount_usd, 1600);
  });

  // --- Scenario 8: Entitlement associated with different provider cannot be revoked ---
  test('8. An entitlement associated with a different provider cannot be revoked', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_prov_8',
      email: 'prov8@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_prov_8';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    // Entitlement with DEMO_ADAPTER provider
    await serverStorage.createEntitlement({
      id: 'ent_demo_prov_8',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'DEMO_ADAPTER',
      provider_transaction_id: 'ord_demo_8',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_demo_prov_8',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_demo_8',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(payloadString),
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 400);
    const body: any = await res.json();
    assert.strictEqual(body.error, 'ORDER_MISMATCH');

    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'ACTIVE');
  });

  // --- Scenario 9: Duplicate refund webhook does not cause second mutation ---
  test('9. A duplicate refund webhook does not cause a second mutation or inconsistent result', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_replay_9',
      email: 'replay9@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_replay_9';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    await serverStorage.createEntitlement({
      id: 'ent_replay_9',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_replay_9',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_replay_9_single',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_replay_9',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const signature = signPayload(payloadString);

    // Initial delivery
    const res1 = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature,
      },
      body: payloadString,
    });
    assert.strictEqual(res1.status, 200);
    const body1: any = await res1.json();
    assert.strictEqual(body1.status, 'SUCCESS');

    // Duplicate delivery
    const res2 = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature,
      },
      body: payloadString,
    });
    assert.strictEqual(res2.status, 200);
    const body2: any = await res2.json();
    assert.strictEqual(body2.status, 'IDEMPOTENT_DUPLICATE');

    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'REVOKED');
  });

  // --- Scenario 10: Concurrent delivery of same refund cannot produce inconsistent state ---
  test('10. Concurrent delivery of same refund cannot produce inconsistent entitlement state', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_concurrent_10',
      email: 'concurrent10@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_concurrent_10';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    await serverStorage.createEntitlement({
      id: 'ent_concurrent_10',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_concurrent_10',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_concurrent_10_unique',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_concurrent_10',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const signature = signPayload(payloadString);

    const sendRequest = () =>
      fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: payloadString,
      });

    const responses = await Promise.all([
      sendRequest(),
      sendRequest(),
      sendRequest(),
      sendRequest(),
      sendRequest(),
    ]);

    for (const r of responses) {
      assert.strictEqual(r.status, 200);
    }

    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<any>));
    const successCount = bodies.filter((b) => b.status === 'SUCCESS').length;
    const duplicateCount = bodies.filter((b) => b.status === 'IDEMPOTENT_DUPLICATE').length;

    assert.strictEqual(successCount, 1);
    assert.strictEqual(duplicateCount, 4);

    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'REVOKED');
  });

  // --- Scenario 11: Partial refund retains access ---
  test('11. A partial refund retains access according to the existing product policy', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_partial_11',
      email: 'partial11@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_partial_11';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    await serverStorage.createEntitlement({
      id: 'ent_partial_11',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_partial_11',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const partialRefundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_partial_refund_11',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_partial_11',
        attributes: {
          status: 'partial_refund',
          refunded: false,
          total: 4900,
          refunded_amount: 1500,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(partialRefundPayload);
    const signature = signPayload(payloadString);

    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature,
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.strictEqual(body.status, 'IGNORED_PARTIAL_REFUND');

    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'ACTIVE');
    assert.strictEqual(await serverStorage.hasActivePaidEntitlement(user.id, findingId), true);
  });

  // --- Scenario 12: Unrelated entitlement remains unchanged ---
  test('12. An unrelated entitlement for the same user remains unchanged when another order is refunded', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_unrelated_12',
      email: 'unrelated12@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const finding1 = 'finding_12_A';
    const finding2 = 'finding_12_B';
    await serverStorage.registerFindingOwnership(finding1, user.id);
    await serverStorage.registerFindingOwnership(finding2, user.id);

    await serverStorage.createEntitlement({
      id: 'ent_12_A',
      user_id: user.id,
      finding_id: finding1,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_12_A',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await serverStorage.createEntitlement({
      id: 'ent_12_B',
      user_id: user.id,
      finding_id: finding2,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_12_B',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_refund_12_A',
        custom_data: {
          user_id: user.id,
          finding_id: finding1,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_12_A',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(payloadString),
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 200);

    const ent1 = await serverStorage.getEntitlement(user.id, finding1);
    assert.strictEqual(ent1?.status, 'REVOKED');

    const ent2 = await serverStorage.getEntitlement(user.id, finding2);
    assert.strictEqual(ent2?.status, 'ACTIVE');
  });

  // --- Scenario 13: Delayed order_created cannot reactivate revoked entitlement ---
  test('13. A delayed order_created or order_settled event cannot reactivate an entitlement revoked by a valid refund', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_delayed_13',
      email: 'delayed13@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_delayed_13';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    await serverStorage.createEntitlement({
      id: 'ent_delayed_13',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'REVOKED',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_delayed_13',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const delayedOrderPayload = {
      meta: {
        event_name: 'order_created',
        event_id: 'evt_delayed_order_13',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_delayed_13',
        attributes: {
          status: 'paid',
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(delayedOrderPayload);
    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(payloadString),
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 200);

    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'REVOKED');
  });

  // --- Scenario 14: Invalid webhook signature cannot revoke an entitlement ---
  test('14. An invalid webhook signature cannot revoke an entitlement', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_invalidsig_14',
      email: 'invalidsig14@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_invalidsig_14';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    await serverStorage.createEntitlement({
      id: 'ent_invalidsig_14',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_invalidsig_14',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_invalid_sig_14',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_invalidsig_14',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const wrongSignature = signPayload(payloadString, 'incorrect_secret');

    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': wrongSignature,
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 401);

    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'ACTIVE');
  });

  // --- Direct ServerStorage fail-closed unit tests ---
  describe('ServerStorage fail-closed unit tests', () => {
    test('ServerStorage fails closed when provider_transaction_id is empty or null', async () => {
      serverStorage.clearAll();

      const user: User = {
        id: 'usr_ss_failclose',
        email: 'ss_failclose@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await serverStorage.createUser(user);

      const findingId = 'finding_ss_empty_tx';
      await serverStorage.registerFindingOwnership(findingId, user.id);

      await serverStorage.createEntitlement({
        id: 'ent_ss_empty',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: '',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await serverStorage.processOrderRefundedWebhookTransaction({
        event: {
          event_id: 'evt_ss_ref_1',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_refunded',
          user_id: user.id,
          finding_id: findingId,
          order_id: 'ord_expected_123',
          processed_at: new Date().toISOString(),
        },
        userId: user.id,
        findingId,
        orderId: 'ord_expected_123',
      });

      assert.strictEqual(res.status, 'MISMATCH');
      const ent = await serverStorage.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'ACTIVE');
    });

    test('ServerStorage fails closed when entitlement provider is not LEMON_SQUEEZY', async () => {
      serverStorage.clearAll();

      const user: User = {
        id: 'usr_ss_diff_prov',
        email: 'ss_diff_prov@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await serverStorage.createUser(user);

      const findingId = 'finding_ss_diff_prov';
      await serverStorage.registerFindingOwnership(findingId, user.id);

      await serverStorage.createEntitlement({
        id: 'ent_ss_demo',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'DEMO_ADAPTER',
        provider_transaction_id: 'ord_match_123',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await serverStorage.processOrderRefundedWebhookTransaction({
        event: {
          event_id: 'evt_ss_ref_2',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_refunded',
          user_id: user.id,
          finding_id: findingId,
          order_id: 'ord_match_123',
          processed_at: new Date().toISOString(),
        },
        userId: user.id,
        findingId,
        orderId: 'ord_match_123',
      });

      assert.strictEqual(res.status, 'MISMATCH');
      const ent = await serverStorage.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'ACTIVE');
    });

    test('ServerStorage fails closed when entitlement type is not PAID_FIX_PACKAGE', async () => {
      serverStorage.clearAll();

      const user: User = {
        id: 'usr_ss_diff_type',
        email: 'ss_diff_type@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await serverStorage.createUser(user);

      const findingId = 'finding_ss_diff_type';
      await serverStorage.registerFindingOwnership(findingId, user.id);

      await serverStorage.createEntitlement({
        id: 'ent_ss_preview',
        user_id: user.id,
        finding_id: findingId,
        type: 'DEMO_PREVIEW',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_match_type_123',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await serverStorage.processOrderRefundedWebhookTransaction({
        event: {
          event_id: 'evt_ss_ref_3',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_refunded',
          user_id: user.id,
          finding_id: findingId,
          order_id: 'ord_match_type_123',
          processed_at: new Date().toISOString(),
        },
        userId: user.id,
        findingId,
        orderId: 'ord_match_type_123',
      });

      assert.strictEqual(res.status, 'MISMATCH');
      const ent = await serverStorage.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'ACTIVE');
    });
  });

  // --- DrizzleStorageAdapter direct refund & monotonic tests ---
  describe('DrizzleStorageAdapter direct refund & monotonic tests', () => {
    let db: any;
    let client: any;
    let adapter: DrizzleStorageAdapter;

    beforeEach(async () => {
      const conn = createDatabaseConnection({ url: ':memory:' });
      db = conn.db;
      client = conn.client;
      await initializeDatabaseSchema(client);
      adapter = new DrizzleStorageAdapter(db, client);
    });

    afterEach(() => {
      if (client) client.close();
    });

    test('DrizzleStorageAdapter atomic refund transaction revokes entitlement with exact match', async () => {
      const user: User = {
        id: 'usr_drizzle_refund',
        email: 'drizzle_refund@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const findingId = 'finding_drizzle_refund';
      await adapter.registerFindingOwnership(findingId, user.id);

      await adapter.createEntitlement({
        id: 'ent_drizzle_1',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_drizzle_1',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await adapter.processOrderRefundedWebhookTransaction({
        event: {
          event_id: 'evt_drizzle_ref_1',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_refunded',
          user_id: user.id,
          finding_id: findingId,
          order_id: 'ord_drizzle_1',
          processed_at: new Date().toISOString(),
        },
        userId: user.id,
        findingId,
        orderId: 'ord_drizzle_1',
      });

      assert.strictEqual(res.status, 'SUCCESS');
      assert.strictEqual(res.entitlement?.status, 'REVOKED');

      const ent = await adapter.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'REVOKED');
      assert.strictEqual(await adapter.hasActivePaidEntitlement(user.id, findingId), false);
    });

    test('DrizzleStorageAdapter fails closed when providerTransactionId is empty or whitespace', async () => {
      const user: User = {
        id: 'usr_drizzle_empty_tx',
        email: 'drizzle_empty_tx@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const findingId = 'finding_drizzle_empty_tx';
      await adapter.registerFindingOwnership(findingId, user.id);

      await adapter.createEntitlement({
        id: 'ent_drizzle_empty_tx',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: '   ',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await adapter.processOrderRefundedWebhookTransaction({
        event: {
          event_id: 'evt_drizzle_empty_ref',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_refunded',
          user_id: user.id,
          finding_id: findingId,
          order_id: 'ord_expected_123',
          processed_at: new Date().toISOString(),
        },
        userId: user.id,
        findingId,
        orderId: 'ord_expected_123',
      });

      assert.strictEqual(res.status, 'MISMATCH');
      const ent = await adapter.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'ACTIVE');
    });

    test('DrizzleStorageAdapter returns NOT_FOUND if entitlement does not exist', async () => {
      const res = await adapter.processOrderRefundedWebhookTransaction({
        event: {
          event_id: 'evt_drizzle_not_found',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_refunded',
          user_id: 'usr_nonexistent',
          finding_id: 'finding_nonexistent',
          order_id: 'ord_none',
          processed_at: new Date().toISOString(),
        },
        userId: 'usr_nonexistent',
        findingId: 'finding_nonexistent',
        orderId: 'ord_none',
      });

      assert.strictEqual(res.status, 'NOT_FOUND');
    });

    test('DrizzleStorageAdapter returns MISMATCH if order ID does not match transaction ID', async () => {
      const user: User = {
        id: 'usr_drizzle_mismatch',
        email: 'drizzle_mismatch@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const findingId = 'finding_drizzle_mismatch';
      await adapter.registerFindingOwnership(findingId, user.id);

      await adapter.createEntitlement({
        id: 'ent_drizzle_mis',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_original_id',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await adapter.processOrderRefundedWebhookTransaction({
        event: {
          event_id: 'evt_drizzle_mismatch',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_refunded',
          user_id: user.id,
          finding_id: findingId,
          order_id: 'ord_wrong_id',
          processed_at: new Date().toISOString(),
        },
        userId: user.id,
        findingId,
        orderId: 'ord_wrong_id',
      });

      assert.strictEqual(res.status, 'MISMATCH');
      const ent = await adapter.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'ACTIVE');
    });

    test('DrizzleStorageAdapter returns MISMATCH if provider is not LEMON_SQUEEZY', async () => {
      const user: User = {
        id: 'usr_drizzle_demo_prov',
        email: 'drizzle_demo_prov@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const findingId = 'finding_drizzle_demo_prov';
      await adapter.registerFindingOwnership(findingId, user.id);

      await adapter.createEntitlement({
        id: 'ent_drizzle_demo_prov',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'DEMO_ADAPTER',
        provider_transaction_id: 'ord_match_demo',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await adapter.processOrderRefundedWebhookTransaction({
        event: {
          event_id: 'evt_drizzle_demo_prov',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_refunded',
          user_id: user.id,
          finding_id: findingId,
          order_id: 'ord_match_demo',
          processed_at: new Date().toISOString(),
        },
        userId: user.id,
        findingId,
        orderId: 'ord_match_demo',
      });

      assert.strictEqual(res.status, 'MISMATCH');
      const ent = await adapter.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'ACTIVE');
    });

    test('DrizzleStorageAdapter returns MISMATCH if type is not PAID_FIX_PACKAGE', async () => {
      const user: User = {
        id: 'usr_drizzle_prev_type',
        email: 'drizzle_prev_type@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const findingId = 'finding_drizzle_prev_type';
      await adapter.registerFindingOwnership(findingId, user.id);

      await adapter.createEntitlement({
        id: 'ent_drizzle_prev',
        user_id: user.id,
        finding_id: findingId,
        type: 'DEMO_PREVIEW',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_match_prev',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await adapter.processOrderRefundedWebhookTransaction({
        event: {
          event_id: 'evt_drizzle_prev_ref',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_refunded',
          user_id: user.id,
          finding_id: findingId,
          order_id: 'ord_match_prev',
          processed_at: new Date().toISOString(),
        },
        userId: user.id,
        findingId,
        orderId: 'ord_match_prev',
      });

      assert.strictEqual(res.status, 'MISMATCH');
      const ent = await adapter.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'ACTIVE');
    });

    test('DrizzleStorageAdapter monotonic guard prevents delayed order_created from reactivating REVOKED entitlement', async () => {
      const user: User = {
        id: 'usr_drizzle_monotonic',
        email: 'drizzle_monotonic@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const findingId = 'finding_drizzle_monotonic';
      await adapter.registerFindingOwnership(findingId, user.id);

      // Entitlement is revoked
      await adapter.createEntitlement({
        id: 'ent_drizzle_mono',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'REVOKED',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_drizzle_mono',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Try calling processOrderCreatedWebhookTransaction with ACTIVE status for same transaction
      const res = await adapter.processOrderCreatedWebhookTransaction({
        event: {
          event_id: 'evt_delayed_created_mono',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_created',
          user_id: user.id,
          finding_id: findingId,
          order_id: 'ord_drizzle_mono',
          processed_at: new Date().toISOString(),
        },
        entitlement: {
          id: 'ent_drizzle_mono_new',
          user_id: user.id,
          finding_id: findingId,
          type: 'PAID_FIX_PACKAGE',
          status: 'ACTIVE',
          provider: 'LEMON_SQUEEZY',
          provider_transaction_id: 'ord_drizzle_mono',
          amount_usd: 49.0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });

      assert.strictEqual(res.status, 'SUCCESS');

      // Must remain REVOKED
      const ent = await adapter.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'REVOKED');
      assert.strictEqual(await adapter.hasActivePaidEntitlement(user.id, findingId), false);
    });
  });
});
