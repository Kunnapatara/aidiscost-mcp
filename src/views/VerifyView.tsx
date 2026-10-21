/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { Finding, VerificationState, AIEvent, AuthoritativeVerification, OutcomeFeeObligation } from '../types/domain';
import { MetricTile } from '../components/MetricTile';
import { ProvenanceBadge } from '../components/ProvenanceBadge';
import { ArrowLeft, CheckCircle2, AlertTriangle, ShieldCheck, Clock, FlaskConical, Upload, FileText, CreditCard, Loader2 } from 'lucide-react';
import { calculateOutcomeFee, COMMERCIAL_PRICING } from '../engine/billing/outcome';
import { IngestionPipeline } from '../engine/ingestion/pipeline';
import { isCommerciallyVerified } from '../engine/verification/comparator';

interface VerifyViewProps {
  finding: Finding;
  verificationState: VerificationState;
  authoritativeVerification?: AuthoritativeVerification | null;
  outcomeFeeObligation?: OutcomeFeeObligation | null;
  onDeploy: (findingId: string) => void;
  onIngestObservation: (findingId: string, count: number) => void;
  onIngestRealObservation?: (findingId: string, events: AIEvent[], fileName: string) => void;
  onPayOutcomeFee?: (findingId: string) => Promise<void>;
  isAuthenticated?: boolean;
  onOpenAuth?: () => void;
  onBack: () => void;
}

