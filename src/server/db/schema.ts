/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { sqliteTable, text, real, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_sessions_user_id').on(table.userId),
  index('idx_sessions_expires_at').on(table.expiresAt),
]);

export const findingOwnerships = sqliteTable('finding_ownerships', {
  findingId: text('finding_id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_finding_ownerships_owner_id').on(table.ownerId),
]);

export const entitlements = sqliteTable('entitlements', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  findingId: text('finding_id').notNull(),
  type: text('type').notNull(), // 'PAID_FIX_PACKAGE' | 'DEMO_PREVIEW'
  status: text('status').notNull(), // 'ACTIVE' | 'REVOKED'
  provider: text('provider').notNull(), // 'LEMON_SQUEEZY' | 'DEMO_ADAPTER'
  providerTransactionId: text('provider_transaction_id').notNull(),
  amountUsd: real('amount_usd').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_entitlements_user_finding').on(table.userId, table.findingId),
  index('idx_entitlements_user_id').on(table.userId),
]);

export const webhookEvents = sqliteTable('webhook_events', {
  eventId: text('event_id').primaryKey(),
  provider: text('provider').notNull(),
  eventName: text('event_name').notNull(),
  userId: text('user_id'),
  findingId: text('finding_id'),
  orderId: text('order_id'),
  processedAt: text('processed_at').notNull(),
});

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  findingId: text('finding_id').notNull().references(() => findingOwnerships.findingId, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(), // 'BASELINE' | 'CUSTOMER_DEPLOYED' | 'OBSERVATION_ACTIVE' | 'VERIFIED_RESULT'
  isAuthoritative: integer('is_authoritative', { mode: 'boolean' }).notNull().default(false),
  isSimulated: integer('is_simulated', { mode: 'boolean' }).notNull().default(false),
  baselineStart: text('baseline_start').notNull(),
  baselineEnd: text('baseline_end').notNull(),
  baselineSampleCount: integer('baseline_sample_count').notNull(),
  baselineAvgCostUsd: real('baseline_avg_cost_usd').notNull(),
  deploymentTimestamp: text('deployment_timestamp'),
  observationStart: text('observation_start'),
  observationEnd: text('observation_end'),
  observationSampleCount: integer('observation_sample_count').notNull().default(0),
  postAvgCostUsd: real('post_avg_cost_usd').notNull().default(0),
  observedReductionPct: real('observed_reduction_pct').notNull().default(0),
  verifiedAnnualizedSavingsUsd: real('verified_annualized_savings_usd').notNull().default(0),
  originalEstimatedAnnualizedUsd: real('original_estimated_annualized_usd'),
  verificationConfidence: text('verification_confidence').notNull().default('INSUFFICIENT_OBSERVATION'),
  verificationNotes: text('verification_notes'),
  postDeploymentFileName: text('post_deployment_file_name'),
  verifiedAt: text('verified_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_verifications_finding_id').on(table.findingId),
  index('idx_verifications_user_id').on(table.userId),
]);

export const outcomeFeeObligations = sqliteTable('outcome_fee_obligations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  findingId: text('finding_id').notNull().references(() => findingOwnerships.findingId, { onDelete: 'cascade' }),
  verificationId: text('verification_id').notNull().references(() => verifications.id, { onDelete: 'cascade' }),
  verifiedAnnualizedSavingsUsd: real('verified_annualized_savings_usd').notNull(),
  feeAmountUsd: real('fee_amount_usd').notNull(),
  currency: text('currency').notNull().default('USD'),
  status: text('status').notNull(), // 'PAYABLE' | 'CHECKOUT_CREATED' | 'PAID' | 'SETTLED' | 'FAILED'
  provider: text('provider').notNull().default('LEMON_SQUEEZY'),
  checkoutUrl: text('checkout_url'),
  providerOrderId: text('provider_order_id'),
  providerTransactionId: text('provider_transaction_id'),
  paidAt: text('paid_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_outcome_fee_user_finding').on(table.userId, table.findingId),
  uniqueIndex('idx_outcome_fee_finding_id').on(table.findingId),
  index('idx_outcome_fee_user_id').on(table.userId),
]);

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type FindingOwnershipRow = typeof findingOwnerships.$inferSelect;
export type FindingOwnershipInsert = typeof findingOwnerships.$inferInsert;
export type EntitlementRow = typeof entitlements.$inferSelect;
export type EntitlementInsert = typeof entitlements.$inferInsert;
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
export type WebhookEventInsert = typeof webhookEvents.$inferInsert;
export type VerificationRow = typeof verifications.$inferSelect;
export type VerificationInsert = typeof verifications.$inferInsert;
export type OutcomeFeeObligationRow = typeof outcomeFeeObligations.$inferSelect;
export type OutcomeFeeObligationInsert = typeof outcomeFeeObligations.$inferInsert;
