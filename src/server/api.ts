/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { ServerStorage, getStorage } from './storage';
import {
  AuthenticatedRequest,
  hashPassword,
  verifyPassword,
  generateSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS,
  getSessionCookieOptions,
  requireAuth,
} from './auth';
import {
  getLemonSqueezyConfig,
  verifyLemonSqueezySignature,
  createLemonSqueezyCheckout,
  createLemonSqueezyOutcomeFeeCheckout,
} from './lemon-squeezy';
import { User, Entitlement, AuthoritativeVerification, OutcomeFeeObligation, OutcomeFeeStatus } from './types';
import {
  evaluateVerification,
  isAuthoritativeVerified,
  getAuthoritativeVerifiedSavings,
} from '../engine/verification/comparator';
import { calculateAuthoritativeVerificationFee } from '../engine/billing/outcome';
import { Finding, AIEvent, VerificationState } from '../types/domain';

export function createApiRouter(): Router {
  const router = Router();
  const isProduction = process.env.NODE_ENV === 'production';

  // ==========================================
  // SYSTEM HEALTH & READINESS ENDPOINTS
  // ==========================================

  // GET /api/health
  router.get('/health', async (_req: Request, res: Response): Promise<void> => {
    res.json({
      status: 'ok',
      service: 'aidiscost',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
    });
  });

  // ==========================================
  // AUTHENTICATION ENDPOINTS
  // ==========================================

  // POST /api/auth/register
  router.post('/auth/register', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { email, password } = req.body || {};

      if (!email || typeof email !== 'string' || !email.includes('@')) {
        res.status(400).json({ error: 'INVALID_EMAIL', message: 'A valid email address is required.' });
        return;
      }

      if (!password || typeof password !== 'string' || password.length < 6) {
        res.status(400).json({
          error: 'WEAK_PASSWORD',
          message: 'Password must be at least 6 characters long.',
        });
        return;
      }

      const storage = getStorage();
      const existing = await storage.getUserByEmail(email);
      if (existing) {
        res.status(409).json({ error: 'USER_EXISTS', message: 'A user with this email already exists.' });
        return;
      }

      const now = new Date().toISOString();
      const user: User = {
        id: `usr_${crypto.randomUUID()}`,
        email: email.trim().toLowerCase(),
        password_hash: hashPassword(password),
        created_at: now,
        updated_at: now,
      };

      await storage.createUser(user);

      // Create session
      const token = generateSessionToken();
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
      await storage.createSession({
        token,
        user_id: user.id,
        expires_at: expiresAt,
        created_at: now,
      });

      res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions(isProduction));

      res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          created_at: user.created_at,
        },
      });
    } catch (err) {
      console.error('[API] Register error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create account.' });
    }
  });

  // POST /api/auth/login
  router.post('/auth/login', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { email, password } = req.body || {};

      if (!email || !password) {
        res.status(400).json({ error: 'MISSING_CREDENTIALS', message: 'Email and password are required.' });
        return;
      }

      const storage = getStorage();
      const user = await storage.getUserByEmail(email);
      if (!user) {
        res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
        return;
      }

      const isValid = verifyPassword(password, user.password_hash);
      if (!isValid) {
        res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
        return;
      }

      const now = new Date().toISOString();
      const token = generateSessionToken();
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

      await storage.createSession({
        token,
        user_id: user.id,
        expires_at: expiresAt,
        created_at: now,
      });

      res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions(isProduction));

      res.json({
        user: {
          id: user.id,
          email: user.email,
          created_at: user.created_at,
        },
      });
    } catch (err) {
      console.error('[API] Login error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Login failed.' });
    }
  });

  // POST /api/auth/logout
  router.post('/auth/logout', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const token = req.cookies?.[SESSION_COOKIE_NAME] || req.sessionToken;
      if (token) {
        const storage = getStorage();
        await storage.deleteSession(token);
      }
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      res.json({ success: true, message: 'Logged out successfully.' });
    } catch (err) {
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Logout error.' });
    }
  });

  // GET /api/auth/me
  router.get('/auth/me', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!req.user) {
      res.json({ authenticated: false, user: null });
      return;
    }
    res.json({
      authenticated: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        created_at: req.user.created_at,
      },
    });
  });

  // ==========================================
  // FINDINGS & OWNERSHIP ENDPOINTS
  // ==========================================

  // POST /api/findings/register
  // Associates an array of finding IDs from an audit with the authenticated user
  router.post('/findings/register', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { finding_ids } = req.body || {};
      if (!Array.isArray(finding_ids) || finding_ids.length === 0) {
        res.status(400).json({ error: 'INVALID_FINDINGS', message: 'Array of finding_ids is required.' });
        return;
      }

      const storage = getStorage();
      const user = req.user!;
      const registered: string[] = [];

      for (const findingId of finding_ids) {
        if (typeof findingId === 'string' && findingId.trim()) {
          const owner = await storage.getFindingOwner(findingId);
          if (!owner) {
            await storage.registerFindingOwnership(findingId, user.id);
            registered.push(findingId);
          } else if (owner === user.id) {
            registered.push(findingId);
          }
        }
      }

      res.json({ success: true, user_id: user.id, registered_count: registered.length });
    } catch (err) {
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to register findings.' });
    }
  });

  // GET /api/findings/:id/entitlement
  // Returns whether the authenticated user has paid entitlement for this finding
  router.get('/findings/:id/entitlement', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const findingId = req.params.id;
      const user = req.user!;
      const storage = getStorage();

      const ownerId = await storage.getFindingOwner(findingId);
      // Privacy boundary: If finding does not belong to user, return 404 to avoid leaking existence
      if (ownerId && ownerId !== user.id) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      const hasPaid = await storage.hasActivePaidEntitlement(user.id, findingId);
      const entitlement = await storage.getEntitlement(user.id, findingId);

      res.json({
        finding_id: findingId,
        user_id: user.id,
        is_paid: hasPaid,
        entitlement_type: hasPaid ? 'PAID_FIX_PACKAGE' : 'LOCKED',
        entitlement: hasPaid ? entitlement : null,
      });
    } catch (err) {
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve entitlement.' });
    }
  });

  // ==========================================
  // AUTHORITATIVE VERIFICATION ENDPOINTS
  // ==========================================

  // GET /api/findings/:id/verification
  // Retrieves the authoritative server-side verification state for a finding
  router.get('/findings/:id/verification', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const findingId = req.params.id;
      const user = req.user!;
      const storage = getStorage();

      // Privacy boundary: if finding does not belong to user, return 404 to avoid leaking existence
      const ownerId = await storage.getFindingOwner(findingId);
      if (ownerId && ownerId !== user.id) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      const verification = await storage.getVerificationByFindingId(findingId);
      if (!verification) {
        res.json({
          finding_id: findingId,
          verification: null,
          stage: 'BASELINE',
          is_authoritative: false,
          verified_annualized_savings_usd: 0,
        });
        return;
      }

      // Security check: ensure user owns this verification record
      if (verification.user_id !== user.id) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      res.json({
        finding_id: findingId,
        verification,
        stage: verification.stage,
        is_authoritative: verification.is_authoritative,
        is_simulated: verification.is_simulated,
        verified_annualized_savings_usd: verification.verified_annualized_savings_usd,
      });
    } catch (err) {
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve verification.' });
    }
  });

  // POST /api/findings/:id/verification/deploy
  // Authoritatively transitions finding verification lifecycle to CUSTOMER_DEPLOYED
  router.post('/findings/:id/verification/deploy', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const findingId = req.params.id;
      const user = req.user!;
      const storage = getStorage();

      // Enforce finding ownership
      const ownerId = await storage.getFindingOwner(findingId);
      if (ownerId && ownerId !== user.id) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      // Auto-register finding ownership if not registered yet
      if (!ownerId) {
        await storage.registerFindingOwnership(findingId, user.id);
      }

      const { baseline, is_sample_data, deployment_timestamp } = req.body || {};
      const now = new Date().toISOString();
      const deployTime = deployment_timestamp && !isNaN(new Date(deployment_timestamp).getTime())
        ? deployment_timestamp
        : now;

      const existing = await storage.getVerificationByFindingId(findingId);

      const updatedRecord: AuthoritativeVerification = {
        id: existing?.id || `ver_${crypto.randomUUID()}`,
        finding_id: findingId,
        user_id: user.id,
        stage: 'CUSTOMER_DEPLOYED',
        is_authoritative: false,
        is_simulated: Boolean(is_sample_data || existing?.is_simulated),
        baseline_start: baseline?.start || existing?.baseline_start || new Date(Date.now() - 7 * 86_400_000).toISOString(),
        baseline_end: baseline?.end || existing?.baseline_end || now,
        baseline_sample_count: Number(baseline?.sample_count ?? existing?.baseline_sample_count ?? 0),
        baseline_avg_cost_usd: Number(baseline?.avg_cost_per_call_usd ?? existing?.baseline_avg_cost_usd ?? 0),
        deployment_timestamp: deployTime,
        observation_start: deployTime,
        observation_end: deployTime,
        observation_sample_count: 0,
        post_avg_cost_usd: 0,
        observed_reduction_pct: 0,
        verified_annualized_savings_usd: 0,
        original_estimated_annualized_usd: existing?.original_estimated_annualized_usd,
        verification_confidence: 'INSUFFICIENT_OBSERVATION',
        verification_notes: 'Remediation deployed. Observation window open for post-deployment production telemetry.',
        created_at: existing?.created_at || now,
        updated_at: now,
      };

      await storage.saveVerification(updatedRecord);

      res.json({
        success: true,
        finding_id: findingId,
        stage: 'CUSTOMER_DEPLOYED',
        is_authoritative: false,
        verification: updatedRecord,
      });
    } catch (err) {
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to record deployment.' });
    }
  });

  // POST /api/findings/:id/verification/evaluate
  // Evaluates telemetry against the canonical verification comparator server-side
  // Ignores any client-supplied claims of authority or savings
  router.post('/findings/:id/verification/evaluate', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const findingId = req.params.id;
      const user = req.user!;
      const storage = getStorage();

      // Enforce finding ownership
      const ownerId = await storage.getFindingOwner(findingId);
      if (ownerId && ownerId !== user.id) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      if (!ownerId) {
        await storage.registerFindingOwnership(findingId, user.id);
      }

      const { events, finding, file_name } = req.body || {};

      if (!Array.isArray(events)) {
        res.status(400).json({ error: 'INVALID_EVENTS', message: 'events array is required.' });
        return;
      }

      if (!finding || typeof finding !== 'object' || finding.id !== findingId) {
        res.status(400).json({ error: 'INVALID_FINDING', message: 'Valid finding payload matching finding_id is required.' });
        return;
      }

      const existing = await storage.getVerificationByFindingId(findingId);
      const now = new Date().toISOString();
      const deployTime = existing?.deployment_timestamp || req.body.deployment_timestamp || now;
      const obsStart = existing?.observation_start || deployTime;

      // If client explicitly passed a closed observation window, honor it;
      // otherwise maintain unclosed window (start === end) so comparator derives end from telemetry
      const explicitWindow = req.body.observation_window;
      const hasExplicitClosedWindow = Boolean(
        explicitWindow?.start &&
        explicitWindow?.end &&
        explicitWindow.start !== explicitWindow.end
      );

      const observationWindow = hasExplicitClosedWindow
        ? {
            start: explicitWindow.start,
            end: explicitWindow.end,
            sample_event_count: 0,
          }
        : {
            start: obsStart,
            end: obsStart,
            sample_event_count: 0,
          };

      // Construct currentState for canonical verification evaluation
      const currentState: VerificationState = {
        finding_id: findingId,
        stage: existing?.stage || 'CUSTOMER_DEPLOYED',
        baseline_window: {
          start: existing?.baseline_start || finding.evidence?.baseline_period?.start || new Date(Date.now() - 7 * 86_400_000).toISOString(),
          end: existing?.baseline_end || finding.evidence?.baseline_period?.end || now,
          avg_cost_per_call_usd: existing?.baseline_avg_cost_usd || (finding.eligible_event_count > 0 ? finding.baseline_spend_usd / finding.eligible_event_count : 0),
          sample_count: existing?.baseline_sample_count || finding.eligible_event_count || 0,
        },
        deployment_timestamp: deployTime,
        observation_window: observationWindow,
        is_simulated: Boolean(finding.is_sample_data || existing?.is_simulated),
        post_deployment_file_name: file_name || existing?.post_deployment_file_name,
      };

      // RUN CANONICAL SERVER-SIDE VERIFICATION
      // Client-supplied claims of is_authoritative, stage, or savings are strictly ignored!
      const evaluated = evaluateVerification(currentState, finding, events, file_name);

      const isAuth = isAuthoritativeVerified(evaluated);
      evaluated.is_authoritative = isAuth;
      const verifiedAnnualSavings = getAuthoritativeVerifiedSavings(evaluated);

      const authRecord: AuthoritativeVerification = {
        id: existing?.id || `ver_${crypto.randomUUID()}`,
        finding_id: findingId,
        user_id: user.id,
        stage: evaluated.stage,
        is_authoritative: isAuth,
        is_simulated: Boolean(evaluated.is_simulated),
        baseline_start: evaluated.baseline_window.start,
        baseline_end: evaluated.baseline_window.end,
        baseline_sample_count: evaluated.baseline_window.sample_count,
        baseline_avg_cost_usd: evaluated.baseline_window.avg_cost_per_call_usd,
        deployment_timestamp: evaluated.deployment_timestamp,
        observation_start: evaluated.observation_window?.start,
        observation_end: evaluated.observation_window?.end,
        observation_sample_count: evaluated.observation_window?.sample_event_count || 0,
        post_avg_cost_usd: evaluated.observed_result?.post_cost_per_call_usd || 0,
        observed_reduction_pct: evaluated.observed_result?.observed_reduction_pct || 0,
        verified_annualized_savings_usd: verifiedAnnualSavings,
        original_estimated_annualized_usd: (typeof existing?.original_estimated_annualized_usd === 'number' && Number.isFinite(existing.original_estimated_annualized_usd) && existing.original_estimated_annualized_usd > 0)
          ? existing.original_estimated_annualized_usd
          : undefined,
        verification_confidence: evaluated.observed_result?.verification_confidence || 'INSUFFICIENT_OBSERVATION',
        verification_notes: evaluated.observed_result?.verification_notes,
        post_deployment_file_name: evaluated.post_deployment_file_name,
        verified_at: isAuth ? (existing?.verified_at || now) : undefined,
        created_at: existing?.created_at || now,
        updated_at: now,
      };

      await storage.saveVerification(authRecord);

      res.json({
        success: true,
        finding_id: findingId,
        stage: authRecord.stage,
        is_authoritative: authRecord.is_authoritative,
        is_simulated: authRecord.is_simulated,
        verified_annualized_savings_usd: authRecord.verified_annualized_savings_usd,
        verification: authRecord,
        evaluated_state: evaluated,
      });
    } catch (err) {
      console.error('[API] Verification evaluation error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to evaluate verification telemetry.' });
    }
  });

  // ==========================================
  // BILLING & CHECKOUT ENDPOINTS
  // ==========================================

  // POST /api/billing/fix-package/checkout
  router.post('/billing/fix-package/checkout', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { finding_id, redirect_url } = req.body || {};
      if (!finding_id || typeof finding_id !== 'string') {
        res.status(400).json({ error: 'INVALID_FINDING', message: 'finding_id is required.' });
        return;
      }

      const user = req.user!;
      const storage = getStorage();

      // Check ownership
      const ownerId = await storage.getFindingOwner(finding_id);
      if (ownerId && ownerId !== user.id) {
        // Do not leak existence of another user's finding
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      // Automatically register ownership if not registered yet
      if (!ownerId) {
        await storage.registerFindingOwnership(finding_id, user.id);
      }

      // Check if already entitled
      const alreadyPaid = await storage.hasActivePaidEntitlement(user.id, finding_id);
      if (alreadyPaid) {
        res.status(409).json({
          error: 'ALREADY_ENTITLED',
          message: 'This finding already has an active Fix Package entitlement.',
        });
        return;
      }

      // Check configuration
      const config = getLemonSqueezyConfig();
      if (!config.isConfigured) {
        res.status(503).json({
          error: 'BILLING_NOT_CONFIGURED',
          message: 'Fix Package checkout is not currently available.',
        });
        return;
      }

      // Initiate real checkout with Lemon Squeezy API
      const result = await createLemonSqueezyCheckout({
        userId: user.id,
        userEmail: user.email,
        findingId: finding_id,
        redirectUrl: redirect_url,
      });

      res.json({
        success: true,
        checkout_url: result.checkoutUrl,
        finding_id,
        amount_usd: 49.0,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'BILLING_NOT_CONFIGURED') {
        res.status(503).json({
          error: 'BILLING_NOT_CONFIGURED',
          message: 'Fix Package checkout is not currently available.',
        });
        return;
      }
      console.error('[API] Checkout error:', err);
      res.status(500).json({ error: 'CHECKOUT_FAILED', message: 'Unable to initiate checkout session.' });
    }
  });

  // ==========================================
  // OUTCOME FEE BILLING & CHECKOUT ENDPOINTS (Sprint B)
  // ==========================================

  // POST /api/findings/:id/outcome-fee
  // Server-authoritatively calculates and creates or retrieves the unique OutcomeFeeObligation
  router.post('/findings/:id/outcome-fee', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const findingId = req.params.id;
      const user = req.user!;
      const storage = getStorage();

      // 1. Verify finding ownership
      const ownerId = await storage.getFindingOwner(findingId);
      if (ownerId && ownerId !== user.id) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      // Enforce cross-user barrier on existing verification
      const verification = await storage.getVerificationByFindingId(findingId);
      if (verification && verification.user_id !== user.id) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      // Check if an obligation already exists for this finding (Idempotent replay)
      const existing = await storage.getOutcomeFeeObligation(findingId);
      if (existing) {
        if (existing.user_id !== user.id || existing.finding_id !== findingId) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
          return;
        }
        res.status(200).json({
          success: true,
          obligation: existing,
        });
        return;
      }

      if (!ownerId) {
        await storage.registerFindingOwnership(findingId, user.id);
      }

      // 2. Load authoritative verification
      if (!verification) {
        res.status(400).json({
          error: 'VERIFICATION_NOT_FOUND',
          message: 'No verification record found for this finding.',
        });
        return;
      }
      if (verification.user_id !== user.id) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      // 3. Enforce Authoritative Verification Gate (Invariants 1 & 2)
      // Simulation, non-authoritative, or observation-only states are strictly rejected
      if (
        !verification.is_authoritative ||
        verification.is_simulated ||
        verification.stage !== 'VERIFIED_RESULT'
      ) {
        res.status(400).json({
          error: 'VERIFICATION_NOT_AUTHORITATIVE',
          message: verification.is_simulated
            ? 'Simulation telemetry cannot establish commercial Outcome Fee obligations.'
            : 'Finding must be authoritatively verified (VERIFIED_RESULT) before an Outcome Fee can be created.',
        });
        return;
      }

      // 4. Validate savings value
      if (!verification.verified_annualized_savings_usd || verification.verified_annualized_savings_usd <= 0) {
        res.status(400).json({
          error: 'ZERO_VERIFIED_SAVINGS',
          message: 'Authoritative verified annualized savings must be greater than $0.',
        });
        return;
      }

      // 5. Canonical Outcome Fee calculation (20% rule, 1-month cap, 50% protection clause)
      // Server-authoritative original estimate MUST come strictly from persisted verification.
      // Client-provided values can never establish, override, or manipulate the estimate.
      const originalEstimate = (typeof verification.original_estimated_annualized_usd === 'number' && Number.isFinite(verification.original_estimated_annualized_usd) && verification.original_estimated_annualized_usd > 0)
        ? verification.original_estimated_annualized_usd
        : undefined;

      const feeCalc = calculateAuthoritativeVerificationFee(verification, originalEstimate);
      if (feeCalc.protectionTriggered || !feeCalc.isPayable || feeCalc.finalOutcomeFeeUsd <= 0) {
        res.status(400).json({
          error: 'OUTCOME_FEE_NOT_PAYABLE',
          message: feeCalc.protectionReason || 'Outcome fee is $0 or waived under commercial protection rules.',
          calculation: feeCalc,
        });
        return;
      }

      // 6. Obligation creation & database uniqueness guarantee
      const existingAfterCalc = await storage.getOutcomeFeeObligation(findingId);
      if (existingAfterCalc) {
        res.status(200).json({
          success: true,
          obligation: existingAfterCalc,
          calculation: feeCalc,
        });
        return;
      }

      const now = new Date().toISOString();
      const obligation: OutcomeFeeObligation = {
        id: `of_${crypto.randomUUID()}`,
        user_id: user.id,
        finding_id: findingId,
        verification_id: verification.id,
        verified_annualized_savings_usd: verification.verified_annualized_savings_usd,
        fee_amount_usd: feeCalc.finalOutcomeFeeUsd,
        currency: 'USD',
        status: 'PAYABLE',
        provider: 'LEMON_SQUEEZY',
        created_at: now,
        updated_at: now,
      };

      const saved = await storage.createOutcomeFeeObligation(obligation);
      const statusCode = saved.id === obligation.id ? 201 : 200;
      res.status(statusCode).json({
        success: true,
        obligation: saved,
        calculation: feeCalc,
      });
    } catch (err) {
      console.error('[API] Create Outcome Fee error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create Outcome Fee obligation.' });
    }
  });

  // GET /api/findings/:id/outcome-fee
  // Authoritative recovery path for Outcome Fee obligation state
  router.get('/findings/:id/outcome-fee', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const findingId = req.params.id;
      const user = req.user!;
      const storage = getStorage();

      const ownerId = await storage.getFindingOwner(findingId);
      if (ownerId && ownerId !== user.id) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      const obligation = await storage.getOutcomeFeeObligation(findingId);
      if (obligation && (obligation.user_id !== user.id || obligation.finding_id !== findingId)) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }
      res.json({
        finding_id: findingId,
        obligation: obligation || null,
      });
    } catch (err) {
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve Outcome Fee obligation.' });
    }
  });

  // POST /api/findings/:id/outcome-fee/checkout
  // Initiates Lemon Squeezy checkout for an existing authoritative Outcome Fee obligation
  router.post('/findings/:id/outcome-fee/checkout', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const findingId = req.params.id;
      const user = req.user!;
      const storage = getStorage();

      const ownerId = await storage.getFindingOwner(findingId);
      if (ownerId && ownerId !== user.id) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      const obligation = await storage.getOutcomeFeeObligation(findingId);
      if (!obligation) {
        res.status(404).json({
          error: 'OBLIGATION_NOT_FOUND',
          message: 'No Outcome Fee obligation exists for this finding. Create obligation first.',
        });
        return;
      }

      if (obligation.user_id !== user.id || obligation.finding_id !== findingId) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Finding not found.' });
        return;
      }

      if (obligation.status === 'PAID' || obligation.status === 'SETTLED') {
        res.status(409).json({
          error: 'ALREADY_PAID',
          message: 'This Outcome Fee obligation has already been paid.',
        });
        return;
      }

      if (obligation.fee_amount_usd <= 0) {
        res.status(400).json({
          error: 'INVALID_FEE_AMOUNT',
          message: 'Outcome Fee amount must be greater than $0.',
        });
        return;
      }

      const config = getLemonSqueezyConfig();
      if (!config.apiKey || !config.storeId || !config.outcomeFeeVariantId) {
        res.status(503).json({
          error: 'BILLING_NOT_CONFIGURED',
          message: 'Outcome Fee billing is not currently configured.',
        });
        return;
      }

      const checkoutRes = await createLemonSqueezyOutcomeFeeCheckout({
        userId: user.id,
        userEmail: user.email,
        findingId,
        obligationId: obligation.id,
        verificationId: obligation.verification_id,
        feeAmountUsd: obligation.fee_amount_usd,
        redirectUrl: req.body?.redirect_url,
      });

      // Transition to CHECKOUT_CREATED on checkout creation success
      const updatedObligation: OutcomeFeeObligation = {
        ...obligation,
        status: 'CHECKOUT_CREATED',
        checkout_url: checkoutRes.checkoutUrl,
        provider_order_id: checkoutRes.checkoutId || obligation.provider_order_id,
        updated_at: new Date().toISOString(),
      };
      await storage.updateOutcomeFeeObligation(updatedObligation);

      res.json({
        success: true,
        checkout_url: checkoutRes.checkoutUrl,
        obligation: updatedObligation,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'OUTCOME_FEE_BILLING_NOT_CONFIGURED' || msg === 'BILLING_NOT_CONFIGURED') {
        res.status(503).json({
          error: 'BILLING_NOT_CONFIGURED',
          message: 'Outcome Fee checkout is not currently available.',
        });
        return;
      }
      if (msg === 'OUTCOME_FEE_CANNOT_USE_FIX_PACKAGE_VARIANT') {
        res.status(500).json({
          error: 'CONFIGURATION_ERROR',
          message: 'Outcome Fee variant must not match Fix Package variant.',
        });
        return;
      }
      console.error('[API] Outcome Fee Checkout error:', err);
      res.status(500).json({ error: 'CHECKOUT_FAILED', message: 'Unable to initiate Outcome Fee checkout session.' });
    }
  });

  // ==========================================
  // WEBHOOK ENDPOINT
  // ==========================================

  // POST /api/webhooks/lemon-squeezy
  router.post('/webhooks/lemon-squeezy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    let currentEventId: string | undefined;
    try {
      const config = getLemonSqueezyConfig();
      const secret = config.webhookSecret;

      if (!secret) {
        res.status(503).json({ error: 'WEBHOOK_NOT_CONFIGURED', message: 'Webhook secret is not configured.' });
        return;
      }

      const signature = req.headers['x-signature'] as string | undefined;
      const rawBody = req.rawBody || JSON.stringify(req.body);

      // 1. Signature Verification
      const isValidSignature = verifyLemonSqueezySignature(rawBody, signature, secret);
      if (!isValidSignature) {
        res.status(401).json({ error: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed.' });
        return;
      }

      const payload = typeof req.body === 'object' ? req.body : JSON.parse(rawBody.toString('utf-8'));
      const eventName = payload?.meta?.event_name;
      const eventId = String(payload?.meta?.event_id || payload?.data?.id || '');
      currentEventId = eventId;

      if (!eventName || !eventId) {
        res.status(400).json({ error: 'MALFORMED_WEBHOOK', message: 'Missing event metadata.' });
        return;
      }

      const storage = getStorage();

      // 2. Concurrency-Safe Idempotency Check & Atomic Claim
      const claimStatus = storage.claimWebhookEvent(eventId);
      if (claimStatus === 'DUPLICATE' || claimStatus === 'IN_FLIGHT') {
        res.status(200).json({
          status: 'IDEMPOTENT_DUPLICATE',
          message: 'Event has already been processed or is currently being processed.',
        });
        return;
      }

      // We handle 'order_created' and 'order_settled' for payment capture & settlement
      if (eventName === 'order_created' || eventName === 'order_settled') {
        const orderData = payload?.data;
        const attributes = orderData?.attributes;
        const customData = payload?.meta?.custom_data || attributes?.first_order_item?.custom;

        const userId = customData?.user_id;
        const findingId = customData?.finding_id;
        const orderStatus = attributes?.status;
        const orderId = String(orderData?.id || attributes?.identifier || eventId);

        // 3. Strict Product Identity Validation
        const product = customData?.product;
        if (typeof product !== 'string' || (product.trim() !== 'FIX_PACKAGE' && product.trim() !== 'OUTCOME_FEE')) {
          storage.releaseWebhookClaim(eventId);
          res.status(400).json({
            error: 'INVALID_PRODUCT',
            message: 'Webhook custom_data.product must be "FIX_PACKAGE" or "OUTCOME_FEE".',
          });
          return;
        }

        // ==========================================
        // BRANCH A: FIX PACKAGE PAYMENT
        // ==========================================
        if (product.trim() === 'FIX_PACKAGE') {
          // If event is order_settled for Fix Package, record and ignore
          if (eventName !== 'order_created') {
            await storage.recordProcessedWebhook({
              event_id: eventId,
              provider: 'LEMON_SQUEEZY',
              event_name: eventName,
              processed_at: new Date().toISOString(),
            });
            res.status(200).json({ status: 'IGNORED_EVENT', event_name: eventName });
            return;
          }

          // Strict Fix Package Variant Validation
          if (config.variantId) {
            const rawVariant = attributes?.first_order_item?.variant_id ?? attributes?.variant_id;
            const incomingVariantId =
              typeof rawVariant === 'string' || typeof rawVariant === 'number'
                ? String(rawVariant).trim()
                : '';
            if (!incomingVariantId || incomingVariantId !== config.variantId) {
              storage.releaseWebhookClaim(eventId);
              res.status(400).json({
                error: 'WRONG_VARIANT',
                message: `Variant ID "${incomingVariantId}" does not match configured Fix Package variant.`,
              });
              return;
            }
          }

          // Only paid status creates entitlement
          if (orderStatus !== 'paid') {
            await storage.recordProcessedWebhook({
              event_id: eventId,
              provider: 'LEMON_SQUEEZY',
              event_name: eventName,
              processed_at: new Date().toISOString(),
            });
            res.status(200).json({ status: 'IGNORED_NON_PAID', order_status: orderStatus });
            return;
          }

          if (!userId || !findingId) {
            storage.releaseWebhookClaim(eventId);
            res.status(400).json({
              error: 'MISSING_CUSTOM_DATA',
              message: 'Webhook custom_data must contain user_id and finding_id.',
            });
            return;
          }

          const user = await storage.getUserById(userId);
          if (!user) {
            storage.releaseWebhookClaim(eventId);
            res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User does not exist.' });
            return;
          }

          const ownerId = await storage.getFindingOwner(findingId);
          if (!ownerId || ownerId !== userId) {
            storage.releaseWebhookClaim(eventId);
            res.status(403).json({
              error: 'FINDING_OWNERSHIP_MISMATCH',
              message: 'Finding is not registered to the paying user.',
            });
            return;
          }

          const now = new Date().toISOString();
          const entitlement: Entitlement = {
            id: `ent_${crypto.randomUUID()}`,
            user_id: userId,
            finding_id: findingId,
            type: 'PAID_FIX_PACKAGE',
            status: 'ACTIVE',
            provider: 'LEMON_SQUEEZY',
            provider_transaction_id: orderId,
            amount_usd: 49.0,
            created_at: now,
            updated_at: now,
          };

          const eventData = {
            event_id: eventId,
            provider: 'LEMON_SQUEEZY' as const,
            event_name: eventName,
            user_id: userId,
            finding_id: findingId,
            order_id: orderId,
            processed_at: now,
          };

          let outcomeStatus: 'SUCCESS' | 'DUPLICATE' = 'SUCCESS';
          if (typeof storage.processOrderCreatedWebhookTransaction === 'function') {
            const txRes = await storage.processOrderCreatedWebhookTransaction({
              event: eventData,
              entitlement,
            });
            outcomeStatus = txRes.status;
          } else {
            await storage.createEntitlement(entitlement);
            await storage.recordProcessedWebhook(eventData);
          }

          if (outcomeStatus === 'DUPLICATE') {
            res.status(200).json({
              status: 'IDEMPOTENT_DUPLICATE',
              message: 'Event has already been processed or is currently being processed.',
            });
            return;
          }

          res.status(200).json({
            status: 'SUCCESS',
            entitlement_id: entitlement.id,
            finding_id: entitlement.finding_id,
          });
          return;
        }

        // ==========================================
        // BRANCH B: OUTCOME FEE PAYMENT (Sprint B)
        // ==========================================
        if (product.trim() === 'OUTCOME_FEE') {
          // 4. Strict Variant Validation
          const rawVariant = attributes?.first_order_item?.variant_id ?? attributes?.variant_id;
          const incomingVariantId =
            typeof rawVariant === 'string' || typeof rawVariant === 'number'
              ? String(rawVariant).trim()
              : '';

          // Must NOT use Fix Package variant (Section 22 & Invariant 7)
          if (config.variantId && incomingVariantId === config.variantId) {
            storage.releaseWebhookClaim(eventId);
            res.status(400).json({
              error: 'WRONG_VARIANT',
              message: 'Outcome Fee cannot use Fix Package variant.',
            });
            return;
          }

          // If Outcome Fee variant configured, must match
          if (config.outcomeFeeVariantId && incomingVariantId !== config.outcomeFeeVariantId) {
            storage.releaseWebhookClaim(eventId);
            res.status(400).json({
              error: 'WRONG_VARIANT',
              message: `Variant ID "${incomingVariantId}" does not match configured Outcome Fee variant.`,
            });
            return;
          }

          if (!userId || !findingId) {
            storage.releaseWebhookClaim(eventId);
            res.status(400).json({
              error: 'MISSING_CUSTOM_DATA',
              message: 'Webhook custom_data must contain user_id and finding_id.',
            });
            return;
          }

          // Verify user exists
          const user = await storage.getUserById(userId);
          if (!user) {
            storage.releaseWebhookClaim(eventId);
            res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User does not exist.' });
            return;
          }

          // Verify finding ownership
          const ownerId = await storage.getFindingOwner(findingId);
          if (!ownerId || ownerId !== userId) {
            storage.releaseWebhookClaim(eventId);
            res.status(403).json({
              error: 'FINDING_OWNERSHIP_MISMATCH',
              message: 'Finding is not registered to the paying user.',
            });
            return;
          }

          // Resolve obligation by obligation_id or finding_id
          const obligationId = customData?.obligation_id;
          let obligation: OutcomeFeeObligation | null = null;
          if (obligationId) {
            obligation = await storage.getOutcomeFeeObligationById(obligationId);
          }
          if (!obligation) {
            obligation = await storage.getOutcomeFeeObligation(findingId);
          }

          if (!obligation) {
            storage.releaseWebhookClaim(eventId);
            res.status(404).json({
              error: 'OBLIGATION_NOT_FOUND',
              message: 'No Outcome Fee obligation found for this finding.',
            });
            return;
          }

          // Obligation binding verification (Section 23 & Invariant 9)
          if (obligation.user_id !== userId || obligation.finding_id !== findingId) {
            storage.releaseWebhookClaim(eventId);
            res.status(400).json({
              error: 'OBLIGATION_BINDING_MISMATCH',
              message: 'Webhook payload does not match obligation binding.',
            });
            return;
          }

          // Amount integrity validation (Section 24 & Invariant 6)
          const rawTotalCents = attributes?.total ?? (attributes?.first_order_item?.price ?? 0);
          const orderTotalCents = Number(rawTotalCents);
          const expectedCents = Math.round(obligation.fee_amount_usd * 100);
          if (Math.abs(orderTotalCents - expectedCents) > 1) {
            storage.releaseWebhookClaim(eventId);
            res.status(400).json({
              error: 'AMOUNT_MISMATCH',
              message: `Reported webhook amount ($${(orderTotalCents / 100).toFixed(2)}) does not match persisted obligation fee ($${obligation.fee_amount_usd.toFixed(2)}).`,
            });
            return;
          }

          // Determine status transition
          let targetStatus: OutcomeFeeStatus = 'PAID';
          if (eventName === 'order_settled' || orderStatus === 'settled') {
            targetStatus = 'SETTLED';
          } else if (orderStatus === 'paid') {
            targetStatus = 'PAID';
          } else if (orderStatus === 'failed' || orderStatus === 'refunded') {
            targetStatus = 'FAILED';
          } else {
            // Pending or non-terminal status; record processed and ignore
            await storage.recordProcessedWebhook({
              event_id: eventId,
              provider: 'LEMON_SQUEEZY',
              event_name: eventName,
              processed_at: new Date().toISOString(),
            });
            res.status(200).json({ status: 'IGNORED_NON_PAID', order_status: orderStatus });
            return;
          }

          // Monotonic State Machine Invariants:
          // 1. SETTLED is terminal. Out-of-order order_created or failed events cannot regress SETTLED.
          // 2. PAID can only transition forward to SETTLED. It cannot regress to FAILED, CHECKOUT_CREATED, or PAYABLE.
          let newStatus = obligation.status;
          if (obligation.status === 'SETTLED') {
            newStatus = 'SETTLED';
          } else if (obligation.status === 'PAID') {
            newStatus = targetStatus === 'SETTLED' ? 'SETTLED' : 'PAID';
          } else {
            newStatus = targetStatus;
          }

          const now = new Date().toISOString();
          const updatedObligation: OutcomeFeeObligation = {
            ...obligation,
            status: newStatus,
            provider_order_id: orderId,
            provider_transaction_id: orderId,
            paid_at: (newStatus === 'PAID' || newStatus === 'SETTLED') ? (obligation.paid_at || now) : obligation.paid_at,
            updated_at: now,
          };

          const eventData = {
            event_id: eventId,
            provider: 'LEMON_SQUEEZY' as const,
            event_name: eventName,
            user_id: userId,
            finding_id: findingId,
            order_id: orderId,
            processed_at: now,
          };

          let outcomeStatus: 'SUCCESS' | 'DUPLICATE' = 'SUCCESS';
          if (typeof storage.processOutcomeFeeWebhookTransaction === 'function') {
            const txRes = await storage.processOutcomeFeeWebhookTransaction({
              event: eventData,
              obligation: updatedObligation,
            });
            outcomeStatus = txRes.status;
          } else {
            await storage.updateOutcomeFeeObligation(updatedObligation);
            await storage.recordProcessedWebhook(eventData);
          }

          if (outcomeStatus === 'DUPLICATE') {
            res.status(200).json({
              status: 'IDEMPOTENT_DUPLICATE',
              message: 'Event has already been processed or is currently being processed.',
            });
            return;
          }

          res.status(200).json({
            status: 'SUCCESS',
            obligation_id: updatedObligation.id,
            outcome_fee_status: updatedObligation.status,
          });
          return;
        }
      }

      // For other events, record as processed and return 200
      await storage.recordProcessedWebhook({
        event_id: eventId,
        provider: 'LEMON_SQUEEZY',
        event_name: eventName,
        processed_at: new Date().toISOString(),
      });

      res.status(200).json({ status: 'IGNORED_EVENT', event_name: eventName });
    } catch (err) {
      if (typeof currentEventId === 'string' && currentEventId) {
        try {
          const storage = getStorage();
          storage.releaseWebhookClaim(currentEventId);
        } catch {
          // ignore release failure in error handler
        }
      }
      console.error('[API] Webhook error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to process webhook.' });
    }
  });

  return router;
}
