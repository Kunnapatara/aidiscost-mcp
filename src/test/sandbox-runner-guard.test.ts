/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  validateSandboxConfig,
  executeSandboxE2E,
  SandboxReport,
} from '../../scripts/lemon-squeezy-sandbox-e2e';

describe('AIDisCost MCP — Area 2 Sandbox Mode Enforcement & Outbound Guard Tests', () => {
  // Test A: Sandbox flag missing -> No API request permitted
  test('Test A: Sandbox flag missing causes zero outbound API requests and reports BLOCKED', async () => {
    let outboundRequestsCount = 0;
    const fetchSpy: typeof fetch = async (input, init) => {
      outboundRequestsCount++;
      return new Response(JSON.stringify({ data: { id: 'dummy' } }), { status: 200 });
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      // LEMON_SQUEEZY_SANDBOX intentionally omitted
      LEMON_SQUEEZY_SANDBOX_API_KEY: 'test_sb_key_123',
      LEMON_SQUEEZY_STORE_ID: 'store_123',
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'var_fix_1',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: 'var_fee_2',
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'wh_secret_123',
    };

    const validation = validateSandboxConfig(env);
    assert.strictEqual(validation.valid, false, 'Validation must fail when sandbox flag is missing');
    assert.strictEqual(validation.blocked, true, 'Validation must report blocked');
    assert.ok(
      validation.reasons.some((r) => r.includes('Sandbox Mode flag is missing')),
      'Must note missing sandbox flag'
    );

    const report: SandboxReport = await executeSandboxE2E({
      env,
      fetchFn: fetchSpy,
    });

    assert.strictEqual(outboundRequestsCount, 0, 'ZERO outbound API requests must be made when sandbox flag is missing');
    assert.strictEqual(report.overall_status, 'BLOCKED', 'Report overall status must be BLOCKED');
    assert.ok(report.blocked_reason?.includes('Sandbox Mode flag is missing'));
  });

  // Test B: Sandbox disabled (false) -> No API request permitted
  test('Test B: Sandbox disabled explicitly (LEMON_SQUEEZY_SANDBOX=false) causes zero outbound API requests', async () => {
    let outboundRequestsCount = 0;
    const fetchSpy: typeof fetch = async () => {
      outboundRequestsCount++;
      return new Response('{}', { status: 200 });
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      LEMON_SQUEEZY_SANDBOX: 'false',
      LEMON_SQUEEZY_SANDBOX_API_KEY: 'test_sb_key_123',
      LEMON_SQUEEZY_STORE_ID: 'store_123',
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'var_fix_1',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: 'var_fee_2',
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'wh_secret_123',
    };

    const validation = validateSandboxConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.blocked, true);

    const report = await executeSandboxE2E({ env, fetchFn: fetchSpy });
    assert.strictEqual(outboundRequestsCount, 0, 'ZERO outbound requests when sandbox is false');
    assert.strictEqual(report.overall_status, 'BLOCKED');
  });

  // Test C: Sandbox credentials missing -> No API request permitted
  test('Test C: Missing sandbox credentials (empty API key) causes zero outbound API requests', async () => {
    let outboundRequestsCount = 0;
    const fetchSpy: typeof fetch = async () => {
      outboundRequestsCount++;
      return new Response('{}', { status: 200 });
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      LEMON_SQUEEZY_SANDBOX: 'true',
      LEMON_SQUEEZY_SANDBOX_API_KEY: '', // Missing
      LEMON_SQUEEZY_STORE_ID: 'store_123',
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'var_fix_1',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: 'var_fee_2',
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'wh_secret_123',
    };

    const validation = validateSandboxConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.missing.includes('LEMON_SQUEEZY_SANDBOX_API_KEY'));

    const report = await executeSandboxE2E({ env, fetchFn: fetchSpy });
    assert.strictEqual(outboundRequestsCount, 0, 'ZERO outbound requests when API key is missing');
    assert.strictEqual(report.overall_status, 'BLOCKED');
  });

  // Test D: Production credentials supplied without valid sandbox configuration -> No API request permitted
  test('Test D: Production credentials supplied without sandbox confirmation are strictly rejected (anti-live fallback)', async () => {
    let outboundRequestsCount = 0;
    const fetchSpy: typeof fetch = async () => {
      outboundRequestsCount++;
      return new Response('{}', { status: 200 });
    };

    // User only configured generic LEMON_SQUEEZY_API_KEY (potential live key)
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      LEMON_SQUEEZY_SANDBOX: 'false',
      LEMON_SQUEEZY_API_KEY: 'live_production_secret_key_999',
      LEMON_SQUEEZY_STORE_ID: 'store_123',
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'var_fix_1',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: 'var_fee_2',
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'wh_secret_123',
    };

    const validation = validateSandboxConfig(env);
    assert.strictEqual(validation.valid, false, 'Must reject live credential ambiguity');
    assert.strictEqual(validation.blocked, true);

    const report = await executeSandboxE2E({ env, fetchFn: fetchSpy });
    assert.strictEqual(outboundRequestsCount, 0, 'ZERO outbound requests when live credentials attempted');
    assert.strictEqual(report.overall_status, 'BLOCKED');
  });

  // Test E: NODE_ENV=production strictly halts runner before any request
  test('Test E: NODE_ENV=production strictly halts runner before any request', async () => {
    let outboundRequestsCount = 0;
    const fetchSpy: typeof fetch = async () => {
      outboundRequestsCount++;
      return new Response('{}', { status: 200 });
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      LEMON_SQUEEZY_SANDBOX: 'true',
      LEMON_SQUEEZY_SANDBOX_API_KEY: 'test_sb_key_123',
      LEMON_SQUEEZY_STORE_ID: 'store_123',
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'var_fix_1',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: 'var_fee_2',
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'wh_secret_123',
    };

    const validation = validateSandboxConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.reasons.some((r) => r.includes('production')));

    const report = await executeSandboxE2E({ env, fetchFn: fetchSpy });
    assert.strictEqual(outboundRequestsCount, 0);
    assert.strictEqual(report.overall_status, 'BLOCKED');
  });

  // Test F: Variant collision is rejected with FAIL
  test('Test F: Variant ID collision is rejected and halts execution', async () => {
    let outboundRequestsCount = 0;
    const fetchSpy: typeof fetch = async () => {
      outboundRequestsCount++;
      return new Response('{}', { status: 200 });
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      LEMON_SQUEEZY_SANDBOX: 'true',
      LEMON_SQUEEZY_SANDBOX_API_KEY: 'test_sb_key_123',
      LEMON_SQUEEZY_STORE_ID: 'store_123',
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'same_var_1',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: 'same_var_1', // Colliding!
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'wh_secret_123',
    };

    const validation = validateSandboxConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.reasons.some((r) => r.includes('Variant ID Collision')));

    const report = await executeSandboxE2E({ env, fetchFn: fetchSpy });
    assert.strictEqual(outboundRequestsCount, 0, 'No checkout created if variant collision');
    assert.ok(report.overall_status === 'BLOCKED' || report.overall_status === 'FAIL');
  });

  // Test G: Valid Sandbox configuration permits Sandbox API request
  test('Test G: Valid Sandbox configuration permits sandbox API request to api.lemonsqueezy.com', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedAuthHeader = '';

    const fetchSpy: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('api.lemonsqueezy.com')) {
        capturedUrl = urlStr;
        capturedMethod = init?.method || 'GET';
        const headers = new Headers(init?.headers);
        capturedAuthHeader = headers.get('authorization') || '';

        // Mock checkout response from Lemon Squeezy sandbox
        return new Response(
          JSON.stringify({
            data: {
              id: 'chk_sb_mock_123',
              type: 'checkouts',
              attributes: {
                url: 'https://aidiscost.lemonsqueezy.com/buy/chk_sb_mock_123',
              },
            },
          }),
          {
            status: 201,
            headers: {
              'Content-Type': 'application/vnd.api+json',
              'x-request-id': 'req_mock_999',
            },
          }
        );
      }

      // Delegate application-internal HTTP requests to global fetch
      return globalThis.fetch(input, init);
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      LEMON_SQUEEZY_SANDBOX: 'true',
      LEMON_SQUEEZY_SANDBOX_API_KEY: 'valid_test_sandbox_api_key_abc',
      LEMON_SQUEEZY_STORE_ID: 'store_9999',
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'var_fix_99',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: 'var_fee_88',
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'wh_secret_valid_123',
    };

    const validation = validateSandboxConfig(env);
    assert.strictEqual(validation.valid, true, 'Validation must succeed for valid sandbox config');
    assert.strictEqual(validation.blocked, false);

    const report = await executeSandboxE2E({
      env,
      fetchFn: fetchSpy,
      mode: 'LOCAL_SIMULATION',
    });

    assert.strictEqual(capturedUrl, 'https://api.lemonsqueezy.com/v1/checkouts');
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedAuthHeader, 'Bearer valid_test_sandbox_api_key_abc');
    assert.strictEqual(report.overall_status, 'PASS', 'Complete 11-step execution in LOCAL_SIMULATION mode must PASS');
    assert.strictEqual(report.test_type, 'LOCAL_SIMULATION');
    assert.strictEqual(report.evidence_summary.provider_originated_events_verified, false, 'Simulated events must never claim genuine provider origin');
    assert.strictEqual(report.assertions.failed, 0);
    assert.ok(report.assertions.passed >= 15, 'All step assertions must be recorded');
  });

  // Test H: Genuine Provider E2E mode halts with BLOCKED on unverified provider webhook
  test('Test H: Genuine Provider E2E mode halts with BLOCKED when provider-originated webhook cannot be verified', async () => {
    let capturedUrl = '';
    const fetchSpy: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('api.lemonsqueezy.com')) {
        capturedUrl = urlStr;
        return new Response(
          JSON.stringify({
            data: {
              id: 'chk_sb_provider_123',
              type: 'checkouts',
              attributes: {
                url: 'https://aidiscost.lemonsqueezy.com/buy/chk_sb_provider_123',
              },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/vnd.api+json' } }
        );
      }
      return globalThis.fetch(input, init);
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      LEMON_SQUEEZY_SANDBOX: 'true',
      LEMON_SQUEEZY_SANDBOX_API_KEY: 'valid_test_sandbox_api_key_abc',
      LEMON_SQUEEZY_STORE_ID: 'store_9999',
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'var_fix_99',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: 'var_fee_88',
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'wh_secret_valid_123',
    };

    const report = await executeSandboxE2E({
      env,
      fetchFn: fetchSpy,
      mode: 'GENUINE_PROVIDER_E2E',
    });

    assert.strictEqual(capturedUrl, 'https://api.lemonsqueezy.com/v1/checkouts', 'Real checkout created');
    assert.strictEqual(report.overall_status, 'BLOCKED', 'Genuine Provider E2E must report BLOCKED when provider webhook is missing');
    assert.strictEqual(report.test_type, 'GENUINE_PROVIDER_E2E');
    assert.strictEqual(report.evidence_summary.provider_originated_events_verified, false);
    assert.ok(report.blocked_reason?.includes('GENUINE PROVIDER E2E BLOCKED'));
  });

  // Test I: LEMON_SQUEEZY_TEST_MODE=true without LEMON_SQUEEZY_SANDBOX=true is strictly rejected
  test('Test I: LEMON_SQUEEZY_TEST_MODE=true without LEMON_SQUEEZY_SANDBOX=true is strictly rejected', async () => {
    let outboundRequestsCount = 0;
    const fetchSpy: typeof fetch = async () => {
      outboundRequestsCount++;
      return new Response('{}', { status: 200 });
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      LEMON_SQUEEZY_TEST_MODE: 'true', // Test mode alone is not acceptable
      // LEMON_SQUEEZY_SANDBOX omitted
      LEMON_SQUEEZY_SANDBOX_API_KEY: 'test_sb_key_123',
      LEMON_SQUEEZY_STORE_ID: 'store_123',
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'var_fix_1',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: 'var_fee_2',
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'wh_secret_123',
    };

    const validation = validateSandboxConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.blocked, true);
    assert.ok(validation.reasons.some((r) => r.includes('LEMON_SQUEEZY_TEST_MODE=true cannot substitute')));

    const report = await executeSandboxE2E({ env, fetchFn: fetchSpy });
    assert.strictEqual(outboundRequestsCount, 0);
    assert.strictEqual(report.overall_status, 'BLOCKED');
  });

  // Test J: ALLOW_LEMON_SQUEEZY_API_KEY_IN_SANDBOX override is prohibited and rejected
  test('Test J: ALLOW_LEMON_SQUEEZY_API_KEY_IN_SANDBOX override is prohibited and rejected', async () => {
    let outboundRequestsCount = 0;
    const fetchSpy: typeof fetch = async () => {
      outboundRequestsCount++;
      return new Response('{}', { status: 200 });
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      LEMON_SQUEEZY_SANDBOX: 'true',
      LEMON_SQUEEZY_API_KEY: 'live_generic_api_key',
      ALLOW_LEMON_SQUEEZY_API_KEY_IN_SANDBOX: 'true', // Attempted override!
      LEMON_SQUEEZY_STORE_ID: 'store_123',
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'var_fix_1',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: 'var_fee_2',
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'wh_secret_123',
    };

    const validation = validateSandboxConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.blocked, true);
    assert.ok(validation.reasons.some((r) => r.includes('ALLOW_LEMON_SQUEEZY_API_KEY_IN_SANDBOX is prohibited')));

    const report = await executeSandboxE2E({ env, fetchFn: fetchSpy });
    assert.strictEqual(outboundRequestsCount, 0);
    assert.strictEqual(report.overall_status, 'BLOCKED');
  });

  // Test K: Missing Webhook Secret is strictly rejected
  test('Test K: Missing Webhook Secret causes zero outbound API requests and reports BLOCKED', async () => {
    let outboundRequestsCount = 0;
    const fetchSpy: typeof fetch = async () => {
      outboundRequestsCount++;
      return new Response('{}', { status: 200 });
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      LEMON_SQUEEZY_SANDBOX: 'true',
      LEMON_SQUEEZY_SANDBOX_API_KEY: 'test_sb_key_123',
      LEMON_SQUEEZY_STORE_ID: 'store_123',
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'var_fix_1',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: 'var_fee_2',
      LEMON_SQUEEZY_WEBHOOK_SECRET: '', // Missing!
    };

    const validation = validateSandboxConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.missing.includes('LEMON_SQUEEZY_WEBHOOK_SECRET'));

    const report = await executeSandboxE2E({ env, fetchFn: fetchSpy });
    assert.strictEqual(outboundRequestsCount, 0);
    assert.strictEqual(report.overall_status, 'BLOCKED');
  });

  // Test L: Missing Store ID or Variant ID is strictly rejected
  test('Test L: Missing Store ID or Variant ID causes zero outbound API requests and reports BLOCKED', async () => {
    let outboundRequestsCount = 0;
    const fetchSpy: typeof fetch = async () => {
      outboundRequestsCount++;
      return new Response('{}', { status: 200 });
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      LEMON_SQUEEZY_SANDBOX: 'true',
      LEMON_SQUEEZY_SANDBOX_API_KEY: 'test_sb_key_123',
      LEMON_SQUEEZY_STORE_ID: '', // Missing!
      LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID: 'var_fix_1',
      LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID: '', // Missing!
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'wh_secret_123',
    };

    const validation = validateSandboxConfig(env);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.missing.includes('LEMON_SQUEEZY_STORE_ID'));
    assert.ok(validation.missing.includes('LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID'));

    const report = await executeSandboxE2E({ env, fetchFn: fetchSpy });
    assert.strictEqual(outboundRequestsCount, 0);
    assert.strictEqual(report.overall_status, 'BLOCKED');
  });
});
