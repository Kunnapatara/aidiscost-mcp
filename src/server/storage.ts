/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { User, UserSession, Entitlement, FindingOwnership, ProcessedWebhookEvent, AuthoritativeVerification, OutcomeFeeObligation } from './types';
import { IStorage } from './storage-interface';
import { createDatabaseConnection } from './db/index';
import { DrizzleStorageAdapter } from './db/adapter';

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
        };
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
    this.data.sessions[session.token] = session;
    this.flushToDisk();
    return session;
  }

  async getSession(token: string): Promise<{ session: UserSession; user: User } | null> {
    if (!token) return null;
    const session = this.data.sessions[token];
    if (!session) return null;

    // Check expiration
    if (new Date(session.expires_at).getTime() < Date.now()) {
      delete this.data.sessions[token];
      this.flushToDisk();
      return null;
    }

    const user = await this.getUserById(session.user_id);
    if (!user) {
      delete this.data.sessions[token];
      this.flushToDisk();
      return null;
    }

    return { session, user };
  }

  async deleteSession(token: string): Promise<boolean> {
    if (this.data.sessions[token]) {
      delete this.data.sessions[token];
      this.flushToDisk();
      return true;
    }
    return false;
  }

  // --- Finding Ownership Operations ---
  async registerFindingOwnership(findingId: string, ownerId: string): Promise<FindingOwnership> {
    const existing = this.data.findingOwnerships[findingId];
    if (existing) {
      return existing;
    }
    const record: FindingOwnership = {
      finding_id: findingId,
      owner_id: ownerId,
      created_at: new Date().toISOString(),
    };
    this.data.findingOwnerships[findingId] = record;
    this.flushToDisk();
    return record;
  }

  async getFindingOwner(findingId: string): Promise<string | null> {
    const record = this.data.findingOwnerships[findingId];
    return record ? record.owner_id : null;
  }

  async listUserFindings(ownerId: string): Promise<string[]> {
    return Object.values(this.data.findingOwnerships)
      .filter((fo) => fo.owner_id === ownerId)
      .map((fo) => fo.finding_id);
  }

  // --- Entitlement Operations ---
  private entitlementKey(userId: string, findingId: string): string {
    return `${userId}:${findingId}`;
  }

  async createEntitlement(entitlement: Entitlement): Promise<Entitlement> {
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
  async saveVerification(verification: AuthoritativeVerification): Promise<AuthoritativeVerification> {
    this.data.verifications[verification.finding_id] = verification;
    this.flushToDisk();
    return verification;
  }

  async getVerificationByFindingId(findingId: string): Promise<AuthoritativeVerification | null> {
    return this.data.verifications[findingId] || null;
  }

  // --- Outcome Fee Obligation Operations ---
  async createOutcomeFeeObligation(obligation: OutcomeFeeObligation): Promise<OutcomeFeeObligation> {
    const existing = this.data.outcomeFeeObligations[obligation.finding_id];
    if (existing) {
      return existing;
    }
    this.data.outcomeFeeObligations[obligation.finding_id] = obligation;
    this.data.outcomeFeeObligationsById[obligation.id] = obligation.finding_id;
    this.flushToDisk();
    return obligation;
  }

  async getOutcomeFeeObligation(findingId: string): Promise<OutcomeFeeObligation | null> {
    return this.data.outcomeFeeObligations[findingId] || null;
  }

  async getOutcomeFeeObligationById(obligationId: string): Promise<OutcomeFeeObligation | null> {
    const findingId = this.data.outcomeFeeObligationsById[obligationId];
    if (!findingId) return null;
    return this.data.outcomeFeeObligations[findingId] || null;
  }

  async updateOutcomeFeeObligation(obligation: OutcomeFeeObligation): Promise<OutcomeFeeObligation> {
    this.data.outcomeFeeObligations[obligation.finding_id] = obligation;
    this.data.outcomeFeeObligationsById[obligation.id] = obligation.finding_id;
    this.flushToDisk();
    return obligation;
  }

  async hasPaidOutcomeFee(userId: string, findingId: string): Promise<boolean> {
    const ob = this.data.outcomeFeeObligations[findingId];
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
    this.data.entitlements[key] = params.entitlement;
    this.data.processedWebhooks[params.event.event_id] = params.event;
    this.inFlightWebhooks.delete(params.event.event_id);
    this.flushToDisk();
    return { status: 'SUCCESS' };
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

