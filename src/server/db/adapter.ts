/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { eq, and, or, desc } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { Client } from '@libsql/client';
import * as schema from './schema';
import { IStorage } from '../storage-interface';
import { User, UserSession, Entitlement, FindingOwnership, ProcessedWebhookEvent, AuthoritativeVerification, OutcomeFeeObligation, OutcomeFeeStatus, PersistedAuditRecord, PersistedFindingRecord } from '../types';
import { hashSessionToken } from '../auth';

export class DrizzleStorageAdapter implements IStorage {
  private db: LibSQLDatabase<typeof schema>;
  private client: Client;
  private inFlightWebhooks: Set<string> = new Set<string>();
  private processedWebhooksCache: Set<string> = new Set<string>();
  private isTestMode = false;

  constructor(db: LibSQLDatabase<typeof schema>, client: Client) {
    this.db = db;
    this.client = client;
  }

  setTestMode(isTest: boolean): void {
    this.isTestMode = isTest;
  }

  async clearAll(): Promise<void> {
    this.inFlightWebhooks.clear();
    this.processedWebhooksCache.clear();
    await this.db.delete(schema.outcomeFeeObligations);
    await this.db.delete(schema.verifications);
    await this.db.delete(schema.webhookEvents);
    await this.db.delete(schema.entitlements);
    await this.db.delete(schema.findingOwnerships);
    await this.db.delete(schema.findings);
    await this.db.delete(schema.audits);
    await this.db.delete(schema.sessions);
    await this.db.delete(schema.users);
  }

