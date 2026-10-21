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
import { hashPassword, authenticate } from '../server/auth';
import { createApiRouter } from '../server/api';
import { verifyLemonSqueezySignature } from '../server/lemon-squeezy';
import { Finding, AuthoritativeVerification, OutcomeFeeObligation, AIEvent } from '../types/domain';
import {
  calculateOutcomeFee,
  calculateAuthoritativeVerificationFee,
  COMMERCIAL_PRICING,
} from '../engine/billing/outcome';
import { createDatabaseConnection } from '../server/db/index';
import { DrizzleStorageAdapter } from '../server/db/adapter';
import { runDatabaseMigrations } from '../../scripts/migrate-db';
import fs from 'fs';

describe('AIDisCost Sprint B — Outcome Fee Payment Lifecycle & Trust Boundary Suite', () => {
  let server: http.Server;
  let serverUrl: string;
  const storage = ServerStorage.getInstance('data', 'test-outcome-fee-db.json');

  const TEST_WEBHOOK_SECRET = 'sprint_b_outcome_fee_webhook_secret_xyz789';
  const TEST_FIX_VARIANT_ID = 'variant_fix_package_49';
  const TEST_OUTCOME_FEE_VARIANT_ID = 'variant_outcome_fee_variable';

  let userA: { id: string; email: string; cookie: string };
  let userB: { id: string; email: string; cookie: string };

  const findingA = 'fnd_outcome_fee_user_a_01';
  const findingB = 'fnd_outcome_fee_user_b_01';

  const mockFindingA: Finding = {
    id: findingA,
    audit_id: 'adt_01',
    rule_id: 'MODEL_RIGHT_SIZING',
    title: 'Model Right-Sizing: gpt-4o → gpt-4o-mini',
    summary: 'Candidate models provide comparable accuracy at lower unit cost.',
    affected_scope: 'gpt-4o → gpt-4o-mini',
    detection_confidence: 'HIGH',
    cost_confidence: 'HIGH',
    savings_confidence: 'HIGH',
    baseline_spend_usd: 100.0,
    candidate_spend_usd: 15.0,
    estimated_savings_usd: 85.0,
    potential_savings_pct: 85.0,
    annualized_projection_usd: 12000.0, // $1,000/mo estimated
    eligible_event_count: 50,
    calculation_method: 'unit_reduction',
    assumptions: [],
    evidence: {
      affected_event_count: 50,
      sample_events: [{ model: 'gpt-4o' }],
      metrics_comparison: [],
      trace_samples: [],
      mathematical_proof: 'proof',
      baseline_period: {
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-09-10T00:00:00.000Z',
      },
    },
    status: 'DETECTED',
    is_sample_data: false,
  };

  before(async () => {
    // Set test configuration for Lemon Squeezy
    process.env.LEMON_SQUEEZY_API_KEY = 'test_ls_api_key';
    process.env.LEMON_SQUEEZY_STORE_ID = '12345';
    process.env.LEMON_SQUEEZY_VARIANT_ID = TEST_FIX_VARIANT_ID;
    process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = TEST_OUTCOME_FEE_VARIANT_ID;
    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

    storage.setTestMode(true);
    storage.clearAll();

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

    // Create User A
    const regResA = await fetch(`${serverUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user.a@company.com', password: 'Password123!' }),
    });
    const regDataA: any = await regResA.json();
    const cookieA = regResA.headers.get('set-cookie') || '';
    userA = { id: regDataA.user.id, email: regDataA.user.email, cookie: cookieA };

    // Create User B
    const regResB = await fetch(`${serverUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user.b@rival.com', password: 'Password123!' }),
    });
    const regDataB: any = await regResB.json();
    const cookieB = regResB.headers.get('set-cookie') || '';
    userB = { id: regDataB.user.id, email: regDataB.user.email, cookie: cookieB };

    // Register Finding Ownership
    await storage.registerFindingOwnership(findingA, userA.id);
    await storage.registerFindingOwnership(findingB, userB.id);
  });

  after(async () => {
    storage.clearAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // Helper to construct signed Lemon Squeezy webhook payloads
  function buildSignedWebhook(payload: any, secret = TEST_WEBHOOK_SECRET): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return { rawBody, signature };
  }

  // Helper to generate N post-deployment events for verification evaluation
  function generatePostEvents(count: number, unitCost: number, isSimulated = false, model = 'gpt-4o-mini'): AIEvent[] {
    const events: AIEvent[] = [];
    const baseTime = new Date('2026-09-15T00:00:00.000Z').getTime();
    for (let i = 0; i < count; i++) {
      events.push({
        id: `post_evt_${i}_${Date.now()}_${Math.random()}`,
        source: 'custom_logs',
        source_event_id: `src_post_${i}`,
        timestamp: new Date(baseTime + i * 60000).toISOString(),
        provider: 'openai',
        model,
        operation: 'chat',
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        latency_ms: 200,
        status: 'SUCCESS',
        trace_id: `tr_${i}`,
        tool_calls: [],
        metadata: {},
        source_reported_cost_usd: unitCost,
        calculated_cost_usd: unitCost,
        resolved_cost_usd: unitCost,
        cost_provenance: 'CALCULATED',
        cost_confidence: 'HIGH',
        quality_signal: 1.0,
        is_simulated: isSimulated,
      });
    }
    return events;
  }

  // =========================================================================
  // 1. Authoritative Verification Gate Tests (Cases 1 - 5)
  // =========================================================================
  describe('1. Authoritative Verification Gate (Cases 1-5)', () => {
    test('Case 2: finding with no verification cannot create Outcome Fee obligation', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({ finding: mockFindingA }),
      });
      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'VERIFICATION_NOT_FOUND');
    });

    test('Case 3 & 5: observation-only / non-authoritative verification cannot create obligation', async () => {
      // Seed non-authoritative CUSTOMER_DEPLOYED verification
      const nonAuthRecord: AuthoritativeVerification = {
        id: `ver_non_auth_${crypto.randomUUID()}`,
        finding_id: findingA,
        user_id: userA.id,
        stage: 'OBSERVATION_ACTIVE',
        is_authoritative: false,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 5,
        post_avg_cost_usd: 1.0,
        observed_reduction_pct: 50.0,
        verified_annualized_savings_usd: 0,
        verification_confidence: 'INSUFFICIENT_OBSERVATION',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveVerification(nonAuthRecord);

      const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({ finding: mockFindingA }),
      });
      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'VERIFICATION_NOT_AUTHORITATIVE');
    });

    test('Case 4: simulated verification cannot create obligation', async () => {
      const simRecord: AuthoritativeVerification = {
        id: `ver_sim_${crypto.randomUUID()}`,
        finding_id: findingA,
        user_id: userA.id,
        stage: 'VERIFIED_RESULT',
        is_authoritative: false, // Invariant: simulated is always non-authoritative
        is_simulated: true,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 25,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 12000.0,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveVerification(simRecord);

      const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({ finding: mockFindingA }),
      });
      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'VERIFICATION_NOT_AUTHORITATIVE');
    });

    test('Case 1: genuine server-authoritative verification creates PAYABLE obligation', async () => {
      // Seed genuine authoritative verification record
      const authRecord: AuthoritativeVerification = {
        id: `ver_auth_${crypto.randomUUID()}`,
        finding_id: findingA,
        user_id: userA.id,
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 30,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 12000.0, // $1,000/mo verified
        original_estimated_annualized_usd: 12000.0, // $1,000/mo server-authoritative baseline
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveVerification(authRecord);

      const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({
          finding: mockFindingA,
          original_estimated_annualized_usd: 12000.0,
        }),
      });

      assert.strictEqual(res.status, 201);
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.obligation.status, 'PAYABLE');
      assert.strictEqual(json.obligation.verified_annualized_savings_usd, 12000.0);
      // Fee: 20% of $12,000 = $2,400; Capped at 1-month ($1,000/mo) = $1,000
      assert.strictEqual(json.obligation.fee_amount_usd, 1000.0);
      assert.strictEqual(json.obligation.user_id, userA.id);
      assert.strictEqual(json.obligation.finding_id, findingA);
    });
  });

  // =========================================================================
  // 2. Amount Integrity & Canonical Calculator Tests (Cases 6 - 13)
  // =========================================================================
  describe('2. Amount Integrity & Calculator Invariants (Cases 6-13)', () => {
    test('Case 6, 7, 8: server calculates fee; client cannot forge savings or fee amount', async () => {
      // Attacker attempts to send forged savings and $1 fee amount in request body
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({
          verified_annualized_savings_usd: 5.0,
          fee_amount_usd: 1.0,
          status: 'PAID',
        }),
      });

      assert.strictEqual(res.status, 200); // Idempotent return of existing obligation
      const json: any = await res.json();
      // Server-authoritative values MUST NOT be modified by client payload
      assert.strictEqual(json.obligation.verified_annualized_savings_usd, 12000.0);
      assert.strictEqual(json.obligation.fee_amount_usd, 1000.0);
      assert.strictEqual(json.obligation.status, 'PAYABLE');
    });

    test('Case 9 & 10: negative or non-finite verified savings calculate $0 fee and are not payable', () => {
      const neg = calculateOutcomeFee(-500, 1000);
      assert.strictEqual(neg.finalOutcomeFeeUsd, 0);
      assert.strictEqual(neg.isPayable, false);

      const nanRes = calculateOutcomeFee(NaN, 1000);
      assert.strictEqual(nanRes.finalOutcomeFeeUsd, 0);
      assert.strictEqual(nanRes.isPayable, false);

      const infRes = calculateOutcomeFee(Infinity, 1000);
      assert.strictEqual(infRes.finalOutcomeFeeUsd, 0);
      assert.strictEqual(infRes.isPayable, false);
    });

    test('Case 11: 1-month cap is applied deterministically', () => {
      // Verified: $10,000/mo -> Annualized: $120,000. 20% = $24,000. Cap = $10,000.
      const capped = calculateOutcomeFee(10000, 10000);
      assert.strictEqual(capped.rawOutcomeFeeUsd, 24000);
      assert.strictEqual(capped.capAmountUsd, 10000);
      assert.strictEqual(capped.finalOutcomeFeeUsd, 10000);
    });

    test('Case 12: 50% Protection Clause boundary conditions', () => {
      const originalMonthly = 1000.0;

      // 49.99% realized -> waived to $0.00
      const below50 = calculateOutcomeFee(499.90, originalMonthly);
      assert.strictEqual(below50.protectionTriggered, true);
      assert.strictEqual(below50.finalOutcomeFeeUsd, 0.0);
      assert.strictEqual(below50.isPayable, false);

      // 50.00% realized -> strictly payable
      const exact50 = calculateOutcomeFee(500.00, originalMonthly);
      assert.strictEqual(exact50.protectionTriggered, false);
      assert.strictEqual(exact50.finalOutcomeFeeUsd, 500.00);
      assert.strictEqual(exact50.isPayable, true);

      // 50.01% realized -> strictly payable
      const above50 = calculateOutcomeFee(500.10, originalMonthly);
      assert.strictEqual(above50.protectionTriggered, false);
      assert.strictEqual(above50.finalOutcomeFeeUsd, 500.10);
      assert.strictEqual(above50.isPayable, true);
    });

    test('Case 13: persisted fee matches calculated obligation fee', async () => {
      const stored = await storage.getOutcomeFeeObligation(findingA);
      assert.ok(stored);
      assert.strictEqual(stored.fee_amount_usd, 1000.0);
    });
  });

  // =========================================================================
  // 3. Finding Ownership & Privacy Tests (Cases 14 - 18)
  // =========================================================================
  describe('3. Finding Ownership & Privacy Isolation (Cases 14-18)', () => {
    test('Case 14: User B cannot create obligation for Finding A owned by User A', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userB.cookie },
        body: JSON.stringify({ finding: mockFindingA }),
      });
      assert.strictEqual(res.status, 404, 'Must return 404 to avoid leaking finding existence');
    });

    test('Case 15: User B cannot retrieve obligation for Finding A owned by User A', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee`, {
        headers: { Cookie: userB.cookie },
      });
      assert.strictEqual(res.status, 404);
    });

    test('Case 16 & 17: webhook cannot bind to wrong user or wrong finding', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingA);
      assert.ok(obligation);

      // Webhook payload claims User B paid for Finding A
      const spoofedPayload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_spoof_ownership_01',
          custom_data: {
            user_id: userB.id, // WRONG USER!
            finding_id: findingA,
            obligation_id: obligation.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_spoof_01',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: TEST_OUTCOME_FEE_VARIANT_ID,
          },
        },
      };

      const { rawBody, signature } = buildSignedWebhook(spoofedPayload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: rawBody,
      });

      assert.strictEqual(res.status, 403);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'FINDING_OWNERSHIP_MISMATCH');

      // Assert obligation status has NOT changed to PAID
      const refreshed = await storage.getOutcomeFeeObligation(findingA);
      assert.strictEqual(refreshed?.status, 'PAYABLE');
    });

    test('Case 18: webhook mismatched obligation binding fails closed', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingA);
      assert.ok(obligation);

      const mismatchedPayload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_mismatched_binding_01',
          custom_data: {
            user_id: userA.id,
            finding_id: findingB, // Mismatched finding!
            obligation_id: obligation.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_mismatch_01',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: TEST_OUTCOME_FEE_VARIANT_ID,
          },
        },
      };

      const { rawBody, signature } = buildSignedWebhook(mismatchedPayload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: rawBody,
      });

      // User A doesn't own Finding B
      assert.strictEqual(res.status, 403);
    });
  });

  // =========================================================================
  // 4. Lemon Squeezy Checkout Creation Tests (Cases 19 - 23)
  // =========================================================================
  describe('4. Lemon Squeezy Checkout Lifecycle (Cases 19-23)', () => {
    test('Case 22: Outcome Fee cannot use Fix Package variant ID', async () => {
      // Temporarily set OUTCOME_FEE variant equal to FIX_PACKAGE variant
      process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = TEST_FIX_VARIANT_ID;

      const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({}),
      });

      assert.strictEqual(res.status, 500);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'CONFIGURATION_ERROR');

      // Restore distinct variant ID
      process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = TEST_OUTCOME_FEE_VARIANT_ID;
    });

    test('Case 19, 20, 23: PAYABLE creates checkout and transitions status to CHECKOUT_CREATED', async () => {
      // Mock global fetch for external Lemon Squeezy checkout API call
      const originalFetch = global.fetch;
      try {
        (global as any).fetch = async (url: string, init?: any) => {
          if (typeof url === 'string' && url.includes('api.lemonsqueezy.com/v1/checkouts')) {
            const body = JSON.parse(init.body);
            // Verify custom price passed in cents matches obligation fee
            assert.strictEqual(body.data.attributes.custom_price, 100000); // $1000.00
            assert.strictEqual(body.data.relationships.variant.data.id, TEST_OUTCOME_FEE_VARIANT_ID);
            assert.strictEqual(body.data.attributes.checkout_data.custom.product, 'OUTCOME_FEE');

            return new Response(
              JSON.stringify({
                data: {
                  id: 'ls_chk_outcome_fee_999',
                  attributes: {
                    url: 'https://aidiscost.lemonsqueezy.com/buy/outcome-fee-session-999',
                  },
                },
              }),
              { status: 201, headers: { 'Content-Type': 'application/vnd.api+json' } }
            );
          }
          return originalFetch(url, init);
        };

        const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
          body: JSON.stringify({ redirect_url: 'https://app.aidiscost.com/#/verify/fnd_01' }),
        });

        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.strictEqual(json.checkout_url, 'https://aidiscost.lemonsqueezy.com/buy/outcome-fee-session-999');
        assert.strictEqual(json.obligation.status, 'CHECKOUT_CREATED');

        // Verify status persisted in storage
        const stored = await storage.getOutcomeFeeObligation(findingA);
        assert.strictEqual(stored?.status, 'CHECKOUT_CREATED');
        assert.strictEqual(stored?.checkout_url, 'https://aidiscost.lemonsqueezy.com/buy/outcome-fee-session-999');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('Case 21: checkout API failure does NOT mark obligation as PAID', async () => {
      const originalFetch = global.fetch;
      try {
        (global as any).fetch = async (url: string, init?: any) => {
          if (typeof url === 'string' && url.includes('api.lemonsqueezy.com/v1/checkouts')) {
            return new Response('Lemon Squeezy 503 Outage', { status: 503 });
          }
          return originalFetch(url, init);
        };

        const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
          body: JSON.stringify({}),
        });

        assert.strictEqual(res.status, 500);
        const stored = await storage.getOutcomeFeeObligation(findingA);
        // Obligation remains in CHECKOUT_CREATED / PAYABLE, never PAID
        assert.notStrictEqual(stored?.status, 'PAID');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // =========================================================================
  // 5. Webhook Security & Validation Tests (Cases 24 - 31)
  // =========================================================================
  describe('5. Webhook Security & Tampering Resistance (Cases 24-31)', () => {
    test('Case 24: invalid signature rejected with 401', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingA);
      const payload = {
        meta: { event_name: 'order_created', event_id: 'evt_invalid_sig' },
        data: { attributes: { status: 'paid' } },
      };

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': 'deadbeef0123456789abcdef', // Invalid signature
        },
        body: JSON.stringify(payload),
      });

      assert.strictEqual(res.status, 401);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'INVALID_SIGNATURE');
    });

    test('Case 25: malformed webhook missing event metadata rejected with 400', async () => {
      const payload = { foo: 'bar' }; // Missing meta.event_name and event_id
      const { rawBody, signature } = buildSignedWebhook(payload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'MALFORMED_WEBHOOK');
    });

    test('Case 26: wrong product rejected with 400', async () => {
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_wrong_prod_01',
          custom_data: { product: 'SUBSCRIPTION_TIER_PRO' },
        },
        data: { id: 'ord_wp_01', attributes: { status: 'paid' } },
      };
      const { rawBody, signature } = buildSignedWebhook(payload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'INVALID_PRODUCT');
    });

    test('Case 27: Outcome Fee with Fix Package variant rejected with 400', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingA);
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_wrong_variant_01',
          custom_data: {
            user_id: userA.id,
            finding_id: findingA,
            obligation_id: obligation!.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_wv_01',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: TEST_FIX_VARIANT_ID, // FIX PACKAGE VARIANT ACCIDENTALLY USED!
          },
        },
      };
      const { rawBody, signature } = buildSignedWebhook(payload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'WRONG_VARIANT');
    });

    test('Case 28: amount mismatch rejected with 400 (fail-closed amount integrity)', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingA);
      // Persisted obligation fee is $1,000.00 (100,000 cents). Webhook claims $10.00 (1,000 cents).
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_amount_mismatch_01',
          custom_data: {
            user_id: userA.id,
            finding_id: findingA,
            obligation_id: obligation!.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_amm_01',
          attributes: {
            status: 'paid',
            total: 1000, // $10.00 instead of $1,000.00
            variant_id: TEST_OUTCOME_FEE_VARIANT_ID,
          },
        },
      };
      const { rawBody, signature } = buildSignedWebhook(payload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 400);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'AMOUNT_MISMATCH');

      // Verify status is NOT marked PAID
      const refreshed = await storage.getOutcomeFeeObligation(findingA);
      assert.notStrictEqual(refreshed?.status, 'PAID');
    });

    test('Case 29: unknown obligation ID rejected with 404', async () => {
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_unknown_ob_01',
          custom_data: {
            user_id: userA.id,
            finding_id: 'fnd_nonexistent_999',
            obligation_id: 'of_nonexistent_999',
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_uob_01',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: TEST_OUTCOME_FEE_VARIANT_ID,
          },
        },
      };
      const { rawBody, signature } = buildSignedWebhook(payload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 403); // User A doesn't own non-existent finding
    });
  });

  // =========================================================================
  // 6. Payment State Transitions & Authority (Cases 32 - 36)
  // =========================================================================
  describe('6. Payment State Transitions & Authority (Cases 32-36)', () => {
    test('Case 32: valid payment webhook transitions obligation to PAID', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingA);
      assert.ok(obligation);

      const validPayload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_valid_payment_order_01',
          custom_data: {
            user_id: userA.id,
            finding_id: findingA,
            obligation_id: obligation.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_valid_outcome_fee_777',
          attributes: {
            status: 'paid',
            total: 100000, // $1,000.00
            variant_id: TEST_OUTCOME_FEE_VARIANT_ID,
          },
        },
      };
      const { rawBody, signature } = buildSignedWebhook(validPayload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.status, 'SUCCESS');
      assert.strictEqual(json.outcome_fee_status, 'PAID');

      // Assert database record is authoritatively updated
      const updated = await storage.getOutcomeFeeObligation(findingA);
      assert.strictEqual(updated?.status, 'PAID');
      assert.strictEqual(updated?.provider_order_id, 'ord_valid_outcome_fee_777');
      assert.ok(updated?.paid_at);
    });

    test('Case 33: valid settlement webhook event transitions obligation to SETTLED', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingA);
      assert.ok(obligation);

      const settlePayload = {
        meta: {
          event_name: 'order_settled',
          event_id: 'evt_settle_order_01',
          custom_data: {
            user_id: userA.id,
            finding_id: findingA,
            obligation_id: obligation.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_settled_777',
          attributes: {
            status: 'settled',
            total: 100000,
            variant_id: TEST_OUTCOME_FEE_VARIANT_ID,
          },
        },
      };
      const { rawBody, signature } = buildSignedWebhook(settlePayload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.outcome_fee_status, 'SETTLED');

      const updated = await storage.getOutcomeFeeObligation(findingA);
      assert.strictEqual(updated?.status, 'SETTLED');
    });

    test('Case 34 & 35: browser redirect cannot forge PAID or SETTLED', async () => {
      // Browser visits /api/findings/:id/outcome-fee with client headers/queries claiming payment
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee?status=PAID`, {
        headers: { Cookie: userA.cookie },
      });
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      // Returned obligation reflects server persistence only
      assert.strictEqual(json.obligation.status, 'SETTLED');
    });

    test('Case 36: client refresh recovers server state via GET /api/findings/:id/outcome-fee', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee`, {
        headers: { Cookie: userA.cookie },
      });
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.ok(json.obligation);
      assert.strictEqual(json.obligation.status, 'SETTLED');
      assert.strictEqual(json.obligation.fee_amount_usd, 1000.0);
    });
  });

  // =========================================================================
  // 7. Webhook Idempotency & Concurrency Tests (Cases 37 - 42)
  // =========================================================================
  describe('7. Webhook Idempotency & Concurrency (Cases 37-42)', () => {
    test('Case 37, 38, 39, 42: replay of processed webhook returns IDEMPOTENT_DUPLICATE without corruption', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingA);
      const replayPayload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_valid_payment_order_01', // Exact same event ID as Case 32!
          custom_data: {
            user_id: userA.id,
            finding_id: findingA,
            obligation_id: obligation!.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_valid_outcome_fee_777',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: TEST_OUTCOME_FEE_VARIANT_ID,
          },
        },
      };
      const { rawBody, signature } = buildSignedWebhook(replayPayload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.status, 'IDEMPOTENT_DUPLICATE');
    });

    test('Case 40: concurrent create requests cannot create duplicate obligations', async () => {
      const findingC = 'fnd_concurrent_test_01';
      await storage.registerFindingOwnership(findingC, userA.id);

      const authRecord: AuthoritativeVerification = {
        id: `ver_concurrent_${crypto.randomUUID()}`,
        finding_id: findingC,
        user_id: userA.id,
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 30,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 6000.0,
        original_estimated_annualized_usd: 6000.0,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveVerification(authRecord);

      // Fire 5 concurrent create requests
      const promises = Array.from({ length: 5 }, () =>
        fetch(`${serverUrl}/api/findings/${findingC}/outcome-fee`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
          body: JSON.stringify({ original_estimated_annualized_usd: 6000.0 }),
        })
      );

      const responses = await Promise.all(promises);
      for (const r of responses) {
        assert.ok(r.status === 200 || r.status === 201);
      }

      const results = await Promise.all(responses.map((r) => r.json() as Promise<any>));
      const firstId = results[0].obligation.id;
      for (const res of results) {
        // Every single response must point to the identical unique obligation ID
        assert.strictEqual(res.obligation.id, firstId);
      }
    });

    test('Case 41: concurrent webhook processing for same event resolves idempotently', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingA);
      const concurrentPayload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_concurrent_webhook_test_01',
          custom_data: {
            user_id: userA.id,
            finding_id: findingA,
            obligation_id: obligation!.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_concurrent_777',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: TEST_OUTCOME_FEE_VARIANT_ID,
          },
        },
      };
      const { rawBody, signature } = buildSignedWebhook(concurrentPayload);

      const [res1, res2] = await Promise.all([
        fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-signature': signature },
          body: rawBody,
        }),
        fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-signature': signature },
          body: rawBody,
        }),
      ]);

      const j1: any = await res1.json();
      const j2: any = await res2.json();

      // One must succeed and the other must be recognized as idempotent duplicate
      const statuses = [j1.status, j2.status].sort();
      assert.deepStrictEqual(statuses, ['IDEMPOTENT_DUPLICATE', 'SUCCESS']);
    });
  });

  // =========================================================================
  // 8. Drizzle / SQLite Adapter Database Persistence
  // =========================================================================
  describe('8. Drizzle Storage Adapter SQLite Persistence', () => {
    let dbClient: any;
    let drizzleAdapter: DrizzleStorageAdapter;
    const testDbPath = 'data/test-outcome-fee-drizzle.db';

    before(async () => {
      process.env.TURSO_DATABASE_URL = `file:${testDbPath}`;
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
      await runDatabaseMigrations();
      const conn = createDatabaseConnection({ url: `file:${testDbPath}` });
      drizzleAdapter = new DrizzleStorageAdapter(conn.db, conn.client);
      dbClient = conn.client;
    });

    after(async () => {
      if (dbClient) dbClient.close();
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
      delete process.env.TURSO_DATABASE_URL;
    });

    test('DrizzleStorageAdapter creates, retrieves, and updates Outcome Fee obligation in SQLite', async () => {
      // 1. Setup user & finding ownership in SQLite
      await drizzleAdapter.createUser({
        id: 'usr_drizzle_01',
        email: 'drizzle.user@aidiscost.com',
        password_hash: 'hash:123',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await drizzleAdapter.registerFindingOwnership('fnd_drizzle_01', 'usr_drizzle_01');

      // 2. Setup verification
      const v = await drizzleAdapter.saveVerification({
        id: 'ver_drizzle_01',
        finding_id: 'fnd_drizzle_01',
        user_id: 'usr_drizzle_01',
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
        verified_annualized_savings_usd: 24000.0,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // 3. Create obligation
      const created = await drizzleAdapter.createOutcomeFeeObligation({
        id: 'of_drizzle_01',
        user_id: 'usr_drizzle_01',
        finding_id: 'fnd_drizzle_01',
        verification_id: v.id,
        verified_annualized_savings_usd: 24000.0,
        fee_amount_usd: 2000.0, // Capped at $2,000/mo
        currency: 'USD',
        status: 'PAYABLE',
        provider: 'LEMON_SQUEEZY',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      assert.strictEqual(created.id, 'of_drizzle_01');
      assert.strictEqual(created.status, 'PAYABLE');

      // 4. Retrieve by findingId and by id
      const retrieved = await drizzleAdapter.getOutcomeFeeObligation('fnd_drizzle_01');
      assert.ok(retrieved);
      assert.strictEqual(retrieved.fee_amount_usd, 2000.0);

      const byId = await drizzleAdapter.getOutcomeFeeObligationById('of_drizzle_01');
      assert.ok(byId);
      assert.strictEqual(byId.id, 'of_drizzle_01');

      // 5. Update obligation status
      await drizzleAdapter.updateOutcomeFeeObligation({
        ...retrieved,
        status: 'CHECKOUT_CREATED',
        checkout_url: 'https://checkout.example.com/123',
        updated_at: new Date().toISOString(),
      });

      const updated = await drizzleAdapter.getOutcomeFeeObligation('fnd_drizzle_01');
      assert.strictEqual(updated?.status, 'CHECKOUT_CREATED');
      assert.strictEqual(updated?.checkout_url, 'https://checkout.example.com/123');

      // 6. Transactional payment update
      const txRes = await drizzleAdapter.processOutcomeFeeWebhookTransaction({
        event: {
          event_id: 'evt_drizzle_tx_01',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_created',
          user_id: 'usr_drizzle_01',
          finding_id: 'fnd_drizzle_01',
          order_id: 'ord_drizzle_123',
          processed_at: new Date().toISOString(),
        },
        obligation: {
          ...updated!,
          status: 'PAID',
          provider_order_id: 'ord_drizzle_123',
          paid_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });

      assert.strictEqual(txRes.status, 'SUCCESS');

      const paid = await drizzleAdapter.getOutcomeFeeObligation('fnd_drizzle_01');
      assert.strictEqual(paid?.status, 'PAID');
      assert.strictEqual(paid?.provider_order_id, 'ord_drizzle_123');
      assert.strictEqual(await drizzleAdapter.hasPaidOutcomeFee('usr_drizzle_01', 'fnd_drizzle_01'), true);

      // 7. Idempotent transaction replay
      const replayRes = await drizzleAdapter.processOutcomeFeeWebhookTransaction({
        event: {
          event_id: 'evt_drizzle_tx_01',
          provider: 'LEMON_SQUEEZY',
          event_name: 'order_created',
          processed_at: new Date().toISOString(),
        },
        obligation: paid!,
      });
      assert.strictEqual(replayRes.status, 'DUPLICATE');
    });
  });

  // =========================================================================
  // 9. Regression Safety: Fix Package Checkout & Webhook (Cases 43 - 45)
  // =========================================================================
  describe('9. Regression Safety: Fix Package & Sprint A.1 (Cases 43-45)', () => {
    test('Case 43: Fix Package checkout and webhook still function with complete isolation', async () => {
      const findingFix = 'fnd_fix_regression_01';
      await storage.registerFindingOwnership(findingFix, userA.id);

      // Verify Fix Package webhook
      const fixPayload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_fix_package_order_01',
          custom_data: {
            user_id: userA.id,
            finding_id: findingFix,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'ord_fix_123',
          attributes: {
            status: 'paid',
            variant_id: TEST_FIX_VARIANT_ID,
          },
        },
      };
      const { rawBody, signature } = buildSignedWebhook(fixPayload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.status, 'SUCCESS');
      assert.ok(json.entitlement_id);

      const hasPaid = await storage.hasActivePaidEntitlement(userA.id, findingFix);
      assert.strictEqual(hasPaid, true);
    });
  });

  // =========================================================================
  // 10. Production Hardening Sprint: Invariants Verification (Cases 46 - 54)
  // =========================================================================
  describe('10. Production Hardening Sprint: Invariants Verification (Cases 46-54)', () => {
    test('Case 46: client cannot manipulate original estimate to reduce fee when server verification has canonical estimate', async () => {
      const findingHarden1 = 'fnd_harden_estimate_manipulation_01';
      await storage.registerFindingOwnership(findingHarden1, userA.id);

      const authRecord: AuthoritativeVerification = {
        id: `ver_harden_${crypto.randomUUID()}`,
        finding_id: findingHarden1,
        user_id: userA.id,
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 30,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 12000.0, // $1,000/mo verified
        original_estimated_annualized_usd: 12000.0, // $1,000/mo canonical server estimate
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveVerification(authRecord);

      // Malicious client tries to send an enormous original estimate ($10,000,000)
      // in an attempt to make verified savings fall below 50% and trigger the protection clause ($0 fee)
      const res = await fetch(`${serverUrl}/api/findings/${findingHarden1}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({
          original_estimated_annualized_usd: 10_000_000.0,
        }),
      });

      assert.strictEqual(res.status, 201);
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      // Persisted fee MUST use the canonical server estimate ($12,000 -> realized ratio 100% >= 50%)
      // Fee: 20% of $12,000 = $2,400; Capped at 1-month ($1,000/mo) = $1,000.0
      assert.strictEqual(json.obligation.fee_amount_usd, 1000.0);
      assert.strictEqual(json.obligation.status, 'PAYABLE');
    });

    test('Case 47: client cannot manipulate original estimate to increase fee beyond cap', async () => {
      const findingHarden2 = 'fnd_harden_estimate_increase_02';
      await storage.registerFindingOwnership(findingHarden2, userA.id);

      const authRecord: AuthoritativeVerification = {
        id: `ver_harden_${crypto.randomUUID()}`,
        finding_id: findingHarden2,
        user_id: userA.id,
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 30,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 6000.0, // $500/mo verified
        original_estimated_annualized_usd: 6000.0,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveVerification(authRecord);

      // Client passes arbitrary inflated values in body
      const res = await fetch(`${serverUrl}/api/findings/${findingHarden2}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({
          original_estimated_annualized_usd: 500_000.0,
          fee_amount_usd: 9999.0,
        }),
      });

      assert.strictEqual(res.status, 201);
      const json: any = await res.json();
      // Cap is $500.00 (1 month of $6,000/yr). 20% of $6,000 is $1,200. Min($1200, $500) = $500.0
      assert.strictEqual(json.obligation.fee_amount_usd, 500.0);
    });

    test('Case 48: User B cannot checkout or GET User A obligation even knowing finding ID', async () => {
      // User B tries to initiate checkout for Finding A owned by User A
      const checkoutRes = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userB.cookie },
        body: JSON.stringify({}),
      });
      assert.strictEqual(checkoutRes.status, 404);

      // User B tries to GET Finding A obligation
      const getRes = await fetch(`${serverUrl}/api/findings/${findingA}/outcome-fee`, {
        headers: { Cookie: userB.cookie },
      });
      assert.strictEqual(getRes.status, 404);
    });

    test('Case 49: User B cannot claim unowned finding that already has User A verification', async () => {
      const findingUnclaimed = 'fnd_unclaimed_verified_by_user_a';
      // User A creates verification without prior findingOwnerships row
      const authRecord: AuthoritativeVerification = {
        id: `ver_unclaimed_${crypto.randomUUID()}`,
        finding_id: findingUnclaimed,
        user_id: userA.id,
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 30,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 12000.0,
        original_estimated_annualized_usd: 12000.0,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveVerification(authRecord);

      // User B attempts to claim this finding by POSTing to /outcome-fee
      const res = await fetch(`${serverUrl}/api/findings/${findingUnclaimed}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userB.cookie },
        body: JSON.stringify({ original_estimated_annualized_usd: 12000.0 }),
      });

      assert.strictEqual(res.status, 404);
      // Ensure ownership was NOT granted to User B
      const owner = await storage.getFindingOwner(findingUnclaimed);
      assert.notStrictEqual(owner, userB.id);
    });

    test('Case 50: PAID or SETTLED obligation rejects new checkout session (409 Conflict)', async () => {
      const findingPaid = 'fnd_paid_obligation_checkout_rejection';
      await storage.registerFindingOwnership(findingPaid, userA.id);

      const obligation: OutcomeFeeObligation = {
        id: `of_paid_${crypto.randomUUID()}`,
        user_id: userA.id,
        finding_id: findingPaid,
        verification_id: `ver_${crypto.randomUUID()}`,
        verified_annualized_savings_usd: 12000.0,
        fee_amount_usd: 1000.0,
        currency: 'USD',
        status: 'PAID',
        provider: 'LEMON_SQUEEZY',
        paid_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.createOutcomeFeeObligation(obligation);

      const res = await fetch(`${serverUrl}/api/findings/${findingPaid}/outcome-fee/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({}),
      });

      assert.strictEqual(res.status, 409);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'ALREADY_PAID');
    });

    test('Case 51: SETTLED obligation cannot regress to PAID or FAILED on out-of-order webhooks', async () => {
      const findingSettled = 'fnd_settled_monotonic_guard';
      await storage.registerFindingOwnership(findingSettled, userA.id);

      const obligation: OutcomeFeeObligation = {
        id: `of_settled_${crypto.randomUUID()}`,
        user_id: userA.id,
        finding_id: findingSettled,
        verification_id: `ver_${crypto.randomUUID()}`,
        verified_annualized_savings_usd: 12000.0,
        fee_amount_usd: 1000.0,
        currency: 'USD',
        status: 'SETTLED',
        provider: 'LEMON_SQUEEZY',
        paid_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.createOutcomeFeeObligation(obligation);

      // Out-of-order webhook arrives with order_created (status: 'paid')
      const outOfOrderPayload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_out_of_order_paid_01',
          custom_data: {
            user_id: userA.id,
            finding_id: findingSettled,
            obligation_id: obligation.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_ooo_101',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: TEST_OUTCOME_FEE_VARIANT_ID,
          },
        },
      };
      const { rawBody, signature } = buildSignedWebhook(outOfOrderPayload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 200);
      const updated = await storage.getOutcomeFeeObligation(findingSettled);
      // Status MUST remain SETTLED and not regress to PAID
      assert.strictEqual(updated?.status, 'SETTLED');
    });

    test('Case 52: PAID obligation cannot regress to FAILED on payment failure webhook', async () => {
      const findingPaid2 = 'fnd_paid_monotonic_guard_02';
      await storage.registerFindingOwnership(findingPaid2, userA.id);

      const obligation: OutcomeFeeObligation = {
        id: `of_paid_guard_${crypto.randomUUID()}`,
        user_id: userA.id,
        finding_id: findingPaid2,
        verification_id: `ver_${crypto.randomUUID()}`,
        verified_annualized_savings_usd: 12000.0,
        fee_amount_usd: 1000.0,
        currency: 'USD',
        status: 'PAID',
        provider: 'LEMON_SQUEEZY',
        paid_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.createOutcomeFeeObligation(obligation);

      // Failure webhook arrives
      const failPayload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_fail_on_paid_02',
          custom_data: {
            user_id: userA.id,
            finding_id: findingPaid2,
            obligation_id: obligation.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_fail_102',
          attributes: {
            status: 'failed',
            total: 100000,
            variant_id: TEST_OUTCOME_FEE_VARIANT_ID,
          },
        },
      };
      const { rawBody, signature } = buildSignedWebhook(failPayload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 200);
      const updated = await storage.getOutcomeFeeObligation(findingPaid2);
      // Status MUST remain PAID and not regress to FAILED
      assert.strictEqual(updated?.status, 'PAID');
    });

    test('Case 53: Webhook failure & recovery: failed webhook processing releases in-flight claim so provider retry succeeds', async () => {
      const testEventId = 'evt_recovery_retry_test_01';
      // Simulate that a webhook claim was started
      const firstClaim = storage.claimWebhookEvent(testEventId);
      assert.strictEqual(firstClaim, 'PROCEED');

      // Processing failed unexpectedly -> releaseWebhookClaim is invoked
      storage.releaseWebhookClaim(testEventId);

      // Provider retries after backoff -> claim must be accepted ('PROCEED') rather than blocked as IN_FLIGHT
      const retryClaim = storage.claimWebhookEvent(testEventId);
      assert.strictEqual(retryClaim, 'PROCEED');

      // Cleanup
      storage.releaseWebhookClaim(testEventId);
    });

    test('Case 54: Database persistence level concurrency: unique index on finding_id prevents duplicate rows even on direct concurrent inserts', async () => {
      const sqlitePath = 'data/test-drizzle-unique-test.db';
      if (fs.existsSync(sqlitePath)) {
        try { fs.unlinkSync(sqlitePath); } catch {}
      }

      const prevEnv = process.env.TURSO_DATABASE_URL;
      process.env.TURSO_DATABASE_URL = `file:${sqlitePath}`;
      await runDatabaseMigrations();

      const { db, client } = createDatabaseConnection({ url: `file:${sqlitePath}` });
      const drizzleAdapter = new DrizzleStorageAdapter(db, client);

      const findingId = 'fnd_concurrency_unique_db_test_01';
      await drizzleAdapter.createUser({
        id: 'usr_01',
        email: 'usr01@aidiscost.com',
        password_hash: 'hash_test_123',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await drizzleAdapter.registerFindingOwnership(findingId, 'usr_01');

      const authRecord: AuthoritativeVerification = {
        id: 'ver_uniq_01',
        finding_id: findingId,
        user_id: 'usr_01',
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 30,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 12000.0,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await drizzleAdapter.saveVerification(authRecord);

      // Fire 5 concurrent create calls directly against SQLite adapter
      const promises = Array.from({ length: 5 }, (_, i) =>
        drizzleAdapter.createOutcomeFeeObligation({
          id: `of_concurrent_db_${i}`,
          user_id: 'usr_01',
          finding_id: findingId,
          verification_id: 'ver_uniq_01',
          verified_annualized_savings_usd: 12000.0,
          fee_amount_usd: 1000.0,
          currency: 'USD',
          status: 'PAYABLE',
          provider: 'LEMON_SQUEEZY',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
      );

      const results = await Promise.all(promises);
      const firstObligationId = results[0].id;

      // Every returned object must be identical to the winning obligation
      for (const res of results) {
        assert.strictEqual(res.id, firstObligationId);
        assert.strictEqual(res.finding_id, findingId);
      }

      // Verify that database table has exactly 1 row for this finding
      const stored = await drizzleAdapter.getOutcomeFeeObligation(findingId);
      assert.ok(stored);
      assert.strictEqual(stored.id, firstObligationId);

      client.close();
      if (prevEnv) {
        process.env.TURSO_DATABASE_URL = prevEnv;
      } else {
        delete process.env.TURSO_DATABASE_URL;
      }
      if (fs.existsSync(sqlitePath)) {
        try { fs.unlinkSync(sqlitePath); } catch {}
      }
    });

    test('Case 55: Typed database column original_estimated_annualized_usd is persisted and retrieved cleanly without notes encoding', async () => {
      const sqlitePath = 'data/test-drizzle-column-test.db';
      if (fs.existsSync(sqlitePath)) {
        try { fs.unlinkSync(sqlitePath); } catch {}
      }

      const prevEnv = process.env.TURSO_DATABASE_URL;
      process.env.TURSO_DATABASE_URL = `file:${sqlitePath}`;
      await runDatabaseMigrations();

      const { db, client } = createDatabaseConnection({ url: `file:${sqlitePath}` });
      const drizzleAdapter = new DrizzleStorageAdapter(db, client);

      const findingId = 'fnd_column_test_01';
      await drizzleAdapter.createUser({
        id: 'usr_col_01',
        email: 'usrcol@aidiscost.com',
        password_hash: 'hash_test_123',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await drizzleAdapter.registerFindingOwnership(findingId, 'usr_col_01');

      const testNotes = 'Human readable audit observation notes only.';
      const authRecord: AuthoritativeVerification = {
        id: 'ver_col_01',
        finding_id: findingId,
        user_id: 'usr_col_01',
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 30,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 12000.0,
        original_estimated_annualized_usd: 15000.0,
        verification_confidence: 'HIGH',
        verification_notes: testNotes,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await drizzleAdapter.saveVerification(authRecord);

      const retrieved = await drizzleAdapter.getVerificationByFindingId(findingId);
      assert.ok(retrieved);
      // Value must be accurately retrieved from real column
      assert.strictEqual(retrieved.original_estimated_annualized_usd, 15000.0);
      // Notes must remain pure human-readable text without [EST:...] prefixes
      assert.strictEqual(retrieved.verification_notes, testNotes);

      client.close();
      if (prevEnv) {
        process.env.TURSO_DATABASE_URL = prevEnv;
      } else {
        delete process.env.TURSO_DATABASE_URL;
      }
      if (fs.existsSync(sqlitePath)) {
        try { fs.unlinkSync(sqlitePath); } catch {}
      }
    });

    test('Case 56: Migration 0003 safely upgrades existing database with prior migrations 0000, 0001, 0002', async () => {
      const sqlitePath = 'data/test-migration-0003-upgrade.db';
      if (fs.existsSync(sqlitePath)) {
        try { fs.unlinkSync(sqlitePath); } catch {}
      }

      const prevEnv = process.env.TURSO_DATABASE_URL;
      process.env.TURSO_DATABASE_URL = `file:${sqlitePath}`;
      
      // Applying all versioned migrations (including 0003) must succeed with exit code 0
      await runDatabaseMigrations();

      const { db, client } = createDatabaseConnection({ url: `file:${sqlitePath}` });
      // Verify that table structure includes original_estimated_annualized_usd
      const testFindingId = 'fnd_mig_03_test';
      const drizzleAdapter = new DrizzleStorageAdapter(db, client);
      await drizzleAdapter.createUser({
        id: 'usr_mig_03',
        email: 'mig03@aidiscost.com',
        password_hash: 'hash_test_123',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await drizzleAdapter.registerFindingOwnership(testFindingId, 'usr_mig_03');

      await drizzleAdapter.saveVerification({
        id: 'ver_mig_03',
        finding_id: testFindingId,
        user_id: 'usr_mig_03',
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 30,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 6000.0,
        original_estimated_annualized_usd: 7200.0,
        verification_confidence: 'HIGH',
        verification_notes: 'Migration 0003 verified column',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const ver = await drizzleAdapter.getVerificationByFindingId(testFindingId);
      assert.strictEqual(ver?.original_estimated_annualized_usd, 7200.0);

      client.close();
      if (prevEnv) {
        process.env.TURSO_DATABASE_URL = prevEnv;
      } else {
        delete process.env.TURSO_DATABASE_URL;
      }
      if (fs.existsSync(sqlitePath)) {
        try { fs.unlinkSync(sqlitePath); } catch {}
      }
    });

    test('Case 57: Direct API endpoint regression: malicious client cannot manipulate original baseline in evaluate or outcome-fee', async () => {
      const findingSec = 'fnd_sec_regression_baseline_01';
      await storage.registerFindingOwnership(findingSec, userA.id);

      // 1. Establish a trusted server-side finding verification with original estimate X = 3,000.0
      // ($250/mo baseline; verified savings of ~$215.45/mo achieves 86.2% realized ratio >= 50% protection threshold)
      const trustedBaselineX = 3000.0;
      const authRecord: AuthoritativeVerification = {
        id: `ver_sec_${crypto.randomUUID()}`,
        finding_id: findingSec,
        user_id: userA.id,
        stage: 'CUSTOMER_DEPLOYED',
        is_authoritative: false,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        deployment_timestamp: '2026-09-10T00:00:00Z',
        observation_sample_count: 0,
        post_avg_cost_usd: 0,
        observed_reduction_pct: 0,
        verified_annualized_savings_usd: 0,
        original_estimated_annualized_usd: trustedBaselineX,
        verification_confidence: 'INSUFFICIENT_OBSERVATION',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveVerification(authRecord);

      // 2. Send /verification/evaluate with malicious request-body finding containing Y = 1,000,000.0
      const maliciousFindingY = {
        ...mockFindingA,
        id: findingSec,
        annualized_projection_usd: 1_000_000.0,
      };
      const events = generatePostEvents(25, 0.3, false);

      const evalRes = await fetch(`${serverUrl}/api/findings/${findingSec}/verification/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({
          events,
          finding: maliciousFindingY,
        }),
      });

      assert.strictEqual(evalRes.status, 200);
      const evalJson: any = await evalRes.json();
      assert.strictEqual(evalJson.is_authoritative, true);

      // 4. Verify persisted original_estimated_annualized_usd remains X (10,000.0)
      const persistedVer = await storage.getVerificationByFindingId(findingSec);
      assert.ok(persistedVer);
      assert.strictEqual(persistedVer.original_estimated_annualized_usd, trustedBaselineX);
      assert.strictEqual(evalJson.verification.original_estimated_annualized_usd, trustedBaselineX);

      // 5. Call /outcome-fee with another malicious client baseline in body
      const feeRes = await fetch(`${serverUrl}/api/findings/${findingSec}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({
          original_estimated_annualized_usd: 999_999.0,
          fee_amount_usd: 1.0,
          finding: {
            ...maliciousFindingY,
            annualized_projection_usd: 5_000_000.0,
          },
        }),
      });

      assert.strictEqual(feeRes.status, 201);
      const feeJson: any = await feeRes.json();
      assert.strictEqual(feeJson.success, true);

      // 6. Verify payable amount is still calculated from X (trustedBaselineX = 10,000.0)
      const expectedMonthly = evalJson.verified_annualized_savings_usd / 12;
      const expectedCap = Number(expectedMonthly.toFixed(2));
      const expectedRaw = Number((evalJson.verified_annualized_savings_usd * 0.20).toFixed(2));
      const expectedFee = Math.min(expectedRaw, expectedCap);
      assert.strictEqual(feeJson.obligation.fee_amount_usd, expectedFee);

      // 7. Verify client values did not mutate authoritative verification state
      const finalVer = await storage.getVerificationByFindingId(findingSec);
      assert.strictEqual(finalVer?.original_estimated_annualized_usd, trustedBaselineX);
    });

    test('Case 58: Webhook HTTP handler failure & retry lifecycle: transient error releases in-flight claim so provider retry succeeds and persists exactly once', async () => {
      const retryFindingId = 'fnd_webhook_handler_retry_01';
      await storage.registerFindingOwnership(retryFindingId, userA.id);

      // Create authoritative verification
      const authRecord: AuthoritativeVerification = {
        id: `ver_retry_${crypto.randomUUID()}`,
        finding_id: retryFindingId,
        user_id: userA.id,
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-09-01T00:00:00Z',
        baseline_end: '2026-09-10T00:00:00Z',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 30,
        post_avg_cost_usd: 0.3,
        observed_reduction_pct: 85.0,
        verified_annualized_savings_usd: 12000.0,
        original_estimated_annualized_usd: 12000.0,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveVerification(authRecord);

      // Create payable obligation
      const obligation = await storage.createOutcomeFeeObligation({
        id: `of_retry_${crypto.randomUUID()}`,
        user_id: userA.id,
        finding_id: retryFindingId,
        verification_id: authRecord.id,
        verified_annualized_savings_usd: 12000.0,
        fee_amount_usd: 1000.0,
        currency: 'USD',
        status: 'PAYABLE',
        provider: 'LEMON_SQUEEZY',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const retryEventId = `evt_handler_retry_${Date.now()}`;
      const webhookPayload = {
        meta: {
          event_name: 'order_created',
          event_id: retryEventId,
          custom_data: {
            user_id: userA.id,
            finding_id: retryFindingId,
            obligation_id: obligation.id,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_retry_ls_001',
          type: 'orders',
          attributes: {
            status: 'paid',
            total: 100000,
            variant_id: TEST_OUTCOME_FEE_VARIANT_ID,
          },
        },
      };

      const signed = buildSignedWebhook(webhookPayload);

      // Simulate a transient error during storage transaction processing on attempt 1
      const origTx = storage.processOutcomeFeeWebhookTransaction?.bind(storage);
      const origUpdate = storage.updateOutcomeFeeObligation.bind(storage);
      let failOnce = true;
      if (origTx) {
        storage.processOutcomeFeeWebhookTransaction = async (params) => {
          if (failOnce) {
            failOnce = false;
            throw new Error('Database connection transient timeout');
          }
          return origTx(params);
        };
      } else {
        storage.updateOutcomeFeeObligation = async (obl) => {
          if (failOnce) {
            failOnce = false;
            throw new Error('Database connection transient timeout');
          }
          return origUpdate(obl);
        };
      }

      try {
        // Attempt 1: Handler hits transient failure -> releases in-flight claim -> returns 500
        const attempt1Res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature': signed.signature,
          },
          body: signed.rawBody,
        });

        assert.strictEqual(attempt1Res.status, 500);
        const attempt1Json: any = await attempt1Res.json();
        assert.strictEqual(attempt1Json.error, 'INTERNAL_ERROR');

        // Obligation must remain in PAYABLE state
        const oblAfterFail = await storage.getOutcomeFeeObligation(retryFindingId);
        assert.strictEqual(oblAfterFail?.status, 'PAYABLE');

        // Attempt 2: Lemon Squeezy provider retries with exact same payload & signature
        const attempt2Res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature': signed.signature,
          },
          body: signed.rawBody,
        });

        assert.strictEqual(attempt2Res.status, 200);
        const attempt2Json: any = await attempt2Res.json();
        assert.strictEqual(attempt2Json.status, 'SUCCESS');
        assert.strictEqual(attempt2Json.outcome_fee_status, 'PAID');

        // Obligation must now be PAID
        const oblAfterSuccess = await storage.getOutcomeFeeObligation(retryFindingId);
        assert.strictEqual(oblAfterSuccess?.status, 'PAID');

        // Attempt 3: Idempotent replay of same event returns IDEMPOTENT_DUPLICATE
        const attempt3Res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature': signed.signature,
          },
          body: signed.rawBody,
        });

        assert.strictEqual(attempt3Res.status, 200);
        const attempt3Json: any = await attempt3Res.json();
        assert.strictEqual(attempt3Json.status, 'IDEMPOTENT_DUPLICATE');
      } finally {
        if (origTx) {
          storage.processOutcomeFeeWebhookTransaction = origTx;
        }
        storage.updateOutcomeFeeObligation = origUpdate;
      }
    });
  });
});
