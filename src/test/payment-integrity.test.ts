/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { createApiRouter } from '../server/api';
import { ServerStorage, setStorage } from '../server/storage';
import { authenticate } from '../server/auth';
import { Finding } from '../types/domain';
import { AuthoritativeVerification, OutcomeFeeObligation } from '../server/types';

describe('AIDisCost MCP — Phase 1 Payment Integrity Suite', () => {
  let server: http.Server;
  let serverUrl: string;
  const storage = ServerStorage.getInstance('data', 'test-payment-integrity-db.json');

  const TEST_WEBHOOK_SECRET = 'payment_integrity_secret_xyz123';
  const TEST_FIX_VARIANT_ID = 'var_fix_49';
  const TEST_OUTCOME_FEE_VARIANT_ID = 'var_outcome_fee_variable';

  let userA: { id: string; email: string; cookie: string };
  const findingId = 'fnd_payment_integrity_01';
  const auditId = 'adt_payment_integrity_01';

  const mockFinding: Finding = {
    id: findingId,
    audit_id: auditId,
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
    annualized_projection_usd: 12000.0,
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

  function buildSignedWebhook(payload: any, secret = TEST_WEBHOOK_SECRET): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return { rawBody, signature };
  }

  before(async () => {
    process.env.LEMON_SQUEEZY_API_KEY = 'test_ls_api_key';
    process.env.LEMON_SQUEEZY_STORE_ID = '12345';
    process.env.LEMON_SQUEEZY_VARIANT_ID = TEST_FIX_VARIANT_ID;
    process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = TEST_OUTCOME_FEE_VARIANT_ID;
    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

    setStorage(storage);
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
      body: JSON.stringify({ email: 'user.integrity@company.com', password: 'Password123!' }),
    });
    const regDataA: any = await regResA.json();
    const cookieA = regResA.headers.get('set-cookie') || '';
    userA = { id: regDataA.user.id, email: regDataA.user.email, cookie: cookieA };

    // Seed Finding Ownership & Audit
    await storage.saveAudit({
      audit_id: auditId,
      user_id: userA.id,
      source: 'custom_logs',
      total_spend_usd: 1200,
      potential_savings_usd: 85,
      annualized_savings_projection_usd: 12000,
      is_sample_data: false,
      findings_count: 1,
      created_at: new Date().toISOString(),
    });
    await storage.saveFinding({
      audit_id: auditId,
      finding_id: findingId,
      user_id: userA.id,
      rule_id: 'MODEL_RIGHT_SIZING',
      title: mockFinding.title,
      summary: mockFinding.summary,
      baseline_spend_usd: mockFinding.baseline_spend_usd,
      estimated_savings_usd: mockFinding.estimated_savings_usd,
      annualized_projection_usd: mockFinding.annualized_projection_usd,
      eligible_event_count: mockFinding.eligible_event_count,
      status: 'DETECTED',
      is_sample_data: false,
      created_at: new Date().toISOString(),
      evidence: mockFinding.evidence,
    });
    await storage.registerFindingOwnership(findingId, userA.id, auditId);

    // Save authoritative verification so Outcome Fee can be created
    const authVerification: AuthoritativeVerification = {
      id: `ver_${crypto.randomUUID()}`,
      finding_id: findingId,
      audit_id: auditId,
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
    await storage.saveVerification(authVerification);
  });

  after(async () => {
    storage.clearAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ==========================================
  // Section A: Fail-Closed Configuration
  // ==========================================
  describe('A. Fail-Closed Configuration & Webhook Secret Enforcement', () => {
    test('Fix Package checkout fails closed (503) if webhook secret is missing', async () => {
      const originalSecret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
      delete process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
      try {
        const res = await fetch(`${serverUrl}/api/billing/fix-package/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
          body: JSON.stringify({ finding_id: findingId, audit_id: auditId }),
        });
        assert.strictEqual(res.status, 503);
        const json: any = await res.json();
        assert.strictEqual(json.error, 'BILLING_NOT_CONFIGURED');
      } finally {
        process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = originalSecret;
      }
    });

    test('Outcome Fee checkout fails closed (503) if webhook secret is missing', async () => {
      // First create obligation
      await fetch(`${serverUrl}/api/findings/${findingId}/outcome-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({ audit_id: auditId }),
      });

      const originalSecret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
      delete process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
      try {
        const res = await fetch(`${serverUrl}/api/findings/${findingId}/outcome-fee/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
          body: JSON.stringify({ audit_id: auditId }),
        });
        assert.strictEqual(res.status, 503);
        const json: any = await res.json();
        assert.strictEqual(json.error, 'BILLING_NOT_CONFIGURED');
      } finally {
        process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = originalSecret;
      }
    });

    test('Checkouts fail closed (500) if variant collision detected', async () => {
      const originalOutcomeVariant = process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID;
      process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = TEST_FIX_VARIANT_ID; // Force collision
      try {
        const resFix = await fetch(`${serverUrl}/api/billing/fix-package/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
          body: JSON.stringify({ finding_id: findingId, audit_id: auditId }),
        });
        assert.strictEqual(resFix.status, 500);
        const jsonFix: any = await resFix.json();
        assert.strictEqual(jsonFix.error, 'CONFIGURATION_ERROR');

        const resOutcome = await fetch(`${serverUrl}/api/findings/${findingId}/outcome-fee/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
          body: JSON.stringify({ audit_id: auditId }),
        });
        assert.strictEqual(resOutcome.status, 500);
        const jsonOutcome: any = await resOutcome.json();
        assert.strictEqual(jsonOutcome.error, 'CONFIGURATION_ERROR');
      } finally {
        process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = originalOutcomeVariant;
      }
    });
  });

  // ==========================================
  // Section B: Actual Amount & Currency Validation
  // ==========================================
  describe('B. Actual Paid Amount & Currency Validation', () => {
    test('Fix Package webhook rejects non-USD currency with 400 CURRENCY_MISMATCH', async () => {
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_fix_currency_err_01',
          custom_data: { user_id: userA.id, finding_id: findingId, audit_id: auditId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: 'ord_curr_eur_01',
          attributes: {
            status: 'paid',
            currency: 'EUR',
            total: 4900,
            variant_id: TEST_FIX_VARIANT_ID,
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
      assert.strictEqual(json.error, 'CURRENCY_MISMATCH');

      // Verify entitlement was NOT created
      const hasPaid = await storage.hasActivePaidEntitlement(userA.id, findingId, auditId);
      assert.strictEqual(hasPaid, false);
    });

    test('Fix Package webhook rejects underpayment with 400 AMOUNT_MISMATCH and logs reconciliation', async () => {
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_fix_amount_err_01',
          custom_data: { user_id: userA.id, finding_id: findingId, audit_id: auditId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: 'ord_underpaid_01',
          attributes: {
            status: 'paid',
            currency: 'USD',
            total: 2000, // $20.00 instead of $49.00
            variant_id: TEST_FIX_VARIANT_ID,
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

      // Verify entitlement was NOT created
      const hasPaid = await storage.hasActivePaidEntitlement(userA.id, findingId, auditId);
      assert.strictEqual(hasPaid, false);

      // Verify payment reconciliation was logged
      const reconciliations = await storage.listPaymentReconciliations(userA.id, findingId);
      const match = reconciliations.find((r) => r.reason === 'AMOUNT_MISMATCH' && r.product === 'FIX_PACKAGE');
      assert.ok(match, 'Payment reconciliation record must be created for underpayment');
      assert.strictEqual(match.status, 'NEEDS_REFUND_REVIEW');
    });

    test('Outcome Fee webhook rejects non-USD currency with 400 CURRENCY_MISMATCH', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      assert.ok(obligation);

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_outcome_curr_err_01',
          custom_data: { user_id: userA.id, finding_id: findingId, audit_id: auditId, obligation_id: obligation.id, product: 'OUTCOME_FEE' },
        },
        data: {
          id: 'ord_out_curr_gbp_01',
          attributes: {
            status: 'paid',
            currency: 'GBP',
            total: Math.round(obligation.fee_amount_usd * 100),
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
      assert.strictEqual(json.error, 'CURRENCY_MISMATCH');

      // Verify obligation was NOT marked paid
      const refreshed = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      assert.notStrictEqual(refreshed?.status, 'PAID');
    });

    test('Outcome Fee webhook rejects amount mismatch with 400 AMOUNT_MISMATCH and logs reconciliation', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      assert.ok(obligation);

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_outcome_amount_err_01',
          custom_data: { user_id: userA.id, finding_id: findingId, audit_id: auditId, obligation_id: obligation.id, product: 'OUTCOME_FEE' },
        },
        data: {
          id: 'ord_out_underpaid_01',
          attributes: {
            status: 'paid',
            currency: 'USD',
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

      // Verify obligation was NOT marked paid
      const refreshed = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      assert.notStrictEqual(refreshed?.status, 'PAID');

      // Verify reconciliation was recorded
      const reconciliations = await storage.listPaymentReconciliations(userA.id, findingId);
      const match = reconciliations.find((r) => r.reason === 'AMOUNT_MISMATCH' && r.product === 'OUTCOME_FEE');
      assert.ok(match, 'Payment reconciliation record must be created for Outcome Fee amount mismatch');
    });
  });

  // ==========================================
  // Section C: Refund State Machine & REFUNDED Status
  // ==========================================
  describe('C. Refund State Machine & Monotonic Invariants', () => {
    test('Valid payment transitions Outcome Fee obligation to PAID', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      assert.ok(obligation);

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_outcome_valid_pay_01',
          custom_data: { user_id: userA.id, finding_id: findingId, audit_id: auditId, obligation_id: obligation.id, product: 'OUTCOME_FEE' },
        },
        data: {
          id: 'ord_out_paid_777',
          attributes: {
            status: 'paid',
            currency: 'USD',
            total: Math.round(obligation.fee_amount_usd * 100),
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

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.status, 'SUCCESS');

      const refreshed = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      assert.strictEqual(refreshed?.status, 'PAID');
    });

    test('Settlement event transitions Outcome Fee obligation from PAID to SETTLED', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      assert.ok(obligation);

      const payload = {
        meta: {
          event_name: 'order_settled',
          event_id: 'evt_outcome_settle_01',
          custom_data: { user_id: userA.id, finding_id: findingId, audit_id: auditId, obligation_id: obligation.id, product: 'OUTCOME_FEE' },
        },
        data: {
          id: 'ord_out_paid_777',
          attributes: {
            status: 'settled',
            currency: 'USD',
            total: Math.round(obligation.fee_amount_usd * 100),
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

      assert.strictEqual(res.status, 200);
      const refreshed = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      assert.strictEqual(refreshed?.status, 'SETTLED');
    });

    test('Full refund transitions Outcome Fee obligation from SETTLED to explicit REFUNDED state', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      assert.ok(obligation);
      assert.strictEqual(obligation.status, 'SETTLED');

      const payload = {
        meta: {
          event_name: 'order_refunded',
          event_id: 'evt_outcome_refund_01',
          custom_data: { user_id: userA.id, finding_id: findingId, audit_id: auditId, obligation_id: obligation.id, product: 'OUTCOME_FEE' },
        },
        data: {
          id: 'ord_out_paid_777',
          attributes: {
            status: 'refunded',
            refunded: true,
            currency: 'USD',
            total: Math.round(obligation.fee_amount_usd * 100),
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

      assert.strictEqual(res.status, 200);
      const refreshed = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      assert.strictEqual(refreshed?.status, 'REFUNDED');
      assert.notStrictEqual(refreshed?.status, 'FAILED');
    });

    test('Monotonic guarantee: late order_created event CANNOT revert REFUNDED obligation back to PAID or SETTLED', async () => {
      const obligation = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      assert.ok(obligation);
      assert.strictEqual(obligation.status, 'REFUNDED');

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_late_order_created_after_refund',
          custom_data: { user_id: userA.id, finding_id: findingId, audit_id: auditId, obligation_id: obligation.id, product: 'OUTCOME_FEE' },
        },
        data: {
          id: 'ord_out_paid_777',
          attributes: {
            status: 'paid',
            currency: 'USD',
            total: Math.round(obligation.fee_amount_usd * 100),
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

      assert.strictEqual(res.status, 200);
      const refreshed = await storage.getOutcomeFeeObligation(findingId, userA.id, auditId);
      // Status MUST strictly stay REFUNDED!
      assert.strictEqual(refreshed?.status, 'REFUNDED');
    });

    test('Partial refund is quarantined for reconciliation without revoking or falsely marking full refund', async () => {
      // Create a new finding for partial refund test
      const partialFindingId = 'fnd_partial_refund_01';
      await storage.saveFinding({
        audit_id: auditId,
        finding_id: partialFindingId,
        user_id: userA.id,
        rule_id: 'MODEL_RIGHT_SIZING',
        title: 'Partial Refund Finding',
        summary: 'Testing partial refund quarantine',
        baseline_spend_usd: 100.0,
        estimated_savings_usd: 85.0,
        annualized_projection_usd: 12000.0,
        eligible_event_count: 50,
        status: 'DETECTED',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      });
      await storage.registerFindingOwnership(partialFindingId, userA.id, auditId);

      // Create active entitlement
      await storage.createEntitlement({
        id: `ent_part_${crypto.randomUUID()}`,
        user_id: userA.id,
        audit_id: auditId,
        finding_id: partialFindingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_partial_fix_01',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        meta: {
          event_name: 'order_refunded',
          event_id: 'evt_fix_partial_ref_01',
          custom_data: { user_id: userA.id, finding_id: partialFindingId, audit_id: auditId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: 'ord_partial_fix_01',
          attributes: {
            status: 'partial_refund',
            refunded_amount: 2000, // $20.00 refunded out of $49.00
            total: 4900,
            variant_id: TEST_FIX_VARIANT_ID,
          },
        },
      };
      const { rawBody, signature } = buildSignedWebhook(payload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: rawBody,
      });

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.status, 'IGNORED_PARTIAL_REFUND');

      // Entitlement must REMAIN ACTIVE (partial refunds do not revoke full access)
      const hasPaid = await storage.hasActivePaidEntitlement(userA.id, partialFindingId, auditId);
      assert.strictEqual(hasPaid, true);

      // Reconciliation logged for partial refund
      const reconciliations = await storage.listPaymentReconciliations(userA.id, partialFindingId);
      const match = reconciliations.find((r) => r.reason === 'PARTIAL_REFUND');
      assert.ok(match, 'Partial refund must be flagged in payment reconciliations');
    });
  });

  // ==========================================
  // Section D: Duplicate Checkout & Readiness Diagnostics
  // ==========================================
  describe('D. Duplicate Checkout Prevention & Production Sign-Off Diagnostics', () => {
    test('REFUNDED obligation rejects new checkout session with 409 ALREADY_REFUNDED', async () => {
      const res = await fetch(`${serverUrl}/api/findings/${findingId}/outcome-fee/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookie },
        body: JSON.stringify({ audit_id: auditId }),
      });
      assert.strictEqual(res.status, 409);
      const json: any = await res.json();
      assert.strictEqual(json.error, 'ALREADY_REFUNDED');
    });

    test('/api/billing/readiness reports comprehensive status without exposing secrets', async () => {
      const res = await fetch(`${serverUrl}/api/billing/readiness`);
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();

      assert.ok(typeof json.payment_ready === 'boolean');
      assert.ok(typeof json.database_ready === 'boolean');
      assert.ok(json.checks);
      assert.strictEqual(json.checks.api_key_configured, true);
      assert.strictEqual(json.checks.store_id_configured, true);
      assert.strictEqual(json.checks.webhook_secret_configured, true);
      assert.strictEqual(json.checks.no_variant_collision, true);

      // Verify NO SECRETS leaked
      const bodyString = JSON.stringify(json);
      assert.strictEqual(bodyString.includes(TEST_WEBHOOK_SECRET), false);
      assert.strictEqual(bodyString.includes('test_ls_api_key'), false);
    });

    test('/api/health/billing is available as an alias for monitoring', async () => {
      const res = await fetch(`${serverUrl}/api/health/billing`);
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.ok(json.checks);
    });
  });
});
