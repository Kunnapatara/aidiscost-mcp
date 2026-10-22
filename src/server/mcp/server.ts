/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IngestionPipeline } from '../../engine/ingestion/pipeline';
import { evaluateDataHealth } from '../../engine/health/evaluator';
import { runOptimizationRules } from '../../engine/rules/evaluator';
import { getStorage } from '../storage';
import { IStorage } from '../storage-interface';
import { User } from '../types';
import { TelemetrySource } from '../../types/domain';

const VALID_SOURCES: TelemetrySource[] = ['langfuse', 'helicone', 'opentelemetry', 'custom_logs'];

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

        // 4. If authenticated, register and verify finding ownerships
        let ownershipConfirmed = false;
        let ownershipWarning: string | undefined;
        let confirmedCount = 0;
        let conflictCount = 0;
        let failedCount = 0;
        const verifiedOwnerFindingIds = new Set<string>();

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

  return server;
}
