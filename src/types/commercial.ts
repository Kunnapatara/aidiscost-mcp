/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface CommercialPricingConstants {
  FREE_AUDIT_PRICE_USD: 0;
  FIX_PACKAGE_PRICE_USD: 49;
  OUTCOME_FEE_ANNUAL_PCT: 0.20; // 20% of verified annualized savings
  OUTCOME_FEE_CAP_MONTHS: 1.0;  // Capped at 1 month of verified savings
  PROTECTION_MIN_RATIO: 0.50;   // Must achieve >= 50% of original estimate
}

export interface OutcomeFeeCalculation {
  verifiedMonthlyRunRateUsd: number;
  verifiedAnnualizedSavingsUsd: number;
  rawOutcomeFeeUsd: number;
  capAmountUsd: number;
  originalEstimatedMonthlySavingsUsd: number;
  realizedRatio: number;
  protectionTriggered: boolean;
  protectionReason?: string;
  finalOutcomeFeeUsd: number;
  isPayable: boolean;
  methodologyDescription: string;
}

export interface CommercialROIYearRow {
  year: number;
  verifiedSavingsUsd: number;
  aidiscostFeeUsd: number;
  netSavingsUsd: number;
  costOfInactionUsd: number;
}

export interface CommercialROIExample {
  verifiedMonthlySavingUsd: number;
  annualizedSavingUsd: number;
  rawOutcomeFeeUsd: number;
  capAmountUsd: number;
  finalOutcomeFeeUsd: number;
  yearlyBreakdown: CommercialROIYearRow[];
  disclaimer: string;
}
