/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ArrowRight, ShieldCheck, Database, CheckCircle2, Search, Sliders, RefreshCw, AlertCircle } from 'lucide-react';
import { COMMERCIAL_PRICING, generateCommercialROIExample } from '../engine/billing/outcome';

interface LandingViewProps {
  onStartAudit: () => void;
  onLoadSample: () => void;
  onNavigate: (route: string) => void;
  hasActiveAudit?: boolean;
}

export const LandingView: React.FC<LandingViewProps> = ({
  onStartAudit,
  onLoadSample,
  onNavigate,
  hasActiveAudit = false,
}) => {
  const roi = generateCommercialROIExample();

  return (
    <div className="space-y-12 sm:space-y-16 pb-16">
      {/* Hero Section */}
      <section className="pt-8 sm:pt-14 text-center max-w-3xl mx-auto px-4">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-slate-200 bg-white text-xs font-semibold text-slate-700 shadow-2xs mb-5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>Non-Invasive AI Cost Optimization</span>
        </div>

        <h1 className="text-3xl sm:text-5xl font-extrabold text-slate-900 tracking-tight leading-[1.15]">
          You already have observability.{' '}
          <span className="text-emerald-700 block mt-1">Now find the money you&apos;re wasting.</span>
        </h1>

        <p className="mt-5 text-base sm:text-lg text-slate-600 leading-relaxed max-w-2xl mx-auto">
          AIDisCost connects to your existing telemetry to uncover model right-sizing opportunities,
          unbacked retry storms, and redundant call loops — backed by deterministic mathematical proof.
        </p>

        {/* Primary CTAs */}
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3.5 max-w-md mx-auto">
          {hasActiveAudit ? (
            <button
              type="button"
              id="btn-hero-resume-audit"
              onClick={() => onNavigate('/audit')}
              className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-emerald-600 text-white font-bold text-sm hover:bg-emerald-700 transition-all shadow-sm flex items-center justify-center gap-2 focus:ring-2 focus:ring-emerald-600 focus:outline-hidden"
            >
              <span>Resume Active Audit</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              id="btn-hero-start-audit"
              onClick={onStartAudit}
              className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-slate-900 text-white font-bold text-sm hover:bg-slate-800 transition-all shadow-sm flex items-center justify-center gap-2 focus:ring-2 focus:ring-slate-900 focus:outline-hidden"
            >
              <span>Start Free Audit</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}

          <button
            type="button"
            id="btn-hero-load-sample"
            onClick={onLoadSample}
            className="w-full sm:w-auto px-6 py-3.5 rounded-xl border border-slate-300 bg-white text-slate-800 font-bold text-sm hover:bg-slate-50 transition-all shadow-2xs flex items-center justify-center gap-2 focus:ring-2 focus:ring-slate-400 focus:outline-hidden"
          >
            <span>Try Sample Dataset</span>
          </button>
        </div>

        <p className="mt-4 text-xs text-slate-500">
          Zero proxy dependency &bull; Read-only export parsing &bull; Zero raw prompts persisted
        </p>
      </section>

      {/* The 4-Step Engineering Workflow */}
      <section className="max-w-5xl mx-auto px-4">
        <div className="text-center mb-8">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">
            The AIDisCost Operating Principle
          </h2>
          <p className="text-xl sm:text-2xl font-bold text-slate-900 mt-1">
            FIND &rarr; PROVE &rarr; FIX &rarr; VERIFY
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-5 rounded-xl bg-white border border-slate-200 shadow-2xs">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center font-bold mb-3 border border-emerald-100">
              <Search className="w-4 h-4" />
            </div>
            <h3 className="font-bold text-slate-900 text-base mb-1">1. FIND</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Detect model right-sizing gaps, runaway retry storms, and redundant prompt executions across Langfuse, Helicone, OpenTelemetry, and custom logs.
            </p>
          </div>

          <div className="p-5 rounded-xl bg-white border border-slate-200 shadow-2xs">
            <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-700 flex items-center justify-center font-bold mb-3 border border-blue-100">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <h3 className="font-bold text-slate-900 text-base mb-1">2. PROVE</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Every finding reveals its mathematical proof, source cost provenance, token distributions, and correlated trace IDs. No AI hallucinations.
            </p>
          </div>

          <div className="p-5 rounded-xl bg-white border border-slate-200 shadow-2xs">
            <div className="w-9 h-9 rounded-lg bg-purple-50 text-purple-700 flex items-center justify-center font-bold mb-3 border border-purple-100">
              <Sliders className="w-4 h-4" />
            </div>
            <h3 className="font-bold text-slate-900 text-base mb-1">3. FIX</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Actionable engineering packages providing root-cause analysis, traffic canary plans, acceptance criteria, and rollback instructions for $49.
            </p>
          </div>

          <div className="p-5 rounded-xl bg-white border border-slate-200 shadow-2xs">
            <div className="w-9 h-9 rounded-lg bg-teal-50 text-teal-700 flex items-center justify-center font-bold mb-3 border border-teal-100">
              <RefreshCw className="w-4 h-4" />
            </div>
            <h3 className="font-bold text-slate-900 text-base mb-1">4. VERIFY</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Empirical before-and-after comparison. We never declare verified savings until post-deployment telemetry demonstrates observed unit reduction across the required comparable production sample.
            </p>
          </div>
        </div>
      </section>

      {/* Strict Truth & Architecture Guarantees */}
      <section className="max-w-5xl mx-auto px-4">
        <div className="p-6 sm:p-8 rounded-2xl bg-slate-900 text-white shadow-md">
          <div className="max-w-2xl">
            <span className="text-xs font-mono uppercase tracking-wider text-emerald-400 font-semibold">
              Non-Negotiable Guardrails
            </span>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mt-1 mb-4">
              Built for Engineering Trust, Not Vanity Metrics
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6 pt-6 border-t border-slate-800 text-sm">
            <div>
              <div className="flex items-center gap-2 font-bold text-white mb-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>Read-Only by Default</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                AIDisCost never touches your production infrastructure, alters your provider keys, or injects runtime proxies in your request path.
              </p>
            </div>

            <div>
              <div className="flex items-center gap-2 font-bold text-white mb-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>Deterministic Pricing Truth</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Every calculation is governed by an explicit pricing registry. Source-reported costs and calculated estimates are never conflated.
              </p>
            </div>

            <div>
              <div className="flex items-center gap-2 font-bold text-white mb-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>Conservative Verification</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                We refuse to label savings &quot;verified&quot; without sufficient sample volume and empirical observation across identical workloads.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Three-Step Commercial Architecture */}
      <section className="max-w-5xl mx-auto px-4 space-y-10">
        <div className="text-center max-w-3xl mx-auto">
          <span className="text-xs font-mono uppercase tracking-wider text-emerald-600 font-semibold">
            Commercial Contract
          </span>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight mt-1">
            Pay for the evidence. Not another subscription.
          </h2>
          <p className="text-sm sm:text-base text-slate-600 mt-2 leading-relaxed">
            Pay ${COMMERCIAL_PRICING.FIX_PACKAGE_PRICE_USD} to know what to fix. Fix it yourself if you can. If we verify the saving &mdash; pay once, capped at {COMMERCIAL_PRICING.OUTCOME_FEE_CAP_MONTHS} month of savings.
          </p>
        </div>

        {/* 3-Step Presentation Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Step 01: Free Audit */}
          <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-slate-100 font-mono text-xs font-bold text-slate-700">
                  01
                </span>
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Free Audit
                </span>
              </div>
              <div className="text-3xl font-extrabold font-mono text-slate-900 mt-1 mb-2">${COMMERCIAL_PRICING.FREE_AUDIT_PRICE_USD}</div>
              <h3 className="text-base font-bold text-slate-900 mb-2">Find the economic anomaly.</h3>
              <p className="text-xs text-slate-600 mb-4 leading-relaxed">
                Connect your telemetry to uncover model waste, retry storms, and redundant loops with mathematical proof.
              </p>
              <div className="space-y-2 pt-3 border-t border-slate-100 text-xs text-slate-700">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Finding detection &amp; categorization</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Evidence preview &amp; trace correlation</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Estimated recovery run-rate</span>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100">
              <button
                type="button"
                id="btn-pricing-free-audit"
                onClick={onStartAudit}
                className="w-full py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition-colors flex items-center justify-center gap-2"
              >
                <span>Run Free Audit &rarr;</span>
              </button>
              <p className="text-[11px] text-center text-slate-500 mt-2">
                No credit card required &bull; Read-only export
              </p>
            </div>
          </div>

          {/* Step 02: Fix Package */}
          <div className="p-6 rounded-2xl bg-white border-2 border-emerald-600 shadow-sm relative flex flex-col justify-between">
            <span className="absolute -top-3 right-6 bg-emerald-600 text-white font-mono text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
              One-Time Deliverable
            </span>
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-100 font-mono text-xs font-bold text-emerald-800">
                  02
                </span>
                <span className="text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Fix Package
                </span>
              </div>
              <div className="text-3xl font-extrabold font-mono text-slate-900 mt-1 mb-1">
                ${COMMERCIAL_PRICING.FIX_PACKAGE_PRICE_USD} <span className="text-xs font-normal text-slate-500">/ finding</span>
              </div>
              <div className="text-[11px] font-semibold text-emerald-800 mb-2">
                One-time payment &bull; No subscription
              </div>
              <h3 className="text-base font-bold text-slate-900 mb-2">Know exactly what to fix.</h3>
              <p className="text-xs text-slate-600 mb-4 leading-relaxed">
                Actionable engineering package providing root-cause analysis, canary test plan, acceptance criteria, and rollback protocol.
              </p>
              <div className="space-y-2 pt-3 border-t border-slate-100 text-xs text-slate-700">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Full evidence &amp; mathematical proof</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Root cause hypothesis &amp; router specs</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Canary test plan (sample size &amp; metrics)</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Acceptance criteria checklist</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Rollback plan &amp; safety toggles</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Verification specification</span>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100">
              <button
                type="button"
                id="btn-pricing-unlock-fix"
                onClick={hasActiveAudit ? () => onNavigate('/audit') : onStartAudit}
                className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition-colors flex items-center justify-center gap-2 shadow-xs"
              >
                <span>Unlock Fix Package &mdash; ${COMMERCIAL_PRICING.FIX_PACKAGE_PRICE_USD}</span>
              </button>
              <p className="text-[11px] text-center text-slate-500 mt-2">
                Each finding unlocks separately &bull; Fix with your own tools
              </p>
            </div>
          </div>

          {/* Step 03: Verified Outcome */}
          <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-teal-100 font-mono text-xs font-bold text-teal-800">
                  03
                </span>
                <span className="text-xs font-semibold text-teal-700 uppercase tracking-wider">
                  Verified Outcome
                </span>
              </div>
              <div className="text-xl font-extrabold font-mono text-slate-900 mt-1 mb-1">
                {(COMMERCIAL_PRICING.OUTCOME_FEE_ANNUAL_PCT * 100).toFixed(0)}% <span className="text-xs font-normal text-slate-500">of verified annualized savings</span>
              </div>
              <div className="text-[11px] font-bold text-teal-800 mb-2">
                Capped at {COMMERCIAL_PRICING.OUTCOME_FEE_CAP_MONTHS.toFixed(0)} month of verified savings
              </div>
              <h3 className="text-base font-bold text-slate-900 mb-2">Pay once, only after verification.</h3>
              <p className="text-xs text-slate-600 mb-3 leading-relaxed">
                You pay whichever is lower. Zero ongoing percentage, zero monthly retainer, and zero recurring invoices.
              </p>

              {/* 50% Protection Clause Callout */}
              <div className="p-3 rounded-xl bg-amber-50/80 border border-amber-200/80 mb-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800 block mb-0.5">
                  {(COMMERCIAL_PRICING.PROTECTION_MIN_RATIO * 100).toFixed(0)}% Protection Clause
                </span>
                <p className="text-[11px] text-amber-900 leading-snug">
                  If verified savings fall below {(COMMERCIAL_PRICING.PROTECTION_MIN_RATIO * 100).toFixed(0)}% of the original estimate, you pay no outcome fee.
                </p>
              </div>

              {/* Truth Boundary Callout */}
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600 block mb-0.5">
                  Truth Boundary
                </span>
                <p className="text-[11px] text-slate-600 leading-snug">
                  Verification measures what changed. It does not guarantee future results.
                </p>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100">
              <div className="w-full py-2.5 px-4 rounded-xl bg-slate-100 border border-slate-200 text-slate-800 font-bold text-xs text-center">
                One-time &bull; Payable only after verified results
              </div>
              <p className="text-[11px] text-center text-slate-500 mt-2">
                Independent evidence &bull; Non-recurring
              </p>
            </div>
          </div>
        </div>

        {/* Commercial Economic Illustration (ROI & Cost of Inaction) */}
        <div className="p-6 sm:p-8 rounded-2xl bg-white border border-slate-200 shadow-sm">
          <div className="max-w-2xl mb-6">
            <span className="text-xs font-mono uppercase tracking-wider text-emerald-700 font-semibold">
              Commercial Economic Illustration
            </span>
            <h3 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight mt-1">
              Cap in Action: Transparent Single-Payment ROI
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 mt-1">
              How the {(COMMERCIAL_PRICING.OUTCOME_FEE_ANNUAL_PCT * 100).toFixed(0)}% annualized fee and {COMMERCIAL_PRICING.OUTCOME_FEE_CAP_MONTHS.toFixed(1)}&times; monthly cap protect your downside and preserve your multi-year upside.
            </p>
          </div>

          {/* Metrics summary banner */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 p-4 rounded-xl bg-slate-50 border border-slate-200 mb-6 text-xs">
            <div>
              <span className="text-slate-500 block text-[11px]">Verified Monthly Saving</span>
              <span className="text-base font-bold font-mono text-slate-900">${roi.verifiedMonthlySavingUsd.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[11px]">Annualized Saving</span>
              <span className="text-base font-bold font-mono text-slate-900">${roi.annualizedSavingUsd.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[11px]">{(COMMERCIAL_PRICING.OUTCOME_FEE_ANNUAL_PCT * 100).toFixed(0)}% of Annualized</span>
              <span className="text-base font-bold font-mono text-slate-600">${roi.rawOutcomeFeeUsd.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[11px]">Outcome Fee Cap</span>
              <span className="text-base font-bold font-mono text-emerald-700">${roi.capAmountUsd.toLocaleString()}</span>
            </div>
            <div className="col-span-2 sm:col-span-1 border-t sm:border-t-0 sm:border-l border-slate-200 pt-2 sm:pt-0 sm:pl-3">
              <span className="text-slate-500 block text-[11px]">Final Outcome Fee</span>
              <span className="text-base font-extrabold font-mono text-emerald-700">${roi.finalOutcomeFeeUsd.toLocaleString()}</span>
            </div>
          </div>

          {/* 3-Year Comparison Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 font-mono text-[11px] uppercase">
                  <th className="py-2.5 pr-4 font-semibold">Economic Dimension</th>
                  {roi.yearlyBreakdown.map((row) => (
                    <th key={row.year} className="py-2.5 px-4 font-semibold text-right">Year {row.year}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                <tr>
                  <td className="py-3 pr-4 font-sans font-medium text-slate-800">
                    Verified saving
                  </td>
                  {roi.yearlyBreakdown.map((row) => (
                    <td key={row.year} className="py-3 px-4 text-right text-emerald-700 font-bold">
                      ${row.verifiedSavingsUsd.toLocaleString()}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-sans font-medium text-slate-800">
                    AIDisCost fee
                  </td>
                  {roi.yearlyBreakdown.map((row) => (
                    <td key={row.year} className="py-3 px-4 text-right text-slate-900 font-semibold">
                      {row.aidiscostFeeUsd < 0 ? `-$${Math.abs(row.aidiscostFeeUsd).toLocaleString()}` : `$${row.aidiscostFeeUsd}`}
                    </td>
                  ))}
                </tr>
                <tr className="bg-emerald-50/50">
                  <td className="py-3 pr-4 font-sans font-bold text-emerald-950">
                    Net saving
                  </td>
                  {roi.yearlyBreakdown.map((row) => (
                    <td key={row.year} className="py-3 px-4 text-right text-emerald-800 font-extrabold">
                      ${row.netSavingsUsd.toLocaleString()}
                    </td>
                  ))}
                </tr>
                <tr className="bg-rose-50/40 text-rose-900">
                  <td className="py-3 pr-4 font-sans font-medium text-rose-800">
                    Illustrative unrealized savings (Cost of Inaction)
                  </td>
                  {roi.yearlyBreakdown.map((row) => (
                    <td key={row.year} className="py-3 px-4 text-right font-semibold text-rose-700">
                      -${Math.abs(row.costOfInactionUsd).toLocaleString()}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mt-4 pt-4 border-t border-slate-100 flex items-start gap-2 text-[11px] text-slate-500 leading-relaxed">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 text-slate-400 mt-0.5" />
            <p>
              {roi.disclaimer} The &quot;Illustrative unrealized savings&quot; row is an economic illustration of ongoing unaddressed waste, not an absolute prediction.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};
