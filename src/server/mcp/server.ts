/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IngestionPipeline } from '../../engine/ingestion/pipeline';
import { evaluateDataHealth } from '../../engine/health/evaluator';
import { runOptimizationRules } from '../../engine/rules/evaluator';
import { generateFixPackage } from '../../engine/fix/generator';
import {
  evaluateVerification,
  isAuthoritativeVerified,
  getAuthoritativeVerifiedSavings,
} from '../../engine/verification/comparator';
import { getStorage } from '../storage';
import { IStorage } from '../storage-interface';
import { User, PersistedAuditRecord, PersistedFindingRecord, AuthoritativeVerification } from '../types';
import { Finding, TelemetrySource, VerificationState } from '../../types/domain';

const VALID_SOURCES: TelemetrySource[] = ['langfuse', 'helicone', 'opentelemetry', 'custom_logs'];

function persistedFindingToDomain(record: PersistedFindingRecord): Finding {
  return {
    id: record.finding_id,
    audit_id: record.audit_id,
    rule_id: record.rule_id as any,
    title: record.title,
    summary: record.summary,
    affected_scope: record.affected_scope || '',
    detection_confidence: (record.detection_confidence as any) || 'MEDIUM',
    cost_confidence: 'HIGH',
    savings_confidence: 'HIGH',
    baseline_spend_usd: record.baseline_spend_usd,
    candidate_spend_usd: record.candidate_spend_usd ?? 0,
    estimated_savings_usd: record.estimated_savings_usd,
    potential_savings_pct: record.potential_savings_pct ?? 0,
    annualized_projection_usd: record.annualized_projection_usd,
    eligible_event_count: record.eligible_event_count,
    calculation_method: record.calculation_method || '',
    assumptions: record.assumptions || [],
    evidence: (record.evidence as any) || {
      affected_event_count: record.eligible_event_count,
      sample_events: [],
      metrics_comparison: [],
      trace_samples: [],
      mathematical_proof: '',
    },
    status: record.status as any,
    is_sample_data: record.is_sample_data,
  };
}

/**
 * Creates a request-scoped McpServer instance.
 * Binds the authenticated user identity to the tool execution context for isolation.
 */
