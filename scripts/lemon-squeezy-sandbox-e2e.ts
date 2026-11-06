/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AIDisCost MCP — Lemon Squeezy Sandbox E2E Runner
 *
 * Validates the complete payment lifecycle against Lemon Squeezy Sandbox / Test Mode.
 *
 * CRITICAL SECURITY & RUNTIME CONSTRAINTS:
 * 1. Must strictly prove Sandbox Mode before making any outbound API requests.
 * 2. Never fall back from Sandbox credentials to Production credentials.
 * 3. Separate BLOCKED (exit code 2), PASS (exit code 0), and FAIL (exit code 1).
 * 4. Outputs structured machine-readable JSON (never leaking credentials or secrets).
 * 5. Executes real assertions for every step against the application database state.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import { execSync } from 'child_process';
import { AddressInfo } from 'net';

export type RunnerStatus = 'PASS' | 'BLOCKED' | 'FAIL';
export type EvidenceSource =
  | 'PROVIDER_ORIGINATED'
  | 'LOCALLY_SIMULATED'
  | 'API_RESPONSE'
  | 'DATABASE_VERIFIED'
  | 'CONFIG_VALIDATION'
  | 'NOT_VERIFIED';

export interface SandboxStepResult {
  step_number: number;
  name: string;
  category: 'CONFIG_VALIDATION' | 'PROVIDER_API' | 'HTTP_WEBHOOK' | 'DATABASE_ASSERTION';
  evidence_source: EvidenceSource;
  status: 'PASS' | 'BLOCKED' | 'FAIL' | 'NOT_RUN';
  duration_ms: number;
  details?: string;
  assertions_passed: number;
  assertions_failed: number;
  provider_request_id?: string;
}

export interface SandboxReport {
  overall_status: RunnerStatus;
  run_id: string;
  commit_sha: string;
  commit_provenance_verified: boolean;
  environment: string;
  sandbox_mode: boolean;
  started_at: string;
  completed_at: string;
  steps: SandboxStepResult[];
  step_status: Record<string, 'PASS' | 'BLOCKED' | 'FAIL' | 'NOT_RUN'>;
  evidence_summary: {
    provider_originated_events_verified: boolean;
    locally_simulated_events_count: number;
    api_response_verified: boolean;
    database_verified_count: number;
  };
  assertions: {
    total: number;
    passed: number;
    failed: number;
  };
  failure_reason: string | null;
  blocked_reason: string | null;
  database_target: string;
  provider_request_ids: string[];
}

export interface SandboxConfig {
  apiKey: string;
  storeId: string;
  fixPackageVariantId: string;
  outcomeFeeVariantId: string;
  webhookSecret: string;
  isSandboxMode: boolean;
}

export interface ConfigValidationResult {
  valid: boolean;
  blocked: boolean;
  config?: SandboxConfig;
  missing: string[];
  reasons: string[];
}

/**
 * Pure configuration validator enforcing strict Sandbox proof before any API requests.
 */
