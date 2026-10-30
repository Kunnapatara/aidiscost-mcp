/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { User, UserSession, Entitlement, FindingOwnership, ProcessedWebhookEvent, AuthoritativeVerification, OutcomeFeeObligation, PersistedAuditRecord, PersistedFindingRecord } from './types';
import { IStorage } from './storage-interface';
import { createDatabaseConnection } from './db/index';
import { DrizzleStorageAdapter } from './db/adapter';
import { hashSessionToken } from './auth';

export type { IStorage } from './storage-interface';

interface StoreSchema {
  users: Record<string, User>; // email -> User
  usersById: Record<string, string>; // id -> email
  sessions: Record<string, UserSession>; // token -> UserSession
  findingOwnerships: Record<string, FindingOwnership>; // finding_id -> FindingOwnership
  entitlements: Record<string, Entitlement>; // `${user_id}:${finding_id}` -> Entitlement
  processedWebhooks: Record<string, ProcessedWebhookEvent>; // event_id -> ProcessedWebhookEvent
  verifications: Record<string, AuthoritativeVerification>; // finding_id -> AuthoritativeVerification
  outcomeFeeObligations: Record<string, OutcomeFeeObligation>; // finding_id -> OutcomeFeeObligation
  outcomeFeeObligationsById: Record<string, string>; // obligation_id -> finding_id
  audits: Record<string, PersistedAuditRecord>; // audit_id -> PersistedAuditRecord
  findings: Record<string, PersistedFindingRecord>; // `${audit_id}:${finding_id}` -> PersistedFindingRecord
}

export class ServerStorage implements IStorage {
  private static instance: ServerStorage;
  private filePath: string;
  private data: StoreSchema;
  private saveTimeout: NodeJS.Timeout | null = null;
  private isTestMode = false;
  private inFlightWebhooks: Set<string> = new Set<string>();

  private constructor(storageDir = 'data', fileName = 'aidiscost-db.json') {
    this.filePath = path.resolve(process.cwd(), storageDir, fileName);
    this.data = {
      users: {},
      usersById: {},
      sessions: {},
      findingOwnerships: {},
      entitlements: {},
      processedWebhooks: {},
      verifications: {},
      outcomeFeeObligations: {},
      outcomeFeeObligationsById: {},
      audits: {},
      findings: {},
    };
    this.loadFromDisk();
  }

