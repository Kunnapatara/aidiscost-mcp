/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { DataHealthReport } from '../types/domain';
import { MetricTile } from '../components/MetricTile';
import { ProvenanceBadge } from '../components/ProvenanceBadge';
import { ShieldCheck, AlertTriangle, XCircle, ArrowRight, ArrowLeft } from 'lucide-react';

interface DataHealthViewProps {
  health: DataHealthReport;
  onProceed: () => void;
  onBack: () => void;
}

export const DataHealthView: React.FC<DataHealthViewProps> = ({
  health,
  onProceed,
  onBack,
}) => {
  const isHealthy = health.health_grade === 'HEALTHY';
  const isUsable = health.health_grade === 'USABLE_WITH_ESTIMATES';
  const isBlocked = health.health_grade === 'INSUFFICIENT_DATA';

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      {/* View Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono uppercase tracking-wider text-emerald-700 font-semibold">
              Step 2: Ingestion Quality Gate
            </span>
            {health.is_sample_data && <ProvenanceBadge provenance="SAMPLE_DATA" />}
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight mt-1">
            Data Health &amp; Coverage Analysis
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Deterministic evaluation of telemetry sufficiency before computing cost conclusions.
          </p>
        </div>

        {/* Health Grade Status Badge */}
        <div className="shrink-0">
          {isHealthy && (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-900 font-bold text-xs">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>HEALTHY QUALITY GATE</span>
            </div>
          )}
          {isUsable && (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 font-bold text-xs">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              <span>USABLE WITH ESTIMATES</span>
            </div>
          )}
          {isBlocked && (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-red-300 bg-red-50 text-red-900 font-bold text-xs">
              <XCircle className="w-4 h-4 text-red-600" />
              <span>INSUFFICIENT DATA</span>
            </div>
          )}
        </div>
      </div>

      {/* Primary Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        <MetricTile
          id="metric-total-events"
          label="Total Events"
          value={health.total_events.toLocaleString()}
          subtext={`Dropped ${health.duplicate_events_dropped} duplicate records`}
          provenance="SOURCE_REPORTED"
        />
        <MetricTile
          id="metric-model-coverage"
          label="Model Coverage"
          value={`${health.model_coverage_pct}%`}
          subtext="Valid model identifiers identified"
          provenance="SOURCE_REPORTED"
        />
        <MetricTile
          id="metric-token-coverage"
          label="Token Coverage"
          value={`${health.token_coverage_pct}%`}
          subtext="Prompt + completion metrics"
          provenance="SOURCE_REPORTED"
        />
        <MetricTile
          id="metric-pricing-coverage"
          label="Pricing Table Match"
          value={`${health.pricing_coverage_pct}%`}
          subtext="Resolved in internal registry"
          provenance="CALCULATED"
        />
      </div>

      {/* Secondary Coverage Dimensions */}
      <div className="p-5 rounded-2xl bg-white border border-slate-200 space-y-4 shadow-xs">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
          Telemetry Coverage Dimensions
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-semibold text-slate-700">Source Cost Coverage</span>
              <span className="font-mono font-bold text-slate-900">{health.source_cost_coverage_pct}%</span>
            </div>
            <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
              <div
                className="bg-emerald-600 h-full rounded-full"
                style={{ width: `${health.source_cost_coverage_pct}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              {health.source_cost_coverage_pct < 50
                ? 'Source omitted costs; calculating from token counts.'
                : 'Direct provider cost assertions validated.'}
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-semibold text-slate-700">Latency Coverage</span>
              <span className="font-mono font-bold text-slate-900">{health.latency_coverage_pct}%</span>
            </div>
            <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
              <div
                className="bg-emerald-600 h-full rounded-full"
                style={{ width: `${health.latency_coverage_pct}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              Available execution duration metrics for timeout and retry loop detection.
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-semibold text-slate-700">Trace ID Coverage</span>
              <span className="font-mono font-bold text-slate-900">{health.trace_coverage_pct}%</span>
            </div>
            <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
              <div
                className="bg-emerald-600 h-full rounded-full"
                style={{ width: `${health.trace_coverage_pct}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              Multi-span correlation links to distinguish intentional repetitions from loops.
            </p>
          </div>
        </div>

        {/* Time Range Information */}
        <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between text-xs text-slate-600 gap-1 font-mono">
          <span>Observation Window:</span>
          <span className="text-slate-900 font-semibold truncate">
            {health.time_range.start} &rarr; {health.time_range.end}
          </span>
        </div>
      </div>

      {/* Warnings & Diagnostics (if any) */}
      {(health.warnings.length > 0 || health.missing_critical_fields.length > 0) && (
        <div className="p-5 rounded-2xl bg-amber-50/70 border border-amber-200 space-y-2">
          <div className="flex items-center gap-2 text-amber-900 font-bold text-xs uppercase tracking-wider">
            <AlertTriangle className="w-4 h-4 text-amber-700" />
            <span>Health Gate Advisories &amp; Missing Fields</span>
          </div>
          <ul className="text-xs text-amber-800 space-y-1 pl-4 list-disc">
            {health.missing_critical_fields.map((f, i) => (
              <li key={`missing-${i}`}>
                Missing critical field: <strong className="font-mono">{f}</strong>.
              </li>
            ))}
            {health.warnings.map((w, i) => (
              <li key={`warn-${i}`}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Gate Actions */}
      <div className="flex items-center justify-between pt-4 border-t border-slate-200">
        <button
          type="button"
          id="btn-health-back"
          onClick={onBack}
          className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-xs font-bold hover:bg-slate-50 transition-colors flex items-center gap-1.5"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Upload Another File</span>
        </button>

        {!isBlocked ? (
          <button
            type="button"
            id="btn-health-proceed"
            onClick={onProceed}
            className="px-5 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors shadow-xs flex items-center gap-1.5"
          >
            <span>Proceed to Audit Summary</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        ) : (
          <div className="text-xs font-semibold text-red-600">
            Cannot run audit: Insufficient telemetry data.
          </div>
        )}
      </div>
    </div>
  );
};
