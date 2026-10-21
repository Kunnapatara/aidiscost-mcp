/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Finding, FixPackage } from '../types/domain';
import { ProvenanceBadge } from '../components/ProvenanceBadge';
import { Lock, Unlock, ArrowLeft, ArrowRight, ShieldCheck, CheckCircle2, Sliders, AlertTriangle, RefreshCw, CreditCard, ExternalLink } from 'lucide-react';
import { COMMERCIAL_PRICING } from '../engine/billing/outcome';
import { createFixPackageCheckout, getFindingEntitlement } from '../services/api';

interface FixPackageViewProps {
  finding: Finding;
  fixPackage: FixPackage;
  onUnlock: (findingId: string, status?: 'PAID_UNLOCKED' | 'DEMO_UNLOCKED') => void;
  onBack: () => void;
  onProceedVerify: (findingId: string) => void;
  isAuthenticated?: boolean;
  onOpenAuth?: () => void;
}

export const FixPackageView: React.FC<FixPackageViewProps> = ({
  finding,
  fixPackage,
  onUnlock,
  onBack,
  onProceedVerify,
  isAuthenticated = false,
  onOpenAuth,
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Check server-side entitlement on mount if authenticated
  useEffect(() => {
    let isMounted = true;
    if (isAuthenticated) {
      getFindingEntitlement(finding.id).then((res) => {
        if (isMounted && res && res.is_paid) {
          onUnlock(finding.id, 'PAID_UNLOCKED');
        }
      });
    }
    return () => {
      isMounted = false;
    };
  }, [finding.id, isAuthenticated, onUnlock]);

  const handleLemonSqueezyCheckout = async () => {
    setCheckoutError(null);

    if (!isAuthenticated) {
      if (onOpenAuth) onOpenAuth();
      return;
    }

    setIsProcessing(true);

    try {
      const redirectUrl = `${window.location.origin}/?checkout=success&finding_id=${encodeURIComponent(finding.id)}#/finding/${finding.id}/fix`;
      const res = await createFixPackageCheckout(finding.id, redirectUrl);
      if (res.success && res.checkout_url) {
        // Real Lemon Squeezy checkout redirect
        window.location.href = res.checkout_url;
        return;
      }

      if (res.error === 'ALREADY_ENTITLED') {
        onUnlock(finding.id, 'PAID_UNLOCKED');
        setIsProcessing(false);
        return;
      }

      // Truthful error state when billing is not configured or fails
      setCheckoutError(res.message || 'Fix Package checkout is not currently available.');
    } catch (err) {
      setCheckoutError((err as Error).message || 'Unable to connect to payment server.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSimulatePayment = () => {
    setIsProcessing(true);
    setTimeout(() => {
      onUnlock(finding.id, 'DEMO_UNLOCKED');
      setIsProcessing(false);
    }, 500);
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      {/* Navigation Header */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          id="btn-back-to-finding"
          onClick={onBack}
          className="text-xs font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1.5 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Evidence (Finding)</span>
        </button>

        <div className="flex items-center gap-2">
          {fixPackage.unlocked ? (
            fixPackage.entitlement_status === 'PAID_UNLOCKED' ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">
                <Unlock className="w-3.5 h-3.5 text-emerald-700" />
                <span>PAID ENTITLEMENT VERIFIED</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300">
                <Unlock className="w-3.5 h-3.5 text-amber-700" />
                <span>DEMO PREVIEW ONLY (NON-AUTHORITATIVE)</span>
              </span>
            )
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-800 border border-slate-300">
              <Lock className="w-3.5 h-3.5 text-slate-600" />
              <span>${COMMERCIAL_PRICING.FIX_PACKAGE_PRICE_USD} / FINDING (ONE-TIME)</span>
            </span>
          )}
        </div>
      </div>

      {/* Package Header */}
      <div>
        <span className="text-xs font-mono uppercase tracking-wider text-purple-700 font-semibold">
          Step 2: Fix Package
        </span>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight mt-1">
          Optimization Fix Package: {finding.title}
        </h1>
        <p className="text-sm text-slate-600 mt-1 max-w-2xl">
          Engineered remediation plan for {finding.affected_scope}. Actionable deliverable
          designed for your team to test, merge, and verify without vendor lock-in.
        </p>
      </div>

      {/* Checkout Error / Unconfigured Notice */}
      {checkoutError && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 text-xs flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <span className="font-bold block">Payment Gateway Notice</span>
            <p className="leading-relaxed">{checkoutError}</p>
            <p className="text-[11px] text-amber-800">
              {checkoutError.includes('not currently available')
                ? 'Lemon Squeezy environment credentials (LEMON_SQUEEZY_API_KEY, LEMON_SQUEEZY_STORE_ID, LEMON_SQUEEZY_VARIANT_ID) are pending configuration in the server environment.'
                : 'Please check your connection and try again.'}
            </p>
          </div>
        </div>
      )}

      {/* Unlock Callout Banner (if locked) */}
      {!fixPackage.unlocked && (
        <div className="p-6 rounded-2xl bg-slate-900 text-white shadow-md flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          <div>
            <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold uppercase tracking-wider mb-1">
              <Lock className="w-4 h-4" />
              <span>Actionable Engineering Deliverable &bull; ${COMMERCIAL_PRICING.FIX_PACKAGE_PRICE_USD} / finding</span>
            </div>
            <h2 className="text-xl font-bold">Unlock Full Implementation Specifications</h2>
            <p className="text-xs text-slate-300 mt-1 max-w-lg leading-relaxed">
              Unlocks the root cause diagnosis, recommended architecture specification, 48-hour canary test harness instructions,
              acceptance criteria checklist, rollback protocol, and verification thresholds.
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-slate-400 font-medium">
              <span>&bull; One-time deliverable</span>
              <span>&bull; No subscription</span>
              <span>&bull; Each finding unlocks separately</span>
              <span>&bull; Implement using your own engineers, Cursor, or existing tools</span>
            </div>
          </div>

          <div className="shrink-0 flex flex-col items-start sm:items-end gap-2">
            <button
              type="button"
              id="btn-purchase-unlock"
              onClick={handleLemonSqueezyCheckout}
              disabled={isProcessing}
              className="px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition-colors shadow-sm flex items-center gap-2"
            >
              {isProcessing ? (
                <span>Preparing Checkout...</span>
              ) : (
                <>
                  <CreditCard className="w-4 h-4" />
                  <span>Unlock Fix Package — ${COMMERCIAL_PRICING.FIX_PACKAGE_PRICE_USD}</span>
                </>
              )}
            </button>
            <span className="text-[11px] text-slate-400">
              One-time payment via Lemon Squeezy &bull; No recurring fee
            </span>
          </div>
        </div>
      )}

      {/* Free Audit Preview: High-Level Recommendation Summary & Expected Impact */}
      <div className="p-5 sm:p-6 rounded-2xl bg-white border border-slate-200 space-y-2">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block">
          Free Audit Preview &bull; High-Level Opportunity Summary
        </span>
        <p className="text-sm text-slate-800 leading-relaxed font-sans">
          {finding.summary}
        </p>
      </div>

      {/* Expected Impact Summary (Estimated / Potential, not guaranteed) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <div className="p-4 rounded-xl bg-white border border-slate-200">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1">
            Projected Monthly Savings
          </span>
          <span className="text-2xl font-bold font-mono text-emerald-700 tabular-nums">
            ${fixPackage.expected_impact.monthly_savings_usd.toFixed(2)}
          </span>
          <p className="text-[11px] text-slate-500 mt-1 leading-snug">
            {fixPackage.expected_impact.projection_basis
              ? 'Modeled run-rate projection under constant volume'
              : 'Estimated direct reduction at steady-state volume'}
          </p>
        </div>

        <div className="p-4 rounded-xl bg-white border border-slate-200">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1">
            Expected Latency Delta
          </span>
          <span className="text-2xl font-bold font-mono text-slate-900 tabular-nums">
            {fixPackage.expected_impact.latency_delta_ms !== 0
              ? `${fixPackage.expected_impact.latency_delta_ms} ms`
              : 'Benchmark Req.'}
          </span>
          <p className="text-[11px] text-slate-500 mt-1 leading-snug">
            Requires empirical measurement during canary testing
          </p>
        </div>

        <div className="p-4 rounded-xl bg-white border border-slate-200">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1">
            Quality Risk Grade
          </span>
          <span className={`text-xl font-bold font-mono ${
            fixPackage.expected_impact.quality_risk === 'REQUIRES_BENCHMARK'
              ? 'text-amber-800'
              : 'text-slate-900'
          }`}>
            {fixPackage.expected_impact.quality_risk.replace('_', ' ')}
          </span>
          <p className="text-[11px] text-slate-500 mt-1 leading-snug">
            {fixPackage.expected_impact.quality_risk === 'REQUIRES_BENCHMARK'
              ? 'Benchmark test required; quality cannot be assumed'
              : 'Evaluated by task complexity constraints'}
          </p>
        </div>
      </div>

      {/* Actionable Engineering Deliverables (True DOM Gating) */}
      {!fixPackage.unlocked ? (
        <div className="p-8 rounded-2xl bg-white border border-slate-200 text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto text-slate-700">
            <Lock className="w-6 h-6" />
          </div>
          <div className="max-w-md mx-auto space-y-1">
            <h3 className="text-base font-bold text-slate-900">
              Actionable Implementation Package Gated
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              The complete engineering package includes Root Cause Diagnosis, Recommended Architecture Specification,
              Canary Test Harness Configuration, Acceptance Criteria Checklist, Rapid Rollback Protocol, and Empirical Verification Instructions.
            </p>
          </div>
          <div className="pt-2">
            <button
              type="button"
              id="btn-unlock-deliverables"
              onClick={handleSimulatePayment}
              disabled={isProcessing}
              className="px-6 py-3 rounded-xl bg-slate-900 text-white font-bold text-xs hover:bg-slate-800 transition-colors inline-flex items-center gap-2"
            >
              <Unlock className="w-4 h-4 text-emerald-400" />
              <span>Unlock Fix Package — ${COMMERCIAL_PRICING.FIX_PACKAGE_PRICE_USD} (Preview Mode)</span>
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            One-time deliverable per finding &bull; No subscription &bull; Standalone MVP mode (no live credit card charged)
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* 1. Root Cause Hypothesis */}
          <div className="p-5 sm:p-6 rounded-2xl bg-white border border-slate-200 space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <span>1. Root Cause Hypothesis</span>
            </h3>
            <p className="text-xs sm:text-sm text-slate-700 leading-relaxed font-sans">
              {fixPackage.root_cause_hypothesis}
            </p>
          </div>

          {/* 2. Recommended Approach */}
          <div className="p-5 sm:p-6 rounded-2xl bg-white border border-slate-200 space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <span>2. Recommended Architecture Approach</span>
            </h3>
            <p className="text-xs sm:text-sm text-slate-700 leading-relaxed font-sans">
              {fixPackage.recommended_approach}
            </p>
          </div>

          {/* 3. Test Plan & Canary Harness */}
          <div className="p-5 sm:p-6 rounded-2xl bg-white border border-slate-200 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
              3. Test Plan &amp; Canary Harness Configuration
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <span className="font-semibold text-slate-500 block mb-1">Recommended Sample Size</span>
                <span className="font-mono font-bold text-slate-900 text-sm">
                  {fixPackage.test_plan.sample_size} cases
                </span>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <span className="font-semibold text-slate-500 block mb-1">Canary Traffic Allocation</span>
                <span className="font-mono font-bold text-slate-900 text-sm">
                  {fixPackage.test_plan.traffic_allocation_pct}% of live requests
                </span>
              </div>
            </div>

            <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 text-xs">
              <span className="font-semibold text-slate-700 block mb-1">Evaluation Criteria:</span>
              <p className="text-slate-600 font-mono">{fixPackage.test_plan.evaluation_criteria}</p>
            </div>

            <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 text-xs">
              <span className="font-semibold text-slate-700 block mb-1">Test Harness Instructions:</span>
              <p className="text-slate-600 leading-relaxed font-sans">{fixPackage.test_plan.test_harness_instructions}</p>
            </div>
          </div>

          {/* 4. Acceptance Criteria Checklist */}
          <div className="p-5 sm:p-6 rounded-2xl bg-white border border-slate-200 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
              4. Acceptance Criteria Checklist
            </h3>

            <div className="space-y-2">
              {fixPackage.acceptance_criteria.map((crit, idx) => (
                <div key={idx} className="flex items-start gap-2.5 text-xs text-slate-700">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>{crit}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 5. Rollback Plan */}
          <div className="p-5 sm:p-6 rounded-2xl bg-white border border-slate-200 space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              <span>5. Rapid Rollback Protocol</span>
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed font-sans">
              {fixPackage.rollback_plan}
            </p>
          </div>

          {/* 6. Verification Protocol */}
          <div className="p-5 sm:p-6 rounded-2xl bg-white border border-slate-200 space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-teal-600" />
              <span>6. Verification Protocol</span>
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed font-sans">
              {fixPackage.verification_instructions}
            </p>
          </div>
        </div>
      )}

      {/* Footer / Progression CTA */}
      <div className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3">
        <button
          type="button"
          id="btn-fix-back"
          onClick={onBack}
          className="text-xs font-bold text-slate-600 hover:text-slate-900"
        >
          &larr; Back to Evidence
        </button>

        <button
          type="button"
          id="btn-fix-to-verify"
          onClick={() => onProceedVerify(finding.id)}
          className="px-6 py-3 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors shadow-xs flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4 text-emerald-400" />
          <span>Proceed to Post-Deployment Verification</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
