/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommercialPricingConstants, OutcomeFeeCalculation, CommercialROIExample } from '../../types/commercial';
import { Finding, VerificationState, AuthoritativeVerification } from '../../types/domain';
import { isAuthoritativeVerified, getAuthoritativeVerifiedSavings } from '../verification/comparator';

export const COMMERCIAL_PRICING: CommercialPricingConstants = {
  FREE_AUDIT_PRICE_USD: 0,
  FIX_PACKAGE_PRICE_USD: 49,
  OUTCOME_FEE_ANNUAL_PCT: 0.20,
  OUTCOME_FEE_CAP_MONTHS: 1.0,
  PROTECTION_MIN_RATIO: 0.50,
};

/**
 * Calculates the Outcome Fee deterministically from verified monthly savings run-rate
 * and original estimated monthly savings.
 * 
 * Rules:
 * 1. Verified Annualized Savings = Verified Monthly Run-rate × 12
 * 2. Raw Outcome Fee = 20% × Verified Annualized Savings
 * 3. Cap = 1.0 × Verified Monthly Run-rate
 * 4. Fee before protection = MIN(Raw Outcome Fee, Cap)
 * 5. 50% Protection Clause:
 *    If verifiedMonthly < originalEstimateMonthly × 0.50, you pay no outcome fee ($0.00).
 *    Boundary: 49.99% -> $0 outcome fee; 50.00% -> normal fee calculation.
 * 6. Safety:
 *    Zero verified savings -> $0.00 fee.
 *    Negative values -> $0.00 fee (no negative fees or NaN).
 */
export function calculateOutcomeFee(
  verifiedMonthlySavingsUsd: number,
  originalEstimatedMonthlySavingsUsd: number
): OutcomeFeeCalculation {
  // Guard against NaN, undefined, or negative values
  const verifiedMonthly = Number.isFinite(verifiedMonthlySavingsUsd) ? Math.max(0, verifiedMonthlySavingsUsd) : 0;
  const originalEstimate = Number.isFinite(originalEstimatedMonthlySavingsUsd) ? Math.max(0, originalEstimatedMonthlySavingsUsd) : 0;

  if (verifiedMonthly <= 0) {
    return {
      verifiedMonthlyRunRateUsd: 0,
      verifiedAnnualizedSavingsUsd: 0,
      rawOutcomeFeeUsd: 0,
      capAmountUsd: 0,
      originalEstimatedMonthlySavingsUsd: originalEstimate,
      realizedRatio: 0,
      protectionTriggered: false,
      finalOutcomeFeeUsd: 0,
      isPayable: false,
      methodologyDescription: 'Zero verified monthly run-rate. No outcome fee is payable.',
    };
  }

  const annualized = Number((verifiedMonthly * 12).toFixed(2));
  const rawFee = Number((annualized * COMMERCIAL_PRICING.OUTCOME_FEE_ANNUAL_PCT).toFixed(2));
  const cap = Number((verifiedMonthly * COMMERCIAL_PRICING.OUTCOME_FEE_CAP_MONTHS).toFixed(2));
  const feeBeforeProtection = Math.min(rawFee, cap);

  // Protection evaluation: compare verified monthly run-rate against original estimate
  let protectionTriggered = false;
  let protectionReason: string | undefined;
  let realizedRatio = 0;

  if (originalEstimate <= 0) {
    // Contractual safety: If there is no valid positive original estimate baseline,
    // we cannot validate 50% protection compliance. The system must NOT invent a commercial
    // obligation or assume a fallback ratio of 100%. The fee is safely waived ($0.00).
    protectionTriggered = true;
    protectionReason = 'Missing or non-positive original estimate baseline ($0.00). Under the commercial contract, 50% protection compliance cannot be validated without a valid original estimate; outcome fee is waived ($0.00).';
    realizedRatio = 0;
  } else {
    realizedRatio = verifiedMonthly / originalEstimate;
    // Boundary: Strictly below 50% (< 0.50) triggers protection and waives fee to $0.
    // 50.00% and above does NOT trigger protection (normal fee calculation).
    // No artificial contractual tolerance or epsilon is permitted.
    if (realizedRatio < COMMERCIAL_PRICING.PROTECTION_MIN_RATIO) {
      protectionTriggered = true;
      protectionReason = `Verified savings ($${verifiedMonthly.toFixed(2)}/mo, ${(realizedRatio * 100).toFixed(2)}%) fell below 50% of the original estimate ($${originalEstimate.toFixed(2)}/mo). 50% Protection Clause triggered: $0.00 fee.`;
    }
  }

  const finalFee = protectionTriggered ? 0 : Number(feeBeforeProtection.toFixed(2));

  return {
    verifiedMonthlyRunRateUsd: verifiedMonthly,
    verifiedAnnualizedSavingsUsd: annualized,
    rawOutcomeFeeUsd: rawFee,
    capAmountUsd: cap,
    originalEstimatedMonthlySavingsUsd: originalEstimate,
    realizedRatio,
    protectionTriggered,
    protectionReason,
    finalOutcomeFeeUsd: finalFee,
    isPayable: finalFee > 0,
    methodologyDescription: protectionTriggered
      ? `50% Protection Clause triggered (achieved ${(realizedRatio * 100).toFixed(2)}% vs 50% threshold). Outcome fee waived ($0.00).`
      : `Verified monthly run-rate ($${verifiedMonthly.toFixed(2)}) annualized to $${annualized.toFixed(2)}. 20% fee is $${rawFee.toFixed(2)}, capped at 1 month ($${cap.toFixed(2)}). Final one-time fee: $${finalFee.toFixed(2)}.`,
  };
}

