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
  test('1. Valid full refund revokes Fix Package entitlement (status: REVOKED)', async () => {
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

  // --- Scenario 2: Invalid webhook signature rejected (401) ---
  test('2. Invalid webhook signature is rejected with 401', async () => {
    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_invalid_sig',
        custom_data: {
          user_id: 'usr_any',
          finding_id: 'finding_any',
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_any',
        attributes: {
          status: 'refunded',
        },
      },
    };

    const payloadString = JSON.stringify(refundPayload);
    const wrongSignature = signPayload(payloadString, 'wrong_secret');

    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': wrongSignature,
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 401);
    const body: any = await res.json();
    assert.strictEqual(body.error, 'INVALID_SIGNATURE');
  });

  // --- Scenario 3: Refund for order A does not revoke order B ---
  test('3. Refund for order A does not revoke entitlement for order B', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_isolation_3',
      email: 'isolation3@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingA = 'finding_A';
    const findingB = 'finding_B';
    await serverStorage.registerFindingOwnership(findingA, user.id);
    await serverStorage.registerFindingOwnership(findingB, user.id);

    // Create entitlements for order A and order B
    await serverStorage.createEntitlement({
      id: 'ent_A',
      user_id: user.id,
      finding_id: findingA,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_A',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await serverStorage.createEntitlement({
      id: 'ent_B',
      user_id: user.id,
      finding_id: findingB,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_B',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Refund order A
    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_refund_ord_A',
        custom_data: {
          user_id: user.id,
          finding_id: findingA,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_A',
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

    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature,
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 200);

    // Finding A entitlement is revoked
    const entA = await serverStorage.getEntitlement(user.id, findingA);
    assert.strictEqual(entA?.status, 'REVOKED');
    assert.strictEqual(await serverStorage.hasActivePaidEntitlement(user.id, findingA), false);

    // Finding B entitlement is strictly ACTIVE
    const entB = await serverStorage.getEntitlement(user.id, findingB);
    assert.strictEqual(entB?.status, 'ACTIVE');
    assert.strictEqual(await serverStorage.hasActivePaidEntitlement(user.id, findingB), true);
  });

  // --- Scenario 4: Refund for user A cannot affect user B ---
  test('4. Refund for user A cannot affect or revoke user B entitlement', async () => {
    serverStorage.clearAll();

    const userA: User = {
      id: 'usr_A_4',
      email: 'userA@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const userB: User = {
      id: 'usr_B_4',
      email: 'userB@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(userA);
    await serverStorage.createUser(userB);

    const findingA = 'finding_userA';
    const findingB = 'finding_userB';
    await serverStorage.registerFindingOwnership(findingA, userA.id);
    await serverStorage.registerFindingOwnership(findingB, userB.id);

    await serverStorage.createEntitlement({
      id: 'ent_userA',
      user_id: userA.id,
      finding_id: findingA,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_userA',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await serverStorage.createEntitlement({
      id: 'ent_userB',
      user_id: userB.id,
      finding_id: findingB,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_userB',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Malicious or mismatched payload attempting to specify userA with findingB
    const mismatchPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_cross_user_attempt',
        custom_data: {
          user_id: userA.id,
          finding_id: findingB, // Owned by userB!
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_malicious',
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
    const resMismatch = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(mismatchString),
      },
      body: mismatchString,
    });

    assert.strictEqual(resMismatch.status, 403);
    const mismatchBody: any = await resMismatch.json();
    assert.strictEqual(mismatchBody.error, 'FINDING_OWNERSHIP_MISMATCH');

    // Verify userB entitlement was completely unaffected
    const entB = await serverStorage.getEntitlement(userB.id, findingB);
    assert.strictEqual(entB?.status, 'ACTIVE');
    assert.strictEqual(await serverStorage.hasActivePaidEntitlement(userB.id, findingB), true);
  });

  // --- Scenario 5: Unknown order does not revoke ---
  test('5. Unknown order or non-existent entitlement returns 404 and revokes nothing', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_unknown_5',
      email: 'unknown5@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_unknown_5';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    const unknownPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_unknown_ord',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_nonexistent',
        attributes: {
          status: 'refunded',
          refunded: true,
          total: 4900,
          refunded_amount: 4900,
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(unknownPayload);
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
  });

  // --- Scenario 6: Replaying refund is idempotent (200 IDEMPOTENT_DUPLICATE) ---
  test('6. Replaying identical refund webhook event is idempotent', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_replay_6',
      email: 'replay6@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_replay_6';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    await serverStorage.createEntitlement({
      id: 'ent_replay_6',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_replay_6',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_replay_unique_1',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_replay_6',
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

    // First delivery
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
    assert.strictEqual(body1.action, 'REVOKED');

    // Second delivery (replay)
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

    // Status remains REVOKED
    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'REVOKED');
  });

  // --- Scenario 7: Concurrent delivery of same refund event is safe ---
  test('7. Concurrent delivery of same refund event is safe and never double-processes', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_concurrent_7',
      email: 'concurrent7@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_concurrent_7';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    await serverStorage.createEntitlement({
      id: 'ent_concurrent_7',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_concurrent_7',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_concurrent_7_unique',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_concurrent_7',
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

    // Fire 5 concurrent requests simultaneously
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

    assert.strictEqual(successCount, 1, 'Exactly one request should execute the revocation');
    assert.strictEqual(duplicateCount, 4, 'Remaining concurrent requests should receive IDEMPOTENT_DUPLICATE');

    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'REVOKED');
  });

  // --- Scenario 8: Delayed order_created cannot reactivate a refunded entitlement ---
  test('8. Delayed order_created cannot reactivate an already refunded entitlement (monotonic invariant)', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_delayed_8',
      email: 'delayed8@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_delayed_8';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    // Step 1: User initially had an active entitlement that got revoked via refund
    await serverStorage.createEntitlement({
      id: 'ent_delayed_8',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'REVOKED',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_delayed_8',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Step 2: A delayed or out-of-order 'order_created' arrives for ord_delayed_8
    const delayedOrderPayload = {
      meta: {
        event_name: 'order_created',
        event_id: 'evt_delayed_order_created_8',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_delayed_8',
        attributes: {
          status: 'paid',
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(delayedOrderPayload);
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

    // Entitlement must STILL be REVOKED, never flipped back to ACTIVE
    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'REVOKED');
    assert.strictEqual(await serverStorage.hasActivePaidEntitlement(user.id, findingId), false);
  });

  // --- Scenario 9: Non-refund payment behavior remains intact ---
  test('9. Normal order_created event successfully creates ACTIVE entitlement', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_normal_9',
      email: 'normal9@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_normal_9';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    const orderPayload = {
      meta: {
        event_name: 'order_created',
        event_id: 'evt_normal_create_9',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_normal_9',
        attributes: {
          status: 'paid',
          first_order_item: { variant_id: 'variant_fix_49' },
        },
      },
    };

    const payloadString = JSON.stringify(orderPayload);
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

    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.ok(ent);
    assert.strictEqual(ent.status, 'ACTIVE');
    assert.strictEqual(await serverStorage.hasActivePaidEntitlement(user.id, findingId), true);
  });

  // --- Scenario 10: Outcome Fee obligations unaffected by Fix Package refund ---
  test('10. Outcome Fee obligations are completely unaffected by Fix Package refund', async () => {
    serverStorage.clearAll();

    const user: User = {
      id: 'usr_outcome_10',
      email: 'outcome10@example.com',
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createUser(user);

    const findingId = 'finding_outcome_10';
    await serverStorage.registerFindingOwnership(findingId, user.id);

    // Active fix package entitlement
    await serverStorage.createEntitlement({
      id: 'ent_fix_10',
      user_id: user.id,
      finding_id: findingId,
      type: 'PAID_FIX_PACKAGE',
      status: 'ACTIVE',
      provider: 'LEMON_SQUEEZY',
      provider_transaction_id: 'ord_fix_10',
      amount_usd: 49.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Settled Outcome Fee obligation
    const obligation: OutcomeFeeObligation = {
      id: 'of_obligation_10',
      user_id: user.id,
      finding_id: findingId,
      verification_id: 'ver_10',
      verified_annualized_savings_usd: 5000,
      fee_amount_usd: 1000,
      currency: 'USD',
      status: 'SETTLED',
      provider: 'LEMON_SQUEEZY',
      provider_order_id: 'ord_outcome_settled_10',
      paid_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await serverStorage.createOutcomeFeeObligation(obligation);

    // Refund Fix Package order
    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: 'evt_refund_fix_10',
        custom_data: {
          user_id: user.id,
          finding_id: findingId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: 'ord_fix_10',
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

    const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature,
      },
      body: payloadString,
    });

    assert.strictEqual(res.status, 200);

    // Fix Package entitlement is revoked
    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'REVOKED');

    // Outcome Fee obligation is preserved intact as SETTLED
    const savedOb = await serverStorage.getOutcomeFeeObligation(findingId);
    assert.ok(savedOb);
    assert.strictEqual(savedOb.status, 'SETTLED');
    assert.strictEqual(savedOb.fee_amount_usd, 1000);
  });

  // --- Scenario 11: Partial refund behavior preserves active entitlement ---
  test('11. Partial refund preserves ACTIVE entitlement and returns IGNORED_PARTIAL_REFUND', async () => {
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
          refunded_amount: 1500, // $15 refunded out of $49
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

    // Entitlement must REMAIN ACTIVE
    const ent = await serverStorage.getEntitlement(user.id, findingId);
    assert.strictEqual(ent?.status, 'ACTIVE');
    assert.strictEqual(await serverStorage.hasActivePaidEntitlement(user.id, findingId), true);
  });

  // --- Scenario 12: Both ServerStorage and DrizzleStorageAdapter tested ---
  describe('12. DrizzleStorageAdapter direct refund & monotonic tests', () => {
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

    test('DrizzleStorageAdapter atomic refund transaction revokes entitlement', async () => {
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