  // --- User Operations ---
  async createUser(user: User): Promise<User> {
    const normalizedEmail = user.email.trim().toLowerCase();
    const existing = await this.getUserByEmail(normalizedEmail);
    if (existing) {
      throw new Error(`User with email ${normalizedEmail} already exists`);
    }

    await this.db.insert(schema.users).values({
      id: user.id,
      email: normalizedEmail,
      passwordHash: user.password_hash,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    });

    return { ...user, email: normalizedEmail };
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const normalizedEmail = email.trim().toLowerCase();
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, normalizedEmail))
      .limit(1);

    if (!rows[0]) return null;

    return {
      id: rows[0].id,
      email: rows[0].email,
      password_hash: rows[0].passwordHash,
      created_at: rows[0].createdAt,
      updated_at: rows[0].updatedAt,
    };
  }

  async getUserById(id: string): Promise<User | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);

    if (!rows[0]) return null;

    return {
      id: rows[0].id,
      email: rows[0].email,
      password_hash: rows[0].passwordHash,
      created_at: rows[0].createdAt,
      updated_at: rows[0].updatedAt,
    };
  }

  // --- Session Operations ---
  async createSession(session: UserSession): Promise<UserSession> {
    const hashedToken = hashSessionToken(session.token);
    await this.db.insert(schema.sessions).values({
      token: hashedToken,
      userId: session.user_id,
      expiresAt: session.expires_at,
      createdAt: session.created_at,
    });
    return session;
  }

  async getSession(token: string): Promise<{ session: UserSession; user: User } | null> {
    if (!token) return null;

    const hashedToken = hashSessionToken(token);
    let rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.token, hashedToken))
      .limit(1);

    let isLegacy = false;
    if (!rows[0]) {
      rows = await this.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.token, token))
        .limit(1);
      if (rows[0]) {
        isLegacy = true;
      }
    }

    if (!rows[0]) return null;

    // Check expiration
    if (new Date(rows[0].expiresAt).getTime() < Date.now()) {
      await this.deleteSession(token);
      return null;
    }

    // Migrate legacy session to hashed token
    if (isLegacy) {
      await this.db
        .update(schema.sessions)
        .set({ token: hashedToken })
        .where(eq(schema.sessions.token, token));
    }

    const user = await this.getUserById(rows[0].userId);
    if (!user) {
      await this.deleteSession(token);
      return null;
    }

    return {
      session: {
        token: isLegacy ? hashedToken : rows[0].token,
        user_id: rows[0].userId,
        expires_at: rows[0].expiresAt,
        created_at: rows[0].createdAt,
      },
      user,
    };
  }

  async deleteSession(token: string): Promise<boolean> {
    if (!token) return false;
    const hashedToken = hashSessionToken(token);
    const res = await this.db
      .delete(schema.sessions)
      .where(or(eq(schema.sessions.token, hashedToken), eq(schema.sessions.token, token)));
    return (res.rowsAffected ?? 0) > 0;
  }

  // --- Finding Ownership Operations ---
  async registerFindingOwnership(findingId: string, ownerId: string): Promise<FindingOwnership> {
    const existing = await this.db
      .select()
      .from(schema.findingOwnerships)
      .where(eq(schema.findingOwnerships.findingId, findingId))
      .limit(1);

    if (existing[0]) {
      return {
        finding_id: existing[0].findingId,
        owner_id: existing[0].ownerId,
        created_at: existing[0].createdAt,
      };
    }

    const now = new Date().toISOString();
    await this.db
      .insert(schema.findingOwnerships)
      .values({
        findingId,
        ownerId,
        createdAt: now,
      })
      .onConflictDoNothing();

    const current = await this.db
      .select()
      .from(schema.findingOwnerships)
      .where(eq(schema.findingOwnerships.findingId, findingId))
      .limit(1);

    return {
      finding_id: current[0].findingId,
      owner_id: current[0].ownerId,
      created_at: current[0].createdAt,
    };
  }

  async getFindingOwner(findingId: string): Promise<string | null> {
    const rows = await this.db
      .select({ ownerId: schema.findingOwnerships.ownerId })
      .from(schema.findingOwnerships)
      .where(eq(schema.findingOwnerships.findingId, findingId))
      .limit(1);

    return rows[0] ? rows[0].ownerId : null;
  }

  async listUserFindings(ownerId: string): Promise<string[]> {
    const rows = await this.db
      .select({ findingId: schema.findingOwnerships.findingId })
      .from(schema.findingOwnerships)
      .where(eq(schema.findingOwnerships.ownerId, ownerId));

    return rows.map((r) => r.findingId);
  }

  // --- Entitlement Operations ---
  async createEntitlement(entitlement: Entitlement): Promise<Entitlement> {
    const existing = await this.getEntitlement(entitlement.user_id, entitlement.finding_id);
    if (
      existing &&
      existing.status === 'REVOKED' &&
      existing.provider_transaction_id === entitlement.provider_transaction_id
    ) {
      return existing; // Monotonic invariant
    }

    await this.db
      .insert(schema.entitlements)
      .values({
        id: entitlement.id,
        userId: entitlement.user_id,
        findingId: entitlement.finding_id,
        type: entitlement.type,
        status: entitlement.status,
        provider: entitlement.provider,
        providerTransactionId: entitlement.provider_transaction_id,
        amountUsd: entitlement.amount_usd,
        createdAt: entitlement.created_at,
        updatedAt: entitlement.updated_at,
      })
      .onConflictDoUpdate({
        target: [schema.entitlements.userId, schema.entitlements.findingId],
        set: {
          status: entitlement.status,
          provider: entitlement.provider,
          providerTransactionId: entitlement.provider_transaction_id,
          amountUsd: entitlement.amount_usd,
          updatedAt: entitlement.updated_at,
        },
      });

    return entitlement;
  }

  async updateEntitlement(entitlement: Entitlement): Promise<Entitlement> {
    await this.db
      .update(schema.entitlements)
      .set({
        status: entitlement.status,
        provider: entitlement.provider,
        providerTransactionId: entitlement.provider_transaction_id,
        amountUsd: entitlement.amount_usd,
        updatedAt: entitlement.updated_at,
      })
      .where(
        and(
          eq(schema.entitlements.userId, entitlement.user_id),
          eq(schema.entitlements.findingId, entitlement.finding_id)
        )
      );

    return entitlement;
  }

  async getEntitlement(userId: string, findingId: string): Promise<Entitlement | null> {
    const rows = await this.db
      .select()
      .from(schema.entitlements)
      .where(
        and(
          eq(schema.entitlements.userId, userId),
          eq(schema.entitlements.findingId, findingId)
        )
      )
      .limit(1);

    if (!rows[0]) return null;

    return {
      id: rows[0].id,
      user_id: rows[0].userId,
      finding_id: rows[0].findingId,
      type: rows[0].type as any,
      status: rows[0].status as any,
      provider: rows[0].provider as any,
      provider_transaction_id: rows[0].providerTransactionId,
      amount_usd: rows[0].amountUsd,
      created_at: rows[0].createdAt,
      updated_at: rows[0].updatedAt,
    };
  }

  async hasActivePaidEntitlement(userId: string, findingId: string): Promise<boolean> {
    const entitlement = await this.getEntitlement(userId, findingId);
    return Boolean(
      entitlement &&
      entitlement.type === 'PAID_FIX_PACKAGE' &&
      entitlement.status === 'ACTIVE'
    );
  }

  // --- Authoritative Verification Operations ---
  async saveVerification(verification: AuthoritativeVerification): Promise<AuthoritativeVerification> {
    const originalEstimateVal = (typeof verification.original_estimated_annualized_usd === 'number' && Number.isFinite(verification.original_estimated_annualized_usd))
      ? verification.original_estimated_annualized_usd
      : null;

    await this.db
      .insert(schema.verifications)
      .values({
        id: verification.id,
        findingId: verification.finding_id,
        userId: verification.user_id,
        stage: verification.stage,
        isAuthoritative: verification.is_authoritative,
        isSimulated: verification.is_simulated,
        baselineStart: verification.baseline_start,
        baselineEnd: verification.baseline_end,
        baselineSampleCount: verification.baseline_sample_count,
        baselineAvgCostUsd: verification.baseline_avg_cost_usd,
        deploymentTimestamp: verification.deployment_timestamp || null,
        observationStart: verification.observation_start || null,
        observationEnd: verification.observation_end || null,
        observationSampleCount: verification.observation_sample_count,
        postAvgCostUsd: verification.post_avg_cost_usd,
        observedReductionPct: verification.observed_reduction_pct,
        verifiedAnnualizedSavingsUsd: verification.verified_annualized_savings_usd,
        originalEstimatedAnnualizedUsd: originalEstimateVal,
        verificationConfidence: verification.verification_confidence,
        verificationNotes: verification.verification_notes || null,
        postDeploymentFileName: verification.post_deployment_file_name || null,
        verifiedAt: verification.verified_at || null,
        createdAt: verification.created_at,
        updatedAt: verification.updated_at,
      })
      .onConflictDoUpdate({
        target: schema.verifications.findingId,
        set: {
          stage: verification.stage,
          isAuthoritative: verification.is_authoritative,
          isSimulated: verification.is_simulated,
          baselineStart: verification.baseline_start,
          baselineEnd: verification.baseline_end,
          baselineSampleCount: verification.baseline_sample_count,
          baselineAvgCostUsd: verification.baseline_avg_cost_usd,
          deploymentTimestamp: verification.deployment_timestamp || null,
          observationStart: verification.observation_start || null,
          observationEnd: verification.observation_end || null,
          observationSampleCount: verification.observation_sample_count,
          postAvgCostUsd: verification.post_avg_cost_usd,
          observedReductionPct: verification.observed_reduction_pct,
          verifiedAnnualizedSavingsUsd: verification.verified_annualized_savings_usd,
          originalEstimatedAnnualizedUsd: originalEstimateVal,
          verificationConfidence: verification.verification_confidence,
          verificationNotes: verification.verification_notes || null,
          postDeploymentFileName: verification.post_deployment_file_name || null,
          verifiedAt: verification.verified_at || null,
          updatedAt: verification.updated_at,
        },
      });

    return verification;
  }

  async getVerificationByFindingId(findingId: string): Promise<AuthoritativeVerification | null> {
    const rows = await this.db
      .select()
      .from(schema.verifications)
      .where(eq(schema.verifications.findingId, findingId))
      .limit(1);

    if (!rows[0]) return null;
    const r = rows[0];

    const originalEstimate = (typeof r.originalEstimatedAnnualizedUsd === 'number' && Number.isFinite(r.originalEstimatedAnnualizedUsd))
      ? r.originalEstimatedAnnualizedUsd
      : undefined;

    return {
      id: r.id,
      finding_id: r.findingId,
      user_id: r.userId,
      stage: r.stage as any,
      is_authoritative: Boolean(r.isAuthoritative),
      is_simulated: Boolean(r.isSimulated),
      baseline_start: r.baselineStart,
      baseline_end: r.baselineEnd,
      baseline_sample_count: r.baselineSampleCount,
      baseline_avg_cost_usd: r.baselineAvgCostUsd,
      deployment_timestamp: r.deploymentTimestamp || undefined,
      observation_start: r.observationStart || undefined,
      observation_end: r.observationEnd || undefined,
      observation_sample_count: r.observationSampleCount,
      post_avg_cost_usd: r.postAvgCostUsd,
      observed_reduction_pct: r.observedReductionPct,
      verified_annualized_savings_usd: r.verifiedAnnualizedSavingsUsd,
      original_estimated_annualized_usd: originalEstimate,
      verification_confidence: r.verificationConfidence as any,
      verification_notes: r.verificationNotes || undefined,
      post_deployment_file_name: r.postDeploymentFileName || undefined,
      verified_at: r.verifiedAt || undefined,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    };
  }

  // --- Outcome Fee Obligation Operations ---
  private mapOutcomeFeeObligation(row: schema.OutcomeFeeObligationRow): OutcomeFeeObligation {
    return {
      id: row.id,
      user_id: row.userId,
      finding_id: row.findingId,
      verification_id: row.verificationId,
      verified_annualized_savings_usd: row.verifiedAnnualizedSavingsUsd,
      fee_amount_usd: row.feeAmountUsd,
      currency: row.currency,
      status: row.status as OutcomeFeeStatus,
      provider: row.provider as 'LEMON_SQUEEZY' | 'DEMO_ADAPTER',
      checkout_url: row.checkoutUrl || undefined,
      provider_order_id: row.providerOrderId || undefined,
      provider_transaction_id: row.providerTransactionId || undefined,
      paid_at: row.paidAt || undefined,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  async createOutcomeFeeObligation(obligation: OutcomeFeeObligation): Promise<OutcomeFeeObligation> {
    const existing = await this.getOutcomeFeeObligation(obligation.finding_id);
    if (existing) {
      return existing;
    }

    await this.db
      .insert(schema.outcomeFeeObligations)
      .values({
        id: obligation.id,
        userId: obligation.user_id,
        findingId: obligation.finding_id,
        verificationId: obligation.verification_id,
        verifiedAnnualizedSavingsUsd: obligation.verified_annualized_savings_usd,
        feeAmountUsd: obligation.fee_amount_usd,
        currency: obligation.currency,
        status: obligation.status,
        provider: obligation.provider,
        checkoutUrl: obligation.checkout_url || null,
        providerOrderId: obligation.provider_order_id || null,
        providerTransactionId: obligation.provider_transaction_id || null,
        paidAt: obligation.paid_at || null,
        createdAt: obligation.created_at,
        updatedAt: obligation.updated_at,
      })
      .onConflictDoNothing();

    const saved = await this.getOutcomeFeeObligation(obligation.finding_id);
    return saved || obligation;
  }

  async getOutcomeFeeObligation(findingId: string): Promise<OutcomeFeeObligation | null> {
    const rows = await this.db
      .select()
      .from(schema.outcomeFeeObligations)
      .where(eq(schema.outcomeFeeObligations.findingId, findingId))
      .limit(1);

    if (!rows[0]) return null;
    return this.mapOutcomeFeeObligation(rows[0]);
  }

  async getOutcomeFeeObligationById(obligationId: string): Promise<OutcomeFeeObligation | null> {
    const rows = await this.db
      .select()
      .from(schema.outcomeFeeObligations)
      .where(eq(schema.outcomeFeeObligations.id, obligationId))
      .limit(1);

    if (!rows[0]) return null;
    return this.mapOutcomeFeeObligation(rows[0]);
  }

  async updateOutcomeFeeObligation(obligation: OutcomeFeeObligation): Promise<OutcomeFeeObligation> {
    await this.db
      .update(schema.outcomeFeeObligations)
      .set({
        status: obligation.status,
        checkoutUrl: obligation.checkout_url || null,
        providerOrderId: obligation.provider_order_id || null,
        providerTransactionId: obligation.provider_transaction_id || null,
        paidAt: obligation.paid_at || null,
        updatedAt: obligation.updated_at,
      })
      .where(eq(schema.outcomeFeeObligations.id, obligation.id));

    return obligation;
  }

  async hasPaidOutcomeFee(userId: string, findingId: string): Promise<boolean> {
    const rows = await this.db
      .select({ status: schema.outcomeFeeObligations.status })
      .from(schema.outcomeFeeObligations)
      .where(
        and(
          eq(schema.outcomeFeeObligations.userId, userId),
          eq(schema.outcomeFeeObligations.findingId, findingId)
        )
      )
      .limit(1);

    return Boolean(rows[0] && (rows[0].status === 'PAID' || rows[0].status === 'SETTLED'));
  }

  // --- Webhook Idempotency Operations ---
  async isWebhookEventProcessed(eventId: string): Promise<boolean> {
    if (this.processedWebhooksCache.has(eventId) || this.inFlightWebhooks.has(eventId)) {
      return true;
    }
    const rows = await this.db
      .select({ eventId: schema.webhookEvents.eventId })
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.eventId, eventId))
      .limit(1);

    if (rows[0]) {
      this.processedWebhooksCache.add(eventId);
      return true;
    }
    return false;
  }

  claimWebhookEvent(eventId: string): 'PROCEED' | 'DUPLICATE' | 'IN_FLIGHT' {
    if (this.processedWebhooksCache.has(eventId)) {
      return 'DUPLICATE';
    }
    if (this.inFlightWebhooks.has(eventId)) {
      return 'IN_FLIGHT';
    }
    this.inFlightWebhooks.add(eventId);
    return 'PROCEED';
  }

  releaseWebhookClaim(eventId: string): void {
    this.inFlightWebhooks.delete(eventId);
  }

  async recordProcessedWebhook(event: ProcessedWebhookEvent): Promise<void> {
    await this.db
      .insert(schema.webhookEvents)
      .values({
        eventId: event.event_id,
        provider: event.provider,
        eventName: event.event_name,
        userId: event.user_id,
        findingId: event.finding_id,
        orderId: event.order_id,
        processedAt: event.processed_at,
      })
      .onConflictDoNothing();

    this.processedWebhooksCache.add(event.event_id);
    this.inFlightWebhooks.delete(event.event_id);
  }

  // --- Atomic Commercial Webhook Transaction ---
  async processOrderCreatedWebhookTransaction(params: {
    event: ProcessedWebhookEvent;
    entitlement: Entitlement;
  }): Promise<{ status: 'SUCCESS' | 'DUPLICATE' }> {
    if (this.processedWebhooksCache.has(params.event.event_id)) {
      this.inFlightWebhooks.delete(params.event.event_id);
      return { status: 'DUPLICATE' };
    }

    try {
      return await this.db.transaction(async (tx) => {
        const existing = await tx
          .select({ eventId: schema.webhookEvents.eventId })
          .from(schema.webhookEvents)
          .where(eq(schema.webhookEvents.eventId, params.event.event_id))
          .limit(1);

        if (existing[0]) {
          this.processedWebhooksCache.add(params.event.event_id);
          this.inFlightWebhooks.delete(params.event.event_id);
          return { status: 'DUPLICATE' };
        }

        await tx.insert(schema.webhookEvents).values({
          eventId: params.event.event_id,
          provider: params.event.provider,
          eventName: params.event.event_name,
          userId: params.event.user_id,
          findingId: params.event.finding_id,
          orderId: params.event.order_id,
          processedAt: params.event.processed_at,
        });

        const existingEntitlementRows = await tx
          .select()
          .from(schema.entitlements)
          .where(
            and(
              eq(schema.entitlements.userId, params.entitlement.user_id),
              eq(schema.entitlements.findingId, params.entitlement.finding_id)
            )
          )
          .limit(1);

        if (
          existingEntitlementRows[0] &&
          existingEntitlementRows[0].status === 'REVOKED' &&
          existingEntitlementRows[0].providerTransactionId === params.entitlement.provider_transaction_id
        ) {
          // Monotonic guard: delayed order_created must not reactivate an already revoked entitlement
          this.processedWebhooksCache.add(params.event.event_id);
          this.inFlightWebhooks.delete(params.event.event_id);
          return { status: 'SUCCESS' };
        }

        await tx
          .insert(schema.entitlements)
          .values({
            id: params.entitlement.id,
            userId: params.entitlement.user_id,
            findingId: params.entitlement.finding_id,
            type: params.entitlement.type,
            status: params.entitlement.status,
            provider: params.entitlement.provider,
            providerTransactionId: params.entitlement.provider_transaction_id,
            amountUsd: params.entitlement.amount_usd,
            createdAt: params.entitlement.created_at,
            updatedAt: params.entitlement.updated_at,
          })
          .onConflictDoUpdate({
            target: [schema.entitlements.userId, schema.entitlements.findingId],
            set: {
              status: params.entitlement.status,
              provider: params.entitlement.provider,
              providerTransactionId: params.entitlement.provider_transaction_id,
              amountUsd: params.entitlement.amount_usd,
              updatedAt: params.entitlement.updated_at,
            },
          });

        this.processedWebhooksCache.add(params.event.event_id);
        this.inFlightWebhooks.delete(params.event.event_id);
        return { status: 'SUCCESS' };
      });
    } catch (err: any) {
      // Release in-flight lock immediately so future retries are never blocked
      this.inFlightWebhooks.delete(params.event.event_id);

      const isLockCollision =
        err?.code === 'SQLITE_BUSY' ||
        String(err?.message || '').includes('locked') ||
        String(err?.cause?.message || '').includes('locked');

      // If the error was a lock collision, allow the winning concurrent transaction a brief window to commit
      if (isLockCollision) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      // Verify if another concurrent transaction committed this specific event_id
      try {
        const committed = await this.db
          .select({ eventId: schema.webhookEvents.eventId })
          .from(schema.webhookEvents)
          .where(eq(schema.webhookEvents.eventId, params.event.event_id))
          .limit(1);

        if (committed[0]) {
          // Confirmed: another transaction successfully committed this event_id
          this.processedWebhooksCache.add(params.event.event_id);
          return { status: 'DUPLICATE' };
        }
      } catch {
        // Ignore fallback query failure and proceed to throw original transaction error
      }

      // If the event was NOT committed in the database, this is NOT a duplicate.
      // Cache must NOT be poisoned with uncommitted events.
      this.processedWebhooksCache.delete(params.event.event_id);
      throw err;
    }
  }

  // --- Atomic Commercial Refund Webhook Transaction ---
  async processOrderRefundedWebhookTransaction(params: {
    event: ProcessedWebhookEvent;
    userId: string;
    findingId: string;
    orderId: string;
  }): Promise<{ status: 'SUCCESS' | 'DUPLICATE' | 'NOT_FOUND' | 'MISMATCH'; entitlement?: Entitlement }> {
    if (this.processedWebhooksCache.has(params.event.event_id)) {
      this.inFlightWebhooks.delete(params.event.event_id);
      return { status: 'DUPLICATE' };
    }

    try {
      return await this.db.transaction(async (tx) => {
        const existingEvent = await tx
          .select({ eventId: schema.webhookEvents.eventId })
          .from(schema.webhookEvents)
          .where(eq(schema.webhookEvents.eventId, params.event.event_id))
          .limit(1);

        if (existingEvent[0]) {
          this.processedWebhooksCache.add(params.event.event_id);
          this.inFlightWebhooks.delete(params.event.event_id);
          return { status: 'DUPLICATE' };
        }

        const existingEntitlementRows = await tx
          .select()
          .from(schema.entitlements)
          .where(
            and(
              eq(schema.entitlements.userId, params.userId),
              eq(schema.entitlements.findingId, params.findingId)
            )
          )
          .limit(1);

        if (!existingEntitlementRows[0]) {
          this.inFlightWebhooks.delete(params.event.event_id);
          return { status: 'NOT_FOUND' };
        }

        const existing = existingEntitlementRows[0];

        // Fail closed: enforce exact transaction ID, provider, type, and eligible status
        const hasValidTransactionId = Boolean(
          existing.providerTransactionId && existing.providerTransactionId.trim() !== ''
        );
        const matchesOrder = hasValidTransactionId && existing.providerTransactionId === params.orderId;
        const matchesProvider = existing.provider === 'LEMON_SQUEEZY';
        const matchesType = existing.type === 'PAID_FIX_PACKAGE';
        const isEligibleStatus = existing.status === 'ACTIVE';

        if (!matchesOrder || !matchesProvider || !matchesType || !isEligibleStatus) {
          this.inFlightWebhooks.delete(params.event.event_id);
          return {
            status: 'MISMATCH',
            entitlement: {
              id: existing.id,
              user_id: existing.userId,
              finding_id: existing.findingId,
              type: existing.type as any,
              status: existing.status as any,
              provider: existing.provider as any,
              provider_transaction_id: existing.providerTransactionId || '',
              amount_usd: existing.amountUsd,
              created_at: existing.createdAt,
              updated_at: existing.updatedAt,
            },
          };
        }

        const now = new Date().toISOString();
        const updateResult = await tx
          .update(schema.entitlements)
          .set({
            status: 'REVOKED',
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.entitlements.id, existing.id),
              eq(schema.entitlements.userId, params.userId),
              eq(schema.entitlements.findingId, params.findingId),
              eq(schema.entitlements.providerTransactionId, params.orderId),
              eq(schema.entitlements.provider, 'LEMON_SQUEEZY'),
              eq(schema.entitlements.type, 'PAID_FIX_PACKAGE'),
              eq(schema.entitlements.status, 'ACTIVE')
            )
          );

        if ((updateResult.rowsAffected ?? 0) === 0) {
          this.inFlightWebhooks.delete(params.event.event_id);
          return {
            status: 'MISMATCH',
            entitlement: {
              id: existing.id,
              user_id: existing.userId,
              finding_id: existing.findingId,
              type: existing.type as any,
              status: existing.status as any,
              provider: existing.provider as any,
              provider_transaction_id: existing.providerTransactionId || '',
              amount_usd: existing.amountUsd,
              created_at: existing.createdAt,
              updated_at: existing.updatedAt,
            },
          };
        }

        await tx.insert(schema.webhookEvents).values({
          eventId: params.event.event_id,
          provider: params.event.provider,
          eventName: params.event.event_name,
          userId: params.event.user_id,
          findingId: params.event.finding_id,
          orderId: params.event.order_id,
          processedAt: params.event.processed_at,
        });

        this.processedWebhooksCache.add(params.event.event_id);
        this.inFlightWebhooks.delete(params.event.event_id);

        return {
          status: 'SUCCESS',
          entitlement: {
            id: existing.id,
            user_id: existing.userId,
            finding_id: existing.findingId,
            type: existing.type as any,
            status: 'REVOKED',
            provider: existing.provider as any,
            provider_transaction_id: existing.providerTransactionId,
            amount_usd: existing.amountUsd,
            created_at: existing.createdAt,
            updated_at: now,
          },
        };
      });
    } catch (err: any) {
      this.inFlightWebhooks.delete(params.event.event_id);

      const isLockCollision =
        err?.code === 'SQLITE_BUSY' ||
        String(err?.message || '').includes('locked') ||
        String(err?.cause?.message || '').includes('locked');

      if (isLockCollision) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      try {
        const committed = await this.db
          .select({ eventId: schema.webhookEvents.eventId })
          .from(schema.webhookEvents)
          .where(eq(schema.webhookEvents.eventId, params.event.event_id))
          .limit(1);

        if (committed[0]) {
          this.processedWebhooksCache.add(params.event.event_id);
          return { status: 'DUPLICATE' };
        }
      } catch {
        // Ignore fallback query failure
      }

      this.processedWebhooksCache.delete(params.event.event_id);
      throw err;
    }
  }

  // --- Atomic Outcome Fee Webhook Transaction ---
  async processOutcomeFeeWebhookTransaction(params: {
    event: ProcessedWebhookEvent;
    obligation: OutcomeFeeObligation;
    entitlement?: Entitlement;
  }): Promise<{ status: 'SUCCESS' | 'DUPLICATE' }> {
    if (this.processedWebhooksCache.has(params.event.event_id)) {
      this.inFlightWebhooks.delete(params.event.event_id);
      return { status: 'DUPLICATE' };
    }

    try {
      return await this.db.transaction(async (tx) => {
        const existing = await tx
          .select({ eventId: schema.webhookEvents.eventId })
          .from(schema.webhookEvents)
          .where(eq(schema.webhookEvents.eventId, params.event.event_id))
          .limit(1);

        if (existing[0]) {
          this.processedWebhooksCache.add(params.event.event_id);
          this.inFlightWebhooks.delete(params.event.event_id);
          return { status: 'DUPLICATE' };
        }

        await tx.insert(schema.webhookEvents).values({
          eventId: params.event.event_id,
          provider: params.event.provider,
          eventName: params.event.event_name,
          userId: params.event.user_id,
          findingId: params.event.finding_id,
          orderId: params.event.order_id,
          processedAt: params.event.processed_at,
        });

        await tx
          .update(schema.outcomeFeeObligations)
          .set({
            status: params.obligation.status,
            providerOrderId: params.obligation.provider_order_id || null,
            providerTransactionId: params.obligation.provider_transaction_id || null,
            paidAt: params.obligation.paid_at || null,
            updatedAt: params.obligation.updated_at,
          })
          .where(eq(schema.outcomeFeeObligations.id, params.obligation.id));

        if (params.entitlement) {
          await tx
            .insert(schema.entitlements)
            .values({
              id: params.entitlement.id,
              userId: params.entitlement.user_id,
              findingId: params.entitlement.finding_id,
              type: params.entitlement.type,
              status: params.entitlement.status,
              provider: params.entitlement.provider,
              providerTransactionId: params.entitlement.provider_transaction_id,
              amountUsd: params.entitlement.amount_usd,
              createdAt: params.entitlement.created_at,
              updatedAt: params.entitlement.updated_at,
            })
            .onConflictDoUpdate({
              target: [schema.entitlements.userId, schema.entitlements.findingId],
              set: {
                status: params.entitlement.status,
                provider: params.entitlement.provider,
                providerTransactionId: params.entitlement.provider_transaction_id,
                amountUsd: params.entitlement.amount_usd,
                updatedAt: params.entitlement.updated_at,
              },
            });
        }

        this.processedWebhooksCache.add(params.event.event_id);
        this.inFlightWebhooks.delete(params.event.event_id);
        return { status: 'SUCCESS' };
      });
    } catch (err: any) {
      this.inFlightWebhooks.delete(params.event.event_id);

      const isLockCollision =
        err?.code === 'SQLITE_BUSY' ||
        String(err?.message || '').includes('locked') ||
        String(err?.cause?.message || '').includes('locked');

      if (isLockCollision) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      try {
        const committed = await this.db
          .select({ eventId: schema.webhookEvents.eventId })
          .from(schema.webhookEvents)
          .where(eq(schema.webhookEvents.eventId, params.event.event_id))
          .limit(1);

        if (committed[0]) {
          this.processedWebhooksCache.add(params.event.event_id);
          return { status: 'DUPLICATE' };
        }
      } catch {
        // Ignore fallback query failure
      }

      this.processedWebhooksCache.delete(params.event.event_id);
      throw err;
    }
  }

  // --- Audit and Finding Operations ---
  async saveAudit(audit: PersistedAuditRecord): Promise<PersistedAuditRecord> {
    await this.db
      .insert(schema.audits)
      .values({
        id: audit.audit_id,
        userId: audit.user_id,
        source: audit.source,
        totalSpendUsd: audit.total_spend_usd,
        potentialSavingsUsd: audit.potential_savings_usd,
        annualizedSavingsProjectionUsd: audit.annualized_savings_projection_usd,
        isSampleData: audit.is_sample_data,
        healthGrade: audit.health_grade ?? null,
        healthReportJson: audit.health_report ? JSON.stringify(audit.health_report) : null,
        findingsCount: audit.findings_count,
        createdAt: audit.created_at,
      })
      .onConflictDoUpdate({
        target: schema.audits.id,
        set: {
          source: audit.source,
          totalSpendUsd: audit.total_spend_usd,
          potentialSavingsUsd: audit.potential_savings_usd,
          annualizedSavingsProjectionUsd: audit.annualized_savings_projection_usd,
          isSampleData: audit.is_sample_data,
          healthGrade: audit.health_grade ?? null,
          healthReportJson: audit.health_report ? JSON.stringify(audit.health_report) : null,
          findingsCount: audit.findings_count,
        },
      });

    return audit;
  }

  async getAudit(auditId: string): Promise<PersistedAuditRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.audits)
      .where(eq(schema.audits.id, auditId))
      .limit(1);

    if (!rows[0]) return null;
    return this.mapAuditRow(rows[0]);
  }

  async listUserAudits(userId: string): Promise<PersistedAuditRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.audits)
      .where(eq(schema.audits.userId, userId))
      .orderBy(desc(schema.audits.createdAt));

    return rows.map((r) => this.mapAuditRow(r));
  }

  async saveFinding(finding: PersistedFindingRecord): Promise<PersistedFindingRecord> {
    const compositeId = `${finding.audit_id}:${finding.finding_id}`;
    await this.db
      .insert(schema.findings)
      .values({
        id: compositeId,
        auditId: finding.audit_id,
        findingId: finding.finding_id,
        userId: finding.user_id,
        ruleId: finding.rule_id,
        title: finding.title,
        summary: finding.summary,
        affectedScope: finding.affected_scope ?? null,
        detectionConfidence: finding.detection_confidence ?? null,
        baselineSpendUsd: finding.baseline_spend_usd,
        candidateSpendUsd: finding.candidate_spend_usd ?? null,
        estimatedSavingsUsd: finding.estimated_savings_usd,
        potentialSavingsPct: finding.potential_savings_pct ?? null,
        annualizedProjectionUsd: finding.annualized_projection_usd,
        eligibleEventCount: finding.eligible_event_count,
        calculationMethod: finding.calculation_method ?? null,
        assumptionsJson: finding.assumptions ? JSON.stringify(finding.assumptions) : null,
        evidenceJson: finding.evidence ? JSON.stringify(finding.evidence) : null,
        status: finding.status,
        isSampleData: finding.is_sample_data,
        createdAt: finding.created_at,
      })
      .onConflictDoUpdate({
        target: schema.findings.id,
        set: {
          title: finding.title,
          summary: finding.summary,
          affectedScope: finding.affected_scope ?? null,
          detectionConfidence: finding.detection_confidence ?? null,
          baselineSpendUsd: finding.baseline_spend_usd,
          candidateSpendUsd: finding.candidate_spend_usd ?? null,
          estimatedSavingsUsd: finding.estimated_savings_usd,
          potentialSavingsPct: finding.potential_savings_pct ?? null,
          annualizedProjectionUsd: finding.annualized_projection_usd,
          eligibleEventCount: finding.eligible_event_count,
          calculationMethod: finding.calculation_method ?? null,
          assumptionsJson: finding.assumptions ? JSON.stringify(finding.assumptions) : null,
          evidenceJson: finding.evidence ? JSON.stringify(finding.evidence) : null,
          status: finding.status,
          isSampleData: finding.is_sample_data,
        },
      });

    return finding;
  }

  async saveFindings(findings: PersistedFindingRecord[]): Promise<PersistedFindingRecord[]> {
    for (const finding of findings) {
      await this.saveFinding(finding);
    }
    return findings;
  }

  async getFinding(auditId: string, findingId: string): Promise<PersistedFindingRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.findings)
      .where(and(eq(schema.findings.auditId, auditId), eq(schema.findings.findingId, findingId)))
      .limit(1);

    if (!rows[0]) return null;
    return this.mapFindingRow(rows[0]);
  }

  async getFindingById(findingId: string, userId?: string): Promise<PersistedFindingRecord | null> {
    const condition = userId
      ? and(eq(schema.findings.findingId, findingId), eq(schema.findings.userId, userId))
      : eq(schema.findings.findingId, findingId);

    const rows = await this.db
      .select()
      .from(schema.findings)
      .where(condition)
      .orderBy(desc(schema.findings.createdAt))
      .limit(1);

    if (!rows[0]) return null;
    return this.mapFindingRow(rows[0]);
  }

  async listAuditFindings(auditId: string): Promise<PersistedFindingRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.auditId, auditId));

    return rows.map((r) => this.mapFindingRow(r));
  }

  private mapAuditRow(row: schema.AuditRow): PersistedAuditRecord {
    return {
      audit_id: row.id,
      user_id: row.userId,
      source: row.source,
      total_spend_usd: row.totalSpendUsd,
      potential_savings_usd: row.potentialSavingsUsd,
      annualized_savings_projection_usd: row.annualizedSavingsProjectionUsd,
      is_sample_data: Boolean(row.isSampleData),
      health_grade: row.healthGrade ?? undefined,
      health_report: row.healthReportJson ? JSON.parse(row.healthReportJson) : undefined,
      findings_count: row.findingsCount,
      created_at: row.createdAt,
    };
  }

  private mapFindingRow(row: schema.FindingRow): PersistedFindingRecord {
    return {
      audit_id: row.auditId,
      finding_id: row.findingId,
      user_id: row.userId,
      rule_id: row.ruleId,
      title: row.title,
      summary: row.summary,
      affected_scope: row.affectedScope ?? undefined,
      detection_confidence: (row.detectionConfidence as any) ?? undefined,
      baseline_spend_usd: row.baselineSpendUsd,
      candidate_spend_usd: row.candidateSpendUsd ?? undefined,
      estimated_savings_usd: row.estimatedSavingsUsd,
      potential_savings_pct: row.potentialSavingsPct ?? undefined,
      annualized_projection_usd: row.annualizedProjectionUsd,
      eligible_event_count: row.eligibleEventCount,
      calculation_method: row.calculationMethod ?? undefined,
      assumptions: row.assumptionsJson ? JSON.parse(row.assumptionsJson) : undefined,
      evidence: row.evidenceJson ? JSON.parse(row.evidenceJson) : undefined,
      status: row.status as any,
      is_sample_data: Boolean(row.isSampleData),
      created_at: row.createdAt,
    };
  }

  // --- Health & Readiness Check ---
  async checkReadiness(): Promise<boolean> {
    try {
      const result = await this.client.execute('SELECT 1 as healthy;');
      return Boolean(result && Array.isArray(result.rows) && result.rows.length > 0);
    } catch {
      return false;
    }
  }
}
