/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuditSummary,
  DataHealthReport,
  Finding,
  FixPackage,
  TelemetrySource,
  VerificationState,
} from '../../types/domain';
import {
  AUDIT_SNAPSHOT_SCHEMA_VERSION,
  PersistedAuditSnapshot,
  PersistedAuditSummary,
  PersistedEventSample,
  PersistedFinding,
  PersistedFindingEvidence,
  PersistedFixPackage,
  PersistedVerificationState,
} from './types';

const DB_NAME = 'aidiscost_local_db';
const DB_VERSION = 1;
const STORE_NAME = 'audit_snapshots';

/**
 * Strict allowlisted keys for event samples in evidence.
 * Any key not explicitly in this set is stripped during persistence.
 */
const ALLOWED_SAMPLE_EVENT_KEYS = new Set<string>([
  'id',
  'source',
  'source_event_id',
  'timestamp',
  'provider',
  'model',
  'operation',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'latency_ms',
  'status',
  'error_code',
  'trace_id',
  'parent_id',
  'tool_calls',
  'prompt_hash',
  'source_reported_cost_usd',
  'calculated_cost_usd',
  'resolved_cost_usd',
  'cost_provenance',
  'cost_confidence',
  'quality_signal',
]);

/**
 * Keys explicitly banned anywhere in the persisted snapshot.
 */
const DISALLOWED_KEYS = new Set<string>([
  'prompt',
  'completion',
  'raw_prompt',
  'raw_completion',
  'request',
  'response',
  'request_body',
  'response_body',
  'raw_payload',
  'payload',
  'body',
  'content',
  'metadata',
  'stack',
  'stack_trace',
  'exception',
  'error_object',
  'error_message',
  'provider_response',
  'headers',
  'authorization',
  'api_key',
  'token',
  'cookie',
  'secret',
  'credential',
  'credentials',
]);

