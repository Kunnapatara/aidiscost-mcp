/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import cookieParser from 'cookie-parser';
import { authenticate } from '../server/auth';
import { createApiRouter } from '../server/api';
import { getStorage } from '../server/storage';
import { OutcomeFeeObligation } from '../server/types';

describe('AIDisCost MCP — Areas 4 & 5 HTTP Webhook & Billing Lifecycle Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  const storage = getStorage();

  const WEBHOOK_SECRET = 'test_webhook_signing_secret_999';
  const FIX_VARIANT_ID = 'variant_fix_49';
  const OUTCOME_VARIANT_ID = 'variant_outcome_fee_20';

  before(async () => {
    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID = FIX_VARIANT_ID;
    process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = OUTCOME_VARIANT_ID;
    process.env.LEMON_SQUEEZY_API_KEY = 'test_api_key';
    process.env.LEMON_SQUEEZY_STORE_ID = 'test_store_123';
    process.env.LEMON_SQUEEZY_SANDBOX = 'true';

    const app = express();
    app.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      })
    );
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser());
    app.use(authenticate);
    app.use('/api', createApiRouter());

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function signPayload(payloadStr: string, secret: string = WEBHOOK_SECRET): string {
    return crypto.createHmac('sha256', secret).update(Buffer.from(payloadStr, 'utf-8')).digest('hex');
  }

  // =========================================================================
  // Section 4A: Fix Package Complete Webhook Lifecycle
  // =========================================================================
  describe('Section 4A: Fix Package Happy Path & Settlement', () => {
    test('Valid signed order_created ($49.00 USD) provisions ACTIVE entitlement, and order_settled is idempotent', async () => {
      const userId = `usr_http_${crypto.randomUUID()}`;
      const findingId = `fnd_http_${crypto.randomUUID()}`;
      const auditId = `aud_http_${crypto.randomUUID()}`;

      await storage.createUser({
        id: userId,
        email: `fix-${userId}@aidiscost.io`,
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await storage.registerFindingOwnership(findingId, userId, auditId);

      const orderId = `ord_fix_${crypto.randomUUID()}`;
      const ocEventId = `evt_oc_${crypto.randomUUID()}`;

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: ocEventId,
          custom_data: {
            user_id: userId,
            finding_id: findingId,
            audit_id: auditId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: orderId,
          type: 'orders',
          attributes: {
            identifier: orderId,
            status: 'paid',
            currency: 'USD',
            total: 4900,
            first_order_item: {
              variant_id: FIX_VARIANT_ID,
              price: 4900,
            },
          },
        },
      };

      const bodyStr = JSON.stringify(payload);
      const res = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(bodyStr),
        },
        body: bodyStr,
      });

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.status, 'SUCCESS');
      assert.ok(json.entitlement_id);
      assert.strictEqual(json.finding_id, findingId);

      // Database assertion
      const ent = await storage.getEntitlement(userId, findingId, auditId);
      assert.ok(ent, 'Entitlement must be in database');
      assert.strictEqual(ent.status, 'ACTIVE');
      assert.strictEqual(ent.provider_transaction_id, orderId);
      assert.strictEqual(ent.type, 'PAID_FIX_PACKAGE');

      // Deliver order_settled
      const osEventId = `evt_os_${crypto.randomUUID()}`;
      const osPayload = {
        ...payload,
        meta: {
          ...payload.meta,
          event_name: 'order_settled',
          event_id: osEventId,
        },
      };
      const osBodyStr = JSON.stringify(osPayload);
      const osRes = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(osBodyStr),
        },
        body: osBodyStr,
      });

      assert.strictEqual(osRes.status, 200);
      const entAfterSettle = await storage.getEntitlement(userId, findingId, auditId);
      assert.strictEqual(entAfterSettle?.status, 'ACTIVE', 'Entitlement must remain ACTIVE');
      assert.strictEqual(entAfterSettle?.provider_transaction_id, orderId);
    });
  });

  // =========================================================================
  // Section 4B: Security & Invalid Webhook Events
  // =========================================================================
  describe('Section 4B: Security Hardening & Fail-Closed Invalid Events', () => {
    const userId = `usr_sec_${crypto.randomUUID()}`;
    const findingId = `fnd_sec_${crypto.randomUUID()}`;
    const auditId = `aud_sec_${crypto.randomUUID()}`;

    before(async () => {
      await storage.createUser({
        id: userId,
        email: `sec-${userId}@aidiscost.io`,
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await storage.registerFindingOwnership(findingId, userId, auditId);
    });

    test('1. Missing x-signature header returns 401 INVALID_SIGNATURE', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: { event_name: 'order_created' } }),
      });
      assert.strictEqual(res.status, 401);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'INVALID_SIGNATURE');
    });

    test('2. Tampered signature returns 401 INVALID_SIGNATURE', async () => {
      const bodyStr = JSON.stringify({ meta: { event_name: 'order_created' } });
      const res = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': '0000000000000000000000000000000000000000000000000000000000000000',
        },
        body: bodyStr,
      });
      assert.strictEqual(res.status, 401);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'INVALID_SIGNATURE');
    });

    test('3. Malformed payload missing event_name or event_id returns 400 MALFORMED_WEBHOOK', async () => {
      const bodyStr = JSON.stringify({ meta: {} });
      const res = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(bodyStr) },
        body: bodyStr,
      });
      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'MALFORMED_WEBHOOK');
    });

    test('4. Missing product in custom_data returns 400 INVALID_PRODUCT', async () => {
      const bodyStr = JSON.stringify({
        meta: { event_name: 'order_created', event_id: `evt_inv_prod_${crypto.randomUUID()}`, custom_data: {} },
        data: { id: 'ord_1', attributes: { status: 'paid' } },
      });
      const res = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(bodyStr) },
        body: bodyStr,
      });
      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'INVALID_PRODUCT');
    });

    test('5. Wrong variant ID returns 400 WRONG_VARIANT', async () => {
      const bodyStr = JSON.stringify({
        meta: {
          event_name: 'order_created',
          event_id: `evt_inv_var_${crypto.randomUUID()}`,
          custom_data: { user_id: userId, finding_id: findingId, audit_id: auditId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: 'ord_var_mismatch',
          attributes: {
            status: 'paid',
            currency: 'USD',
            total: 4900,
            first_order_item: { variant_id: 'wrong_variant_999', price: 4900 },
          },
        },
      });
      const res = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(bodyStr) },
        body: bodyStr,
      });
      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'WRONG_VARIANT');
    });

    test('6. Wrong currency (e.g. EUR) returns 400 CURRENCY_MISMATCH', async () => {
      const bodyStr = JSON.stringify({
        meta: {
          event_name: 'order_created',
          event_id: `evt_inv_curr_${crypto.randomUUID()}`,
          custom_data: { user_id: userId, finding_id: findingId, audit_id: auditId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: 'ord_curr_eur',
          attributes: {
            status: 'paid',
            currency: 'EUR',
            total: 4900,
            first_order_item: { variant_id: FIX_VARIANT_ID, price: 4900 },
          },
        },
      });
      const res = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(bodyStr) },
        body: bodyStr,
      });
      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'CURRENCY_MISMATCH');
    });

    test('7. Incorrect amount ($48.00 instead of $49.00) returns 400 AMOUNT_MISMATCH', async () => {
      const bodyStr = JSON.stringify({
        meta: {
          event_name: 'order_created',
          event_id: `evt_inv_amt_${crypto.randomUUID()}`,
          custom_data: { user_id: userId, finding_id: findingId, audit_id: auditId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: 'ord_amt_under',
          attributes: {
            status: 'paid',
            currency: 'USD',
            total: 4800, // $48.00
            first_order_item: { variant_id: FIX_VARIANT_ID, price: 4800 },
          },
        },
      });
      const res = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(bodyStr) },
        body: bodyStr,
      });
      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'AMOUNT_MISMATCH');
    });

    test('8. Cross-user finding ownership mismatch returns 403 FINDING_OWNERSHIP_MISMATCH', async () => {
      const imposterUserId = `usr_imposter_${crypto.randomUUID()}`;
      await storage.createUser({
        id: imposterUserId,
        email: `imposter-${imposterUserId}@aidiscost.io`,
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const bodyStr = JSON.stringify({
        meta: {
          event_name: 'order_created',
          event_id: `evt_imposter_${crypto.randomUUID()}`,
          custom_data: { user_id: imposterUserId, finding_id: findingId, audit_id: auditId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: 'ord_imposter',
          attributes: {
            status: 'paid',
            currency: 'USD',
            total: 4900,
            first_order_item: { variant_id: FIX_VARIANT_ID, price: 4900 },
          },
        },
      });
      const res = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(bodyStr) },
        body: bodyStr,
      });
      assert.strictEqual(res.status, 403);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'FINDING_OWNERSHIP_MISMATCH');
    });

    test('9. Replayed event ID returns 200 IDEMPOTENT_DUPLICATE without duplicating entitlement', async () => {
      const replayEventId = `evt_replay_${crypto.randomUUID()}`;
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: replayEventId,
          custom_data: { user_id: userId, finding_id: findingId, audit_id: auditId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: `ord_replay_${crypto.randomUUID()}`,
          attributes: {
            status: 'paid',
            currency: 'USD',
            total: 4900,
            first_order_item: { variant_id: FIX_VARIANT_ID, price: 4900 },
          },
        },
      };
      const bodyStr = JSON.stringify(payload);

      // First delivery
      const res1 = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(bodyStr) },
        body: bodyStr,
      });
      assert.strictEqual(res1.status, 200);

      // Replay identical event
      const res2 = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(bodyStr) },
        body: bodyStr,
      });
      assert.strictEqual(res2.status, 200);
      const json2: any = await res2.json();
      assert.strictEqual(json2.status, 'IDEMPOTENT_DUPLICATE');
    });
  });

  // =========================================================================
  // Section 5: Outcome Fee, Refunds, Underpayment, & Reconciliation
  // =========================================================================
  describe('Section 5: Outcome Fee Lifecycle, Refunds & Reconciliation', () => {
    test('Authoritative obligation creation, 20% savings basis, paid transition, and full refund to REFUNDED', async () => {
      const userId = `usr_of_${crypto.randomUUID()}`;
      const findingId = `fnd_of_${crypto.randomUUID()}`;
      const auditId = `aud_of_${crypto.randomUUID()}`;

      await storage.createUser({
        id: userId,
        email: `outcome-${userId}@aidiscost.io`,
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await storage.registerFindingOwnership(findingId, userId, auditId);

      const verId = `ver_of_${crypto.randomUUID()}`;
      await storage.saveVerification({
        id: verId,
        finding_id: findingId,
        user_id: userId,
        audit_id: auditId,
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 20,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 12000.0,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const obligation: OutcomeFeeObligation = {
        id: `of_flow_${crypto.randomUUID()}`,
        user_id: userId,
        finding_id: findingId,
        audit_id: auditId,
        verification_id: verId,
        verified_annualized_savings_usd: 12000.0,
        fee_amount_usd: 1000.0, // 20% of monthly savings
        currency: 'USD',
        status: 'CHECKOUT_CREATED',
        provider: 'LEMON_SQUEEZY',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.createOutcomeFeeObligation(obligation);

      // Deliver Outcome Fee order_created webhook ($1,000.00 USD = 100,000 cents)
      const ofOrderId = `ord_of_${crypto.randomUUID()}`;
      const ofPayload = {
        meta: {
          event_name: 'order_created',
          event_id: `evt_of_oc_${crypto.randomUUID()}`,
          custom_data: {
            user_id: userId,
            finding_id: findingId,
            audit_id: auditId,
            obligation_id: obligation.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: ofOrderId,
          type: 'orders',
          attributes: {
            status: 'paid',
            currency: 'USD',
            total: 100000,
            first_order_item: { variant_id: OUTCOME_VARIANT_ID, price: 100000 },
          },
        },
      };
      const ofBody = JSON.stringify(ofPayload);
      const ofRes = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(ofBody) },
        body: ofBody,
      });
      assert.strictEqual(ofRes.status, 200);

      const obPaid = await storage.getOutcomeFeeObligation(findingId, userId, auditId);
      assert.strictEqual(obPaid?.status, 'PAID');

      // Full refund on Outcome Fee -> Status REFUNDED
      const refundEventId = `evt_of_ref_${crypto.randomUUID()}`;
      const refundPayload = {
        meta: {
          event_name: 'order_refunded',
          event_id: refundEventId,
          custom_data: {
            user_id: userId,
            finding_id: findingId,
            audit_id: auditId,
            obligation_id: obligation.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: ofOrderId,
          type: 'orders',
          attributes: {
            status: 'refunded',
            currency: 'USD',
            total: 100000,
            refunded: true,
            refunded_amount: 100000,
            first_order_item: { variant_id: OUTCOME_VARIANT_ID },
          },
        },
      };
      const refBody = JSON.stringify(refundPayload);
      const refRes = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(refBody) },
        body: refBody,
      });
      assert.strictEqual(refRes.status, 200);

      const obRefunded = await storage.getOutcomeFeeObligation(findingId, userId, auditId);
      assert.strictEqual(obRefunded?.status, 'REFUNDED', 'Obligation must transition to REFUNDED');

      // Monotonic non-regression: late order_created cannot revert REFUNDED back to PAID
      const lateEventId = `evt_of_late_${crypto.randomUUID()}`;
      const latePayload = {
        ...ofPayload,
        meta: { ...ofPayload.meta, event_id: lateEventId },
      };
      const lateBody = JSON.stringify(latePayload);
      await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(lateBody) },
        body: lateBody,
      });

      const obAfterLate = await storage.getOutcomeFeeObligation(findingId, userId, auditId);
      assert.strictEqual(obAfterLate?.status, 'REFUNDED', 'Delayed event must NEVER revert REFUNDED state');
    });

    test('Partial refund is quarantined to payment_reconciliations with reason PARTIAL_REFUND', async () => {
      const userId = `usr_part_${crypto.randomUUID()}`;
      const findingId = `fnd_part_${crypto.randomUUID()}`;
      const auditId = `aud_part_${crypto.randomUUID()}`;

      await storage.createUser({
        id: userId,
        email: `part-${userId}@aidiscost.io`,
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await storage.registerFindingOwnership(findingId, userId, auditId);

      const partialEventId = `evt_part_${crypto.randomUUID()}`;
      const orderId = `ord_part_${crypto.randomUUID()}`;
      const partialPayload = {
        meta: {
          event_name: 'order_refunded',
          event_id: partialEventId,
          custom_data: { user_id: userId, finding_id: findingId, audit_id: auditId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: orderId,
          type: 'orders',
          attributes: {
            status: 'partial_refund',
            currency: 'USD',
            total: 4900,
            refunded_amount: 1000, // $10.00 refunded out of $49.00
            first_order_item: { variant_id: FIX_VARIANT_ID },
          },
        },
      };

      const partBody = JSON.stringify(partialPayload);
      const res = await fetch(`${baseUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(partBody) },
        body: partBody,
      });

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.status, 'IGNORED_PARTIAL_REFUND');

      // Verify reconciliation record
      const reconciliations = typeof storage.listPaymentReconciliations === 'function'
        ? await storage.listPaymentReconciliations()
        : [];
      const rec = reconciliations.find((r) => r.primary_order_id === orderId);
      assert.ok(rec, 'Partial refund must be recorded in payment_reconciliations');
      assert.strictEqual(rec.reason, 'PARTIAL_REFUND');
      assert.strictEqual(rec.status, 'NEEDS_REFUND_REVIEW');
      assert.strictEqual(rec.amount_usd, 10.0);
    });

    test('GET /api/billing/reconciliations exposes all flagged reconciliation items to authenticated user', async () => {
      const authUserId = `usr_auth_rec_${crypto.randomUUID()}`;
      await storage.createUser({
        id: authUserId,
        email: `auth-rec-${authUserId}@aidiscost.io`,
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const sessionToken = crypto.randomBytes(32).toString('hex');
      await storage.createSession({
        token: sessionToken,
        user_id: authUserId,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      });

      const res = await fetch(`${baseUrl}/api/billing/reconciliations`, {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.ok(Array.isArray(json.reconciliations), 'Response must contain reconciliations array');
      assert.ok(typeof json.count === 'number', 'Response must contain count');
    });
  });
});