export const VerifyView: React.FC<VerifyViewProps> = ({
  finding,
  verificationState,
  authoritativeVerification,
  outcomeFeeObligation,
  onDeploy,
  onIngestObservation,
  onIngestRealObservation,
  onPayOutcomeFee,
  isAuthenticated,
  onOpenAuth,
  onBack,
}) => {
  const [postImportError, setPostImportError] = useState<string | null>(null);
  const [postImportSuccess, setPostImportSuccess] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [postPasteContent, setPostPasteContent] = useState('');
  const [showPostPaste, setShowPostPaste] = useState(false);
  const [isPayingFee, setIsPayingFee] = useState(false);
  const postFileInputRef = useRef<HTMLInputElement>(null);

  const stage = verificationState.stage;
  const isBaseline = stage === 'BASELINE';
  const isObserving = stage === 'OBSERVATION_ACTIVE';
  const isSimulated = Boolean(verificationState.is_simulated);

  // CRITICAL TRUST BOUNDARY INVARIANT (Sprint A.1):
  // Commercial verification requires SERVER-AUTHORITATIVE proof.
  // Neither client-local state nor IndexedDB cache alone can establish commercial authority.
  const isVerified = isCommerciallyVerified(verificationState, authoritativeVerification);

  // Local unconfirmed preview detection: client claims VERIFIED_RESULT without confirmed server authority
  const isUnconfirmedLocalPreview = stage === 'VERIFIED_RESULT' && !isVerified && !isSimulated;

  // Active observation result to display
  const activeResult = isVerified
    ? verificationState.observed_result
    : (isSimulated && verificationState.simulated_result ? verificationState.simulated_result : verificationState.observed_result);

  const hasSimulationResult = isSimulated && Boolean(verificationState.simulated_result);
  const showFeeCard = isVerified || (hasSimulationResult && (activeResult?.observed_reduction_pct || 0) >= 10);

  const stages = [
    { key: 'BASELINE', label: '1. Baseline' },
    { key: 'CUSTOMER_DEPLOYED', label: '2. Deployed' },
    { key: 'OBSERVATION_ACTIVE', label: '3. Observation Active' },
    { key: 'VERIFIED_RESULT', label: '4. Verified Result' },
  ];

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      {/* Navigation & Header */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          id="btn-back-from-verify"
          onClick={onBack}
          className="text-xs font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1.5 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Finding</span>
        </button>

        <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-800 border border-slate-200">
          {finding.rule_id}
        </span>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-mono uppercase tracking-wider text-teal-700 font-semibold">
            Empirical Post-Deployment Verification
          </span>
          <ProvenanceBadge provenance={isVerified ? 'VERIFIED' : (isSimulated ? 'ESTIMATED' : 'ESTIMATED')} size="sm" />
          {isSimulated && (
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300 uppercase tracking-wide flex items-center gap-1">
              <FlaskConical className="w-3 h-3" />
              Demo / Simulation Telemetry
            </span>
          )}
        </div>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
          Verify Savings: {finding.title}
        </h1>
        <p className="text-sm text-slate-600 mt-1 max-w-2xl">
          Conservative validation engine. Authoritative verification requires qualifying post-deployment
          telemetry proving unit-cost reduction across comparable production traffic.
        </p>
      </div>

      {/* Non-Authoritative Local Preview / Cache Alert */}
      {isUnconfirmedLocalPreview && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-xs flex items-start gap-2.5 shadow-xs">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold block">Non-Authoritative Local Preview / Cache</span>
            <span className="text-slate-600">
              This verification state has not been confirmed or established by the server authority. Local calculations or browser-cached entries cannot produce commercially authoritative verification or outcome fee eligibility. Authoritative verification requires server evaluation.
            </span>
          </div>
        </div>
      )}

      {/* 4-Stage Verification Progression Bar */}
      <div className="p-4 sm:p-5 rounded-2xl bg-white border border-slate-200 shadow-xs">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {stages.map((s) => {
            const isStage4 = s.key === 'VERIFIED_RESULT';
            const isCurrent = isStage4 ? isVerified : stage === s.key;
            const isPassed =
              (stage === 'OBSERVATION_ACTIVE' && (s.key === 'BASELINE' || s.key === 'CUSTOMER_DEPLOYED')) ||
              (isVerified && !isStage4);

            return (
              <div
                key={s.key}
                className={`p-3 rounded-xl border text-xs font-semibold transition-all ${
                  isCurrent
                    ? 'bg-slate-900 border-slate-900 text-white shadow-xs'
                    : isPassed
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-slate-50 border-slate-200 text-slate-500'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  {isPassed ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  ) : isCurrent ? (
                    <Clock className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-slate-300" />
                  )}
                  <span className="truncate">{s.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Baseline Window Specifications */}
      <div className="p-5 rounded-2xl bg-white border border-slate-200 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
            Pre-Deployment Baseline Metric Window
          </h3>
          <ProvenanceBadge provenance="CALCULATED" size="sm" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <span className="text-slate-500 block mb-1 text-[11px] font-sans">Baseline Sample Count</span>
            <span className="font-bold text-slate-900 text-sm">{verificationState.baseline_window.sample_count} events</span>
          </div>
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <span className="text-slate-500 block mb-1 text-[11px] font-sans">Avg Cost per Execution</span>
            <span className="font-bold text-slate-900 text-sm">${verificationState.baseline_window.avg_cost_per_call_usd.toFixed(6)}</span>
          </div>
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <span className="text-slate-500 block mb-1 text-[11px] font-sans">Baseline Spend Basis</span>
            <span className="font-bold text-slate-900 text-sm">${finding.baseline_spend_usd.toFixed(4)}</span>
          </div>
        </div>
      </div>

      {/* Observation Window & Results (if deployed) */}
      {!isBaseline && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            <MetricTile
              id="metric-verify-pre"
              label="Pre-Deployment Unit Cost"
              value={`$${activeResult?.pre_cost_per_call_usd.toFixed(4) || '0.00'}`}
              subtext="Historical baseline per call"
              provenance="CALCULATED"
            />
            <MetricTile
              id="metric-verify-post"
              label={isSimulated ? 'Post-Deployment Unit Cost (Simulated)' : 'Post-Deployment Unit Cost'}
              value={`$${activeResult?.post_cost_per_call_usd.toFixed(4) || '0.00'}`}
              subtext={`${isSimulated ? 'Simulated across' : 'Across'} ${verificationState.observation_window?.sample_event_count || 0} observed events`}
              provenance={isVerified ? 'VERIFIED' : 'ESTIMATED'}
              highlight={isVerified}
            />
            <MetricTile
              id="metric-verify-realized"
              label={isSimulated ? 'Empirical Unit Reduction (Simulated)' : 'Empirical Unit Reduction'}
              value={`${activeResult?.observed_reduction_pct || 0}%`}
              subtext={
                isVerified
                  ? `Sustained annual savings: $${activeResult?.annualized_realized_savings_usd.toLocaleString()}`
                  : (isSimulated
                      ? `Simulated delta: $${activeResult?.annualized_realized_savings_usd.toLocaleString()}/yr`
                      : 'Requires >= 15 events threshold')
              }
              provenance={isVerified ? 'VERIFIED' : 'ESTIMATED'}
            />
          </div>

          {/* Verification Verdict & Notes */}
          <div
            className={`p-5 rounded-2xl border ${
              isVerified
                ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                : isSimulated
                ? 'bg-amber-50/70 border-amber-200 text-amber-950'
                : 'bg-slate-50 border-slate-200 text-slate-800'
            }`}
          >
            <div className="flex items-center gap-2 mb-2 font-bold text-xs uppercase tracking-wider">
              {isVerified ? (
                <>
                  <ShieldCheck className="w-4 h-4 text-emerald-700" />
                  <span>Verified Result: Empirical Confidence High</span>
                </>
              ) : isSimulated ? (
                <>
                  <FlaskConical className="w-4 h-4 text-amber-700" />
                  <span>Observation Active &mdash; Demo / Simulation Telemetry Preview</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-4 h-4 text-amber-700" />
                  <span>Observation Active: Insufficient Observation Sample</span>
                </>
              )}
            </div>
            <p className="text-xs sm:text-sm leading-relaxed">
              {activeResult?.verification_notes}
            </p>
          </div>

          {/* Outcome Fee Commercial Calculation (if verified or simulation preview) */}
          {showFeeCard && (() => {
            const annualSavings = activeResult?.annualized_realized_savings_usd || 0;
            const monthlySavings = annualSavings / 12;
            const estimatedMonthlySavings = (finding.annualized_projection_usd && finding.annualized_projection_usd > 0)
              ? Number((finding.annualized_projection_usd / 12).toFixed(2))
              : 0;
            const outcome = calculateOutcomeFee(monthlySavings, estimatedMonthlySavings);

            return (
              <div className={`p-6 rounded-2xl bg-white border-2 ${isVerified ? 'border-emerald-600' : 'border-amber-400'} shadow-sm space-y-4`}>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-block w-2 h-2 rounded-full ${isVerified ? 'bg-emerald-600' : 'bg-amber-500'}`} />
                      <h3 className={`text-xs font-bold uppercase tracking-wider font-mono ${isVerified ? 'text-emerald-800' : 'text-amber-900'}`}>
                        Step 3: Verified Outcome Fee Evaluation
                      </h3>
                      {isSimulated && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300 uppercase tracking-wide">
                          Demo / Simulation Telemetry
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Pay once, only after verification &bull; Capped at {COMMERCIAL_PRICING.OUTCOME_FEE_CAP_MONTHS.toFixed(0)} month of verified savings
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="text-[11px] uppercase tracking-wider font-mono text-slate-500 block">
                      {isSimulated ? 'Simulated One-Time Fee' : 'Final One-Time Fee'}
                    </span>
                    <span className={`text-2xl font-extrabold font-mono ${isVerified ? 'text-emerald-700' : 'text-amber-700'}`}>
                      ${outcome.finalOutcomeFeeUsd.toFixed(2)}
                    </span>
                  </div>
                </div>

                {/* Simulation Disclaimer Banner */}
                {isSimulated && (
                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-2">
                    <FlaskConical className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold block">SIMULATION PREVIEW ONLY &mdash; Non-Authoritative</span>
                      <span className="text-slate-600">
                        This fee breakdown illustrates how the contract evaluates empirical observations. It is not an invoice or commercial charge. A payable outcome fee only applies upon genuine production verification from non-simulated telemetry.
                      </span>
                    </div>
                  </div>
                )}

                {/* Mathematical breakdown */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 text-xs font-mono">
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="text-slate-500 block text-[11px] font-sans">Original Estimate/mo</span>
                    <span className="font-bold text-slate-900">${outcome.originalEstimatedMonthlySavingsUsd.toFixed(2)}</span>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="text-slate-500 block text-[11px] font-sans">{isSimulated ? 'Simulated Run-rate/mo' : 'Verified Run-rate/mo'}</span>
                    <span className="font-bold text-slate-900">${outcome.verifiedMonthlyRunRateUsd.toFixed(2)}</span>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="text-slate-500 block text-[11px] font-sans">Realized Ratio</span>
                    <span className={`font-bold ${outcome.protectionTriggered ? 'text-amber-700' : 'text-emerald-700'}`}>
                      {(outcome.realizedRatio * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="text-slate-500 block text-[11px] font-sans">Annualized (&times;12)</span>
                    <span className="font-bold text-slate-900">${outcome.verifiedAnnualizedSavingsUsd.toFixed(2)}</span>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="text-slate-500 block text-[11px] font-sans">{(COMMERCIAL_PRICING.OUTCOME_FEE_ANNUAL_PCT * 100).toFixed(0)}% Annualized Fee</span>
                    <span className="font-bold text-slate-600">${outcome.rawOutcomeFeeUsd.toFixed(2)}</span>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="text-slate-500 block text-[11px] font-sans">{COMMERCIAL_PRICING.OUTCOME_FEE_CAP_MONTHS.toFixed(0)}-Mo Cap ({COMMERCIAL_PRICING.OUTCOME_FEE_CAP_MONTHS.toFixed(1)}&times;)</span>
                    <span className={`font-bold ${isVerified ? 'text-emerald-700' : 'text-amber-700'}`}>${outcome.capAmountUsd.toFixed(2)}</span>
                  </div>
                </div>

                {/* 50% Protection Clause Callout */}
                {outcome.protectionTriggered ? (
                  <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs">
                    <span className="font-bold block mb-0.5">{(COMMERCIAL_PRICING.PROTECTION_MIN_RATIO * 100).toFixed(0)}% Protection Clause Triggered &mdash; Outcome Fee Waived ($0.00)</span>
                    <p className="leading-relaxed">
                      {outcome.protectionReason || `Savings achieved ${(outcome.realizedRatio * 100).toFixed(1)}% of original estimate, which is below the ${(COMMERCIAL_PRICING.PROTECTION_MIN_RATIO * 100).toFixed(0)}% threshold. Fee is waived to $0.00.`}
                    </p>
                  </div>
                ) : (
                  <div className={`p-3.5 rounded-xl ${isVerified ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950' : 'bg-slate-50 border-slate-200 text-slate-800'} text-xs flex items-center justify-between`}>
                    <div>
                      <span className="font-bold block">{(COMMERCIAL_PRICING.PROTECTION_MIN_RATIO * 100).toFixed(0)}% Protection Condition Satisfied</span>
                      <span className="text-slate-600">
                        Achieved {(outcome.realizedRatio * 100).toFixed(1)}% of original estimate (threshold &ge; {(COMMERCIAL_PRICING.PROTECTION_MIN_RATIO * 100).toFixed(0)}%). Fee bound by {COMMERCIAL_PRICING.OUTCOME_FEE_CAP_MONTHS.toFixed(0)}-month cap.
                      </span>
                    </div>
                    <span className={`text-xs font-mono font-bold ${isVerified ? 'text-emerald-700 border-emerald-200' : 'text-amber-700 border-amber-200'} px-2 py-1 bg-white rounded border`}>
                      Cap Bound: ${outcome.finalOutcomeFeeUsd.toFixed(2)}
                    </span>
                  </div>
                )}

                {/* Server-Authoritative Commercial Payment Action (Sprint B) */}
                {isVerified && outcome.isPayable && (() => {
                  const obligationStatus = outcomeFeeObligation?.status;
                  const feeAmountDisplay = outcomeFeeObligation && outcomeFeeObligation.fee_amount_usd > 0
                    ? outcomeFeeObligation.fee_amount_usd
                    : outcome.finalOutcomeFeeUsd;

                  return (
                    <div className="pt-3 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-900">Commercial Obligation:</span>
                          {obligationStatus === 'PAID' ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                              Outcome Fee Paid (${feeAmountDisplay.toFixed(2)})
                            </span>
                          ) : obligationStatus === 'SETTLED' ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-teal-100 text-teal-800 border border-teal-300">
                              <CheckCircle2 className="w-3.5 h-3.5 text-teal-600" />
                              Fee Settled
                            </span>
                          ) : obligationStatus === 'CHECKOUT_CREATED' ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300">
                              <Clock className="w-3.5 h-3.5 text-amber-600" />
                              Awaiting Payment Confirmation
                            </span>
                          ) : obligationStatus === 'FAILED' ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800 border border-rose-300">
                              <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
                              Payment Failed
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-800 border border-blue-300">
                              Payable (${feeAmountDisplay.toFixed(2)})
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {obligationStatus === 'PAID' || obligationStatus === 'SETTLED'
                            ? 'Authoritative payment confirmed via Lemon Squeezy webhook. Obligation fully satisfied.'
                            : obligationStatus === 'CHECKOUT_CREATED'
                            ? 'Checkout session initiated. Complete payment on Lemon Squeezy to satisfy obligation.'
                            : 'One-time Outcome Fee payment based strictly on server-authoritative verified savings.'}
                        </p>
                      </div>

                      {obligationStatus === 'PAID' || obligationStatus === 'SETTLED' ? (
                        <div className="flex items-center gap-2 text-xs font-bold text-emerald-700">
                          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          <span>Commercial Terms Met</span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          id="btn-pay-outcome-fee"
                          onClick={async () => {
                            if (!isAuthenticated && onOpenAuth) {
                              onOpenAuth();
                              return;
                            }
                            if (onPayOutcomeFee) {
                              setIsPayingFee(true);
                              try {
                                await onPayOutcomeFee(finding.id);
                              } finally {
                                setIsPayingFee(false);
                              }
                            }
                          }}
                          disabled={isPayingFee}
                          className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-colors flex items-center gap-2 shadow-xs shrink-0 disabled:opacity-50"
                        >
                          {isPayingFee ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span>Processing...</span>
                            </>
                          ) : (
                            <>
                              <CreditCard className="w-4 h-4" />
                              <span>
                                {obligationStatus === 'CHECKOUT_CREATED'
                                  ? 'Resume Checkout'
                                  : obligationStatus === 'FAILED'
                                  ? 'Retry Outcome Fee Payment'
                                  : `Pay Outcome Fee ($${feeAmountDisplay.toFixed(2)})`}
                              </span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  );
                })()}

                <div className="text-[11px] text-slate-500 leading-relaxed pt-2 border-t border-slate-100 flex items-start gap-1.5">
                  <span className="font-semibold text-slate-700 shrink-0">Truth Boundary:</span>
                  <span>Verification measures what changed. It does not guarantee future results. No ongoing percentage, recurring retainers, or subscription commitments.</span>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Interactive Verification Workflow Controls */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 space-y-6">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
          Verification Testing &amp; Lifecycle Controls
        </h3>

        {isBaseline ? (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h4 className="text-sm font-bold text-slate-900">Lifecycle Action: Mark Deployment as Live</h4>
              <p className="text-xs text-slate-500 mt-0.5">
                Sets the deployment timestamp. Subsequent telemetry events will be evaluated in the observation window.
              </p>
            </div>
            <button
              type="button"
              id="btn-mark-deployed"
              onClick={() => onDeploy(finding.id)}
              className="px-5 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors shrink-0"
            >
              Mark Deployed &amp; Start Observation
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-1">
              <div className="font-semibold text-slate-900 flex items-center gap-2">
                <Clock className="w-4 h-4 text-slate-600" />
                <span>Active Observation Window</span>
              </div>
              <p className="text-slate-600 leading-relaxed">
                Deployment timestamp logged: <strong className="font-mono text-slate-900">{verificationState.deployment_timestamp}</strong>.
                Only events occurring after this timestamp that match the affected scope ({finding.affected_scope}) are evaluated.
              </p>
              {verificationState.post_deployment_file_name && (
                <div className="mt-2 pt-2 border-t border-slate-200 text-slate-700 font-mono text-[11px] flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Imported Source: <strong>{verificationState.post_deployment_file_name}</strong></span>
                </div>
              )}
            </div>

            {/* SECTION 1: Production Post-Deployment Telemetry Import (Primary Path) */}
            <div className="p-5 rounded-2xl bg-emerald-50/50 border border-emerald-200 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">
                      Authoritative Path
                    </span>
                    <h4 className="text-sm font-bold text-slate-900">Import Post-Deployment Telemetry</h4>
                  </div>
                  <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                    Upload telemetry captured after deployment. AIDisCost evaluates unit costs, validates event provenance,
                    and calculates verified empirical reduction.
                  </p>
                </div>
              </div>

              {postImportError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-900 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <span>{postImportError}</span>
                </div>
              )}

              {postImportSuccess && (
                <div className="p-3 rounded-xl bg-emerald-100 border border-emerald-300 text-xs text-emerald-900 flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                  <span>{postImportSuccess}</span>
                </div>
              )}

              <input
                ref={postFileInputRef}
                type="file"
                accept=".csv,.json,.jsonl,.ndjson,.txt"
                className="hidden"
                id="input-post-deployment-file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setPostImportError(null);
                    setPostImportSuccess(null);
                    setIsImporting(true);
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                      try {
                        const text = ev.target?.result;
                        if (typeof text !== 'string') {
                          throw new Error('Could not read post-deployment file.');
                        }
                        const pipelineResult = IngestionPipeline.ingest(text, {
                          source: 'custom_logs',
                          fileName: file.name,
                        });
                        const events = pipelineResult.ingestResult?.events || [];
                        if (events.length === 0) {
                          throw new Error(`Parsed 0 telemetry events from "${file.name}". Please check the file format.`);
                        }
                        const productionEvents = events.map(event => ({
                          ...event,
                          is_simulated: false,
                        }));
                        if (onIngestRealObservation) {
                          onIngestRealObservation(finding.id, productionEvents, file.name);
                        }
                        setPostImportSuccess(`Successfully processed ${productionEvents.length} post-deployment events from "${file.name}".`);
                      } catch (err) {
                        setPostImportError((err as Error).message || 'Failed to process post-deployment telemetry.');
                      } finally {
                        setIsImporting(false);
                      }
                    };
                    reader.onerror = () => {
                      setPostImportError('File reading error occurred.');
                      setIsImporting(false);
                    };
                    reader.readAsText(file);
                  }
                }}
              />

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  id="btn-upload-post-telemetry"
                  disabled={isImporting}
                  onClick={() => postFileInputRef.current?.click()}
                  className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-colors flex items-center gap-2 shadow-xs"
                >
                  <Upload className="w-4 h-4" />
                  <span>{isImporting ? 'Processing File...' : 'Upload Post-Deployment File (.json, .jsonl, .csv)'}</span>
                </button>

                <button
                  type="button"
                  id="btn-toggle-post-paste"
                  onClick={() => setShowPostPaste(!showPostPaste)}
                  className="px-3.5 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-white transition-colors"
                >
                  {showPostPaste ? 'Hide Paste Form' : 'Paste Post-Deployment Logs'}
                </button>
              </div>

              {showPostPaste && (
                <div className="p-4 rounded-xl bg-white border border-slate-200 space-y-3 mt-3">
                  <label className="text-xs font-bold text-slate-700 block">
                    Paste Post-Deployment Telemetry (JSON lines or CSV)
                  </label>
                  <textarea
                    rows={4}
                    value={postPasteContent}
                    onChange={(e) => setPostPasteContent(e.target.value)}
                    placeholder='{"timestamp":"2026-09-23T20:00:00Z","model":"gpt-4o-mini","prompt_tokens":850,"completion_tokens":120,"cost":0.0018}'
                    className="w-full text-xs font-mono p-3 rounded-lg border border-slate-300 focus:ring-2 focus:ring-slate-900 focus:outline-hidden"
                  />
                  <button
                    type="button"
                    id="btn-submit-post-paste"
                    disabled={isImporting || !postPasteContent.trim()}
                    onClick={() => {
                      const trimmed = postPasteContent.trim();
                      if (!trimmed) return;
                      setPostImportError(null);
                      setPostImportSuccess(null);
                      setIsImporting(true);
                      try {
                        const pipelineResult = IngestionPipeline.ingest(trimmed, {
                          source: 'custom_logs',
                          fileName: 'pasted_post_deployment_telemetry',
                        });
                        const events = pipelineResult.ingestResult?.events || [];
                        if (events.length === 0) {
                          throw new Error('Parsed 0 telemetry events from pasted payload.');
                        }
                        const productionEvents = events.map(event => ({
                          ...event,
                          is_simulated: false,
                        }));
                        if (onIngestRealObservation) {
                          onIngestRealObservation(finding.id, productionEvents, 'pasted_post_deployment_telemetry');
                        }
                        setPostImportSuccess(`Successfully processed ${productionEvents.length} post-deployment events.`);
                        setPostPasteContent('');
                        setShowPostPaste(false);
                      } catch (err) {
                        setPostImportError((err as Error).message || 'Failed to process pasted telemetry.');
                      } finally {
                        setIsImporting(false);
                      }
                    }}
                    className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors"
                  >
                    Ingest &amp; Evaluate Pasted Telemetry
                  </button>
                </div>
              )}
            </div>

            {/* SECTION 2: Demo / Simulation Sandbox (Demarcated Non-Authoritative) */}
            <div className="p-5 rounded-2xl bg-amber-50/60 border border-amber-200 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded font-bold bg-amber-100 text-amber-900 border border-amber-300">
                  Demo Sandbox
                </span>
                <h4 className="text-xs font-bold text-amber-950">Simulation Preview (Non-Authoritative)</h4>
              </div>
              <p className="text-xs text-amber-900/80 leading-relaxed">
                Generate synthetic post-deployment events to preview how the verification stage and commercial fee formula behave.
                Simulation telemetry is explicitly marked non-authoritative and will never trigger an outcome fee.
              </p>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  id="btn-ingest-insufficient-sample"
                  onClick={() => onIngestObservation(finding.id, 5)}
                  className="px-3.5 py-2 rounded-lg border border-amber-300 bg-white text-amber-950 text-xs font-semibold hover:bg-amber-100/50 transition-colors"
                >
                  Simulate 5 Events (Triggers Insufficient Observation)
                </button>

                <button
                  type="button"
                  id="btn-ingest-full-verification"
                  onClick={() => onIngestObservation(finding.id, 25)}
                  className="px-3.5 py-2 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 transition-colors shadow-xs"
                >
                  Simulate 25 Events (Triggers Empirical Verification Preview)
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
