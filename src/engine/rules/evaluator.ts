/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AIEvent, AuditSummary, DataHealthReport, Finding, TelemetrySource } from '../../types/domain';
import { evaluateModelRightSizing } from './right-sizing';
import { evaluateRetryErrorLoop } from './retry-loop';
import { evaluateRepeatedCallPattern } from './repeated-call';
import { isValidRuleEvent } from './validation';

export function runOptimizationRules(
  events: AIEvent[],
  source: TelemetrySource,
  health: DataHealthReport,
  isSampleData: boolean
): AuditSummary {
  const auditId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const findings: Finding[] = [];

  // Filter for valid canonical events
  const validEvents: AIEvent[] = [];
  let totalSpend = 0;

  for (const ev of events) {
    if (!isValidRuleEvent(ev)) continue;

    // Production audits reject simulated events from production analysis
    if (!isSampleData && ev.is_simulated === true) {
      continue;
    }

    validEvents.push(ev);
    totalSpend += ev.resolved_cost_usd;
  }

  // Only run rules if data health is at least USABLE_WITH_ESTIMATES and sufficient valid events exist
  if (health.health_grade !== 'INSUFFICIENT_DATA' && validEvents.length >= 5) {
    // Rule A: Model Right-Sizing
    const findingA = evaluateModelRightSizing(validEvents, auditId, isSampleData, health.time_range);
    if (findingA) {
      findings.push(findingA);
    }

    // Rule B: Retry / Error Loop
    const findingB = evaluateRetryErrorLoop(validEvents, auditId, isSampleData, health.time_range);
    if (findingB) {
      findings.push(findingB);
    }

    // Rule C: Repeated Call Pattern
    const findingC = evaluateRepeatedCallPattern(validEvents, auditId, isSampleData, health.time_range);
    if (findingC) {
      findings.push(findingC);
    }
  }

  // Calculate sum of detected opportunity estimates
  // TRUTH BOUNDARY: This aggregate is the arithmetic sum of individual pattern estimates.
  // Cross-rule portfolio deduplication is not performed; individual opportunities may be potentially overlapping.
  const potentialSavings = findings.reduce((sum, f) => sum + f.estimated_savings_usd, 0);
  const annualizedProjection = findings.reduce((sum, f) => sum + f.annualized_projection_usd, 0);

  return {
    id: auditId,
    created_at: new Date().toISOString(),
    source,
    total_spend_usd: Number(totalSpend.toFixed(4)),
    potential_savings_usd: Number(potentialSavings.toFixed(4)),
    annualized_savings_projection_usd: Number(annualizedProjection.toFixed(2)),
    health,
    findings,
    is_sample_data: isSampleData,
    aggregate_is_deduplicated: false,
    deduplication_note: 'Sum of detected opportunity estimates. Individual findings represent distinct optimization hypotheses that have not been portfolio-deduplicated; opportunities may partially overlap across workloads.',
  };
}