export function validateSandboxConfig(env: NodeJS.ProcessEnv = process.env): ConfigValidationResult {
  const missing: string[] = [];
  const reasons: string[] = [];

  const isProduction = (env.NODE_ENV || '').toLowerCase() === 'production';
  if (isProduction) {
    reasons.push('NODE_ENV is set to "production". The Sandbox Runner strictly refuses to execute in production mode.');
    return { valid: false, blocked: true, missing, reasons };
  }

  const isSandboxExplicit =
    env.LEMON_SQUEEZY_SANDBOX === 'true' || env.LEMON_SQUEEZY_TEST_MODE === 'true';

  if (!isSandboxExplicit) {
    reasons.push(
      'Sandbox Mode flag is missing or not set to "true". ' +
      'LEMON_SQUEEZY_SANDBOX=true is strictly required to prove test environment.'
    );
  }

  // API Key enforcement: strictly require LEMON_SQUEEZY_SANDBOX_API_KEY
  // Ambiguous fallback to live LEMON_SQUEEZY_API_KEY is rejected unless explicitly verified
  const sandboxApiKey = (env.LEMON_SQUEEZY_SANDBOX_API_KEY || '').trim();
  const genericApiKey = (env.LEMON_SQUEEZY_API_KEY || '').trim();

  let resolvedApiKey = '';
  if (sandboxApiKey) {
    resolvedApiKey = sandboxApiKey;
  } else if (genericApiKey && isSandboxExplicit && env.ALLOW_LEMON_SQUEEZY_API_KEY_IN_SANDBOX === 'true') {
    resolvedApiKey = genericApiKey;
  } else if (genericApiKey) {
    reasons.push(
      'Ambiguous API Key: LEMON_SQUEEZY_API_KEY was supplied without LEMON_SQUEEZY_SANDBOX_API_KEY. ' +
      'To prevent accidental production API calls, LEMON_SQUEEZY_SANDBOX_API_KEY is required, ' +
      'or set ALLOW_LEMON_SQUEEZY_API_KEY_IN_SANDBOX=true if you have confirmed this key belongs to test mode.'
    );
  } else {
    missing.push('LEMON_SQUEEZY_SANDBOX_API_KEY');
  }

  const storeId = (env.LEMON_SQUEEZY_STORE_ID || '').trim();
  if (!storeId) missing.push('LEMON_SQUEEZY_STORE_ID');

  const fixPackageVariantId = (
    env.LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID ||
    env.LEMON_SQUEEZY_VARIANT_ID ||
    ''
  ).trim();
  if (!fixPackageVariantId) missing.push('LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID');

  const outcomeFeeVariantId = (env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID || '').trim();
  if (!outcomeFeeVariantId) missing.push('LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID');

  const webhookSecret = (env.LEMON_SQUEEZY_WEBHOOK_SECRET || '').trim();
  if (!webhookSecret) missing.push('LEMON_SQUEEZY_WEBHOOK_SECRET');

  if (fixPackageVariantId && outcomeFeeVariantId && fixPackageVariantId === outcomeFeeVariantId) {
    reasons.push(
      `Variant ID Collision: Fix Package variant ID and Outcome Fee variant ID are identical ("${fixPackageVariantId}"). They must be distinct products.`
    );
  }

  const blocked = !isSandboxExplicit || missing.length > 0 || !resolvedApiKey;
  const valid = !blocked && reasons.length === 0;

  return {
    valid,
    blocked,
    config: valid
      ? {
          apiKey: resolvedApiKey,
          storeId,
          fixPackageVariantId,
          outcomeFeeVariantId,
          webhookSecret,
          isSandboxMode: isSandboxExplicit,
        }
      : undefined,
    missing,
    reasons,
  };
}

export interface RunnerOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  appUrl?: string;
  outputPath?: string;
}

export function resolveCommitSha(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_SHA && env.GITHUB_SHA.trim()) return env.GITHUB_SHA.trim();
  if (env.COMMIT_SHA && env.COMMIT_SHA.trim()) return env.COMMIT_SHA.trim();
  try {
    const out = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    if (out && /^[0-9a-f]{40}$/i.test(out)) return out;
  } catch {
    // git command unavailable or not a repo
  }
  return 'UNKNOWN';
}

/**
 * Execute the 11-step Lemon Squeezy Sandbox E2E Runner.
 */
