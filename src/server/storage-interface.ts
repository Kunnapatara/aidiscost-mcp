/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { User, UserSession, Entitlement, FindingOwnership, ProcessedWebhookEvent, AuthoritativeVerification, OutcomeFeeObligation } from './types';

export interface IStorage {
  // --- User Operations ---
  createUser(user: User): Promise<User>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;

  // --- Session Operations ---
  createSession(session: UserSession): Promise<UserSession>;
  getSession(token: string): Promise<{ session: UserSession; user: User } | null>;
  deleteSession(token: string): Promise<boolean>;

  // --- Finding Ownership Operations ---
  registerFindingOwnership(findingId: string, ownerId: string): Promise<FindingOwnership>;
  getFindingOwner(findingId: string): Promise<string | null>;
  listUserFindings(ownerId: string): Promise<string[]>;

  // --- Entitlement Operations ---
  createEntitlement(entitlement: Entitlement): Promise<Entitlement>;
  getEntitlement(userId: string, findingId: string): Promise<Entitlement | null>;
  hasActivePaidEntitlement(userId: string, findingId: string): Promise<boolean>;

  // --- Authoritative Verification Operations ---
  saveVerification(verification: AuthoritativeVerification): Promise<AuthoritativeVerification>;
  getVerificationByFindingId(findingId: string): Promise<AuthoritativeVerification | null>;

  // --- Outcome Fee Obligation Operations ---
  createOutcomeFeeObligation(obligation: OutcomeFeeObligation): Promise<OutcomeFeeObligation>;
  getOutcomeFeeObligation(findingId: string): Promise<OutcomeFeeObligation | null>;
  getOutcomeFeeObligationById(obligationId: string): Promise<OutcomeFeeObligation | null>;
  updateOutcomeFeeObligation(obligation: OutcomeFeeObligation): Promise<OutcomeFeeObligation>;
  hasPaidOutcomeFee(userId: string, findingId: string): Promise<boolean>;

  // --- Webhook Idempotency Operations ---
  isWebhookEventProcessed(eventId: string): Promise<boolean>;
  claimWebhookEvent(eventId: string): 'PROCEED' | 'DUPLICATE' | 'IN_FLIGHT';
  releaseWebhookClaim(eventId: string): void;
  recordProcessedWebhook(event: ProcessedWebhookEvent): Promise<void>;

  // --- Atomic Commercial Webhook Transactions ---
  /**
   * Atomically records the processed webhook event and activates/updates the entitlement
   * inside a single database transaction. If the event ID was already committed, returns 'DUPLICATE'.
   */
  processOrderCreatedWebhookTransaction?(params: {
    event: ProcessedWebhookEvent;
    entitlement: Entitlement;
  }): Promise<{ status: 'SUCCESS' | 'DUPLICATE' }>;

  /**
   * Atomically records the processed webhook event and updates the outcome fee obligation status
   * to 'PAID'/'SETTLED' inside a single database transaction. If the event ID was already committed, returns 'DUPLICATE'.
   */
  processOutcomeFeeWebhookTransaction?(params: {
    event: ProcessedWebhookEvent;
    obligation: OutcomeFeeObligation;
    entitlement?: Entitlement;
  }): Promise<{ status: 'SUCCESS' | 'DUPLICATE' }>;

  // --- Test & Lifecycle Helpers ---
  clearAll?(): Promise<void> | void;
  setTestMode?(isTest: boolean): void;
}
