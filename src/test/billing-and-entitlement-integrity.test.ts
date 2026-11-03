/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe, before, after, beforeEach } from 'node:test';
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
import { User, Entitlement, AuthoritativeVerification, OutcomeFeeObligation, PersistedAuditRecord } from '../server/types';

describe('AIDisCost Group B: Entitlement & Billing Integrity Verification Suite', () => {
  let server: http.Server;
  let serverUrl: string;
  const testSecret = 'test_group_b_billing_secret_xyz789';
  const testVariantId = 'variant_fix_49_test';
  const testOutcomeFeeVariantId = 'variant_outcome_fee_test';

  const memoryStorage = ServerStorage.getInstance('data', 'test-group-b-db.json');

  before(async () => {
    process.env.LEMON_SQUEEZY_API_KEY = 'test_ls_api_key_123';
    process.env.LEMON_SQUEEZY_STORE_ID = 'test_store_123';
    process.env.LEMON_SQUEEZY_VARIANT_ID = testVariantId;
    process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = testOutcomeFeeVariantId;
    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = testSecret;

    memoryStorage.setTestMode(true);
    memoryStorage.clearAll();
    setStorage(memoryStorage);

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
    memoryStorage.clearAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function signPayload(payloadString: string, secret: string = testSecret): string {
    return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
  }

  async function createTestSession(userId: string): Promise<string> {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await memoryStorage.createSession({
      token: rawToken,
      user_id: userId,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    });
    return rawToken;
  }

  async function seedTestAuditAndFinding(
    userId: string,
    findingId: string,
    auditId = `audit_${findingId}`,
    estimatedSavings = 10000
  ) {
    await memoryStorage.saveAudit({
      audit_id: auditId,
      user_id: userId,
      source: 'custom_logs',
      total_spend_usd: 12000,
      potential_savings_usd: estimatedSavings,
      annualized_savings_projection_usd: estimatedSavings,
      is_sample_data: false,
      health_grade: 'A',
      health_report: {} as any,
      findings_count: 1,
      created_at: new Date().toISOString(),
    });
    await memoryStorage.saveFinding({
      audit_id: auditId,
      finding_id: findingId,
      user_id: userId,
      rule_id: 'RULE_MODEL_RIGHT_SIZING',
      title: 'Test Finding',
      summary: 'Summary',
      affected_scope: 'scope',
      detection_confidence: 'HIGH',
      baseline_spend_usd: 12000,
      candidate_spend_usd: 2000,
      estimated_savings_usd: estimatedSavings,
      potential_savings_pct: 80,
      annualized_projection_usd: estimatedSavings,
      eligible_event_count: 50,
      calculation_method: 'DIFFERENTIAL',
      assumptions: [],
      evidence: {} as any,
      status: 'DETECTED',
      is_sample_data: false,
      created_at: new Date().toISOString(),
    });
  }

  // =========================================================================
  // SECTION 1: ENTITLEMENT IDENTITY AND ISOLATION (Phase A & H.1)
  // =========================================================================
  describe('1. Entitlement Identity Scoping by (user_id, audit_id, finding_id)', () => {
    test('1.1. User purchasing Finding A in Audit X does NOT receive entitlement in Audit Y', async () => {
      memoryStorage.clearAll();

      const user: User = {
        id: 'usr_iso_1',
        email: 'isolation1@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);

      const auditX: any = {
        audit_id: 'audit_X',
        id: 'audit_X',
        user_id: user.id,
        created_at: new Date().toISOString(),
        summary: { total_spend_annualized_usd: 10000, total_waste_annualized_usd: 2000, findings_count: 1 },
      };
      const auditY: any = {
        audit_id: 'audit_Y',
        id: 'audit_Y',
        user_id: user.id,
        created_at: new Date().toISOString(),
        summary: { total_spend_annualized_usd: 12000, total_waste_annualized_usd: 3000, findings_count: 1 },
      };
      await memoryStorage.saveAudit(auditX);
      await memoryStorage.saveAudit(auditY);

      const sharedFindingId = 'finding_duplicate_rule_id';

      // Register finding in both audits for the user
      await memoryStorage.registerFindingOwnership(sharedFindingId, user.id, auditX.audit_id);
      await memoryStorage.registerFindingOwnership(sharedFindingId, user.id, auditY.audit_id);

      // Grant paid entitlement strictly for auditX
      const entitlementX: Entitlement = {
        id: 'ent_audit_X',
        user_id: user.id,
        audit_id: auditX.audit_id,
        finding_id: sharedFindingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_audit_X',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createEntitlement(entitlementX);

      // Verify auditX has active paid entitlement
      assert.strictEqual(await memoryStorage.hasActivePaidEntitlement(user.id, sharedFindingId, auditX.audit_id), true);

      // CRITICAL: auditY MUST NOT have active paid entitlement
      assert.strictEqual(await memoryStorage.hasActivePaidEntitlement(user.id, sharedFindingId, auditY.audit_id), false);

      // Direct entitlement lookup by audit context
      const entForX = await memoryStorage.getEntitlement(user.id, sharedFindingId, auditX.audit_id);
      assert.ok(entForX);
      assert.strictEqual(entForX.audit_id, auditX.audit_id);
      assert.strictEqual(entForX.status, 'ACTIVE');

      const entForY = await memoryStorage.getEntitlement(user.id, sharedFindingId, auditY.audit_id);
      assert.strictEqual(entForY, null);
    });

    test('1.2. GET /api/findings/:id/entitlement isolates access based on query audit_id', async () => {
      const user: User = {
        id: 'usr_api_iso_2',
        email: 'api_iso2@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);

      const auditA: any = {
        audit_id: 'audit_A_route',
        id: 'audit_A_route',
        user_id: user.id,
        created_at: new Date().toISOString(),
        summary: { total_spend_annualized_usd: 5000, total_waste_annualized_usd: 1000, findings_count: 1 },
      };
      const auditB: any = {
        audit_id: 'audit_B_route',
        id: 'audit_B_route',
        user_id: user.id,
        created_at: new Date().toISOString(),
        summary: { total_spend_annualized_usd: 6000, total_waste_annualized_usd: 1500, findings_count: 1 },
      };
      await memoryStorage.saveAudit(auditA);
      await memoryStorage.saveAudit(auditB);

      const findingId = 'finding_shared_route_id';
      await memoryStorage.saveFinding({
        audit_id: auditA.audit_id,
        finding_id: findingId,
        user_id: user.id,
        rule_id: 'RULE_MODEL_RIGHT_SIZING',
        title: 'Title',
        summary: 'Summary',
        affected_scope: 'scope',
        detection_confidence: 'HIGH',
        baseline_spend_usd: 5000,
        candidate_spend_usd: 4000,
        estimated_savings_usd: 1000,
        potential_savings_pct: 20,
        annualized_projection_usd: 1000,
        eligible_event_count: 10,
        calculation_method: 'DIFF',
        assumptions: [],
        evidence: {} as any,
        status: 'DETECTED',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      });
      await memoryStorage.saveFinding({
        audit_id: auditB.audit_id,
        finding_id: findingId,
        user_id: user.id,
        rule_id: 'RULE_MODEL_RIGHT_SIZING',
        title: 'Title',
        summary: 'Summary',
        affected_scope: 'scope',
        detection_confidence: 'HIGH',
        baseline_spend_usd: 6000,
        candidate_spend_usd: 4500,
        estimated_savings_usd: 1500,
        potential_savings_pct: 25,
        annualized_projection_usd: 1500,
        eligible_event_count: 15,
        calculation_method: 'DIFF',
        assumptions: [],
        evidence: {} as any,
        status: 'DETECTED',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      });
      await memoryStorage.registerFindingOwnership(findingId, user.id, auditA.audit_id);
      await memoryStorage.registerFindingOwnership(findingId, user.id, auditB.audit_id);

      // Entitle auditA only
      await memoryStorage.createEntitlement({
        id: 'ent_route_A',
        user_id: user.id,
        audit_id: auditA.audit_id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_route_A',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const token = await createTestSession(user.id);

      // Query entitlement with audit_id = auditA
      const resA = await fetch(`${serverUrl}/api/findings/${findingId}/entitlement?audit_id=${auditA.audit_id}`, {
        headers: { Cookie: `aidiscost_session=${token}` },
      });
      assert.strictEqual(resA.status, 200);
      const dataA: any = await resA.json();
      assert.strictEqual(dataA.is_paid, true);
      assert.strictEqual(dataA.entitlement_type, 'PAID_FIX_PACKAGE');
      assert.strictEqual(dataA.audit_id, auditA.audit_id);

      // Query entitlement with audit_id = auditB
      const resB = await fetch(`${serverUrl}/api/findings/${findingId}/entitlement?audit_id=${auditB.audit_id}`, {
        headers: { Cookie: `aidiscost_session=${token}` },
      });
      assert.strictEqual(resB.status, 200);
      const dataB: any = await resB.json();
      assert.strictEqual(dataB.is_paid, false);
      assert.strictEqual(dataB.entitlement_type, 'LOCKED');
      assert.strictEqual(dataB.entitlement, null);
    });

    test('1.3. Cross-Account Isolation: Querying another user audit_id returns 404', async () => {
      const userVictim: User = {
        id: 'usr_victim_1',
        email: 'victim1@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const userAttacker: User = {
        id: 'usr_attacker_1',
        email: 'attacker1@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(userVictim);
      await memoryStorage.createUser(userAttacker);

      const victimAudit: any = {
        audit_id: 'audit_victim_private',
        id: 'audit_victim_private',
        user_id: userVictim.id,
        created_at: new Date().toISOString(),
        summary: { total_spend_annualized_usd: 100000, total_waste_annualized_usd: 25000, findings_count: 5 },
      };
      await memoryStorage.saveAudit(victimAudit);

      const tokenAttacker = await createTestSession(userAttacker.id);

      // Attacker queries victim's audit_id
      const res = await fetch(`${serverUrl}/api/findings/some_finding/entitlement?audit_id=${victimAudit.audit_id}`, {
        headers: { Cookie: `aidiscost_session=${tokenAttacker}` },
      });
      assert.strictEqual(res.status, 404);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'NOT_FOUND');
    });

    test('1.4. DrizzleStorageAdapter preserves audit_id scoping in SQLite/libSQL', async () => {
      const { db, client } = createDatabaseConnection({ url: ':memory:' });
      await initializeDatabaseSchema(client);
      const adapter = new DrizzleStorageAdapter(db, client);

      const user: User = {
        id: 'usr_drizzle_iso_1',
        email: 'drizzle_iso1@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await adapter.createUser(user);

      const audit1: any = {
        audit_id: 'audit_drizzle_1',
        id: 'audit_drizzle_1',
        user_id: user.id,
        source: 'OPENAI_API_LOG',
        total_spend_usd: 20000,
        potential_savings_usd: 4000,
        annualized_savings_projection_usd: 4000,
        is_sample_data: false,
        findings_count: 1,
        created_at: new Date().toISOString(),
      };
      const audit2: any = {
        audit_id: 'audit_drizzle_2',
        id: 'audit_drizzle_2',
        user_id: user.id,
        source: 'OPENAI_API_LOG',
        total_spend_usd: 25000,
        potential_savings_usd: 5000,
        annualized_savings_projection_usd: 5000,
        is_sample_data: false,
        findings_count: 1,
        created_at: new Date().toISOString(),
      };
      await adapter.saveAudit(audit1);
      await adapter.saveAudit(audit2);

      const findingId = 'finding_drizzle_scoped';
      await adapter.registerFindingOwnership(findingId, user.id, audit1.audit_id);
      await adapter.registerFindingOwnership(findingId, user.id, audit2.audit_id);

      // Entitle audit1 only
      await adapter.createEntitlement({
        id: 'ent_drizzle_1',
        user_id: user.id,
        audit_id: audit1.audit_id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_drizzle_1',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      assert.strictEqual(await adapter.hasActivePaidEntitlement(user.id, findingId, audit1.audit_id), true);
      assert.strictEqual(await adapter.hasActivePaidEntitlement(user.id, findingId, audit2.audit_id), false);

      const ent1 = await adapter.getEntitlement(user.id, findingId, audit1.audit_id);
      assert.ok(ent1);
      assert.strictEqual(ent1.audit_id, audit1.audit_id);
      assert.strictEqual(ent1.status, 'ACTIVE');

      const ent2 = await adapter.getEntitlement(user.id, findingId, audit2.audit_id);
      assert.strictEqual(ent2, null);
    });
  });

  // =========================================================================
  // SECTION 2: WEBHOOK AUTHENTICATION AND SIGNATURE VERIFICATION (Phase B & H.3)
  // =========================================================================
  describe('2. Webhook Authentication and Signature Security', () => {
    test('2.1. Valid HMAC SHA-256 signature is accepted', async () => {
      const payload = {
        meta: {
          event_name: 'order_settled',
          event_id: 'evt_auth_valid_1',
          custom_data: { product: 'FIX_PACKAGE' },
        },
        data: { id: 'ord_auth_1' },
      };
      const payloadString = JSON.stringify(payload);
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
    });

    test('2.2. Missing x-signature header is rejected with 401 INVALID_SIGNATURE', async () => {
      const payload = { meta: { event_name: 'order_created', event_id: 'evt_missing_sig' } };
      const payloadString = JSON.stringify(payload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloadString,
      });

      assert.strictEqual(res.status, 401);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'INVALID_SIGNATURE');
    });

    test('2.3. Invalid signature hash is rejected with 401 INVALID_SIGNATURE', async () => {
      const payload = { meta: { event_name: 'order_created', event_id: 'evt_bad_sig' } };
      const payloadString = JSON.stringify(payload);

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
        body: payloadString,
      });

      assert.strictEqual(res.status, 401);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'INVALID_SIGNATURE');
    });

    test('2.4. Tampered payload with valid original signature is rejected (timing-safe)', async () => {
      const originalPayload = { meta: { event_name: 'order_settled', event_id: 'evt_original' } };
      const originalString = JSON.stringify(originalPayload);
      const validSignatureForOriginal = signPayload(originalString);

      // Attacker tampers body
      const tamperedString = JSON.stringify({ meta: { event_name: 'order_settled', event_id: 'evt_tampered' } });

      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': validSignatureForOriginal,
        },
        body: tamperedString,
      });

      assert.strictEqual(res.status, 401);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'INVALID_SIGNATURE');
    });
  });

  // =========================================================================
  // SECTION 3: CHECKOUT CREATION & PRICE LOCKING (Phase B & H.2)
  // =========================================================================
  describe('3. Checkout Creation and Commercial Price Integrity', () => {
    test('3.1. Checkout rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${serverUrl}/api/billing/fix-package/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ finding_id: 'finding_unauth' }),
      });
      assert.strictEqual(res.status, 401);
    });

    test('3.2. Checkout rejects missing finding_id with 400', async () => {
      const user: User = {
        id: 'usr_chk_1',
        email: 'checkout1@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const token = await createTestSession(user.id);

      const res = await fetch(`${serverUrl}/api/billing/fix-package/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `aidiscost_session=${token}`,
        },
        body: JSON.stringify({}),
      });

      assert.strictEqual(res.status, 400);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'INVALID_FINDING');
    });

    test('3.3. Checkout rejects checkout on another user audit with 404 (isolation)', async () => {
      const userA: User = {
        id: 'usr_chk_A',
        email: 'chk_a@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const userB: User = {
        id: 'usr_chk_B',
        email: 'chk_b@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(userA);
      await memoryStorage.createUser(userB);

      const auditA: any = {
        audit_id: 'audit_A_private_checkout',
        id: 'audit_A_private_checkout',
        user_id: userA.id,
        created_at: new Date().toISOString(),
        summary: { total_spend_annualized_usd: 10000, total_waste_annualized_usd: 2000, findings_count: 1 },
      };
      await memoryStorage.saveAudit(auditA);

      const tokenB = await createTestSession(userB.id);

      // User B attempts to checkout finding referencing User A's audit
      const res = await fetch(`${serverUrl}/api/billing/fix-package/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `aidiscost_session=${tokenB}`,
        },
        body: JSON.stringify({
          finding_id: 'some_finding',
          audit_id: auditA.audit_id,
        }),
      });

      assert.strictEqual(res.status, 404);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'NOT_FOUND');
    });

    test('3.4. Double checkout returns 409 ALREADY_ENTITLED if finding already entitled', async () => {
      const user: User = {
        id: 'usr_already_ent',
        email: 'already_ent@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const findingId = 'finding_already_active';
      await seedTestAuditAndFinding(user.id, findingId);
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      await memoryStorage.createEntitlement({
        id: 'ent_existing_active',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_existing_active',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const token = await createTestSession(user.id);
      const res = await fetch(`${serverUrl}/api/billing/fix-package/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `aidiscost_session=${token}`,
        },
        body: JSON.stringify({ finding_id: findingId }),
      });

      assert.strictEqual(res.status, 409);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'ALREADY_ENTITLED');
    });
  });

  // =========================================================================
  // SECTION 4: WEBHOOK PROCESSING & IDEMPOTENCY (Phase C & H.4)
  // =========================================================================
  describe('4. Webhook Processing, Concurrency & Idempotency', () => {
    test('4.1. order_created creates active entitlement and records processed webhook', async () => {
      const user: User = {
        id: 'usr_webhook_create_1',
        email: 'webhook_create1@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);

      const findingId = 'finding_webhook_1';
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_create_order_100',
          custom_data: {
            user_id: user.id,
            finding_id: findingId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'ord_ls_100',
          attributes: {
            status: 'paid',
            first_order_item: { variant_id: testVariantId },
          },
        },
      };

      const payloadString = JSON.stringify(payload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(payloadString),
        },
        body: payloadString,
      });

      assert.strictEqual(res.status, 200);
      const body: any = await res.json();
      assert.strictEqual(body.status, 'SUCCESS');

      // Verify entitlement was created
      assert.strictEqual(await memoryStorage.hasActivePaidEntitlement(user.id, findingId), true);
      const ent = await memoryStorage.getEntitlement(user.id, findingId);
      assert.ok(ent);
      assert.strictEqual(ent.status, 'ACTIVE');
      assert.strictEqual(ent.amount_usd, 49.0);
      assert.strictEqual(ent.provider_transaction_id, 'ord_ls_100');
    });

    test('4.2. Duplicate webhook with same event_id is recognized idempotently without duplicate grants', async () => {
      const user: User = {
        id: 'usr_dup_evt_1',
        email: 'dup_evt1@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const findingId = 'finding_dup_evt_1';
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_replay_999',
          custom_data: {
            user_id: user.id,
            finding_id: findingId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'ord_ls_dup_999',
          attributes: {
            status: 'paid',
            first_order_item: { variant_id: testVariantId },
          },
        },
      };

      const payloadString = JSON.stringify(payload);
      const sig = signPayload(payloadString);

      // First delivery: returns SUCCESS
      const res1 = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': sig },
        body: payloadString,
      });
      assert.strictEqual(res1.status, 200);
      const body1: any = await res1.json();
      assert.strictEqual(body1.status, 'SUCCESS');

      // Second delivery: returns IDEMPOTENT_DUPLICATE
      const res2 = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': sig },
        body: payloadString,
      });
      assert.strictEqual(res2.status, 200);
      const body2: any = await res2.json();
      assert.strictEqual(body2.status, 'IDEMPOTENT_DUPLICATE');
    });

    test('4.3. Concurrent identical webhooks (Sequence C) grant exactly one entitlement', async () => {
      const user: User = {
        id: 'usr_concurrent_1',
        email: 'concurrent1@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const findingId = 'finding_concurrent_1';
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_concurrent_seq_c',
          custom_data: {
            user_id: user.id,
            finding_id: findingId,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'ord_concurrent_seq_c',
          attributes: {
            status: 'paid',
            first_order_item: { variant_id: testVariantId },
          },
        },
      };

      const payloadString = JSON.stringify(payload);
      const sig = signPayload(payloadString);

      // Send both simultaneously
      const [res1, res2] = await Promise.all([
        fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-signature': sig },
          body: payloadString,
        }),
        fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-signature': sig },
          body: payloadString,
        }),
      ]);

      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res2.status, 200);

      const b1: any = await res1.json();
      const b2: any = await res2.json();

      const statuses = [b1.status, b2.status].sort();
      // One must be SUCCESS and the other IDEMPOTENT_DUPLICATE
      assert.deepStrictEqual(statuses, ['IDEMPOTENT_DUPLICATE', 'SUCCESS']);

      // Entitlement must be active and valid
      assert.strictEqual(await memoryStorage.hasActivePaidEntitlement(user.id, findingId), true);
    });

    test('4.4. Webhook fails closed if finding does not belong to the user', async () => {
      const userA: User = {
        id: 'usr_owner_A',
        email: 'ownerA@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const userB: User = {
        id: 'usr_owner_B',
        email: 'ownerB@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(userA);
      await memoryStorage.createUser(userB);

      const findingOwnedByA = 'finding_owned_by_A';
      await memoryStorage.registerFindingOwnership(findingOwnedByA, userA.id);

      // Webhook payload claims userB is paying for userA's finding
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_hijack_attempt',
          custom_data: {
            user_id: userB.id,
            finding_id: findingOwnedByA,
            product: 'FIX_PACKAGE',
          },
        },
        data: {
          id: 'ord_hijack',
          attributes: {
            status: 'paid',
            first_order_item: { variant_id: testVariantId },
          },
        },
      };

      const payloadString = JSON.stringify(payload);
      const res = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signPayload(payloadString),
        },
        body: payloadString,
      });

      assert.strictEqual(res.status, 403);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'FINDING_OWNERSHIP_MISMATCH');

      // User B must NOT have entitlement
      assert.strictEqual(await memoryStorage.hasActivePaidEntitlement(userB.id, findingOwnedByA), false);
    });
  });

  // =========================================================================
  // SECTION 5: EVENT ORDERING MATRIX (Phase F)
  // =========================================================================
  describe('5. Complete Event Ordering Matrix (Sequences A through I)', () => {
    test('Sequence A: order_created -> order_refunded revokes entitlement', async () => {
      const user: User = {
        id: 'usr_seq_a',
        email: 'seq_a@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const findingId = 'finding_seq_a';
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      // 1. order_created
      const createPayload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_seq_a_created',
          custom_data: { user_id: user.id, finding_id: findingId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: 'ord_seq_a',
          attributes: { status: 'paid', first_order_item: { variant_id: testVariantId } },
        },
      };
      const cStr = JSON.stringify(createPayload);
      const resCreate = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(cStr) },
        body: cStr,
      });
      assert.strictEqual(resCreate.status, 200);
      assert.strictEqual(await memoryStorage.hasActivePaidEntitlement(user.id, findingId), true);

      // 2. order_refunded
      const refundPayload = {
        meta: {
          event_name: 'order_refunded',
          event_id: 'evt_seq_a_refunded',
          custom_data: { user_id: user.id, finding_id: findingId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: 'ord_seq_a',
          attributes: {
            status: 'refunded',
            refunded: true,
            total: 4900,
            refunded_amount: 4900,
            first_order_item: { variant_id: testVariantId },
          },
        },
      };
      const rStr = JSON.stringify(refundPayload);
      const resRefund = await fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(rStr) },
        body: rStr,
      });
      assert.strictEqual(resRefund.status, 200);

      // Entitlement is revoked
      assert.strictEqual(await memoryStorage.hasActivePaidEntitlement(user.id, findingId), false);
      const ent = await memoryStorage.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'REVOKED');
    });

    test('Sequence D: concurrent order_refunded + order_refunded handles exactly one revocation', async () => {
      const user: User = {
        id: 'usr_seq_d',
        email: 'seq_d@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const findingId = 'finding_seq_d';
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      await memoryStorage.createEntitlement({
        id: 'ent_seq_d',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_seq_d',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const refundPayload = {
        meta: {
          event_name: 'order_refunded',
          event_id: 'evt_seq_d_dup',
          custom_data: { user_id: user.id, finding_id: findingId, product: 'FIX_PACKAGE' },
        },
        data: {
          id: 'ord_seq_d',
          attributes: {
            status: 'refunded',
            refunded: true,
            total: 4900,
            refunded_amount: 4900,
            first_order_item: { variant_id: testVariantId },
          },
        },
      };

      const rStr = JSON.stringify(refundPayload);
      const sig = signPayload(rStr);

      const [res1, res2] = await Promise.all([
        fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-signature': sig },
          body: rStr,
        }),
        fetch(`${serverUrl}/api/webhooks/lemon-squeezy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-signature': sig },
          body: rStr,
        }),
      ]);

      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res2.status, 200);

      const b1: any = await res1.json();
      const b2: any = await res2.json();

      const statuses = [b1.status, b2.status].sort();
      assert.deepStrictEqual(statuses, ['IDEMPOTENT_DUPLICATE', 'SUCCESS']);

      const ent = await memoryStorage.getEntitlement(user.id, findingId);
      assert.strictEqual(ent?.status, 'REVOKED');
    });

    test('Sequence F: order_created -> order_refunded -> delayed duplicate order_created remains REVOKED (Monotonic Guard)', async () => {
      const user: User = {
        id: 'usr_seq_f',
        email: 'seq_f@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const findingId = 'finding_seq_f';
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      const orderId = 'ord_seq_f_monotonic';

      // 1. Initial order_created
      await memoryStorage.createEntitlement({
        id: 'ent_seq_f',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: orderId,
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // 2. Refund revokes it
      const refundEvent = {
        event_id: 'evt_seq_f_ref',
        provider: 'LEMON_SQUEEZY' as const,
        event_name: 'order_refunded',
        user_id: user.id,
        finding_id: findingId,
        order_id: orderId,
        processed_at: new Date().toISOString(),
      };
      const refRes = await memoryStorage.processOrderRefundedWebhookTransaction({
        event: refundEvent,
        userId: user.id,
        findingId,
        orderId,
      });
      assert.strictEqual(refRes.status, 'SUCCESS');
      assert.strictEqual(refRes.entitlement?.status, 'REVOKED');

      // 3. Delayed order_created with a NEW event_id arrives for the same refunded orderId
      const delayedEvent = {
        event_id: 'evt_seq_f_delayed_created',
        provider: 'LEMON_SQUEEZY' as const,
        event_name: 'order_created',
        user_id: user.id,
        finding_id: findingId,
        order_id: orderId,
        processed_at: new Date().toISOString(),
      };
      const delayedEntitlement: Entitlement = {
        id: 'ent_seq_f_delayed',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: orderId,
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const delayedRes = await memoryStorage.processOrderCreatedWebhookTransaction({
        event: delayedEvent,
        entitlement: delayedEntitlement,
      });

      // Monotonic guard acknowledges successfully without reactivating
      assert.strictEqual(delayedRes.status, 'SUCCESS');

      // Invariant: Entitlement must REMAIN REVOKED, never reactivated!
      const currentEnt = await memoryStorage.getEntitlement(user.id, findingId);
      assert.ok(currentEnt);
      assert.strictEqual(currentEnt.status, 'REVOKED');
      assert.strictEqual(await memoryStorage.hasActivePaidEntitlement(user.id, findingId), false);
    });

    test('Sequence G: Outcome Fee before Fix Package (independent commercial flows)', async () => {
      const user: User = {
        id: 'usr_seq_g',
        email: 'seq_g@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const findingId = 'finding_seq_g';
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      // Outcome Fee obligation exists and gets settled
      const obligation: OutcomeFeeObligation = {
        id: 'of_seq_g',
        user_id: user.id,
        finding_id: findingId,
        verification_id: 'ver_seq_g',
        verified_annualized_savings_usd: 12000,
        fee_amount_usd: 2400,
        currency: 'USD',
        status: 'PAID',
        provider: 'LEMON_SQUEEZY',
        provider_order_id: 'ord_seq_g_of',
        provider_transaction_id: 'ord_seq_g_of',
        paid_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createOutcomeFeeObligation(obligation);

      // Fix package has not been paid
      assert.strictEqual(await memoryStorage.hasActivePaidEntitlement(user.id, findingId), false);
      // Outcome fee is paid
      assert.strictEqual(await memoryStorage.hasPaidOutcomeFee(user.id, findingId), true);

      // Later, Fix Package is purchased
      const fixEntitlement: Entitlement = {
        id: 'ent_seq_g',
        user_id: user.id,
        finding_id: findingId,
        type: 'PAID_FIX_PACKAGE',
        status: 'ACTIVE',
        provider: 'LEMON_SQUEEZY',
        provider_transaction_id: 'ord_seq_g_fix',
        amount_usd: 49.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createEntitlement(fixEntitlement);

      // Both are active and distinct
      assert.strictEqual(await memoryStorage.hasActivePaidEntitlement(user.id, findingId), true);
      assert.strictEqual(await memoryStorage.hasPaidOutcomeFee(user.id, findingId), true);
    });

    test('Sequence H: Out-of-order Outcome Fee rejected if verification not completed', async () => {
      const user: User = {
        id: 'usr_seq_h',
        email: 'seq_h@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const findingId = 'finding_seq_h';
      await seedTestAuditAndFinding(user.id, findingId);
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      // Verification is still in observation / not completed
      const nonAuthVerification: AuthoritativeVerification = {
        id: 'ver_seq_h',
        finding_id: findingId,
        user_id: user.id,
        stage: 'OBSERVATION_ACTIVE',
        is_authoritative: false,
        is_simulated: false,
        baseline_start: '2026-01-01',
        baseline_end: '2026-01-15',
        baseline_sample_count: 50,
        baseline_avg_cost_usd: 1.0,
        observation_sample_count: 50,
        post_avg_cost_usd: 0.8,
        observed_reduction_pct: 20,
        verified_annualized_savings_usd: 2000,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.saveVerification(nonAuthVerification);

      const token = await createTestSession(user.id);

      // Client attempts to create Outcome Fee obligation before verification is authoritative
      const res = await fetch(`${serverUrl}/api/findings/${findingId}/outcome-fee`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `aidiscost_session=${token}`,
        },
        body: JSON.stringify({}),
      });

      assert.strictEqual(res.status, 400);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'VERIFICATION_NOT_AUTHORITATIVE');
    });
  });

  // =========================================================================
  // SECTION 6: OUTCOME FEE LIFECYCLE & PROTECTION RULES (Phase D & H.5)
  // =========================================================================
  describe('6. Outcome Fee 20% Calculation, 1-Month Cap & 50% Protection Clause', () => {
    test('6.1. Canonical Outcome Fee: 20% of verified annualized savings, capped at 1 month', async () => {
      const user: User = {
        id: 'usr_fee_calc_1',
        email: 'feecalc1@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const findingId = 'finding_fee_calc_1';
      await seedTestAuditAndFinding(user.id, findingId, undefined, 10000);
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      // 10,000 verified savings, original estimate 10,000
      // 20% = 2,000; 1 month cap = 10,000 / 12 = 833.33; final fee = 833.33
      const verification: AuthoritativeVerification = {
        id: 'ver_fee_1',
        finding_id: findingId,
        user_id: user.id,
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-01-01',
        baseline_end: '2026-01-15',
        baseline_sample_count: 100,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 50,
        post_avg_cost_usd: 1.0,
        observed_reduction_pct: 50,
        verified_annualized_savings_usd: 10000,
        original_estimated_annualized_usd: 10000,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.saveVerification(verification);

      const token = await createTestSession(user.id);
      const res = await fetch(`${serverUrl}/api/findings/${findingId}/outcome-fee`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `aidiscost_session=${token}`,
        },
        body: JSON.stringify({}),
      });

      assert.strictEqual(res.status, 201);
      const body: any = await res.json();
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.obligation.fee_amount_usd, 833.33);
      assert.strictEqual(body.obligation.status, 'PAYABLE');
    });

    test('6.2. 50% Protection Clause: If verified savings < 50% of original estimate, fee is waived ($0)', async () => {
      const user: User = {
        id: 'usr_fee_prot_2',
        email: 'feeprot2@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const findingId = 'finding_fee_prot_2';
      await seedTestAuditAndFinding(user.id, findingId, undefined, 10000);
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      // Original estimate was 10,000, but verified savings is only 4,000 (40% < 50%)
      const verification: AuthoritativeVerification = {
        id: 'ver_fee_prot_2',
        finding_id: findingId,
        user_id: user.id,
        stage: 'VERIFIED_RESULT',
        is_authoritative: true,
        is_simulated: false,
        baseline_start: '2026-01-01',
        baseline_end: '2026-01-15',
        baseline_sample_count: 100,
        baseline_avg_cost_usd: 2.0,
        observation_sample_count: 50,
        post_avg_cost_usd: 1.6,
        observed_reduction_pct: 20,
        verified_annualized_savings_usd: 4000,
        original_estimated_annualized_usd: 10000,
        verification_confidence: 'HIGH',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.saveVerification(verification);

      const token = await createTestSession(user.id);
      const res = await fetch(`${serverUrl}/api/findings/${findingId}/outcome-fee`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `aidiscost_session=${token}`,
        },
        body: JSON.stringify({}),
      });

      assert.strictEqual(res.status, 400);
      const body: any = await res.json();
      assert.strictEqual(body.error, 'OUTCOME_FEE_NOT_PAYABLE');
      assert.strictEqual(body.calculation.protectionTriggered, true);
      assert.strictEqual(body.calculation.finalOutcomeFeeUsd, 0);
    });

    test('6.3. Outcome Fee variant must not match Fix Package variant', async () => {
      const user: User = {
        id: 'usr_var_collision',
        email: 'varcol@example.com',
        password_hash: 'salt:hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createUser(user);
      const findingId = 'finding_var_collision';
      await memoryStorage.registerFindingOwnership(findingId, user.id);

      // Obligation with $1,000 fee
      const ob: OutcomeFeeObligation = {
        id: 'of_var_collision',
        user_id: user.id,
        finding_id: findingId,
        verification_id: 'ver_var_col',
        verified_annualized_savings_usd: 5000,
        fee_amount_usd: 1000,
        currency: 'USD',
        provider: 'LEMON_SQUEEZY',
        status: 'PAYABLE',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await memoryStorage.createOutcomeFeeObligation(ob);

      // Webhook for Outcome Fee arriving with Fix Package variant must be strictly rejected
      const payload = {
        meta: {
          event_name: 'order_created',
          event_id: 'evt_outcome_var_collide',
          custom_data: {
            user_id: user.id,
            finding_id: findingId,
            product: 'OUTCOME_FEE',
          },
        },
        data: {
          id: 'ord_var_collide',
          attributes: {
            status: 'paid',
            // Uses Fix Package variant instead of Outcome Fee variant!
            first_order_item: { variant_id: testVariantId },
          },
        },
      };

      const payloadString = JSON.stringify(payload);
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
      assert.strictEqual(body.error, 'WRONG_VARIANT');
    });
  });
});