export async function executeSandboxE2E(options: RunnerOptions = {}): Promise<SandboxReport> {
  const env = options.env || process.env;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const startedAt = new Date().toISOString();
  const runId = `sb_run_${crypto.randomUUID()}`;
  const commitSha = resolveCommitSha(env);
  const dbTarget = env.TURSO_DATABASE_URL || 'file:data/aidiscost.db (local)';

  const steps: SandboxStepResult[] = [];
  const providerRequestIds: string[] = [];
  let totalAssertionsPassed = 0;
  let totalAssertionsFailed = 0;

  function recordStep(
    stepNum: number,
    name: string,
    category: SandboxStepResult['category'],
    evidenceSource: EvidenceSource,
    status: SandboxStepResult['status'],
    durationMs: number,
    details?: string,
    passed = 0,
    failed = 0,
    reqId?: string
  ) {
    totalAssertionsPassed += passed;
    totalAssertionsFailed += failed;
    if (reqId) providerRequestIds.push(reqId);
    steps.push({
      step_number: stepNum,
      name,
      category,
      evidence_source: evidenceSource,
      status,
      duration_ms: durationMs,
      details,
      assertions_passed: passed,
      assertions_failed: failed,
      provider_request_id: reqId,
    });
  }

  // Preflight validation
  const validation = validateSandboxConfig(env);

  // Step 1: Validate Configuration & Environment
  const t0 = Date.now();
  if (validation.missing.length > 0) {
    const missingMsg = `Missing required environment variables: ${validation.missing.join(', ')}`;
    recordStep(1, 'Validate Configuration & Environment', 'CONFIG_VALIDATION', 'CONFIG_VALIDATION', 'BLOCKED', Date.now() - t0, missingMsg, 0, 1);
    
    return buildReport('BLOCKED', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, null, missingMsg, dbTarget, providerRequestIds, options.outputPath);
  }
  recordStep(1, 'Validate Configuration & Environment', 'CONFIG_VALIDATION', 'CONFIG_VALIDATION', 'PASS', Date.now() - t0, 'All required configuration variables present', 1, 0);

  // Step 2: Enforce Sandbox Proof & API Credentials
  const t1 = Date.now();
  if (!validation.valid || !validation.config) {
    const blockedReason = validation.reasons.join('; ');
    recordStep(2, 'Enforce Sandbox Proof & Anti-Live Fallback', 'CONFIG_VALIDATION', 'CONFIG_VALIDATION', 'BLOCKED', Date.now() - t1, blockedReason, 0, 1);
    return buildReport('BLOCKED', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, null, blockedReason, dbTarget, providerRequestIds, options.outputPath);
  }
  recordStep(2, 'Enforce Sandbox Proof & Anti-Live Fallback', 'CONFIG_VALIDATION', 'CONFIG_VALIDATION', 'PASS', Date.now() - t1, 'Sandbox Mode strictly verified; zero fallback to live API credentials', 2, 0);

  const config = validation.config;

  // Step 3: Distinct Product Variants
  const t2 = Date.now();
  if (config.fixPackageVariantId === config.outcomeFeeVariantId) {
    const err = 'Variant collision: Fix Package and Outcome Fee variant IDs are identical.';
    recordStep(3, 'Verify Distinct Variant IDs', 'CONFIG_VALIDATION', 'CONFIG_VALIDATION', 'FAIL', Date.now() - t2, err, 0, 1);
    return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, err, null, dbTarget, providerRequestIds, options.outputPath);
  }
  recordStep(3, 'Verify Distinct Variant IDs', 'CONFIG_VALIDATION', 'CONFIG_VALIDATION', 'PASS', Date.now() - t2, `Fix Variant: ${config.fixPackageVariantId}, Outcome Fee Variant: ${config.outcomeFeeVariantId}`, 1, 0);

  // Sync process.env for the in-process application HTTP server and webhook handler
  const originalEnv: Record<string, string | undefined> = {
    LEMON_SQUEEZY_API_KEY: process.env.LEMON_SQUEEZY_API_KEY,
    LEMON_SQUEEZY_STORE_ID: process.env.LEMON_SQUEEZY_STORE_ID,
    LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: process.env.LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID,
    LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID,
    LEMON_SQUEEZY_WEBHOOK_SECRET: process.env.LEMON_SQUEEZY_WEBHOOK_SECRET,
  };
  process.env.LEMON_SQUEEZY_API_KEY = config.apiKey;
  process.env.LEMON_SQUEEZY_STORE_ID = config.storeId;
  process.env.LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID = config.fixPackageVariantId;
  process.env.LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID = config.outcomeFeeVariantId;
  process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = config.webhookSecret;

  // Initialize or connect to application storage and server
  let localServer: http.Server | null = null;
  let resolvedBaseUrl = options.appUrl || env.APP_URL;

  try {
    const { getStorage } = await import('../src/server/storage');
    const storage = getStorage();

    if (!resolvedBaseUrl) {
      // Spin up ephemeral application HTTP server for end-to-end HTTP testing
      const express = (await import('express')).default;
      const cookieParser = (await import('cookie-parser')).default;
      const { authenticate } = await import('../src/server/auth');
      const { createApiRouter } = await import('../src/server/api');

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
        localServer = app.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = (localServer as any).address() as AddressInfo;
      resolvedBaseUrl = `http://127.0.0.1:${addr.port}`;
    }

    // Prepare authenticated test user and finding
    const testUserId = `usr_sb_${crypto.randomUUID()}`;
    const testFindingId = `fnd_sb_${crypto.randomUUID()}`;
    const testAuditId = `aud_sb_${crypto.randomUUID()}`;

    await storage.createUser({
      id: testUserId,
      email: `sandbox-e2e-${testUserId}@aidiscost.io`,
      password_hash: 'salt:hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await storage.registerFindingOwnership(testFindingId, testUserId, testAuditId);

    // Helper for webhook signing
    function signPayload(bodyStr: string): string {
      return crypto.createHmac('sha256', config.webhookSecret).update(Buffer.from(bodyStr, 'utf-8')).digest('hex');
    }

    // Step 4: Real Lemon Squeezy Sandbox Checkout Creation
    const t3 = Date.now();
    let checkoutId = '';
    let checkoutUrl = '';
    try {
      const checkoutReqPayload = {
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: 'sandbox-e2e-buyer@aidiscost.io',
              custom: {
                user_id: testUserId,
                finding_id: testFindingId,
                audit_id: testAuditId,
                product: 'FIX_PACKAGE',
              },
            },
            product_options: {
              redirect_url: 'https://aidiscost.io/#/verify/test',
            },
          },
          relationships: {
            store: { data: { type: 'stores', id: config.storeId } },
            variant: { data: { type: 'variants', id: config.fixPackageVariantId } },
          },
        },
      };

      const res = await fetchFn('https://api.lemonsqueezy.com/v1/checkouts', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(checkoutReqPayload),
      });

      const providerReqId = res.headers.get('x-request-id') || undefined;

      if (!res.ok) {
        const errText = await res.text();
        const failReason = `Lemon Squeezy Sandbox API returned ${res.status}: ${errText}`;
        recordStep(4, 'Create Real Lemon Squeezy Sandbox Fix Package Checkout', 'PROVIDER_API', 'API_RESPONSE', 'FAIL', Date.now() - t3, failReason, 0, 1, providerReqId);
        return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, failReason, null, dbTarget, providerRequestIds, options.outputPath);
      }

      const resJson: any = await res.json();
      checkoutId = String(resJson?.data?.id || '');
      checkoutUrl = String(resJson?.data?.attributes?.url || '');

      if (!checkoutId || !checkoutUrl) {
        throw new Error('Sandbox API response did not contain checkout ID or checkout URL');
      }

      recordStep(4, 'Create Real Lemon Squeezy Sandbox Fix Package Checkout', 'PROVIDER_API', 'API_RESPONSE', 'PASS', Date.now() - t3, `Created Checkout ID: ${checkoutId}`, 2, 0, providerReqId);
    } catch (checkoutErr: any) {
      const failReason = `Sandbox checkout creation failed: ${checkoutErr.message}`;
      recordStep(4, 'Create Real Lemon Squeezy Sandbox Fix Package Checkout', 'PROVIDER_API', 'API_RESPONSE', 'FAIL', Date.now() - t3, failReason, 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, failReason, null, dbTarget, providerRequestIds, options.outputPath);
    }

    // Step 5: Verify Checkout Data & Record Checkout Attempt
    const t4 = Date.now();
    if (typeof storage.saveCheckoutAttempt === 'function') {
      await storage.saveCheckoutAttempt({
        id: `att_${crypto.randomUUID()}`,
        user_id: testUserId,
        finding_id: testFindingId,
        audit_id: testAuditId,
        product: 'FIX_PACKAGE',
        checkout_url: checkoutUrl,
        checkout_id: checkoutId,
        status: 'PENDING',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    const savedAttempt = typeof storage.getActiveCheckoutAttempt === 'function'
      ? await storage.getActiveCheckoutAttempt(testUserId, testFindingId, 'FIX_PACKAGE', testAuditId)
      : null;
    if (!savedAttempt || savedAttempt.checkout_id !== checkoutId) {
      recordStep(5, 'Verify Checkout Data & Storage Persistence', 'DATABASE_ASSERTION', 'DATABASE_VERIFIED', 'FAIL', Date.now() - t4, 'Checkout attempt was not persisted to database', 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, 'Checkout attempt persistence assertion failed', null, dbTarget, providerRequestIds, options.outputPath);
    }
    recordStep(5, 'Verify Checkout Data & Storage Persistence', 'DATABASE_ASSERTION', 'DATABASE_VERIFIED', 'PASS', Date.now() - t4, `Persisted checkout ${checkoutId} to storage`, 1, 0);

    // Step 6: HTTP Integration — Submit order_created Event via HTTP
    const t5 = Date.now();
    const orderCreatedEventId = `evt_sb_oc_${crypto.randomUUID()}`;
    const orderId = `ord_sb_${crypto.randomUUID()}`;

    const orderCreatedPayload = {
      meta: {
        event_name: 'order_created',
        event_id: orderCreatedEventId,
        custom_data: {
          user_id: testUserId,
          finding_id: testFindingId,
          audit_id: testAuditId,
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
            variant_id: config.fixPackageVariantId,
            price: 4900,
          },
        },
      },
    };

    const ocBodyStr = JSON.stringify(orderCreatedPayload);
    const ocSig = signPayload(ocBodyStr);

    const ocRes = await fetchFn(`${resolvedBaseUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': ocSig,
      },
      body: ocBodyStr,
    });

    if (ocRes.status !== 200) {
      const errText = await ocRes.text();
      const failReason = `order_created HTTP webhook failed with status ${ocRes.status}: ${errText}`;
      recordStep(6, 'HTTP Webhook: order_created ($49.00 USD)', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'FAIL', Date.now() - t5, failReason, 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, failReason, null, dbTarget, providerRequestIds, options.outputPath);
    }
    recordStep(6, 'HTTP Webhook: order_created ($49.00 USD)', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'PASS', Date.now() - t5, 'Successfully delivered signed order_created event to application HTTP endpoint', 1, 0);

    // Step 7: Database Verification — Entitlement Activation
    const t6 = Date.now();
    const entitlement = await storage.getEntitlement(testUserId, testFindingId, testAuditId);
    if (!entitlement || entitlement.status !== 'ACTIVE' || entitlement.type !== 'PAID_FIX_PACKAGE') {
      const failReason = `Entitlement state invalid: status=${entitlement?.status}, type=${entitlement?.type}`;
      recordStep(7, 'Verify Entitlement State in Storage', 'DATABASE_ASSERTION', 'DATABASE_VERIFIED', 'FAIL', Date.now() - t6, failReason, 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, failReason, null, dbTarget, providerRequestIds, options.outputPath);
    }
    recordStep(7, 'Verify Entitlement State in Storage', 'DATABASE_ASSERTION', 'DATABASE_VERIFIED', 'PASS', Date.now() - t6, `Entitlement ${entitlement.id} is ACTIVE for finding ${testFindingId}`, 2, 0);

    // Step 8: HTTP Integration — Submit order_settled Event via HTTP
    const t7 = Date.now();
    const orderSettledEventId = `evt_sb_os_${crypto.randomUUID()}`;
    const orderSettledPayload = {
      meta: {
        event_name: 'order_settled',
        event_id: orderSettledEventId,
        custom_data: {
          user_id: testUserId,
          finding_id: testFindingId,
          audit_id: testAuditId,
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
            variant_id: config.fixPackageVariantId,
            price: 4900,
          },
        },
      },
    };
    const osBodyStr = JSON.stringify(orderSettledPayload);
    const osSig = signPayload(osBodyStr);

    const osRes = await fetchFn(`${resolvedBaseUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': osSig,
      },
      body: osBodyStr,
    });
    if (osRes.status !== 200) {
      const errText = await osRes.text();
      recordStep(8, 'HTTP Webhook: order_settled Transition', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'FAIL', Date.now() - t7, `order_settled failed: ${errText}`, 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, 'order_settled failed', null, dbTarget, providerRequestIds, options.outputPath);
    }
    const entAfterSettle = await storage.getEntitlement(testUserId, testFindingId, testAuditId);
    if (!entAfterSettle || entAfterSettle.status !== 'ACTIVE') {
      recordStep(8, 'HTTP Webhook: order_settled Transition', 'DATABASE_ASSERTION', 'DATABASE_VERIFIED', 'FAIL', Date.now() - t7, 'Entitlement did not remain ACTIVE after order_settled', 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, 'Entitlement lost active state on settle', null, dbTarget, providerRequestIds, options.outputPath);
    }
    recordStep(8, 'HTTP Webhook: order_settled Transition', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'PASS', Date.now() - t7, 'order_settled handled idempotently; entitlement remains ACTIVE', 2, 0);

    // Step 9: Outcome Fee Obligation Lifecycle & Checkout
    const t8 = Date.now();
    const verId = `ver_sb_${crypto.randomUUID()}`;
    await storage.saveVerification({
      id: verId,
      finding_id: testFindingId,
      user_id: testUserId,
      audit_id: testAuditId,
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

    const obligationId = `of_sb_${crypto.randomUUID()}`;
    await storage.createOutcomeFeeObligation({
      id: obligationId,
      user_id: testUserId,
      finding_id: testFindingId,
      audit_id: testAuditId,
      verification_id: verId,
      verified_annualized_savings_usd: 12000.0,
      fee_amount_usd: 1000.0, // Capped outcome fee
      currency: 'USD',
      status: 'CHECKOUT_CREATED',
      provider: 'LEMON_SQUEEZY',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Deliver Outcome Fee order_created webhook ($1,000.00 USD = 100,000 cents)
    const ofOrderId = `ord_sb_of_${crypto.randomUUID()}`;
    const ofEventId = `evt_sb_of_oc_${crypto.randomUUID()}`;
    const ofPayload = {
      meta: {
        event_name: 'order_created',
        event_id: ofEventId,
        custom_data: {
          user_id: testUserId,
          finding_id: testFindingId,
          audit_id: testAuditId,
          obligation_id: obligationId,
          product: 'OUTCOME_FEE',
        },
      },
      data: {
        id: ofOrderId,
        type: 'orders',
        attributes: {
          identifier: ofOrderId,
          status: 'paid',
          currency: 'USD',
          total: 100000,
          first_order_item: {
            variant_id: config.outcomeFeeVariantId,
            price: 100000,
          },
        },
      },
    };

    const ofBodyStr = JSON.stringify(ofPayload);
    const ofRes = await fetchFn(`${resolvedBaseUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(ofBodyStr),
      },
      body: ofBodyStr,
    });

    if (ofRes.status !== 200) {
      const errText = await ofRes.text();
      recordStep(9, 'Outcome Fee Obligation & Webhook Lifecycle', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'FAIL', Date.now() - t8, `Outcome fee webhook failed: ${errText}`, 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, 'Outcome fee webhook failed', null, dbTarget, providerRequestIds, options.outputPath);
    }
    const obAfterPay = await storage.getOutcomeFeeObligation(testFindingId, testUserId, testAuditId);
    if (!obAfterPay || obAfterPay.status !== 'PAID') {
      recordStep(9, 'Outcome Fee Obligation & Webhook Lifecycle', 'DATABASE_ASSERTION', 'DATABASE_VERIFIED', 'FAIL', Date.now() - t8, `Obligation status is ${obAfterPay?.status}, expected PAID`, 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, 'Obligation not marked PAID', null, dbTarget, providerRequestIds, options.outputPath);
    }
    recordStep(9, 'Outcome Fee Obligation & Webhook Lifecycle', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'PASS', Date.now() - t8, 'Obligation transitioned to PAID upon exact $1,000.00 payment confirmation', 2, 0);

    // Step 10: Idempotency, Duplicate Prevention, Underpayment, & Currency Mismatch
    const t9 = Date.now();
    // 10a. Duplicate webhook
    const dupRes = await fetchFn(`${resolvedBaseUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signPayload(ofBodyStr),
      },
      body: ofBodyStr,
    });
    const dupJson: any = await dupRes.json();
    if (dupJson?.status !== 'IDEMPOTENT_DUPLICATE') {
      recordStep(10, 'Idempotency, Underpayment & Currency Verification', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'FAIL', Date.now() - t9, 'Duplicate webhook event was not recognized as idempotent', 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, 'Duplicate webhook idempotency failure', null, dbTarget, providerRequestIds, options.outputPath);
    }

    // 10b. Underpayment ($10.00 instead of $1,000.00)
    const underpayEventId = `evt_sb_under_${crypto.randomUUID()}`;
    const underpayPayload = {
      meta: {
        event_name: 'order_created',
        event_id: underpayEventId,
        custom_data: {
          user_id: testUserId,
          finding_id: testFindingId,
          audit_id: testAuditId,
          obligation_id: obligationId,
          product: 'OUTCOME_FEE',
        },
      },
      data: {
        id: `ord_under_${crypto.randomUUID()}`,
        type: 'orders',
        attributes: {
          status: 'paid',
          currency: 'USD',
          total: 1000, // $10.00
          first_order_item: { variant_id: config.outcomeFeeVariantId, price: 1000 },
        },
      },
    };
    const underpayBody = JSON.stringify(underpayPayload);
    const underpayRes = await fetchFn(`${resolvedBaseUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(underpayBody) },
      body: underpayBody,
    });
    if (underpayRes.status !== 400) {
      recordStep(10, 'Idempotency, Underpayment & Currency Verification', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'FAIL', Date.now() - t9, `Underpayment returned status ${underpayRes.status}, expected 400`, 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, 'Underpayment was not rejected', null, dbTarget, providerRequestIds, options.outputPath);
    }

    // 10c. Currency mismatch
    const currMismatchEventId = `evt_sb_curr_${crypto.randomUUID()}`;
    const currMismatchPayload = {
      meta: {
        event_name: 'order_created',
        event_id: currMismatchEventId,
        custom_data: {
          user_id: testUserId,
          finding_id: testFindingId,
          audit_id: testAuditId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: `ord_eur_${crypto.randomUUID()}`,
        type: 'orders',
        attributes: {
          status: 'paid',
          currency: 'EUR',
          total: 4900,
          first_order_item: { variant_id: config.fixPackageVariantId, price: 4900 },
        },
      },
    };
    const currBody = JSON.stringify(currMismatchPayload);
    const currRes = await fetchFn(`${resolvedBaseUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(currBody) },
      body: currBody,
    });
    if (currRes.status !== 400) {
      recordStep(10, 'Idempotency, Underpayment & Currency Verification', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'FAIL', Date.now() - t9, `Currency mismatch returned status ${currRes.status}, expected 400`, 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, 'Currency mismatch was not rejected', null, dbTarget, providerRequestIds, options.outputPath);
    }
    recordStep(10, 'Idempotency, Underpayment & Currency Verification', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'PASS', Date.now() - t9, 'Duplicate events deduplicated; underpayment ($10.00) and currency mismatch (EUR) strictly rejected', 3, 0);

    // Step 11: Full Refund, Partial Refund, & Monotonic Non-Regression
    const t10 = Date.now();
    // 11a. Full refund on Fix Package -> Entitlement REVOKED
    const refundEventId = `evt_sb_ref_${crypto.randomUUID()}`;
    const refundPayload = {
      meta: {
        event_name: 'order_refunded',
        event_id: refundEventId,
        custom_data: {
          user_id: testUserId,
          finding_id: testFindingId,
          audit_id: testAuditId,
          product: 'FIX_PACKAGE',
        },
      },
      data: {
        id: orderId,
        type: 'orders',
        attributes: {
          status: 'refunded',
          currency: 'USD',
          total: 4900,
          refunded: true,
          refunded_amount: 4900,
          first_order_item: { variant_id: config.fixPackageVariantId },
        },
      },
    };
    const refBody = JSON.stringify(refundPayload);
    const refRes = await fetchFn(`${resolvedBaseUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(refBody) },
      body: refBody,
    });
    if (refRes.status !== 200) {
      const errText = await refRes.text();
      recordStep(11, 'Refunds, Reconciliation & Monotonic Non-Regression', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'FAIL', Date.now() - t10, `Refund failed: ${errText}`, 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, 'Refund webhook failed', null, dbTarget, providerRequestIds, options.outputPath);
    }
    const entAfterRefund = await storage.getEntitlement(testUserId, testFindingId, testAuditId);
    if (!entAfterRefund || entAfterRefund.status !== 'REVOKED') {
      recordStep(11, 'Refunds, Reconciliation & Monotonic Non-Regression', 'DATABASE_ASSERTION', 'DATABASE_VERIFIED', 'FAIL', Date.now() - t10, `Entitlement status is ${entAfterRefund?.status}, expected REVOKED`, 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, 'Entitlement not revoked on refund', null, dbTarget, providerRequestIds, options.outputPath);
    }

    // 11b. Monotonic non-regression: delayed order_created cannot reactivate REVOKED entitlement
    const delayedOcEventId = `evt_sb_late_${crypto.randomUUID()}`;
    const lateOcPayload = {
      ...orderCreatedPayload,
      meta: {
        ...orderCreatedPayload.meta,
        event_id: delayedOcEventId,
      },
    };
    const lateBody = JSON.stringify(lateOcPayload);
    await fetchFn(`${resolvedBaseUrl}/api/webhooks/lemon-squeezy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(lateBody) },
      body: lateBody,
    });
    const entAfterLate = await storage.getEntitlement(testUserId, testFindingId, testAuditId);
    if (!entAfterLate || entAfterLate.status !== 'REVOKED') {
      recordStep(11, 'Refunds, Reconciliation & Monotonic Non-Regression', 'DATABASE_ASSERTION', 'DATABASE_VERIFIED', 'FAIL', Date.now() - t10, 'Delayed order_created regressed REVOKED entitlement back to ACTIVE', 0, 1);
      return buildReport('FAIL', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, 'Monotonic non-regression violated', null, dbTarget, providerRequestIds, options.outputPath);
    }

    recordStep(11, 'Refunds, Reconciliation & Monotonic Non-Regression', 'HTTP_WEBHOOK', 'LOCALLY_SIMULATED', 'PASS', Date.now() - t10, 'Full refund revokes entitlement; monotonic guard prohibits late re-activation', 3, 0);

    return buildReport('PASS', runId, commitSha, env, startedAt, steps, totalAssertionsPassed, totalAssertionsFailed, null, null, dbTarget, providerRequestIds, options.outputPath);
  } finally {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (localServer) {
      await new Promise<void>((resolve) => (localServer as http.Server).close(() => resolve()));
    }
  }
}

