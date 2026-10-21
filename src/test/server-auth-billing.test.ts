/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { ServerStorage } from '../server/storage';
import { hashPassword, verifyPassword, generateSessionToken, authenticate } from '../server/auth';
import { verifyLemonSqueezySignature } from '../server/lemon-squeezy';
import { createApiRouter } from '../server/api';

describe('AIDisCost Server — Auth, Entitlement & Billing Tests', () => {
  let server: http.Server;
  let serverUrl: string;
  const storage = ServerStorage.getInstance('data', 'test-db.json');

  before(async () => {
    storage.setTestMode(true);
    storage.clearAll();

    // Create test express app
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
    storage.clearAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe('Cryptographic Password & Session Security', () => {
    test('hashes password using PBKDF2 with salt', () => {
      const password = 'StrongPassword123!';
      const hash = hashPassword(password);
      assert.ok(hash.includes(':'), 'Hash must contain salt delimiter');
      assert.strictEqual(verifyPassword(password, hash), true);
      assert.strictEqual(verifyPassword('WrongPassword', hash), false);
    });

    test('generates cryptographically secure session tokens', () => {
      const token1 = generateSessionToken();
      const token2 = generateSessionToken();
      assert.strictEqual(token1.length, 64, 'Token must be 32 bytes hex (64 chars)');
      assert.notStrictEqual(token1, token2);
    });

    test('verifies Lemon Squeezy HMAC SHA256 signature correctly', () => {
      const secret = 'test_webhook_secret_key_12345';
      const body = JSON.stringify({ event: 'order_created', data: { id: 'ord_123' } });

      const validSignature = crypto.createHmac('sha256', secret).update(body).digest('hex');
      assert.strictEqual(verifyLemonSqueezySignature(body, validSignature, secret), true);

      // Rejects tampered signature
      const tamperedSignature = crypto.createHmac('sha256', secret).update(body + 'tamper').digest('hex');
      assert.strictEqual(verifyLemonSqueezySignature(body, tamperedSignature, secret), false);

      // Rejects missing or empty signature
      assert.strictEqual(verifyLemonSqueezySignature(body, '', secret), false);
      assert.strictEqual(verifyLemonSqueezySignature(body, undefined, secret), false);
    });
  });

  describe('Auth Endpoints & Session Management', () => {
    let sessionCookie: string;
    const testEmail = 'eng-lead@acmecorp.internal';
    const testPassword = 'SecurePassword987!';

    test('rejects registration with invalid email or weak password', async () => {
      // Invalid email
      const res1 = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'notanemail', password: testPassword }),
      });
      assert.strictEqual(res1.status, 400);

      // Weak password (< 6 chars)
      const res2 = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: '123' }),
      });
      assert.strictEqual(res2.status, 400);
    });

    test('registers a new user and sets HttpOnly session cookie', async () => {
      const res = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });

      assert.strictEqual(res.status, 201);
      const json: any = await res.json();
      assert.ok(json.user?.id);
      assert.strictEqual(json.user?.email, testEmail);

      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie, 'Must set cookie');
      assert.ok(setCookie.includes('aidiscost_session='));
      sessionCookie = setCookie.split(';')[0];
    });

    test('rejects duplicate registration with 409 Conflict', async () => {
      const res = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });
      assert.strictEqual(res.status, 409);
    });

    test('GET /api/auth/me verifies session token and returns user profile', async () => {
      // With valid session cookie
      const res1 = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Cookie: sessionCookie },
      });
      assert.strictEqual(res1.status, 200);
      const data1: any = await res1.json();
      assert.strictEqual(data1.authenticated, true);
      assert.strictEqual(data1.user?.email, testEmail);

      // Without cookie
      const res2 = await fetch(`${serverUrl}/api/auth/me`);
      assert.strictEqual(res2.status, 200);
      const data2: any = await res2.json();
      assert.strictEqual(data2.authenticated, false);
      assert.strictEqual(data2.user, null);
    });

    test('POST /api/auth/login authenticates registered user and issues cookie', async () => {
      // Bad password
      const resBad = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: 'WrongPassword!' }),
      });
      assert.strictEqual(resBad.status, 401);

      // Correct credentials
      const resOk = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });
      assert.strictEqual(resOk.status, 200);
      const data: any = await resOk.json();
      assert.strictEqual(data.user?.email, testEmail);
    });
  });

  describe('Finding Ownership & Privacy Boundaries', () => {
    let userCookie: string;
    let otherUserCookie: string;
    const testFindingId = 'fnd_test_retry_storm_001';

    before(async () => {
      // Create user 1
      const res1 = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user1@company.com', password: 'Password123!' }),
      });
      userCookie = res1.headers.get('set-cookie')!.split(';')[0];

      // Create user 2
      const res2 = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user2@company.com', password: 'Password123!' }),
      });
      otherUserCookie = res2.headers.get('set-cookie')!.split(';')[0];
    });

    test('unauthenticated calls to protected routes return 401 UNAUTHORIZED', async () => {
      const res = await fetch(`${serverUrl}/api/findings/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ finding_ids: [testFindingId] }),
      });
      assert.strictEqual(res.status, 401);
    });

    test('registers finding ownership to authenticated user', async () => {
      const res = await fetch(`${serverUrl}/api/findings/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: userCookie,
        },
        body: JSON.stringify({ finding_ids: [testFindingId] }),
      });
      assert.strictEqual(res.status, 200);
      const data: any = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.registered_count, 1);
    });

    test('finding owner can query initial locked entitlement status', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${testFindingId}/entitlement`, {
        headers: { Cookie: userCookie },
      });
      assert.strictEqual(res.status, 200);
      const data: any = await res.json();
      assert.strictEqual(data.is_paid, false);
      assert.strictEqual(data.entitlement_type, 'LOCKED');
    });

    test('privacy boundary: another user receives 404 for findings owned by user 1', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${testFindingId}/entitlement`, {
        headers: { Cookie: otherUserCookie },
      });
      assert.strictEqual(res.status, 404, 'Must return 404 to avoid leaking existence of another user finding');
    });
  });

  describe('Lemon Squeezy Webhook & Entitlement Activation', () => {
    const webhookSecret = 'test_ls_secret_777';
    let findingOwnerId: string;
    const findingToUnlock = 'fnd_model_rightsizing_premium_01';

    before(async () => {
      process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = webhookSecret;

      // Register owner
      const res = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'finance-lead@corp.net', password: 'Password123!' }),
      });
      const data: any = await res.json();
      findingOwnerId = data.user.id;
      const cookie = res.headers.get('set-cookie')!.split(';')[0];

      // Register finding
      await fetch(`${serverUrl}/api/findings/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ finding_ids: [findingToUnlock] }),
      });
    });

    test('rejects webhook without valid HMAC signature', async () => {
      const body = JSON.stringify({ meta: { event_name: 'order_created', event_id: 'evt_1' } });
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': 'invalid_signature_hex',
        },
        body,
      });
      assert.strictEqual(res.status, 401);
    });

    test('processes order_created webhook and activates authoritative entitlement', async () => {
      const eventId = `ls_evt_${Date.now()}`;
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: eventId,
          custom_data: {
            user_id: findingOwnerId,
            finding_id: findingToUnlock,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'order_ls_99901',
          attributes: {
            status: 'paid',
            identifier: 'ord_ident_001',
          },
        },
      };

      const bodyString = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', webhookSecret).update(bodyString).digest('hex');

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: bodyString,
      });

      assert.strictEqual(res.status, 200);
      const result: any = await res.json();
      assert.strictEqual(result.status, 'SUCCESS');
      assert.strictEqual(result.finding_id, findingToUnlock);

      // Verify entitlement exists in storage
      const hasEntitlement = await storage.hasActivePaidEntitlement(findingOwnerId, findingToUnlock);
      assert.strictEqual(hasEntitlement, true);

      // Verify idempotent deduplication: sending the same event again returns duplicate status
      const resDupe = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: bodyString,
      });

      assert.strictEqual(resDupe.status, 200);
      const dupeJson: any = await resDupe.json();
      assert.strictEqual(dupeJson.status, 'IDEMPOTENT_DUPLICATE');
    });

    test('webhook ownership invariant: User A paying for finding owned by User B is rejected (403)', async () => {
      // Create user B who owns a finding
      const resB = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user-b@target.org', password: 'Password123!' }),
      });
      const cookieB = resB.headers.get('set-cookie')!.split(';')[0];
      const findingOwnedByB = 'fnd_owned_by_b_123';

      await fetch(`${serverUrl}/api/findings/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieB,
        },
        body: JSON.stringify({ finding_ids: [findingOwnedByB] }),
      });

      // User A attempts to claim entitlement via webhook payment for User B's finding
      const maliciousEventId = `ls_evt_malicious_${Date.now()}`;
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: maliciousEventId,
          custom_data: {
            user_id: findingOwnerId, // User A's ID
            finding_id: findingOwnedByB, // Finding owned by User B
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'order_ls_attack_01',
          attributes: {
            status: 'paid',
            identifier: 'ord_attack_01',
          },
        },
      };

      const bodyString = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', webhookSecret).update(bodyString).digest('hex');

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: bodyString,
      });

      assert.strictEqual(res.status, 403, 'Must return 403 Forbidden for ownership mismatch');
      const errJson: any = await res.json();
      assert.strictEqual(errJson.error, 'FINDING_OWNERSHIP_MISMATCH');

      // Verify User A did NOT receive entitlement for User B's finding
      const hasEntitlement = await storage.hasActivePaidEntitlement(findingOwnerId, findingOwnedByB);
      assert.strictEqual(hasEntitlement, false, 'User A must not receive entitlement for User B finding');
    });

    test('variant validation: rejects webhook with wrong variant ID', async () => {
      process.env.LEMON_SQUEEZY_VARIANT_ID = 'variant_fix_pkg_49';

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: `ls_evt_wrong_var_${Date.now()}`,
          custom_data: {
            user_id: findingOwnerId,
            finding_id: findingToUnlock,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'order_wrong_var_01',
          attributes: {
            status: 'paid',
            first_order_item: {
              variant_id: 'wrong_subscription_variant_999',
            },
          },
        },
      };

      const bodyString = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', webhookSecret).update(bodyString).digest('hex');

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: bodyString,
      });

      assert.strictEqual(res.status, 400);
      const errJson: any = await res.json();
      assert.strictEqual(errJson.error, 'WRONG_VARIANT');
    });

    test('product validation: rejects webhook with wrong product identity', async () => {
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: `ls_evt_wrong_prod_${Date.now()}`,
          custom_data: {
            user_id: findingOwnerId,
            finding_id: findingToUnlock,
            product: 'UNAUTHORIZED_SUBSCRIPTION',
          },
        },
        data: {
          id: 'order_wrong_prod_01',
          attributes: {
            status: 'paid',
            first_order_item: {
              variant_id: 'variant_fix_pkg_49',
            },
          },
        },
      };

      const bodyString = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', webhookSecret).update(bodyString).digest('hex');

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: bodyString,
      });

      assert.strictEqual(res.status, 400);
      const errJson: any = await res.json();
      assert.strictEqual(errJson.error, 'INVALID_PRODUCT');
    });

    test('product validation: rejects webhook with missing product', async () => {
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: `ls_evt_missing_prod_${Date.now()}`,
          custom_data: {
            user_id: findingOwnerId,
            finding_id: findingToUnlock,
            // product is omitted
          },
        },
        data: {
          id: 'order_missing_prod_01',
          attributes: {
            status: 'paid',
            first_order_item: {
              variant_id: 'variant_fix_pkg_49',
            },
          },
        },
      };

      const bodyString = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', webhookSecret).update(bodyString).digest('hex');

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: bodyString,
      });

      assert.strictEqual(res.status, 400);
      const errJson: any = await res.json();
      assert.strictEqual(errJson.error, 'INVALID_PRODUCT');
    });

    test('product validation: rejects webhook with empty product', async () => {
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: `ls_evt_empty_prod_${Date.now()}`,
          custom_data: {
            user_id: findingOwnerId,
            finding_id: findingToUnlock,
            product: '   ',
          },
        },
        data: {
          id: 'order_empty_prod_01',
          attributes: {
            status: 'paid',
            first_order_item: {
              variant_id: 'variant_fix_pkg_49',
            },
          },
        },
      };

      const bodyString = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', webhookSecret).update(bodyString).digest('hex');

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: bodyString,
      });

      assert.strictEqual(res.status, 400);
      const errJson: any = await res.json();
      assert.strictEqual(errJson.error, 'INVALID_PRODUCT');
    });

    test('variant validation: rejects webhook with missing variant when variant ID is configured', async () => {
      process.env.LEMON_SQUEEZY_VARIANT_ID = 'variant_fix_pkg_49';

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: `ls_evt_missing_var_${Date.now()}`,
          custom_data: {
            user_id: findingOwnerId,
            finding_id: findingToUnlock,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'order_missing_var_01',
          attributes: {
            status: 'paid',
            // first_order_item has no variant_id
          },
        },
      };

      const bodyString = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', webhookSecret).update(bodyString).digest('hex');

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: bodyString,
      });

      assert.strictEqual(res.status, 400);
      const errJson: any = await res.json();
      assert.strictEqual(errJson.error, 'WRONG_VARIANT');
    });

    test('ownership lineage: rejects webhook for unknown/unregistered finding (403)', async () => {
      const unknownFindingId = 'fnd_unknown_999999';
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: `ls_evt_unknown_fnd_${Date.now()}`,
          custom_data: {
            user_id: findingOwnerId,
            finding_id: unknownFindingId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'order_unknown_fnd_01',
          attributes: {
            status: 'paid',
            first_order_item: {
              variant_id: 'variant_fix_pkg_49',
            },
          },
        },
      };

      const bodyString = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', webhookSecret).update(bodyString).digest('hex');

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: bodyString,
      });

      assert.strictEqual(res.status, 403);
      const errJson: any = await res.json();
      assert.strictEqual(errJson.error, 'FINDING_OWNERSHIP_MISMATCH');

      // Verify no entitlement was created
      const hasEntitlement = await storage.hasActivePaidEntitlement(findingOwnerId, unknownFindingId);
      assert.strictEqual(hasEntitlement, false);
    });

    test('payment status: non-paid order (pending, refunded) does not create entitlement', async () => {
      const pendingFindingId = 'fnd_pending_test_01';
      await storage.registerFindingOwnership(pendingFindingId, findingOwnerId);

      for (const nonPaidStatus of ['pending', 'refunded']) {
        const payload = {
          meta: {
            event_name: 'order_created',
            event_id: `ls_evt_nonpaid_${nonPaidStatus}_${Date.now()}`,
            custom_data: {
              user_id: findingOwnerId,
              finding_id: pendingFindingId,
              product: 'FIX_PACKAGE',
            },
          },
          data: {
            id: `order_${nonPaidStatus}_01`,
            attributes: {
              status: nonPaidStatus,
              first_order_item: {
                variant_id: 'variant_fix_pkg_49',
              },
            },
          },
        };

        const bodyString = JSON.stringify(payload);
        const signature = crypto.createHmac('sha256', webhookSecret).update(bodyString).digest('hex');

        const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-signature': signature,
          },
          body: bodyString,
        });

        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.status, 'IGNORED_NON_PAID');

        const hasEntitlement = await storage.hasActivePaidEntitlement(findingOwnerId, pendingFindingId);
        assert.strictEqual(hasEntitlement, false, `Status ${nonPaidStatus} must not create entitlement`);
      }
    });

    test('concurrency hardening: concurrent webhook requests with same event_id result in exactly one entitlement', async () => {
      const concurrentFindingId = 'fnd_concurrent_test_01';
      await storage.registerFindingOwnership(concurrentFindingId, findingOwnerId);

      const sharedEventId = `ls_evt_concurrent_${Date.now()}`;
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: sharedEventId,
          custom_data: {
            user_id: findingOwnerId,
            finding_id: concurrentFindingId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'order_concurrent_01',
          attributes: {
            status: 'paid',
            first_order_item: {
              variant_id: 'variant_fix_pkg_49',
            },
          },
        },
      };

      const bodyString = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', webhookSecret).update(bodyString).digest('hex');

      const sendWebhook = () =>
        fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-signature': signature,
          },
          body: bodyString,
        });

      // Fire both requests concurrently
      const [res1, res2] = await Promise.all([sendWebhook(), sendWebhook()]);
      const json1: any = await res1.json();
      const json2: any = await res2.json();

      const statuses = [json1.status, json2.status];
      assert.ok(
        statuses.includes('SUCCESS'),
        'At least one concurrent request must succeed'
      );
      assert.ok(
        statuses.includes('IDEMPOTENT_DUPLICATE'),
        'The concurrent duplicate must be recognized as duplicate'
      );

      // Verify only one active entitlement was created
      const hasEntitlement = await storage.hasActivePaidEntitlement(findingOwnerId, concurrentFindingId);
      assert.strictEqual(hasEntitlement, true);
    });
  });

  describe('Commercial Entitlement Authority & Simulation Isolation', () => {
    test('DEMO_UNLOCKED does not create a server-side paid entitlement', async () => {
      const demoFindingId = 'fnd_demo_client_preview_01';
      // Server check returns false for demo unlocks
      const hasPaid = await storage.hasActivePaidEntitlement('any_user', demoFindingId);
      assert.strictEqual(hasPaid, false);
    });

    test('simulated verification cannot generate an authoritative commercial outcome fee', async () => {
      const { calculateAuthoritativeOutcomeFee } = await import('../engine/billing/outcome');
      const simulatedVerificationState: any = {
        finding_id: 'fnd_123',
        stage: 'VERIFIED_RESULT', // even if stage label says verified
        is_simulated: true,       // marked simulated
        baseline_window: { avg_cost_per_call_usd: 0.05 },
        observed_result: {
          annualized_realized_savings_usd: 12000,
        },
      };
      const mockFinding: any = {
        id: 'fnd_123',
        annualized_projection_usd: 12000,
        is_sample_data: false,
      };

      const result = calculateAuthoritativeOutcomeFee(simulatedVerificationState, mockFinding);
      assert.strictEqual(result.finalOutcomeFeeUsd, 0, 'Simulated verification must result in $0 fee');
      assert.strictEqual(result.isPayable, false);
      assert.strictEqual(result.protectionTriggered, false);
      assert.ok(result.protectionReason?.includes('simulated'));
    });

    test('sample data finding cannot generate an authoritative commercial outcome fee', async () => {
      const { calculateAuthoritativeOutcomeFee } = await import('../engine/billing/outcome');
      const realVerificationState: any = {
        finding_id: 'fnd_sample_01',
        stage: 'VERIFIED_RESULT',
        is_simulated: false,
        baseline_window: { avg_cost_per_call_usd: 0.05 },
        observed_result: {
          annualized_realized_savings_usd: 12000,
          verification_confidence: 'HIGH',
        },
      };
      const sampleFinding: any = {
        id: 'fnd_sample_01',
        annualized_projection_usd: 12000,
        is_sample_data: true, // sample dataset
      };

      const result = calculateAuthoritativeOutcomeFee(realVerificationState, sampleFinding);
      assert.strictEqual(result.finalOutcomeFeeUsd, 0, 'Sample dataset finding must result in $0 fee');
      assert.strictEqual(result.isPayable, false);
    });
  });
});
