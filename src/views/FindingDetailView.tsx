/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Finding } from '../types/domain';
import { MetricTile } from '../components/MetricTile';
import { ProvenanceBadge } from '../components/ProvenanceBadge';
import { EvidenceDrawer } from '../components/EvidenceDrawer';
import { ArrowLeft, ArrowRight, ShieldCheck, CheckCircle2, Lock, Sliders, RefreshCw, FileText } from 'lucide-react';

interface FindingDetailViewProps {
  finding: Finding;
  onBack: () => void;
  onOpenFix: (findingId: string) => void;
  onOpenVerify: (findingId: string) => void;
}

export const FindingDetailView: React.FC<FindingDetailViewProps> = ({
  finding,
  onBack,
  onOpenFix,
  onOpenVerify,
}) => {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      {/* Top Breadcrumb & Action */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          id="btn-back-to-audit"
          onClick={onBack}
          className="text-xs font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1.5 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Audit Summary</span>
        </button>

        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold px-2.5 py-1 rounded bg-slate-100 text-slate-800 border border-slate-200">
            {finding.rule_id}
          </span>
          {finding.is_sample_data && <ProvenanceBadge provenance="SAMPLE_DATA" size="md" />}
        </div>
      </div>

      {/* Main Title & Affected Scope */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-mono uppercase tracking-wider text-emerald-700 font-semibold">
            Evidence-First Verification (PROVE)
          </span>
          <ProvenanceBadge provenance="CALCULATED" size="sm" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
          {finding.title}
        </h1>
        <p className="text-sm text-slate-600 mt-2 leading-relaxed max-w-2xl">
          {finding.summary}
        </p>
      </div>

      {/* Financial Comparison Metric Tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <MetricTile
          id="metric-fnd-baseline"
          label="Baseline Observed Spend"
          value={`$${finding.baseline_spend_usd.toFixed(2)}`}
          subtext={`Across ${finding.eligible_event_count} eligible events`}
          provenance="CALCULATED"
        />
        <MetricTile
          id="metric-fnd-savings"
          label="Estimated Recovery Opportunity"
          value={`$${finding.estimated_savings_usd.toFixed(2)}`}
          subtext={`${finding.potential_savings_pct}% spend reduction delta`}
          provenance="CALCULATED"
          highlight
        />
        <MetricTile
          id="metric-fnd-annualized"
          label="Annualized Projection"
          value={`$${finding.annualized_projection_usd.toLocaleString()}`}
          subtext="Extrapolated run-rate forecast"
          provenance="ESTIMATED"
        />
      </div>

      {/* Tripartite Confidence Matrix (Never Collapsed into One Score) */}
      <div className="p-4 rounded-xl bg-white border border-slate-200">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-3">
          Independent Confidence Breakdown
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <span className="text-slate-500 block mb-1">Detection Confidence</span>
            <span className="font-mono font-bold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded text-[11px]">
              {finding.detection_confidence}
            </span>
            <p className="text-[11px] text-slate-600 mt-1.5">
              Workload and anomaly characteristics statistically exceed baseline noise thresholds.
            </p>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <span className="text-slate-500 block mb-1">Cost Confidence</span>
            <span className="font-mono font-bold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded text-[11px]">
              {finding.cost_confidence}
            </span>
            <p className="text-[11px] text-slate-600 mt-1.5">
              Calculated using version-aware published pricing table applied to exact token counts.
            </p>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <span className="text-slate-500 block mb-1">Savings Confidence</span>
            <span className="font-mono font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded text-[11px]">
              {finding.savings_confidence}
            </span>
            <p className="text-[11px] text-slate-600 mt-1.5">
              Modeled potential savings contingent on post-deployment canary test validation.
            </p>
          </div>
        </div>
      </div>

      {/* Assumptions & Mathematical Foundation */}
      <div className="p-5 rounded-2xl bg-white border border-slate-200 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
          Governing Assumptions &amp; Method
        </h3>
        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 font-mono">
          Method: {finding.calculation_method}
        </div>
        <ul className="text-xs text-slate-600 space-y-1.5 pl-4 list-disc">
          {finding.assumptions.map((asm, idx) => (
            <li key={idx}>{asm}</li>
          ))}
        </ul>
      </div>

      {/* Telemetry Evidence Drawer (Deterministic Math, Traces, Event Hashes) */}
      <EvidenceDrawer evidence={finding.evidence} defaultExpanded />

      {/* Bottom Action Footer */}
      <div className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3">
        <button
          type="button"
          id="btn-nav-to-verify"
          onClick={() => onOpenVerify(finding.id)}
          className="w-full sm:w-auto px-4 py-3 rounded-xl border border-slate-300 text-slate-800 text-xs font-bold hover:bg-slate-50 transition-colors flex items-center justify-center gap-2"
        >
          <RefreshCw className="w-4 h-4 text-slate-600" />
          <span>Verify Post-Deployment Results</span>
        </button>

        <button
          type="button"
          id="btn-unlock-fix-package"
          onClick={() => onOpenFix(finding.id)}
          className="w-full sm:w-auto px-6 py-3 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors shadow-xs flex items-center justify-center gap-2"
        >
          <Sliders className="w-4 h-4 text-emerald-400" />
          <span>Unlock Optimization Fix Package ($49)</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