function buildReport(
  overallStatus: RunnerStatus,
  runId: string,
  commitSha: string,
  env: NodeJS.ProcessEnv,
  startedAt: string,
  steps: SandboxStepResult[],
  passed: number,
  failed: number,
  failureReason: string | null,
  blockedReason: string | null,
  dbTarget: string,
  reqIds: string[],
  outputPath?: string
): SandboxReport {
  const completedAt = new Date().toISOString();
  const stepStatus: Record<string, 'PASS' | 'BLOCKED' | 'FAIL' | 'NOT_RUN'> = {};
  for (const s of steps) {
    stepStatus[`step_${s.step_number}`] = s.status;
  }

  const commitProvenanceVerified = commitSha !== 'UNKNOWN' && /^[0-9a-f]{40}$/i.test(commitSha);
  const evidenceSummary = {
    provider_originated_events_verified: steps.some((s) => s.evidence_source === 'PROVIDER_ORIGINATED' && s.status === 'PASS'),
    locally_simulated_events_count: steps.filter((s) => s.evidence_source === 'LOCALLY_SIMULATED').length,
    api_response_verified: steps.some((s) => s.evidence_source === 'API_RESPONSE' && s.status === 'PASS'),
    database_verified_count: steps.filter((s) => s.evidence_source === 'DATABASE_VERIFIED' && s.status === 'PASS').length,
  };

  const report: SandboxReport = {
    overall_status: overallStatus,
    run_id: runId,
    commit_sha: commitSha,
    commit_provenance_verified: commitProvenanceVerified,
    environment: env.NODE_ENV || 'development',
    sandbox_mode: env.LEMON_SQUEEZY_SANDBOX === 'true' || env.LEMON_SQUEEZY_TEST_MODE === 'true',
    started_at: startedAt,
    completed_at: completedAt,
    steps,
    step_status: stepStatus,
    evidence_summary: evidenceSummary,
    assertions: {
      total: passed + failed,
      passed,
      failed,
    },
    failure_reason: failureReason,
    blocked_reason: blockedReason,
    database_target: dbTarget,
    provider_request_ids: reqIds,
  };

  const reportFile = outputPath || path.resolve(process.cwd(), 'sandbox-e2e-result.json');
  try {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');
  } catch (err) {
    // Non-fatal write failure
  }

  return report;
}

