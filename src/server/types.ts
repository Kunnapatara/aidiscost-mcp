/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface User {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface UserSession {
  token: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export type EntitlementType = 'PAID_FIX_PACKAGE' | 'DEMO_PREVIEW';

export type EntitlementStatus = 'ACTIVE' | 'REVOKED';

export interface Entitlement {
  id: string;
  user_id: string;
  finding_id: string;
  type: EntitlementType;
  status: EntitlementStatus;
  provider: 'LEMON_SQUEEZY' | 'DEMO_ADAPTER';
  provider_transaction_id: string;
  amount_usd: number;
  created_at: string;
  updated_at: string;
}

export interface FindingOwnership {
  finding_id: string;
  owner_id: string;
  created_at: string;
}

export interface ProcessedWebhookEvent {
  event_id: string;
  provider: 'LEMON_SQUEEZY';
  event_name: string;
  user_id?: string;
  finding_id?: string;
  order_id?: string;
  processed_at: string;
}

export interface LemonSqueezyConfig {
  apiKey: string;
  storeId: string;
  variantId: string;
  outcomeFeeVariantId?: string;
  webhookSecret: string;
  isConfigured: boolean;
}

export type OutcomeFeeStatus = 'PAYABLE' | 'CHECKOUT_CREATED' | 'PAID' | 'SETTLED' | 'FAILED';

export interface OutcomeFeeObligation {
  id: string;
  user_id: string;
  finding_id: string;
  verification_id: string;
  verified_annualized_savings_usd: number;
  fee_amount_usd: number;
  currency: string;
  status: OutcomeFeeStatus;
  provider: 'LEMON_SQUEEZY' | 'DEMO_ADAPTER';
  checkout_url?: string;
  provider_order_id?: string;
  provider_transaction_id?: string;
  paid_at?: string;
  created_at: string;
  updated_at: string;
}

export type VerificationStage = 'BASELINE' | 'CUSTOMER_DEPLOYED' | 'OBSERVATION_ACTIVE' | 'VERIFIED_RESULT';

export interface AuthoritativeVerification {
  id: string;
  finding_id: string;
  user_id: string;
  stage: VerificationStage;
  is_authoritative: boolean;
  is_simulated: boolean;
  baseline_start: string;
  baseline_end: string;
  baseline_sample_count: number;
  baseline_avg_cost_usd: number;
  deployment_timestamp?: string;
  observation_start?: string;
  observation_end?: string;
  observation_sample_count: number;
  post_avg_cost_usd: number;
  observed_reduction_pct: number;
  verified_annualized_savings_usd: number;
  original_estimated_annualized_usd?: number;
  verification_confidence: 'HIGH' | 'MEDIUM' | 'INSUFFICIENT_OBSERVATION';
  verification_notes?: string;
  post_deployment_file_name?: string;
  verified_at?: string;
  created_at: string;
  updated_at: string;
}