  static getInstance(storageDir = 'data', fileName = 'aidiscost-db.json'): ServerStorage {
    if (!ServerStorage.instance) {
      ServerStorage.instance = new ServerStorage(storageDir, fileName);
    }
    return ServerStorage.instance;
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.data = {
          users: parsed.users || {},
          usersById: parsed.usersById || {},
          sessions: parsed.sessions || {},
          findingOwnerships: parsed.findingOwnerships || {},
          entitlements: parsed.entitlements || {},
          processedWebhooks: parsed.processedWebhooks || {},
          verifications: parsed.verifications || {},
          outcomeFeeObligations: parsed.outcomeFeeObligations || {},
          outcomeFeeObligationsById: parsed.outcomeFeeObligationsById || {},
          audits: parsed.audits || {},
          findings: parsed.findings || {},
        };

        // Safely reconcile legacy records with NULL audit_id ONLY when exactly 1 distinct audit exists
        const findingsList = Object.values(this.data.findings);
        for (const v of Object.values(this.data.verifications)) {
          if (!v.audit_id && v.user_id && v.finding_id) {
            const audits = Array.from(
              new Set(
                findingsList
                  .filter((f) => f.finding_id === v.finding_id && f.user_id === v.user_id)
                  .map((f) => f.audit_id)
              )
            );
            if (audits.length === 1) {
              v.audit_id = audits[0];
            }
          }
        }
        for (const obl of Object.values(this.data.outcomeFeeObligations)) {
          if (!obl.audit_id && obl.user_id && obl.finding_id) {
            const audits = Array.from(
              new Set(
                findingsList
                  .filter((f) => f.finding_id === obl.finding_id && f.user_id === obl.user_id)
                  .map((f) => f.audit_id)
              )
            );
            if (audits.length === 1) {
              obl.audit_id = audits[0];
            }
          }
        }
        for (const fo of Object.values(this.data.findingOwnerships)) {
          if (!fo.audit_id && fo.owner_id && fo.finding_id) {
            const audits = Array.from(
              new Set(
                findingsList
                  .filter((f) => f.finding_id === fo.finding_id && f.user_id === fo.owner_id)
                  .map((f) => f.audit_id)
              )
            );
            if (audits.length === 1) {
              fo.audit_id = audits[0];
            }
          }
        }
      }
    } catch (err) {
      // If disk read fails, fallback to clean memory store
      console.warn('[ServerStorage] Warning loading disk state:', (err as Error).message);
    }
  }

  private flushToDisk(): void {
    if (this.isTestMode) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.filePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.warn('[ServerStorage] Warning saving disk state:', (err as Error).message);
    }
  }

  setTestMode(isTest: boolean): void {
    this.isTestMode = isTest;
  }

  clearAll(): void {
    this.inFlightWebhooks.clear();
    this.data = {
      users: {},
      usersById: {},
      sessions: {},
      findingOwnerships: {},
      entitlements: {},
      processedWebhooks: {},
      verifications: {},
      outcomeFeeObligations: {},
      outcomeFeeObligationsById: {},
      audits: {},
      findings: {},
    };
    this.flushToDisk();
  }

  // --- User Operations ---
  async createUser(user: User): Promise<User> {
    const normalizedEmail = user.email.trim().toLowerCase();
    if (this.data.users[normalizedEmail]) {
      throw new Error(`User with email ${normalizedEmail} already exists`);
    }
    this.data.users[normalizedEmail] = user;
    this.data.usersById[user.id] = normalizedEmail;
    this.flushToDisk();
    return user;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const normalizedEmail = email.trim().toLowerCase();
    return this.data.users[normalizedEmail] || null;
  }

  async getUserById(id: string): Promise<User | null> {
    const email = this.data.usersById[id];
    if (!email) return null;
    return this.data.users[email] || null;
  }

  // --- Session Operations ---
  async createSession(session: UserSession): Promise<UserSession> {
    const hashedToken = hashSessionToken(session.token);
    const storedSession: UserSession = {
      ...session,
      token: hashedToken,
    };
    this.data.sessions[hashedToken] = storedSession;
    this.flushToDisk();
    return session;
  }

  async getSession(token: string): Promise<{ session: UserSession; user: User } | null> {
    if (!token) return null;
    const hashedToken = hashSessionToken(token);
    let session = this.data.sessions[hashedToken];
    let isLegacy = false;

    if (!session) {
      session = this.data.sessions[token];
      if (session) {
        isLegacy = true;
      }
    }

    if (!session) return null;

    // Check expiration
    if (new Date(session.expires_at).getTime() < Date.now()) {
      delete this.data.sessions[isLegacy ? token : hashedToken];
      this.flushToDisk();
      return null;
    }

    // Migrate legacy session to hashed token
    if (isLegacy) {
      delete this.data.sessions[token];
      const migratedSession: UserSession = {
        ...session,
        token: hashedToken,
      };
      this.data.sessions[hashedToken] = migratedSession;
      this.flushToDisk();
      session = migratedSession;
    }

    const user = await this.getUserById(session.user_id);
    if (!user) {
      delete this.data.sessions[hashedToken];
      this.flushToDisk();
      return null;
    }

    return { session, user };
  }

  async deleteSession(token: string): Promise<boolean> {
    if (!token) return false;
    const hashedToken = hashSessionToken(token);
    let deleted = false;
    if (this.data.sessions[hashedToken]) {
      delete this.data.sessions[hashedToken];
      deleted = true;
    }
    if (this.data.sessions[token]) {
      delete this.data.sessions[token];
      deleted = true;
    }
    if (deleted) {
      this.flushToDisk();
    }
    return deleted;
  }

  // --- Finding Ownership Operations ---
  async registerFindingOwnership(
    findingId: string,
    ownerId: string,
    auditId?: string
  ): Promise<FindingOwnership> {
    const existing = this.data.findingOwnerships[findingId];
    if (existing) {
      return existing;
    }

    const record: FindingOwnership = {
      finding_id: findingId,
      owner_id: ownerId,
      audit_id: auditId,
      created_at: new Date().toISOString(),
    };
    this.data.findingOwnerships[findingId] = record;
    this.flushToDisk();
    return record;
  }

  async getFindingOwner(
    findingId: string,
    auditId?: string,
    ownerId?: string
  ): Promise<string | null> {
    const record = this.data.findingOwnerships[findingId];
    if (!record) return null;
    if (ownerId && record.owner_id !== ownerId) return null;
    if (auditId && record.audit_id && record.audit_id !== auditId) return null;
    return record.owner_id;
  }

  async listUserFindings(ownerId: string): Promise<string[]> {
    return Array.from(
      new Set(
        Object.values(this.data.findingOwnerships)
          .filter((fo) => fo.owner_id === ownerId)
          .map((fo) => fo.finding_id)
      )
    );
  }

  // --- Entitlement Operations ---
  private entitlementKey(userId: string, findingId: string): string {
    return `${userId}:${findingId}`;
  }

  async createEntitlement(entitlement: Entitlement): Promise<Entitlement> {
    const key = this.entitlementKey(entitlement.user_id, entitlement.finding_id);
    const existing = this.data.entitlements[key];
    if (
      existing &&
      existing.status === 'REVOKED' &&
      existing.provider_transaction_id === entitlement.provider_transaction_id
    ) {
      return existing; // Monotonic invariant
    }
    this.data.entitlements[key] = entitlement;
    this.flushToDisk();
    return entitlement;
  }

  async updateEntitlement(entitlement: Entitlement): Promise<Entitlement> {
    const key = this.entitlementKey(entitlement.user_id, entitlement.finding_id);
    this.data.entitlements[key] = entitlement;
    this.flushToDisk();
    return entitlement;
  }

  async getEntitlement(userId: string, findingId: string): Promise<Entitlement | null> {
    const key = this.entitlementKey(userId, findingId);
    return this.data.entitlements[key] || null;
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
  private verificationCompositeKey(userId: string, findingId: string, auditId?: string): string {
    return auditId ? `${userId}:${auditId}:${findingId}` : `${userId}:${findingId}`;
  }

  private outcomeFeeCompositeKey(userId: string, findingId: string, auditId?: string): string {
    return auditId ? `${userId}:${auditId}:${findingId}` : `${userId}:${findingId}`;
  }

  async saveVerification(verification: AuthoritativeVerification): Promise<AuthoritativeVerification> {
    const key = this.verificationCompositeKey(verification.user_id, verification.finding_id, verification.audit_id);
    this.data.verifications[key] = verification;
    this.data.verifications[verification.finding_id] = verification;
    this.flushToDisk();
    return verification;
  }

  async getVerificationByFindingId(findingId: string, userId?: string, auditId?: string): Promise<AuthoritativeVerification | null> {
    if (userId && auditId) {
      const compositeKey = this.verificationCompositeKey(userId, findingId, auditId);
      if (this.data.verifications[compositeKey]) {
        return this.data.verifications[compositeKey];
      }
    }

    const uniqueMap = new Map<string, AuthoritativeVerification>();
    for (const v of Object.values(this.data.verifications)) {
      if (v.finding_id !== findingId) continue;
      if (userId && v.user_id !== userId) continue;
      if (auditId && v.audit_id && v.audit_id !== auditId) continue;
      uniqueMap.set(v.id, v);
    }

    const uniqueMatches = Array.from(uniqueMap.values());
    if (uniqueMatches.length === 0) return null;
    if (!auditId && uniqueMatches.length > 1) {
      // Ambiguous: fail closed and do not guess latest
      return null;
    }
    return uniqueMatches[0];
  }

  // --- Outcome Fee Obligation Operations ---
  async createOutcomeFeeObligation(obligation: OutcomeFeeObligation): Promise<OutcomeFeeObligation> {
    const existing = await this.getOutcomeFeeObligation(obligation.finding_id, obligation.user_id, obligation.audit_id);
    if (existing) {
      return existing;
    }
    const key = this.outcomeFeeCompositeKey(obligation.user_id, obligation.finding_id, obligation.audit_id);
    this.data.outcomeFeeObligations[key] = obligation;
    this.data.outcomeFeeObligationsById[obligation.id] = key;
    this.data.outcomeFeeObligations[obligation.finding_id] = obligation;
    this.flushToDisk();
    return obligation;
  }

  async getOutcomeFeeObligation(findingId: string, userId?: string, auditId?: string): Promise<OutcomeFeeObligation | null> {
    if (userId && auditId) {
      const compositeKey = this.outcomeFeeCompositeKey(userId, findingId, auditId);
      if (this.data.outcomeFeeObligations[compositeKey]) {
        return this.data.outcomeFeeObligations[compositeKey];
      }
    }

    const uniqueMap = new Map<string, OutcomeFeeObligation>();
    for (const ob of Object.values(this.data.outcomeFeeObligations)) {
      if (ob.finding_id !== findingId) continue;
      if (userId && ob.user_id !== userId) continue;
      if (auditId && ob.audit_id && ob.audit_id !== auditId) continue;
      uniqueMap.set(ob.id, ob);
    }

    const uniqueMatches = Array.from(uniqueMap.values());
    if (uniqueMatches.length === 0) return null;
    if (!auditId && uniqueMatches.length > 1) {
      // Ambiguous: fail closed and do not guess latest
      return null;
    }
    return uniqueMatches[0];
  }

  async getOutcomeFeeObligationById(obligationId: string, userId?: string): Promise<OutcomeFeeObligation | null> {
    let ob = Object.values(this.data.outcomeFeeObligations).find((o) => o.id === obligationId);
    if (!ob) {
      const key = this.data.outcomeFeeObligationsById[obligationId];
      if (key) ob = this.data.outcomeFeeObligations[key];
    }
    if (!ob) return null;
    if (userId && ob.user_id !== userId) return null;
    return ob;
  }

  async updateOutcomeFeeObligation(obligation: OutcomeFeeObligation): Promise<OutcomeFeeObligation> {
    const key = this.outcomeFeeCompositeKey(obligation.user_id, obligation.finding_id, obligation.audit_id);
    this.data.outcomeFeeObligations[key] = obligation;
    this.data.outcomeFeeObligationsById[obligation.id] = key;
    this.data.outcomeFeeObligations[obligation.finding_id] = obligation;
    this.flushToDisk();
    return obligation;
  }

  async hasPaidOutcomeFee(userId: string, findingId: string, auditId?: string): Promise<boolean> {
    const ob = await this.getOutcomeFeeObligation(findingId, userId, auditId);
    return Boolean(ob && ob.user_id === userId && (ob.status === 'PAID' || ob.status === 'SETTLED'));
  }

  // --- Webhook Idempotency Operations ---
  async isWebhookEventProcessed(eventId: string): Promise<boolean> {
    return Boolean(this.data.processedWebhooks[eventId] || this.inFlightWebhooks.has(eventId));
  }

  /**
   * Atomically claims a webhook event ID for processing.
   * Returns:
   * - 'PROCEED' if the event is new and now claimed by the caller
   * - 'DUPLICATE' if the event was already successfully processed
   * - 'IN_FLIGHT' if another concurrent request is currently processing this event
   */
  claimWebhookEvent(eventId: string): 'PROCEED' | 'DUPLICATE' | 'IN_FLIGHT' {
    if (this.data.processedWebhooks[eventId]) {
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
    this.data.processedWebhooks[event.event_id] = event;
    this.inFlightWebhooks.delete(event.event_id);
    this.flushToDisk();
  }

  async processOrderCreatedWebhookTransaction(params: {
    event: ProcessedWebhookEvent;
    entitlement: Entitlement;
  }): Promise<{ status: 'SUCCESS' | 'DUPLICATE' }> {
    if (this.data.processedWebhooks[params.event.event_id]) {
      this.inFlightWebhooks.delete(params.event.event_id);
      return { status: 'DUPLICATE' };
    }
    const key = this.entitlementKey(params.entitlement.user_id, params.entitlement.finding_id);
    const existing = this.data.entitlements[key];
    if (
      existing &&
      existing.status === 'REVOKED' &&
      existing.provider_transaction_id === params.entitlement.provider_transaction_id
    ) {
      // Monotonic guard: delayed order_created must not reactivate an already revoked entitlement
      this.data.processedWebhooks[params.event.event_id] = params.event;
      this.inFlightWebhooks.delete(params.event.event_id);
      this.flushToDisk();
      return { status: 'SUCCESS' };
    }
    this.data.entitlements[key] = params.entitlement;
    this.data.processedWebhooks[params.event.event_id] = params.event;
    this.inFlightWebhooks.delete(params.event.event_id);
    this.flushToDisk();
    return { status: 'SUCCESS' };
  }

  async processOrderRefundedWebhookTransaction(params: {
    event: ProcessedWebhookEvent;
    userId: string;
    findingId: string;
    orderId: string;
  }): Promise<{ status: 'SUCCESS' | 'DUPLICATE' | 'NOT_FOUND' | 'MISMATCH'; entitlement?: Entitlement }> {
    if (this.data.processedWebhooks[params.event.event_id]) {
      this.inFlightWebhooks.delete(params.event.event_id);
      return { status: 'DUPLICATE' };
    }
    const key = this.entitlementKey(params.userId, params.findingId);
    const existing = this.data.entitlements[key];
    if (!existing) {
      this.inFlightWebhooks.delete(params.event.event_id);
      return { status: 'NOT_FOUND' };
    }

    // Fail closed: enforce exact transaction ID, provider, type, and eligible status
    const hasValidTransactionId = Boolean(
      existing.provider_transaction_id && existing.provider_transaction_id.trim() !== ''
    );
    const matchesOrder = hasValidTransactionId && existing.provider_transaction_id === params.orderId;
    const matchesProvider = existing.provider === 'LEMON_SQUEEZY';
    const matchesType = existing.type === 'PAID_FIX_PACKAGE';
    const isEligibleStatus = existing.status === 'ACTIVE';

    if (!matchesOrder || !matchesProvider || !matchesType || !isEligibleStatus) {
      this.inFlightWebhooks.delete(params.event.event_id);
      return { status: 'MISMATCH', entitlement: existing };
    }

    const updated: Entitlement = {
      ...existing,
      status: 'REVOKED',
      updated_at: new Date().toISOString(),
    };
    this.data.entitlements[key] = updated;
    this.data.processedWebhooks[params.event.event_id] = params.event;
    this.inFlightWebhooks.delete(params.event.event_id);
    this.flushToDisk();
    return { status: 'SUCCESS', entitlement: updated };
  }

  async processOutcomeFeeWebhookTransaction(params: {
    event: ProcessedWebhookEvent;
    obligation: OutcomeFeeObligation;
    entitlement?: Entitlement;
  }): Promise<{ status: 'SUCCESS' | 'DUPLICATE' }> {
    if (this.data.processedWebhooks[params.event.event_id]) {
      this.inFlightWebhooks.delete(params.event.event_id);
      return { status: 'DUPLICATE' };
    }
    this.data.outcomeFeeObligations[params.obligation.finding_id] = params.obligation;
    this.data.outcomeFeeObligationsById[params.obligation.id] = params.obligation.finding_id;
    if (params.entitlement) {
      const key = this.entitlementKey(params.entitlement.user_id, params.entitlement.finding_id);
      this.data.entitlements[key] = params.entitlement;
    }
    this.data.processedWebhooks[params.event.event_id] = params.event;
    this.inFlightWebhooks.delete(params.event.event_id);
    this.flushToDisk();
    return { status: 'SUCCESS' };
  }

  // --- Audit and Finding Operations ---
  private findingCompositeKey(auditId: string, findingId: string): string {
    return `${auditId}:${findingId}`;
  }

  async saveAudit(audit: PersistedAuditRecord): Promise<PersistedAuditRecord> {
    this.data.audits[audit.audit_id] = audit;
    this.flushToDisk();
    return audit;
  }

  async getAudit(auditId: string): Promise<PersistedAuditRecord | null> {
    return this.data.audits[auditId] || null;
  }

  async listUserAudits(userId: string): Promise<PersistedAuditRecord[]> {
    return Object.values(this.data.audits)
      .filter((a) => a.user_id === userId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  async saveFinding(finding: PersistedFindingRecord): Promise<PersistedFindingRecord> {
    const key = this.findingCompositeKey(finding.audit_id, finding.finding_id);
    this.data.findings[key] = finding;
    this.flushToDisk();
    return finding;
  }

  async saveFindings(findings: PersistedFindingRecord[]): Promise<PersistedFindingRecord[]> {
    for (const finding of findings) {
      const key = this.findingCompositeKey(finding.audit_id, finding.finding_id);
      this.data.findings[key] = finding;
    }
    this.flushToDisk();
    return findings;
  }

  async getFinding(auditId: string, findingId: string): Promise<PersistedFindingRecord | null> {
    const key = this.findingCompositeKey(auditId, findingId);
    return this.data.findings[key] || null;
  }

  async findFindingsByFindingId(findingId: string, userId?: string): Promise<PersistedFindingRecord[]> {
    return Object.values(this.data.findings)
      .filter((f) => {
        if (f.finding_id !== findingId) return false;
        if (userId && f.user_id !== userId) return false;
        return true;
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  async getFindingById(findingId: string, userId?: string, auditId?: string): Promise<PersistedFindingRecord | null> {
    if (auditId) {
      const finding = await this.getFinding(auditId, findingId);
      if (!finding) return null;
      if (userId && finding.user_id !== userId) return null;
      return finding;
    }

    const matches = await this.findFindingsByFindingId(findingId, userId);
    if (matches.length === 1) {
      return matches[0];
    }
    // Ambiguous (> 1) or not found (0): fail closed and do not guess latest
    return null;
  }

  async listAuditFindings(auditId: string): Promise<PersistedFindingRecord[]> {
    return Object.values(this.data.findings).filter((f) => f.audit_id === auditId);
  }

  // --- Health & Readiness Check ---
  async checkReadiness(): Promise<boolean> {
    return Boolean(this.data && typeof this.data.users === 'object');
  }
}

let activeStorage: IStorage | null = null;

export function getStorage(): IStorage {
  if (activeStorage) {
    return activeStorage;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const tursoUrl = process.env.TURSO_DATABASE_URL;

  // In production, silent fallback to local/in-memory storage is strictly prohibited
  if (isProduction) {
    if (!tursoUrl) {
      throw new Error(
        '[FATAL PRODUCTION CONFIGURATION ERROR] In production (NODE_ENV=production), TURSO_DATABASE_URL is required. ' +
        'Silent fallback to local in-memory or filesystem ServerStorage is strictly prohibited.'
      );
    }
    if ((tursoUrl.startsWith('libsql://') || tursoUrl.startsWith('https://')) && !process.env.TURSO_AUTH_TOKEN) {
      throw new Error(
        '[FATAL PRODUCTION CONFIGURATION ERROR] In production with a remote Turso database, TURSO_AUTH_TOKEN is required.'
      );
    }
    const { db, client } = createDatabaseConnection({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN });
    activeStorage = new DrizzleStorageAdapter(db, client);
    return activeStorage;
  }

  // Non-production environments (test / development)
  if (tursoUrl) {
    const { db, client } = createDatabaseConnection({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN });
    activeStorage = new DrizzleStorageAdapter(db, client);
    return activeStorage;
  }

  return ServerStorage.getInstance();
}

export function setStorage(storage: IStorage | null): void {
  activeStorage = storage;
}

