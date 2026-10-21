/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AuditSummary, Finding } from '../types/domain';
import { MetricTile } from '../components/MetricTile';
import { ProvenanceBadge } from '../components/ProvenanceBadge';
import { ArrowRight, ShieldCheck, CheckCircle2, Sliders, AlertCircle, Info } from 'lucide-react';

interface AuditSummaryViewProps {
  audit: AuditSummary;
  onSelectFinding: (findingId: string) => void;
  onViewHealth: () => void;
}

export const AuditSummaryView: React.FC<AuditSummaryViewProps> = ({
  audit,
  onSelectFinding,
  onViewHealth,
}) => {
  const hasFindings = audit.findings.length > 0;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      {/* View Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono uppercase tracking-wider text-emerald-700 font-semibold">
              Step 3: Executive Audit Overview
            </span>
            {audit.is_sample_data && <ProvenanceBadge provenance="SAMPLE_DATA" />}
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight mt-1">
            Telemetry Cost &amp; Optimization Audit
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Analyzed {audit.health.total_events.toLocaleString()} production calls from {audit.source.replace('_', ' ')}.
          </p>
        </div>

        <button
          type="button"
          id="btn-inspect-health-gate"
          onClick={onViewHealth}
          className="px-3.5 py-2 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors flex items-center gap-1.5 shrink-0"
        >
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
          <span>Inspect Data Health ({audit.health.health_grade})</span>
        </button>
      </div>

      {/* Primary Financial Metric Tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricTile
          id="metric-analyzed-spend"
          label="Analyzed Telemetry Spend"
          value={`$${audit.total_spend_usd.toFixed(2)}`}
          subtext={`Across ${audit.health.total_events.toLocaleString()} valid events`}
          provenance={audit.health.source_cost_coverage_pct > 80 ? 'SOURCE_REPORTED' : 'CALCULATED'}
        />
        <MetricTile
          id="metric-observed-opportunity"
          label="Sum of Opportunity Estimates"
          value={`$${audit.potential_savings_usd.toFixed(2)}`}
          subtext={`${audit.findings.length} patterns detected (potentially overlapping)`}
          provenance="ESTIMATED"
          trend={
            audit.total_spend_usd > 0
              ? {
                  direction: 'down',
                  label: `${((audit.potential_savings_usd / audit.total_spend_usd) * 100).toFixed(1)}% spend delta`,
                }
              : undefined
          }
          highlight
        />
        <MetricTile
          id="metric-annualized-projection"
          label="Annualized Projection"
          value={`$${audit.annualized_savings_projection_usd.toLocaleString()}`}
          subtext="Extrapolated run-rate projection (not historical fact)"
          provenance="ESTIMATED"
        />
      </div>

      {/* Transparency Callout: Projections vs Historical Facts */}
      <div className="p-4 rounded-xl bg-slate-100 border border-slate-200 text-xs text-slate-600 flex items-start gap-2.5">
        <Info className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
        <div>
          <strong>Accounting Transparency Guardrail:</strong> The aggregate opportunity reflects the sum of individually detected optimization estimates. Because distinct optimization patterns (such as right-sizing, caching, and retry handling) may address overlapping execution subsets, this total is an upper-bound scenario, not a deduplicated or guaranteed portfolio recovery. Annualized figures are modeled projections under constant-volume assumptions, not past realized savings. Realized savings are confirmed only through post-deployment verification.
        </div>
      </div>

      {/* Findings Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900 tracking-tight">
              Detected Optimization Patterns ({audit.findings.length})
            </h2>
            <p className="text-xs text-slate-500">
              Select any finding to inspect evidence, trace IDs, and mathematical proof.
            </p>
          </div>
        </div>

        {hasFindings ? (
          <div className="grid grid-cols-1 gap-4">
            {audit.findings.map((fnd) => (
              <div
                key={fnd.id}
                id={`card-finding-${fnd.id}`}
                onClick={() => onSelectFinding(fnd.id)}
                className="p-5 sm:p-6 rounded-2xl bg-white border border-slate-200 hover:border-slate-400 hover:shadow-xs transition-all cursor-pointer group"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-800 border border-slate-200">
                      {fnd.rule_id}
                    </span>
                    <ProvenanceBadge provenance="CALCULATED" size="sm" />
                    {fnd.is_sample_data && <ProvenanceBadge provenance="SAMPLE_DATA" size="sm" />}
                  </div>

                  <div className="text-right sm:text-right">
                    <span className="text-xs font-medium text-slate-500 mr-2">Estimated Opportunity:</span>
                    <span className="text-xl font-bold font-mono text-emerald-700 tabular-nums">
                      ${fnd.estimated_savings_usd.toFixed(2)}
                    </span>
                    <span className="text-xs font-semibold text-slate-500 ml-1">
                      ({fnd.potential_savings_pct}%)
                    </span>
                  </div>
                </div>

                <h3 className="text-base font-bold text-slate-900 group-hover:text-emerald-700 transition-colors">
                  {fnd.title}
                </h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  {fnd.summary}
                </p>

                <div className="mt-4 pt-4 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-slate-500">
                  <div className="flex items-center gap-4">
                    <span>
                      Affected Scope: <strong className="text-slate-800">{fnd.affected_scope}</strong>
                    </span>
                    <span>
                      Events: <strong className="font-mono text-slate-800">{fnd.eligible_event_count}</strong>
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 font-bold text-slate-900 group-hover:text-emerald-700">
                    <span>Inspect Evidence &amp; Proof</span>
                    <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-10 rounded-2xl bg-white border border-slate-200 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 mx-auto flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <h3 className="text-base font-bold text-slate-900">
              No high-confidence optimization opportunities were detected.
            </h3>
            <p className="text-xs text-slate-600 max-w-md mx-auto leading-relaxed">
              Your ingested telemetry conforms to balanced model tier selection, healthy error behavior,
              and low request redundancy. This is an authoritative, successful analytical conclusion.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
