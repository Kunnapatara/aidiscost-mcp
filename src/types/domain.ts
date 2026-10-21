/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type TelemetrySource = 'langfuse' | 'helicone' | 'opentelemetry' | 'custom_logs';

export type CostProvenance = 'SOURCE_REPORTED' | 'CALCULATED' | 'ESTIMATED' | 'UNKNOWN' | 'UNPRICED';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'ESTIMATED' | 'UNPRICED';

export type HealthGrade = 'HEALTHY' | 'USABLE_WITH_ESTIMATES' | 'INSUFFICIENT_DATA';

export type RuleType = 'MODEL_RIGHT_SIZING' | 'RETRY_ERROR_LOOP' | 'REPEATED_CALL_PATTERN';

export type FindingStatus = 'DETECTED' | 'FIX_LOCKED' | 'FIX_UNLOCKED' | 'IN_VERIFICATION' | 'VERIFIED';

export type VerificationStage = 'BASELINE' | 'CUSTOMER_DEPLOYED' | 'OBSERVATION_ACTIVE' | 'VERIFIED_RESULT';

/**
 * Normalized Canonical AIEvent
 * Raw prompts & completions are NEVER stored or rendered.
 */
export interface AIEvent {
  id: string;
  source: TelemetrySource;
  source_event_id: string;
  timestamp: string; // ISO-8601 UTC

  // Model & Execution
  provider: string; // 'openai' | 'anthropic' | 'google' | 'meta' | string
  model: string;    // canonical model name, e.g. 'gpt-4o', 'claude-3-5-sonnet'
  operation: 'chat' | 'completion' | 'embedding' | 'tool_call';

  // Volume & Metrics
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  latency_ms: number;
  status: 'SUCCESS' | 'ERROR' | 'TIMEOUT' | 'RATE_LIMITED';
  error_code?: string;

  // Distributed Context
  trace_id: string;
  parent_id?: string;
  tool_calls: {
    name?: string;
    count: number;
  }[];

  // Privacy & Loop Detection
  prompt_hash?: string; // Non-reversible SHA-256 hash. Never raw text.

  // Authoritative Cost & Provenance Model
  source_reported_cost_usd: number | null;
  calculated_cost_usd: number | null;
  resolved_cost_usd: number;
  cost_provenance: CostProvenance;
  cost_confidence: ConfidenceLevel;

  // Metadata & Quality Signal
  metadata: Record<string, string | number | boolean>;
  quality_signal?: number; // 0.0 - 1.0 (from evals or feedback if present)

  // Simulation & Provenance
  is_simulated?: boolean; // false for authoritative production ingestion, true for simulation/demo
}

/**
 * Data Health Evaluation Gate
 */
export interface DataHealthReport {
  total_events: number;
  unique_events: number;
  duplicate_events_dropped: number;
  time_range: { start: string; end: string };
  model_coverage_pct: number;
  token_coverage_pct: number;
  source_cost_coverage_pct: number;
  pricing_coverage_pct: number;
  latency_coverage_pct: number;
  trace_coverage_pct: number;
  missing_critical_fields: string[];
  warnings: string[];
  analysis_confidence: ConfidenceLevel;
  health_grade: HealthGrade;
  is_sample_data: boolean;
}

/**
 * Evidence supporting a Finding
 */
export interface FindingEvidence {
  affected_event_count: number;
  sample_events: Partial<AIEvent>[];
  metrics_comparison: {
    label: string;
    current_value: string | number;
    target_value: string | number;
    provenance: CostProvenance | 'VERIFIED';
  }[];
  trace_samples: string[];
  mathematical_proof: string;
  baseline_period?: {
    start: string;
    end: string;
  };
}

/**
 * Optimization Finding
 */
export interface Finding {
  id: string;
  audit_id: string;
  rule_id: RuleType;
  title: string;
  summary: string;
  affected_scope: string;
  detection_confidence: ConfidenceLevel;
  cost_confidence: ConfidenceLevel;
  savings_confidence: ConfidenceLevel;
  baseline_spend_usd: number;
  candidate_spend_usd: number;
  estimated_savings_usd: number;
  potential_savings_pct: number;
  annualized_projection_usd: number;
  eligible_event_count: number;
  calculation_method: string;
  assumptions: string[];
  evidence: FindingEvidence;
  status: FindingStatus;
  is_sample_data: boolean;
}

/**
 * Optimization Fix Package ($49 paid level 1 deliverable)
 */
export interface FixPackage {
  finding_id: string;
  unlocked: boolean;
  unlocked_at?: string;
  entitlement_status?: 'LOCKED' | 'DEMO_UNLOCKED' | 'PAID_UNLOCKED';
  purchase_id?: string;
  root_cause_hypothesis: string;
  recommended_approach: string;
  expected_impact: {
    monthly_savings_usd: number;
    latency_delta_ms: number;
    quality_risk: 'NEGLIGIBLE' | 'LOW' | 'MEDIUM' | 'REQUIRES_BENCHMARK';
    projection_basis?: string;
  };
  test_plan: {
    sample_size: number;
    evaluation_criteria: string;
    traffic_allocation_pct: number;
    test_harness_instructions: string;
  };
  acceptance_criteria: string[];
  verification_instructions: string;
  rollback_plan: string;
}

/**
 * Observation Window Empirical Result
 */
export interface VerificationObservationResult {
  pre_cost_per_call_usd: number;
  post_cost_per_call_usd: number;
  observed_reduction_pct: number;
  annualized_realized_savings_usd: number;
  verification_confidence: 'HIGH' | 'MEDIUM' | 'INSUFFICIENT_OBSERVATION';
  verification_notes: string;
  is_authoritative?: boolean;
}

/**
 * Post-Deployment Verification State
 */
export interface VerificationState {
  finding_id: string;
  stage: VerificationStage;
  baseline_window: {
    start: string;
    end: string;
    avg_cost_per_call_usd: number;
    sample_count: number;
  };
  deployment_timestamp?: string;
  observation_window?: {
    start: string;
    end: string;
    sample_event_count: number;
  };
  observed_result?: VerificationObservationResult;
  simulated_result?: VerificationObservationResult;
  is_simulated?: boolean;
  is_authoritative?: boolean;
  post_deployment_file_name?: string;
}

/**
 * Server-Authoritative Verification Record
 * Persisted exclusively on the server in authoritative storage.
 */
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

/**
 * Ingestion Result from any Source Adapter
 */
export interface NormalizedIngestResult {
  source: TelemetrySource;
  events: AIEvent[];
  raw_event_count: number;
  unparseable_records: number;
  duplicate_count: number;
  warnings: string[];
  is_sample_data: boolean;
}

/**
 * Executive Audit Summary
 */
export interface AuditSummary {
  id: string;
  created_at: string;
  source: TelemetrySource;
  total_spend_usd: number;
  potential_savings_usd: number;
  annualized_savings_projection_usd: number;
  health: DataHealthReport;
  findings: Finding[];
  is_sample_data: boolean;
  aggregate_is_deduplicated?: boolean;
  deduplication_note?: string;
}