/**
 * Generates the canonical ROI and cost-of-inaction commercial illustration:
 * Verified Monthly: $1,000
 * Annualized: $12,000
 * 20% Annualized: $2,400
 * Cap: $1,000
 * Final: $1,000
 */
export function generateCommercialROIExample(): CommercialROIExample {
  const monthly = 1000;
  const annualized = 12000;
  const raw = 2400;
  const cap = 1000;
  const finalFee = 1000;

  return {
    verifiedMonthlySavingUsd: monthly,
    annualizedSavingUsd: annualized,
    rawOutcomeFeeUsd: raw,
    capAmountUsd: cap,
    finalOutcomeFeeUsd: finalFee,
    yearlyBreakdown: [
      {
        year: 1,
        verifiedSavingsUsd: 12000,
        aidiscostFeeUsd: -1000,
        netSavingsUsd: 11000,
        costOfInactionUsd: -12000,
      },
      {
        year: 2,
        verifiedSavingsUsd: 12000,
        aidiscostFeeUsd: 0,
        netSavingsUsd: 12000,
        costOfInactionUsd: -12000,
      },
      {
        year: 3,
        verifiedSavingsUsd: 12000,
        aidiscostFeeUsd: 0,
        netSavingsUsd: 12000,
        costOfInactionUsd: -12000,
      },
    ],
    disclaimer:
      "Economic illustration based on the example's verified monthly saving continuing at the same rate. Not a guarantee of future results.",
  };
}

/**
 * Authoritatively calculates the commercial outcome fee from a Finding and VerificationState.
 * Guarantees that unverified or simulated telemetry cannot produce a commercial obligation.
 */
export function calculateAuthoritativeOutcomeFee(
  verificationState: VerificationState,
  finding: Finding
): OutcomeFeeCalculation {
  const originalEstimate = (finding.annualized_projection_usd && finding.annualized_projection_usd > 0)
    ? Number((finding.annualized_projection_usd / 12).toFixed(2))
    : 0;

  if (!isAuthoritativeVerified(verificationState) || finding.is_sample_data === true) {
    return {
      verifiedMonthlyRunRateUsd: 0,
      verifiedAnnualizedSavingsUsd: 0,
      rawOutcomeFeeUsd: 0,
      capAmountUsd: 0,
      originalEstimatedMonthlySavingsUsd: originalEstimate,
      realizedRatio: 0,
      protectionTriggered: false,
      protectionReason: verificationState.is_simulated
        ? 'Telemetric evaluation was simulated (demo). Authoritative commercial billing requires genuine production verification.'
        : 'Finding has not reached an authoritative VERIFIED_RESULT stage.',
      finalOutcomeFeeUsd: 0,
      isPayable: false,
      methodologyDescription: 'Non-authoritative or unverified telemetry. No outcome fee is payable.',
    };
  }

  const verifiedAnnualSavings = getAuthoritativeVerifiedSavings(verificationState);
  const verifiedMonthlySavings = verifiedAnnualSavings / 12;

  return calculateOutcomeFee(verifiedMonthlySavings, originalEstimate);
}

/**
 * Server-authoritative Outcome Fee calculation directly from persisted AuthoritativeVerification record.
 * Guarantees that unverified, simulated, or non-authoritative records cannot produce a commercial obligation.
 */
export function calculateAuthoritativeVerificationFee(
  verification: AuthoritativeVerification,
  originalEstimatedAnnualizedSavingsUsd?: number
): OutcomeFeeCalculation {
  const originalEstimateMonthly = (originalEstimatedAnnualizedSavingsUsd && Number.isFinite(originalEstimatedAnnualizedSavingsUsd) && originalEstimatedAnnualizedSavingsUsd > 0)
    ? Number((originalEstimatedAnnualizedSavingsUsd / 12).toFixed(2))
    : 0;

  if (
    !verification.is_authoritative ||
    verification.is_simulated ||
    verification.stage !== 'VERIFIED_RESULT' ||
    !verification.verified_annualized_savings_usd ||
    verification.verified_annualized_savings_usd <= 0
  ) {
    return {
      verifiedMonthlyRunRateUsd: 0,
      verifiedAnnualizedSavingsUsd: 0,
      rawOutcomeFeeUsd: 0,
      capAmountUsd: 0,
      originalEstimatedMonthlySavingsUsd: originalEstimateMonthly,
      realizedRatio: 0,
      protectionTriggered: false,
      protectionReason: verification.is_simulated
        ? 'Telemetric evaluation was simulated (demo). Authoritative commercial billing requires genuine production verification.'
        : 'Finding has not reached an authoritative VERIFIED_RESULT stage.',
      finalOutcomeFeeUsd: 0,
      isPayable: false,
      methodologyDescription: 'Non-authoritative or unverified telemetry. No outcome fee is payable.',
    };
  }

  const verifiedAnnualSavings = verification.verified_annualized_savings_usd;
  const verifiedMonthlySavings = verifiedAnnualSavings / 12;

  return calculateOutcomeFee(verifiedMonthlySavings, originalEstimateMonthly);
}