export function createMcpServer(user?: User, customStorage?: IStorage): McpServer {
  const server = new McpServer({
    name: 'aidiscost-mcp',
    version: '1.0.0',
  });

  const storage = customStorage || getStorage();

  // Tool 1: run_cost_audit
  (server as any).registerTool(
    'run_cost_audit',
    {
      description:
        'Ingest raw telemetry data (CSV, JSON, JSONL, NDJSON), evaluate data health, and detect AI cost optimization opportunities.',
      inputSchema: {
        telemetry_data: z.string(),
        source_hint: z.string().optional(),
        file_name: z.string().optional(),
      },
    },
    async (args: { telemetry_data: string; source_hint?: string; file_name?: string }) => {
      try {
        const { telemetry_data, source_hint, file_name } = args;

        // Bounded payload validation
        if (!telemetry_data || typeof telemetry_data !== 'string') {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'INVALID_INPUT',
                  message: 'Telemetry data must be a non-empty string.',
                }),
              },
            ],
          };
        }

        if (telemetry_data.length > 1_800_000) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'PAYLOAD_TOO_LARGE',
                  message: 'Telemetry payload exceeds maximum permitted length of 1.8MB.',
                }),
              },
            ],
          };
        }

        let parsedSource: TelemetrySource | undefined;
        if (source_hint) {
          if (VALID_SOURCES.includes(source_hint as TelemetrySource)) {
            parsedSource = source_hint as TelemetrySource;
          } else {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'INVALID_SOURCE_HINT',
                    message: `Invalid source_hint. Supported sources: ${VALID_SOURCES.join(', ')}`,
                  }),
                },
              ],
            };
          }
        }

        // 1. Ingest telemetry through existing pipeline
        const ingestPipelineResult = IngestionPipeline.ingest(telemetry_data, {
          source: parsedSource,
          fileName: file_name,
        });

        if (!ingestPipelineResult.success) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: ingestPipelineResult.errorCode || 'INGESTION_FAILED',
                  message: ingestPipelineResult.errorMessage || 'Failed to parse telemetry data.',
                  warnings: ingestPipelineResult.warnings,
                  format: ingestPipelineResult.format,
                }),
              },
            ],
          };
        }

        const events = ingestPipelineResult.ingestResult.events;

        // 2. Evaluate data health using existing evaluator
        const health = evaluateDataHealth(
          events,
          ingestPipelineResult.ingestResult.raw_event_count,
          ingestPipelineResult.ingestResult.duplicate_count,
          ingestPipelineResult.ingestResult.is_sample_data
        );

        // 3. Execute optimization rules
        const auditSummary = runOptimizationRules(
          events,
          ingestPipelineResult.detectedSource === 'SOURCE_UNCERTAIN'
            ? 'custom_logs'
            : ingestPipelineResult.detectedSource,
          health,
          ingestPipelineResult.ingestResult.is_sample_data
        );

        // 4. If authenticated, persist audit & findings and register finding ownerships
        let ownershipConfirmed = false;
        let ownershipWarning: string | undefined;
        let confirmedCount = 0;
        let conflictCount = 0;
        let failedCount = 0;
        const verifiedOwnerFindingIds = new Set<string>();

        if (user) {
          try {
            const auditRecord: PersistedAuditRecord = {
              audit_id: auditSummary.id,
              user_id: user.id,
              source:
                ingestPipelineResult.detectedSource === 'SOURCE_UNCERTAIN'
                  ? 'custom_logs'
                  : ingestPipelineResult.detectedSource,
              total_spend_usd: auditSummary.total_spend_usd,
              potential_savings_usd: auditSummary.potential_savings_usd,
              annualized_savings_projection_usd: auditSummary.annualized_savings_projection_usd,
              is_sample_data: auditSummary.is_sample_data,
              health_grade: health.health_grade,
              health_report: health,
              findings_count: auditSummary.findings.length,
              created_at: auditSummary.created_at || new Date().toISOString(),
            };
            await storage.saveAudit(auditRecord);

            if (auditSummary.findings.length > 0) {
              const findingRecords: PersistedFindingRecord[] = auditSummary.findings.map((f) => ({
                audit_id: auditSummary.id,
                finding_id: f.id,
                user_id: user.id,
                rule_id: f.rule_id,
                title: f.title,
                summary: f.summary,
                affected_scope: f.affected_scope,
                detection_confidence: f.detection_confidence,
                baseline_spend_usd: f.baseline_spend_usd,
                candidate_spend_usd: f.candidate_spend_usd,
                estimated_savings_usd: f.estimated_savings_usd,
                potential_savings_pct: f.potential_savings_pct,
                annualized_projection_usd: f.annualized_projection_usd,
                eligible_event_count: f.eligible_event_count,
                calculation_method: f.calculation_method,
                assumptions: f.assumptions,
                evidence: f.evidence as any,
                status: 'DETECTED',
                is_sample_data: auditSummary.is_sample_data,
                created_at: auditSummary.created_at || new Date().toISOString(),
              }));
              await storage.saveFindings(findingRecords);
            }
          } catch (persistErr) {
            console.warn('[MCP run_cost_audit] Warning persisting audit and findings:', (persistErr as Error).message);
          }
        }

        if (user && auditSummary.findings.length > 0) {
          try {
            for (const finding of auditSummary.findings) {
              try {
                const currentOwner = await storage.getFindingOwner(finding.id);
                if (!currentOwner) {
                  await storage.registerFindingOwnership(finding.id, user.id);
                } else if (currentOwner !== user.id) {
                  // Do not overwrite ownership or disclose other user's identity
                  conflictCount++;
                  continue;
                }

                // Explicitly read back stored owner to verify persistence
                const verifiedOwner = await storage.getFindingOwner(finding.id);
                if (verifiedOwner === user.id) {
                  confirmedCount++;
                  verifiedOwnerFindingIds.add(finding.id);
                } else {
                  failedCount++;
                }
              } catch {
                failedCount++;
              }
            }

            const totalFindings = auditSummary.findings.length;
            if (confirmedCount === totalFindings && totalFindings > 0) {
              ownershipConfirmed = true;
              ownershipWarning = undefined;
            } else {
              ownershipConfirmed = false;

              // Compose accurate warning message detailing all observed outcomes
              if (conflictCount === totalFindings) {
                ownershipWarning = 'All findings from this audit are already owned by another account and were not re-assigned.';
              } else if (failedCount === totalFindings) {
                ownershipWarning = `Ownership verification failed for ${failedCount} of ${totalFindings} findings.`;
              } else if (conflictCount > 0 && failedCount > 0) {
                const prefix = confirmedCount > 0 ? `${confirmedCount} registered to your account, ` : '';
                ownershipWarning = `Partial ownership outcome: ${prefix}${conflictCount} already owned by another account, ownership verification failed for ${failedCount} finding${failedCount > 1 ? 's' : ''}.`;
              } else if (conflictCount > 0 && confirmedCount > 0) {
                ownershipWarning = `Partial ownership: ${confirmedCount} of ${totalFindings} findings registered to your account. ${conflictCount} findings are already owned by another account.`;
              } else if (failedCount > 0) {
                ownershipWarning = `Ownership verification failed for ${failedCount} of ${totalFindings} findings.`;
              } else {
                ownershipWarning = 'Failed to verify finding ownership records.';
              }
            }
          } catch {
            ownershipConfirmed = false;
            ownershipWarning = 'Failed to persist finding ownership records to database.';
          }
        }

        // Return structured audit results
        const responsePayload = {
          audit_id: auditSummary.id,
          created_at: auditSummary.created_at,
          detected_source: ingestPipelineResult.detectedSource,
          detected_format: ingestPipelineResult.format,
          total_spend_usd: auditSummary.total_spend_usd,
          potential_savings_usd: auditSummary.potential_savings_usd,
          annualized_savings_projection_usd: auditSummary.annualized_savings_projection_usd,
          is_sample_data: auditSummary.is_sample_data,
          data_health: {
            health_grade: health.health_grade,
            analysis_confidence: health.analysis_confidence,
            total_events: health.total_events,
            unique_events: health.unique_events,
            model_coverage_pct: health.model_coverage_pct,
            cost_coverage_pct: health.pricing_coverage_pct,
            warnings: health.warnings,
          },
          findings_count: auditSummary.findings.length,
          findings: auditSummary.findings.map((f) => ({
            id: f.id,
            rule_id: f.rule_id,
            title: f.title,
            summary: f.summary,
            estimated_savings_usd: f.estimated_savings_usd,
            annualized_projection_usd: f.annualized_projection_usd,
            confidence: f.detection_confidence,
            affected_scope: f.affected_scope,
            eligible_event_count: f.eligible_event_count,
            fix_package_price_usd: 49.0,
            is_unlocked: false,
            is_owned_by_requesting_user: user ? verifiedOwnerFindingIds.has(f.id) : false,
          })),
          ownership: user
            ? {
                registered_to_user_id: ownershipConfirmed ? user.id : null,
                requesting_user_id: user.id,
                ownership_confirmed: ownershipConfirmed,
                total_findings: auditSummary.findings.length,
                confirmed_findings_count: confirmedCount,
                conflict_findings_count: conflictCount,
                failed_findings_count: failedCount,
                warning: ownershipWarning,
              }
            : {
                is_anonymous: true,
                note: 'Free anonymous scan. Sign in to register ownership and track verification.',
              },
          deduplication_note: auditSummary.deduplication_note,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responsePayload, null, 2),
            },
          ],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'AUDIT_EXECUTION_ERROR',
                message: 'An error occurred while executing the cost audit pipeline.',
              }),
            },
          ],
        };
      }
    }
  );

  // Tool 2: check_entitlement
  (server as any).registerTool(
    'check_entitlement',
    {
      description:
        'Check entitlement and outcome-fee status for a specific finding. Requires authentication and finding ownership.',
      inputSchema: {
        finding_id: z.string(),
      },
    },
    async (args: { finding_id: string }) => {
      try {
        const { finding_id } = args;

        // Input validation
        if (!finding_id || typeof finding_id !== 'string' || !finding_id.trim()) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'INVALID_INPUT',
                  message: 'Finding ID must be a non-empty string.',
                }),
              },
            ],
          };
        }

        // 1. Require authenticated user
        if (!user) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'UNAUTHORIZED',
                  message: 'Authentication required. Please provide a valid Bearer token.',
                }),
              },
            ],
          };
        }

        // 2. Check ownership - must exist and belong to the authenticated user
        const ownerId = await storage.getFindingOwner(finding_id);
        if (!ownerId || ownerId !== user.id) {
          // Consistent non-disclosing response for unowned, non-existent, or mismatched findings
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'FINDING_NOT_FOUND',
                  message: 'Finding not found or access denied.',
                }),
              },
            ],
          };
        }

        // 3. Query entitlement and outcome fee obligation
        const isPaid = await storage.hasActivePaidEntitlement(user.id, finding_id);
        const entitlement = await storage.getEntitlement(user.id, finding_id);
        const obligation = await storage.getOutcomeFeeObligation(finding_id);

        const responsePayload = {
          finding_id,
          is_owner: true,
          fix_package: {
            unlocked: isPaid,
            price_usd: 49.0,
            entitlement_id: entitlement?.id || null,
            unlocked_at: entitlement?.created_at || null,
          },
          outcome_fee: obligation
            ? {
                obligation_id: obligation.id,
                status: obligation.status,
                fee_amount_usd: obligation.fee_amount_usd,
                verified_annualized_savings_usd: obligation.verified_annualized_savings_usd,
                paid_at: obligation.paid_at || null,
              }
            : null,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responsePayload, null, 2),
            },
          ],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'ENTITLEMENT_CHECK_ERROR',
                message: 'Failed to verify finding entitlement status.',
              }),
            },
          ],
        };
      }
    }
  );

  // Tool 3: get_finding_details
  (server as any).registerTool(
    'get_finding_details',
    {
      description:
        'Retrieve comprehensive details for a specific finding, including root-cause hypothesis, test plan, acceptance criteria, and rollback instructions. Fix package details are unlocked if purchased.',
      inputSchema: {
        finding_id: z.string(),
        audit_id: z.string().optional(),
      },
    },
    async (args: { finding_id: string; audit_id?: string }) => {
      try {
        const { finding_id, audit_id } = args;

        if (!finding_id || typeof finding_id !== 'string' || !finding_id.trim()) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'INVALID_INPUT',
                  message: 'Finding ID must be a non-empty string.',
                }),
              },
            ],
          };
        }

        if (!user) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'UNAUTHORIZED',
                  message: 'Authentication required. Please provide a valid Bearer token.',
                }),
              },
            ],
          };
        }

        let findingRecord: PersistedFindingRecord | null = null;
        if (audit_id) {
          findingRecord = await storage.getFinding(audit_id, finding_id);
        } else {
          findingRecord = await storage.getFindingById(finding_id, user.id);
        }

        if (!findingRecord || findingRecord.user_id !== user.id) {
          const ownerId = await storage.getFindingOwner(finding_id);
          if (!ownerId || ownerId !== user.id || !findingRecord) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'FINDING_NOT_FOUND',
                    message: 'Finding not found or access denied.',
                  }),
                },
              ],
            };
          }
        }

        const isPaid = await storage.hasActivePaidEntitlement(user.id, findingRecord.finding_id);
        const domainFinding = persistedFindingToDomain(findingRecord);
        const fixPackage = generateFixPackage(domainFinding, isPaid);

        const responsePayload = {
          finding_id: findingRecord.finding_id,
          audit_id: findingRecord.audit_id,
          rule_id: findingRecord.rule_id,
          title: findingRecord.title,
          summary: findingRecord.summary,
          affected_scope: findingRecord.affected_scope,
          detection_confidence: findingRecord.detection_confidence,
          baseline_spend_usd: findingRecord.baseline_spend_usd,
          candidate_spend_usd: findingRecord.candidate_spend_usd,
          estimated_savings_usd: findingRecord.estimated_savings_usd,
          potential_savings_pct: findingRecord.potential_savings_pct,
          annualized_projection_usd: findingRecord.annualized_projection_usd,
          eligible_event_count: findingRecord.eligible_event_count,
          calculation_method: findingRecord.calculation_method,
          assumptions: findingRecord.assumptions,
          evidence: findingRecord.evidence,
          fix_package: fixPackage,
          entitlement: {
            status: isPaid ? 'PAID_ACTIVE' : 'LOCKED',
            price_usd: 49.0,
            unlocked: isPaid,
          },
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responsePayload, null, 2),
            },
          ],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'FINDING_DETAILS_ERROR',
                message: 'Failed to retrieve finding details.',
              }),
            },
          ],
        };
      }
    }
  );

  // Tool 4: evaluate_verification
  (server as any).registerTool(
    'evaluate_verification',
    {
      description:
        'Evaluate post-deployment telemetry against a baseline finding to authoritatively verify realized cost reductions and calculate annualized outcome fee basis.',
      inputSchema: {
        finding_id: z.string(),
        telemetry_data: z.string(),
        audit_id: z.string().optional(),
        source_hint: z.string().optional(),
        file_name: z.string().optional(),
        deployment_timestamp: z.string().optional(),
      },
    },
    async (args: {
      finding_id: string;
      telemetry_data: string;
      audit_id?: string;
      source_hint?: string;
      file_name?: string;
      deployment_timestamp?: string;
    }) => {
      try {
        const { finding_id, telemetry_data, audit_id, source_hint, file_name, deployment_timestamp } = args;

        if (!finding_id || typeof finding_id !== 'string' || !finding_id.trim()) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'INVALID_INPUT',
                  message: 'Finding ID must be a non-empty string.',
                }),
              },
            ],
          };
        }

        if (!telemetry_data || typeof telemetry_data !== 'string') {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'INVALID_INPUT',
                  message: 'Telemetry data must be a non-empty string.',
                }),
              },
            ],
          };
        }

        if (telemetry_data.length > 1_800_000) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'PAYLOAD_TOO_LARGE',
                  message: 'Telemetry payload exceeds maximum permitted length of 1.8MB.',
                }),
              },
            ],
          };
        }

        if (!user) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'UNAUTHORIZED',
                  message: 'Authentication required. Please provide a valid Bearer token.',
                }),
              },
            ],
          };
        }

        let parsedSource: TelemetrySource | undefined;
        if (source_hint) {
          if (VALID_SOURCES.includes(source_hint as TelemetrySource)) {
            parsedSource = source_hint as TelemetrySource;
          } else {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'INVALID_SOURCE_HINT',
                    message: `Invalid source_hint. Supported sources: ${VALID_SOURCES.join(', ')}`,
                  }),
                },
              ],
            };
          }
        }

        let findingRecord: PersistedFindingRecord | null = null;
        if (audit_id) {
          findingRecord = await storage.getFinding(audit_id, finding_id);
        } else {
          findingRecord = await storage.getFindingById(finding_id, user.id);
        }

        if (!findingRecord || findingRecord.user_id !== user.id) {
          const ownerId = await storage.getFindingOwner(finding_id);
          if (!ownerId || ownerId !== user.id || !findingRecord) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'FINDING_NOT_FOUND',
                    message: 'Finding not found or access denied.',
                  }),
                },
              ],
            };
          }
        }

        // Ingest post-deployment telemetry
        const ingestPipelineResult = IngestionPipeline.ingest(telemetry_data, {
          source: parsedSource,
          fileName: file_name,
        });

        if (!ingestPipelineResult.success) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: ingestPipelineResult.errorCode || 'INGESTION_FAILED',
                  message: ingestPipelineResult.errorMessage || 'Failed to parse telemetry data.',
                  warnings: ingestPipelineResult.warnings,
                  format: ingestPipelineResult.format,
                }),
              },
            ],
          };
        }

        const domainFinding = persistedFindingToDomain(findingRecord);
        const existing = await storage.getVerificationByFindingId(finding_id);
        const now = new Date().toISOString();
        const deployTime = deployment_timestamp || existing?.deployment_timestamp || now;
        const obsStart = existing?.observation_start || deployTime;

        const observationWindow = {
          start: obsStart,
          end: obsStart,
          sample_event_count: 0,
        };

        const currentState: VerificationState = {
          finding_id,
          stage: existing?.stage || 'CUSTOMER_DEPLOYED',
          baseline_window: {
            start:
              existing?.baseline_start ||
              domainFinding.evidence?.baseline_period?.start ||
              new Date(Date.now() - 7 * 86_400_000).toISOString(),
            end: existing?.baseline_end || domainFinding.evidence?.baseline_period?.end || now,
            avg_cost_per_call_usd:
              existing?.baseline_avg_cost_usd ||
              (domainFinding.eligible_event_count > 0
                ? domainFinding.baseline_spend_usd / domainFinding.eligible_event_count
                : 0),
            sample_count: existing?.baseline_sample_count || domainFinding.eligible_event_count || 0,
          },
          deployment_timestamp: deployTime,
          observation_window: observationWindow,
          is_simulated: Boolean(domainFinding.is_sample_data || existing?.is_simulated),
          post_deployment_file_name: file_name || existing?.post_deployment_file_name,
        };

        const evaluated = evaluateVerification(
          currentState,
          domainFinding,
          ingestPipelineResult.ingestResult.events,
          file_name
        );
        const isAuth = isAuthoritativeVerified(evaluated);
        evaluated.is_authoritative = isAuth;
        const verifiedAnnualSavings = getAuthoritativeVerifiedSavings(evaluated);

        const authRecord: AuthoritativeVerification = {
          id: existing?.id || `ver_${crypto.randomUUID()}`,
          finding_id,
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
          original_estimated_annualized_usd: domainFinding.annualized_projection_usd,
          verification_confidence: evaluated.observed_result?.verification_confidence || 'INSUFFICIENT_OBSERVATION',
          verification_notes: evaluated.observed_result?.verification_notes,
          post_deployment_file_name: evaluated.post_deployment_file_name,
          verified_at: isAuth ? existing?.verified_at || now : undefined,
          created_at: existing?.created_at || now,
          updated_at: now,
        };

        await storage.saveVerification(authRecord);

        const obligation = await storage.getOutcomeFeeObligation(finding_id);

        const responsePayload = {
          finding_id,
          audit_id: findingRecord.audit_id,
          verification_stage: evaluated.stage,
          is_authoritative: isAuth,
          is_simulated: Boolean(evaluated.is_simulated),
          pre_cost_per_call_usd:
            evaluated.observed_result?.pre_cost_per_call_usd ?? evaluated.baseline_window.avg_cost_per_call_usd,
          post_cost_per_call_usd: evaluated.observed_result?.post_cost_per_call_usd ?? 0,
          observed_reduction_pct: evaluated.observed_result?.observed_reduction_pct ?? 0,
          annualized_realized_savings_usd: verifiedAnnualSavings,
          verification_confidence: evaluated.observed_result?.verification_confidence || 'INSUFFICIENT_OBSERVATION',
          notes: evaluated.observed_result?.verification_notes,
          observation_window: evaluated.observation_window,
          outcome_fee: obligation
            ? {
                obligation_id: obligation.id,
                status: obligation.status,
                fee_amount_usd: obligation.fee_amount_usd,
                verified_annualized_savings_usd: obligation.verified_annualized_savings_usd,
              }
            : isAuth && verifiedAnnualSavings > 0
            ? {
                status: 'PENDING_QUALIFICATION',
                fee_percentage: 20,
                estimated_fee_usd: Number((verifiedAnnualSavings * 0.2).toFixed(2)),
              }
            : null,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responsePayload, null, 2),
            },
          ],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'VERIFICATION_EVALUATION_ERROR',
                message: 'Failed to evaluate post-deployment verification telemetry.',
              }),
            },
          ],
        };
      }
    }
  );

  return server;
}
