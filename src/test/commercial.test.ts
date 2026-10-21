/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { calculateOutcomeFee, generateCommercialROIExample, COMMERCIAL_PRICING } from '../engine/billing/outcome';

describe('AIDisCost Commercial Contract — Outcome Fee & Protection Tests', () => {
  describe('Cap Examples (1.0x Monthly Run-rate Binding)', () => {
    test('calculates $500 monthly run-rate correctly with cap binding', () => {
      // Annualized = $6,000. Raw 20% = $1,200. Cap = $500. Final = $500.
      const result = calculateOutcomeFee(500, 500);
      assert.strictEqual(result.verifiedMonthlyRunRateUsd, 500);
      assert.strictEqual(result.verifiedAnnualizedSavingsUsd, 6000);
      assert.strictEqual(result.rawOutcomeFeeUsd, 1200);
      assert.strictEqual(result.capAmountUsd, 500);
      assert.strictEqual(result.finalOutcomeFeeUsd, 500);
      assert.strictEqual(result.protectionTriggered, false);
      assert.strictEqual(result.isPayable, true);
    });

    test('calculates $1,000 monthly run-rate correctly with cap binding', () => {
      // Annualized = $12,000. Raw 20% = $2,400. Cap = $1,000. Final = $1,000.
      const result = calculateOutcomeFee(1000, 1000);
      assert.strictEqual(result.verifiedMonthlyRunRateUsd, 1000);
      assert.strictEqual(result.verifiedAnnualizedSavingsUsd, 12000);
      assert.strictEqual(result.rawOutcomeFeeUsd, 2400);
      assert.strictEqual(result.capAmountUsd, 1000);
      assert.strictEqual(result.finalOutcomeFeeUsd, 1000);
      assert.strictEqual(result.protectionTriggered, false);
      assert.strictEqual(result.isPayable, true);
    });

    test('calculates $2,500 monthly run-rate correctly with cap binding', () => {
      // Annualized = $30,000. Raw 20% = $6,000. Cap = $2,500. Final = $2,500.
      const result = calculateOutcomeFee(2500, 2500);
      assert.strictEqual(result.verifiedMonthlyRunRateUsd, 2500);
      assert.strictEqual(result.verifiedAnnualizedSavingsUsd, 30000);
      assert.strictEqual(result.rawOutcomeFeeUsd, 6000);
      assert.strictEqual(result.capAmountUsd, 2500);
      assert.strictEqual(result.finalOutcomeFeeUsd, 2500);
      assert.strictEqual(result.protectionTriggered, false);
      assert.strictEqual(result.isPayable, true);
    });

    test('calculates $5,000 monthly run-rate correctly with cap binding', () => {
      // Annualized = $60,000. Raw 20% = $12,000. Cap = $5,000. Final = $5,000.
      const result = calculateOutcomeFee(5000, 5000);
      assert.strictEqual(result.verifiedMonthlyRunRateUsd, 5000);
      assert.strictEqual(result.verifiedAnnualizedSavingsUsd, 60000);
      assert.strictEqual(result.rawOutcomeFeeUsd, 12000);
      assert.strictEqual(result.capAmountUsd, 5000);
      assert.strictEqual(result.finalOutcomeFeeUsd, 5000);
      assert.strictEqual(result.protectionTriggered, false);
      assert.strictEqual(result.isPayable, true);
    });
  });

  describe('50% Protection Clause Verification', () => {
    const originalEstimate = 1000;

    test('triggers protection clause and waives fee to $0 when verified is $499.90 (49.99%)', () => {
      const result = calculateOutcomeFee(499.90, originalEstimate);
      assert.ok(Math.abs(result.realizedRatio - 0.4999) < 0.001);
      assert.strictEqual(result.protectionTriggered, true);
      assert.strictEqual(result.finalOutcomeFeeUsd, 0);
      assert.strictEqual(result.isPayable, false);
      assert.ok(result.protectionReason !== undefined);
    });

    test('triggers protection clause and waives fee to $0 when verified is $499.99', () => {
      const result = calculateOutcomeFee(499.99, originalEstimate);
      assert.strictEqual(result.protectionTriggered, true);
      assert.strictEqual(result.finalOutcomeFeeUsd, 0);
      assert.strictEqual(result.isPayable, false);
    });

    test('Case A: triggers protection clause and waives fee to $0 when verified is $499.999999 (exact floating-point boundary)', () => {
      const result = calculateOutcomeFee(499.999999, originalEstimate);
      assert.strictEqual(result.protectionTriggered, true);
      assert.strictEqual(result.finalOutcomeFeeUsd, 0);
      assert.strictEqual(result.isPayable, false);
    });

    test('Case B: does NOT trigger protection clause when verified is exactly $500.00 (50.00% exact boundary)', () => {
      const result = calculateOutcomeFee(500.00, originalEstimate);
      assert.strictEqual(result.realizedRatio, 0.5);
      assert.strictEqual(result.protectionTriggered, false);
      // Raw: $500 * 12 * 0.20 = $1,200. Cap: $500. Final: $500.
      assert.strictEqual(result.finalOutcomeFeeUsd, 500);
      assert.strictEqual(result.isPayable, true);
    });

    test('Case C: does NOT trigger protection clause when verified is $500.000001 (>50.00% exact boundary)', () => {
      const result = calculateOutcomeFee(500.000001, originalEstimate);
      assert.strictEqual(result.protectionTriggered, false);
      assert.strictEqual(result.finalOutcomeFeeUsd, 500);
      assert.strictEqual(result.isPayable, true);
    });

    test('evaluates normal outcome fee when verified exceeds 50% ($600 / $1000 = 60%)', () => {
      const result = calculateOutcomeFee(600, originalEstimate);
      assert.strictEqual(result.realizedRatio, 0.6);
      assert.strictEqual(result.protectionTriggered, false);
      assert.strictEqual(result.finalOutcomeFeeUsd, 600);
      assert.strictEqual(result.isPayable, true);
    });

    test('evaluates normal outcome fee when verified equals original estimate ($1000 / $1000 = 100%)', () => {
      const result = calculateOutcomeFee(1000, originalEstimate);
      assert.strictEqual(result.realizedRatio, 1.0);
      assert.strictEqual(result.protectionTriggered, false);
      assert.strictEqual(result.finalOutcomeFeeUsd, 1000);
      assert.strictEqual(result.isPayable, true);
    });
  });

  describe('Zero and Negative Value Safety Handling', () => {
    test('handles zero verified savings gracefully ($0 fee)', () => {
      const result = calculateOutcomeFee(0, 1000);
      assert.strictEqual(result.verifiedMonthlyRunRateUsd, 0);
      assert.strictEqual(result.finalOutcomeFeeUsd, 0);
      assert.strictEqual(result.isPayable, false);
    });

    test('handles negative verified savings safely without producing negative fees', () => {
      const result = calculateOutcomeFee(-250, 1000);
      assert.strictEqual(result.verifiedMonthlyRunRateUsd, 0);
      assert.strictEqual(result.finalOutcomeFeeUsd, 0);
      assert.strictEqual(result.isPayable, false);
    });

    test('handles NaN or non-finite inputs safely', () => {
      const result = calculateOutcomeFee(Number.NaN, Number.NaN);
      assert.strictEqual(result.verifiedMonthlyRunRateUsd, 0);
      assert.strictEqual(result.finalOutcomeFeeUsd, 0);
      assert.strictEqual(result.isPayable, false);
    });

    test('handles zero original estimate safely by waiving fee ($0) rather than inventing a commercial obligation', () => {
      const result = calculateOutcomeFee(500, 0);
      assert.strictEqual(result.verifiedMonthlyRunRateUsd, 500);
      assert.strictEqual(result.finalOutcomeFeeUsd, 0);
      assert.strictEqual(result.protectionTriggered, true);
      assert.strictEqual(result.isPayable, false);
      assert.ok(result.protectionReason?.includes('Missing or non-positive original estimate baseline'));
    });

    test('handles negative original estimate safely by waiving fee ($0)', () => {
      const result = calculateOutcomeFee(500, -250);
      assert.strictEqual(result.verifiedMonthlyRunRateUsd, 500);
      assert.strictEqual(result.finalOutcomeFeeUsd, 0);
      assert.strictEqual(result.protectionTriggered, true);
      assert.strictEqual(result.isPayable, false);
      assert.ok(result.protectionReason?.includes('Missing or non-positive original estimate baseline'));
    });
  });

  describe('Commercial Contract Invariants', () => {
    test('guarantees finalOutcomeFee is always >= 0 and <= verifiedMonthlySavings for positive inputs', () => {
      const testInputs = [10, 50, 100, 350, 750, 1200, 4800, 15000];
      for (const monthly of testInputs) {
        const result = calculateOutcomeFee(monthly, monthly);
        assert.ok(result.finalOutcomeFeeUsd >= 0);
        assert.ok(result.finalOutcomeFeeUsd <= monthly);
      }
    });

    test('enforces that when protection is triggered, final fee is strictly 0', () => {
      const result = calculateOutcomeFee(200, 1000); // 20% < 50%
      assert.strictEqual(result.protectionTriggered, true);
      assert.strictEqual(result.finalOutcomeFeeUsd, 0);
    });
  });

  describe('ROI & Cost of Inaction Commercial Illustration', () => {
    test('produces the exact canonical illustration specified in the locked contract', () => {
      const example = generateCommercialROIExample();
      assert.strictEqual(example.verifiedMonthlySavingUsd, 1000);
      assert.strictEqual(example.annualizedSavingUsd, 12000);
      assert.strictEqual(example.rawOutcomeFeeUsd, 2400);
      assert.strictEqual(example.capAmountUsd, 1000);
      assert.strictEqual(example.finalOutcomeFeeUsd, 1000);

      assert.strictEqual(example.yearlyBreakdown.length, 3);

      const [y1, y2, y3] = example.yearlyBreakdown;
      assert.deepStrictEqual(y1, {
        year: 1,
        verifiedSavingsUsd: 12000,
        aidiscostFeeUsd: -1000,
        netSavingsUsd: 11000,
        costOfInactionUsd: -12000,
      });

      assert.deepStrictEqual(y2, {
        year: 2,
        verifiedSavingsUsd: 12000,
        aidiscostFeeUsd: 0,
        netSavingsUsd: 12000,
        costOfInactionUsd: -12000,
      });

      assert.deepStrictEqual(y3, {
        year: 3,
        verifiedSavingsUsd: 12000,
        aidiscostFeeUsd: 0,
        netSavingsUsd: 12000,
        costOfInactionUsd: -12000,
      });

      assert.ok(example.disclaimer.includes('Not a guarantee of future results'));
    });
  });
});