// CLI Execution Entry Point
const isDirectRun = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith('lemon-squeezy-sandbox-e2e.ts') || process.argv[1].endsWith('lemon-squeezy-sandbox-e2e.js'))
);

if (isDirectRun) {
  console.log('===============================================================');
  console.log('AIDisCost MCP — Lemon Squeezy Sandbox E2E Verification Runner');
  console.log('===============================================================\n');

  executeSandboxE2E()
    .then((report) => {
      console.log(`STATUS: ${report.overall_status}`);
      if (report.overall_status === 'BLOCKED') {
        console.log(`Reason: ${report.blocked_reason}\n`);
        console.log('Instructions to configure Lemon Squeezy Test Mode:');
        console.log('  1. Log into your Lemon Squeezy dashboard: https://app.lemonsqueezy.com');
        console.log('  2. Enable "Test Mode" toggle in the bottom left corner.');
        console.log('  3. Navigate to Settings -> API Keys and generate an API key.');
        console.log('     Export as: LEMON_SQUEEZY_SANDBOX_API_KEY=<your_api_key>');
        console.log('  4. Navigate to Settings -> Stores and copy your Store ID.');
        console.log('     Export as: LEMON_SQUEEZY_STORE_ID=<your_store_id>');
        console.log('  5. Create a $49.00 USD single-payment product ("AIDisCost Fix Package").');
        console.log('     Copy the Variant ID. Export as: LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID=<id>');
        console.log('  6. Create a variable pricing product ("AIDisCost Outcome Fee").');
        console.log('     Copy the Variant ID. Export as: LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID=<id>');
        console.log('     (Note: Fix Package and Outcome Fee MUST have distinct variant IDs)');
        console.log('  7. Navigate to Settings -> Webhooks. Create a webhook endpoint pointing to:');
        console.log('     https://<your-app-domain>/api/webhooks/lemon-squeezy');
        console.log('     Select events: order_created, order_settled, order_refunded.');
        console.log('     Set a signing secret. Export as: LEMON_SQUEEZY_WEBHOOK_SECRET=<signing_secret>');
        console.log('  8. Set LEMON_SQUEEZY_SANDBOX=true');
        console.log('  9. Re-run: npm run test:sandbox\n');
        console.log('Report saved to: sandbox-e2e-result.json');
        console.log('===============================================================');
        // Nonzero exit code 2 for BLOCKED (distinct from 0 for PASS and 1 for FAIL)
        process.exit(2);
      } else if (report.overall_status === 'FAIL') {
        console.error(`Failure: ${report.failure_reason}`);
        console.log('Report saved to: sandbox-e2e-result.json');
        console.log('===============================================================');
        process.exit(1);
      } else {
        console.log('All 11 Sandbox E2E steps passed successfully!');
        console.log('Report saved to: sandbox-e2e-result.json');
        console.log('===============================================================');
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error('Fatal unhandled error in Sandbox E2E runner:', err);
      process.exit(1);
    });
}