export class AuditStore {
  private static dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Internal database opener with lazy initialization
   */
  private static getDB(): Promise<IDBDatabase> {
    if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('IndexedDB is not available in current environment'));
    }

    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        try {
          const req = indexedDB.open(DB_NAME, DB_VERSION);

          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
              const store = db.createObjectStore(STORE_NAME, { keyPath: 'audit_id' });
              store.createIndex('created_at', 'created_at', { unique: false });
            }
          };

          req.onsuccess = () => {
            resolve(req.result);
          };

          req.onerror = () => {
            reject(req.error || new Error('Failed to open IndexedDB'));
          };

          req.onblocked = () => {
            console.warn('[AuditStore] IndexedDB open blocked by other tabs');
          };
        } catch (err) {
          reject(err);
        }
      });
    }

    return this.dbPromise;
  }

  /**
   * Sanitizes a sample event into a strict allowlist-only DTO.
   * Strips metadata, raw prompts/completions, and any unallowed fields.
   */
  static sanitizeSampleEvent(raw: unknown): PersistedEventSample {
    if (!raw || typeof raw !== 'object') return {};
    const src = raw as Record<string, unknown>;
    const clean: Record<string, unknown> = {};

    for (const key of ALLOWED_SAMPLE_EVENT_KEYS) {
      if (src[key] !== undefined) {
        clean[key] = src[key];
      }
    }

    return clean as PersistedEventSample;
  }

  /**
   * Sanitizes finding evidence into a privacy-safe DTO.
   */
  static sanitizeEvidence(evidence: unknown): PersistedFindingEvidence {
    if (!evidence || typeof evidence !== 'object') {
      return {
        affected_event_count: 0,
        sample_events: [],
        metrics_comparison: [],
        trace_samples: [],
        mathematical_proof: '',
      };
    }

    const ev = evidence as Partial<PersistedFindingEvidence>;
    const sampleEvents = Array.isArray(ev.sample_events)
      ? ev.sample_events.map(e => this.sanitizeSampleEvent(e))
      : [];

    return {
      affected_event_count: typeof ev.affected_event_count === 'number' ? ev.affected_event_count : 0,
      sample_events: sampleEvents,
      metrics_comparison: Array.isArray(ev.metrics_comparison) ? [...ev.metrics_comparison] : [],
      trace_samples: Array.isArray(ev.trace_samples) ? [...ev.trace_samples] : [],
      mathematical_proof: typeof ev.mathematical_proof === 'string' ? ev.mathematical_proof : '',
    };
  }

  /**
   * Sanitizes a runtime Finding into a PersistedFinding DTO.
   */
  static sanitizeFinding(finding: Finding): PersistedFinding {
    return {
      id: finding.id,
      audit_id: finding.audit_id,
      rule_id: finding.rule_id,
      title: finding.title,
      summary: finding.summary,
      affected_scope: finding.affected_scope,
      detection_confidence: finding.detection_confidence,
      cost_confidence: finding.cost_confidence,
      savings_confidence: finding.savings_confidence,
      baseline_spend_usd: finding.baseline_spend_usd,
      candidate_spend_usd: finding.candidate_spend_usd,
      estimated_savings_usd: finding.estimated_savings_usd,
      potential_savings_pct: finding.potential_savings_pct,
      annualized_projection_usd: finding.annualized_projection_usd,
      eligible_event_count: finding.eligible_event_count,
      calculation_method: finding.calculation_method,
      assumptions: Array.isArray(finding.assumptions) ? [...finding.assumptions] : [],
      evidence: this.sanitizeEvidence(finding.evidence),
      status: finding.status,
      is_sample_data: Boolean(finding.is_sample_data),
    };
  }

  /**
   * Sanitizes a runtime FixPackage into an allowlisted PersistedFixPackage DTO.
   * Strips raw_payload, metadata, prompt, completion, tokens, and arbitrary user objects.
   */
  static sanitizeFixPackage(pkg: FixPackage): PersistedFixPackage {
    const raw = pkg as unknown as Record<string, unknown>;
    const rawImpact = (raw.expected_impact || {}) as Record<string, unknown>;
    const rawTestPlan = (raw.test_plan || {}) as Record<string, unknown>;

    return {
      finding_id: String(raw.finding_id || ''),
      unlocked: Boolean(raw.unlocked),
      unlocked_at: raw.unlocked_at ? String(raw.unlocked_at) : undefined,
      entitlement_status: (['LOCKED', 'DEMO_UNLOCKED', 'PAID_UNLOCKED'].includes(raw.entitlement_status as string)
        ? raw.entitlement_status
        : (Boolean(raw.unlocked) ? 'DEMO_UNLOCKED' : 'LOCKED')) as 'LOCKED' | 'DEMO_UNLOCKED' | 'PAID_UNLOCKED',
      purchase_id: raw.purchase_id ? String(raw.purchase_id) : undefined,
      root_cause_hypothesis: String(raw.root_cause_hypothesis || ''),
      recommended_approach: String(raw.recommended_approach || ''),
      expected_impact: {
        monthly_savings_usd: Number(rawImpact.monthly_savings_usd) || 0,
        latency_delta_ms: Number(rawImpact.latency_delta_ms) || 0,
        quality_risk: (['NEGLIGIBLE', 'LOW', 'MEDIUM', 'REQUIRES_BENCHMARK'].includes(rawImpact.quality_risk as string)
          ? rawImpact.quality_risk
          : 'LOW') as 'NEGLIGIBLE' | 'LOW' | 'MEDIUM' | 'REQUIRES_BENCHMARK',
        projection_basis: rawImpact.projection_basis ? String(rawImpact.projection_basis) : undefined,
      },
      test_plan: {
        sample_size: Number(rawTestPlan.sample_size) || 0,
        evaluation_criteria: String(rawTestPlan.evaluation_criteria || ''),
        traffic_allocation_pct: Number(rawTestPlan.traffic_allocation_pct) || 0,
        test_harness_instructions: String(rawTestPlan.test_harness_instructions || ''),
      },
      acceptance_criteria: Array.isArray(raw.acceptance_criteria)
        ? raw.acceptance_criteria.map(c => String(c))
        : [],
      verification_instructions: String(raw.verification_instructions || ''),
      rollback_plan: String(raw.rollback_plan || ''),
    };
  }

  /**
   * Sanitizes a runtime VerificationState into an allowlisted PersistedVerificationState DTO.
   * Strips raw_response, metadata, headers, tokens, and arbitrary runtime objects.
   */
  static sanitizeVerificationState(state: VerificationState): PersistedVerificationState {
    const raw = state as unknown as Record<string, unknown>;
    const rawBase = (raw.baseline_window || {}) as Record<string, unknown>;
    const rawObsWindow = raw.observation_window as Record<string, unknown> | undefined;
    const rawResult = raw.observed_result as Record<string, unknown> | undefined;

    const clean: PersistedVerificationState = {
      finding_id: String(raw.finding_id || ''),
      stage: (['BASELINE', 'CUSTOMER_DEPLOYED', 'OBSERVATION_ACTIVE', 'VERIFIED_RESULT'].includes(raw.stage as string)
        ? raw.stage
        : 'BASELINE') as VerificationState['stage'],
      baseline_window: {
        start: String(rawBase.start || ''),
        end: String(rawBase.end || ''),
        avg_cost_per_call_usd: Number(rawBase.avg_cost_per_call_usd) || 0,
        sample_count: Number(rawBase.sample_count) || 0,
      },
      deployment_timestamp: raw.deployment_timestamp ? String(raw.deployment_timestamp) : undefined,
    };

    if (rawObsWindow && typeof rawObsWindow === 'object') {
      clean.observation_window = {
        start: String(rawObsWindow.start || ''),
        end: String(rawObsWindow.end || ''),
        sample_event_count: Number(rawObsWindow.sample_event_count) || 0,
      };
    }

    if (rawResult && typeof rawResult === 'object') {
      clean.observed_result = {
        pre_cost_per_call_usd: Number(rawResult.pre_cost_per_call_usd) || 0,
        post_cost_per_call_usd: Number(rawResult.post_cost_per_call_usd) || 0,
        observed_reduction_pct: Number(rawResult.observed_reduction_pct) || 0,
        annualized_realized_savings_usd: Number(rawResult.annualized_realized_savings_usd) || 0,
        verification_confidence: (['HIGH', 'MEDIUM', 'INSUFFICIENT_OBSERVATION'].includes(rawResult.verification_confidence as string)
          ? rawResult.verification_confidence
          : 'MEDIUM') as 'HIGH' | 'MEDIUM' | 'INSUFFICIENT_OBSERVATION',
        verification_notes: String(rawResult.verification_notes || ''),
        is_authoritative: Boolean(rawResult.is_authoritative),
      };
    }

    const rawSimResult = raw.simulated_result as Record<string, unknown> | undefined;
    if (rawSimResult && typeof rawSimResult === 'object') {
      clean.simulated_result = {
        pre_cost_per_call_usd: Number(rawSimResult.pre_cost_per_call_usd) || 0,
        post_cost_per_call_usd: Number(rawSimResult.post_cost_per_call_usd) || 0,
        observed_reduction_pct: Number(rawSimResult.observed_reduction_pct) || 0,
        annualized_realized_savings_usd: Number(rawSimResult.annualized_realized_savings_usd) || 0,
        verification_confidence: (['HIGH', 'MEDIUM', 'INSUFFICIENT_OBSERVATION'].includes(rawSimResult.verification_confidence as string)
          ? rawSimResult.verification_confidence
          : 'MEDIUM') as 'HIGH' | 'MEDIUM' | 'INSUFFICIENT_OBSERVATION',
        verification_notes: String(rawSimResult.verification_notes || ''),
        is_authoritative: false,
      };
    }

    if (typeof raw.is_simulated === 'boolean') {
      clean.is_simulated = raw.is_simulated;
    }

    if (typeof raw.post_deployment_file_name === 'string') {
      clean.post_deployment_file_name = String(raw.post_deployment_file_name);
    }

    return clean;
  }

  /**
   * Builds a canonical, privacy-safe PersistedAuditSnapshot from current runtime state
   */
  static buildSnapshot(params: {
    auditSummary: AuditSummary;
    healthReport: DataHealthReport;
    findings?: Finding[];
    fixPackages: Map<string, FixPackage> | Record<string, FixPackage>;
    verificationStates: Map<string, VerificationState> | Record<string, VerificationState>;
    activeFindingId?: string;
    currentRoute?: string;
  }): PersistedAuditSnapshot {
    const { auditSummary, healthReport, findings, fixPackages, verificationStates, activeFindingId, currentRoute } = params;

    // Convert and sanitize fix packages through allowlist DTO
    const rawFixPackages: Record<string, FixPackage> =
      fixPackages instanceof Map ? Object.fromEntries(fixPackages.entries()) : { ...fixPackages };
    const persistedFixPackages: Record<string, PersistedFixPackage> = {};
    for (const [id, pkg] of Object.entries(rawFixPackages)) {
      if (pkg && typeof pkg === 'object') {
        persistedFixPackages[id] = this.sanitizeFixPackage(pkg);
      }
    }

    // Convert and sanitize verification states through allowlist DTO
    const rawVerificationStates: Record<string, VerificationState> =
      verificationStates instanceof Map ? Object.fromEntries(verificationStates.entries()) : { ...verificationStates };
    const persistedVerificationStates: Record<string, PersistedVerificationState> = {};
    for (const [id, state] of Object.entries(rawVerificationStates)) {
      if (state && typeof state === 'object') {
        persistedVerificationStates[id] = this.sanitizeVerificationState(state);
      }
    }

    const runtimeFindings = findings || auditSummary.findings || [];
    const persistedFindings = runtimeFindings.map(f => this.sanitizeFinding(f));

    const persistedSummary: PersistedAuditSummary = {
      id: auditSummary.id,
      created_at: auditSummary.created_at || new Date().toISOString(),
      source: auditSummary.source,
      total_spend_usd: auditSummary.total_spend_usd,
      potential_savings_usd: auditSummary.potential_savings_usd,
      annualized_savings_projection_usd: auditSummary.annualized_savings_projection_usd,
      health: healthReport,
      findings: persistedFindings,
      is_sample_data: Boolean(auditSummary.is_sample_data),
      aggregate_is_deduplicated: Boolean(auditSummary.aggregate_is_deduplicated),
      deduplication_note: auditSummary.deduplication_note ? String(auditSummary.deduplication_note) : undefined,
    };

    return {
      schema_version: AUDIT_SNAPSHOT_SCHEMA_VERSION,
      audit_id: auditSummary.id,
      created_at: persistedSummary.created_at,
      source: auditSummary.source,
      is_sample_data: Boolean(auditSummary.is_sample_data),
      health: healthReport,
      audit_summary: persistedSummary,
      findings: persistedFindings,
      fix_packages: persistedFixPackages,
      verification_states: persistedVerificationStates,
      active_finding_id: activeFindingId,
      current_route: currentRoute,
    };
  }

  /**
   * Deeply scans an object or array to ensure no disallowed keys exist anywhere.
   */
  private static containsDisallowedKeys(obj: unknown): boolean {
    if (!obj || typeof obj !== 'object') return false;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (this.containsDisallowedKeys(item)) return true;
      }
      return false;
    }

    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (DISALLOWED_KEYS.has(key.toLowerCase())) {
        return true;
      }
      if (typeof record[key] === 'object' && record[key] !== null) {
        if (this.containsDisallowedKeys(record[key])) return true;
      }
    }

    return false;
  }

  /**
   * Validates snapshot structural, version, and privacy integrity.
   * Returns true if valid, false if corrupt, unsupported version, or privacy violation.
   */
  static validateSnapshot(data: unknown): data is PersistedAuditSnapshot {
    if (!data || typeof data !== 'object') return false;
    const s = data as Partial<PersistedAuditSnapshot>;

    // Schema version gate
    if (s.schema_version !== AUDIT_SNAPSHOT_SCHEMA_VERSION) {
      return false;
    }

    // Required fields check
    if (
      typeof s.audit_id !== 'string' ||
      !s.audit_id.trim() ||
      typeof s.created_at !== 'string' ||
      typeof s.source !== 'string' ||
      typeof s.is_sample_data !== 'boolean' ||
      !s.health ||
      typeof s.health !== 'object' ||
      !s.audit_summary ||
      typeof s.audit_summary !== 'object' ||
      !Array.isArray(s.findings) ||
      !s.fix_packages ||
      typeof s.fix_packages !== 'object' ||
      !s.verification_states ||
      typeof s.verification_states !== 'object'
    ) {
      return false;
    }

    // Stable ID invariant
    if (s.audit_id !== s.audit_summary.id) {
      return false;
    }

    // Check findings integrity
    for (const f of s.findings) {
      if (
        !f ||
        typeof f !== 'object' ||
        typeof f.id !== 'string' ||
        typeof f.audit_id !== 'string' ||
        typeof f.baseline_spend_usd !== 'number' ||
        typeof f.candidate_spend_usd !== 'number' ||
        typeof f.estimated_savings_usd !== 'number' ||
        !f.evidence ||
        !Array.isArray(f.evidence.sample_events)
      ) {
        return false;
      }

      // Check sample_events privacy allowlist
      for (const sample of f.evidence.sample_events) {
        if (!sample || typeof sample !== 'object') return false;
        const keys = Object.keys(sample);
        for (const k of keys) {
          if (!ALLOWED_SAMPLE_EVENT_KEYS.has(k)) {
            return false; // Rejects any unallowed key (e.g. metadata, prompt, user_text)
          }
        }
      }
    }

    // Check fix_packages integrity
    for (const [findingId, pkg] of Object.entries(s.fix_packages)) {
      if (
        !pkg ||
        typeof pkg !== 'object' ||
        typeof pkg.finding_id !== 'string' ||
        typeof pkg.unlocked !== 'boolean' ||
        typeof pkg.root_cause_hypothesis !== 'string' ||
        typeof pkg.recommended_approach !== 'string' ||
        !pkg.expected_impact ||
        typeof pkg.expected_impact !== 'object' ||
        !pkg.test_plan ||
        typeof pkg.test_plan !== 'object' ||
        !Array.isArray(pkg.acceptance_criteria)
      ) {
        return false;
      }
    }

    // Check verification_states integrity
    for (const [findingId, state] of Object.entries(s.verification_states)) {
      if (
        !state ||
        typeof state !== 'object' ||
        typeof state.finding_id !== 'string' ||
        typeof state.stage !== 'string' ||
        !state.baseline_window ||
        typeof state.baseline_window !== 'object'
      ) {
        return false;
      }
    }

    // Privacy boundary deep scan: reject any snapshot containing disallowed keys anywhere
    if (this.containsDisallowedKeys(s)) {
      return false;
    }

    return true;
  }

  /**
   * Saves a canonical audit snapshot into IndexedDB.
   * Storage failures are caught and handled gracefully without crashing the app.
   */
  static async saveAuditSnapshot(snapshot: PersistedAuditSnapshot): Promise<boolean> {
    if (!this.validateSnapshot(snapshot)) {
      console.warn('[AuditStore] Refusing to persist invalid or privacy-violating snapshot');
      return false;
    }

    try {
      const db = await this.getDB();
      return new Promise<boolean>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(snapshot);

        req.onsuccess = () => resolve(true);
        req.onerror = () => {
          console.warn('[AuditStore] Failed to write audit snapshot to IndexedDB');
          resolve(false);
        };
        tx.onerror = () => {
          console.warn('[AuditStore] Transaction error writing snapshot');
          resolve(false);
        };
      });
    } catch (err) {
      console.warn('[AuditStore] Storage save error:', (err as Error).message);
      return false;
    }
  }

  /**
   * Loads an audit snapshot by ID from IndexedDB.
   * Corrupt or invalid records are caught safely and return null.
   */
  static async loadAuditSnapshot(auditId: string): Promise<PersistedAuditSnapshot | null> {
    try {
      const db = await this.getDB();
      return new Promise<PersistedAuditSnapshot | null>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(auditId);

        req.onsuccess = () => {
          const record = req.result;
          if (!record) {
            resolve(null);
            return;
          }

          if (this.validateSnapshot(record)) {
            resolve(record);
          } else {
            console.warn(`[AuditStore] Snapshot ${auditId} failed validation; returning null`);
            resolve(null);
          }
        };

        req.onerror = () => {
          console.warn(`[AuditStore] Error reading audit ${auditId}`);
          resolve(null);
        };
      });
    } catch (err) {
      console.warn('[AuditStore] Storage load error:', (err as Error).message);
      return null;
    }
  }

  /**
   * Loads the most recently created valid audit snapshot.
   */
  static async loadLatestAuditSnapshot(): Promise<PersistedAuditSnapshot | null> {
    try {
      const db = await this.getDB();
      return new Promise<PersistedAuditSnapshot | null>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);

        const allReq = store.getAll();
        allReq.onsuccess = () => {
          const records: unknown[] = allReq.result || [];
          const validRecords = records.filter((r): r is PersistedAuditSnapshot => this.validateSnapshot(r));

          if (validRecords.length === 0) {
            resolve(null);
            return;
          }

          validRecords.sort((a, b) => {
            const timeA = new Date(a.created_at).getTime();
            const timeB = new Date(b.created_at).getTime();
            return timeB - timeA;
          });

          resolve(validRecords[0]);
        };

        allReq.onerror = () => {
          console.warn('[AuditStore] Error loading all snapshots');
          resolve(null);
        };
      });
    } catch (err) {
      console.warn('[AuditStore] Storage load latest error:', (err as Error).message);
      return null;
    }
  }

  /**
   * Deletes an audit snapshot by ID.
   */
  static async deleteAuditSnapshot(auditId: string): Promise<boolean> {
    try {
      const db = await this.getDB();
      return new Promise<boolean>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(auditId);

        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  /**
   * Clears all persisted snapshots (useful for tests or full data reset).
   */
  static async clearAll(): Promise<boolean> {
    try {
      const db = await this.getDB();
      return new Promise<boolean>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();

        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  /**
   * Clears all persisted audit snapshots (alias for clearAll).
   */
  static async clearAuditSnapshots(): Promise<boolean> {
    return this.clearAll();
  }
}

