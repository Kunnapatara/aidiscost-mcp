/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ModelPricing, PricingLookupResult } from '../../types/pricing';
import { CostProvenance, ConfidenceLevel } from '../../types/domain';

export const INTERNAL_PRICING_REGISTRY: ModelPricing[] = [
  // OpenAI
  {
    provider: 'openai',
    model: 'gpt-4o',
    model_aliases: ['gpt-4o-2024-08-06', 'gpt-4o-2024-05-13', 'gpt-4o'],
    input_per_million_usd: 2.50,
    output_per_million_usd: 10.00,
    cached_input_per_million_usd: 1.25,
    effective_date: '2024-08-06',
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    model_aliases: ['gpt-4o-mini-2024-07-18', 'gpt-4o-mini'],
    input_per_million_usd: 0.15,
    output_per_million_usd: 0.60,
    cached_input_per_million_usd: 0.075,
    effective_date: '2024-07-18',
  },
  {
    provider: 'openai',
    model: 'gpt-4-turbo',
    model_aliases: ['gpt-4-turbo-2024-04-09', 'gpt-4-turbo-preview', 'gpt-4-0125-preview'],
    input_per_million_usd: 10.00,
    output_per_million_usd: 30.00,
    effective_date: '2024-04-09',
  },
  {
    provider: 'openai',
    model: 'gpt-3.5-turbo',
    model_aliases: ['gpt-3.5-turbo-0125', 'gpt-3.5-turbo-1106', 'gpt-3.5-turbo'],
    input_per_million_usd: 0.50,
    output_per_million_usd: 1.50,
    effective_date: '2024-01-25',
  },
  {
    provider: 'openai',
    model: 'o1-preview',
    model_aliases: ['o1-preview-2024-09-12', 'o1-preview'],
    input_per_million_usd: 15.00,
    output_per_million_usd: 60.00,
    effective_date: '2024-09-12',
  },
  {
    provider: 'openai',
    model: 'o1-mini',
    model_aliases: ['o1-mini-2024-09-12', 'o1-mini'],
    input_per_million_usd: 3.00,
    output_per_million_usd: 12.00,
    effective_date: '2024-09-12',
  },

  // Anthropic
  {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    model_aliases: ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620', 'claude-3-5-sonnet'],
    input_per_million_usd: 3.00,
    output_per_million_usd: 15.00,
    cached_input_per_million_usd: 0.30,
    effective_date: '2024-10-22',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-haiku',
    model_aliases: ['claude-3-5-haiku-20241022', 'claude-3-5-haiku'],
    input_per_million_usd: 0.80,
    output_per_million_usd: 4.00,
    cached_input_per_million_usd: 0.08,
    effective_date: '2024-10-22',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-opus',
    model_aliases: ['claude-3-opus-20240229', 'claude-3-opus'],
    input_per_million_usd: 15.00,
    output_per_million_usd: 75.00,
    effective_date: '2024-02-29',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-haiku',
    model_aliases: ['claude-3-haiku-20240307', 'claude-3-haiku'],
    input_per_million_usd: 0.25,
    output_per_million_usd: 1.25,
    effective_date: '2024-03-07',
  },

  // Google
  {
    provider: 'google',
    model: 'gemini-1.5-pro',
    model_aliases: ['gemini-1.5-pro-latest', 'gemini-1.5-pro-002', 'gemini-1.5-pro-001', 'gemini-1.5-pro'],
    input_per_million_usd: 1.25,
    output_per_million_usd: 5.00,
    cached_input_per_million_usd: 0.3125,
    effective_date: '2024-09-24',
  },
  {
    provider: 'google',
    model: 'gemini-1.5-flash',
    model_aliases: ['gemini-1.5-flash-latest', 'gemini-1.5-flash-002', 'gemini-1.5-flash-001', 'gemini-1.5-flash'],
    input_per_million_usd: 0.075,
    output_per_million_usd: 0.30,
    cached_input_per_million_usd: 0.01875,
    effective_date: '2024-09-24',
  },
  {
    provider: 'google',
    model: 'gemini-2.0-flash',
    model_aliases: ['gemini-2.0-flash-exp', 'gemini-2.0-flash'],
    input_per_million_usd: 0.10,
    output_per_million_usd: 0.40,
    effective_date: '2024-12-11',
  },

  // Open Weights / Hosted
  {
    provider: 'meta',
    model: 'llama-3.1-70b',
    model_aliases: ['meta-llama/llama-3.1-70b-instruct', 'llama-3.1-70b'],
    input_per_million_usd: 0.88,
    output_per_million_usd: 0.88,
    effective_date: '2024-07-23',
  },
  {
    provider: 'meta',
    model: 'llama-3.1-8b',
    model_aliases: ['meta-llama/llama-3.1-8b-instruct', 'llama-3.1-8b'],
    input_per_million_usd: 0.18,
    output_per_million_usd: 0.18,
    effective_date: '2024-07-23',
  },
  {
    provider: 'mistral',
    model: 'mistral-large',
    model_aliases: ['mistral-large-2407', 'mistral-large-latest'],
    input_per_million_usd: 2.00,
    output_per_million_usd: 6.00,
    effective_date: '2024-07-24',
  },
];

/**
 * Normalize model identifier for registry lookup
 */
export function normalizeModelName(rawModel: string): string {
  if (!rawModel) return '';
  const cleaned = rawModel.trim().toLowerCase();
  // Strip common prefixes
  return cleaned
    .replace(/^openai\//, '')
    .replace(/^anthropic\//, '')
    .replace(/^google\//, '')
    .replace(/^meta-llama\//, '')
    .replace(/^azure\//, '');
}

/**
 * Find pricing entry for a given model
 */
export function lookupModelPricing(modelName: string): ModelPricing | null {
  const normalized = normalizeModelName(modelName);
  for (const entry of INTERNAL_PRICING_REGISTRY) {
    if (entry.model === normalized || entry.model_aliases.includes(normalized)) {
      return entry;
    }
  }
  // Try partial match
  for (const entry of INTERNAL_PRICING_REGISTRY) {
    if (normalized.startsWith(entry.model) || entry.model.startsWith(normalized)) {
      return entry;
    }
  }
  return null;
}

/**
 * Calculate cost from token counts and pricing
 */
export function calculateEventCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number
): PricingLookupResult {
  const pricing = lookupModelPricing(modelName);
  if (!pricing) {
    return {
      is_priced: false,
      unpriced_reason: `Model "${modelName}" is unpriced in AIDisCost registry.`,
    };
  }

  const inCost = (Math.max(0, inputTokens) / 1_000_000) * pricing.input_per_million_usd;
  const outCost = (Math.max(0, outputTokens) / 1_000_000) * pricing.output_per_million_usd;
  const total = Number((inCost + outCost).toFixed(8));

  return {
    is_priced: true,
    pricing,
    calculated_cost_usd: total,
  };
}

/**
 * Cross-validate source-reported cost against AIDisCost pricing registry
 */
export function crossValidateCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  sourceReportedCostUsd: number | null
): {
  calculated_cost_usd: number | null;
  resolved_cost_usd: number;
  cost_provenance: CostProvenance;
  cost_confidence: ConfidenceLevel;
} {
  const lookup = calculateEventCost(modelName, inputTokens, outputTokens);

  if (!lookup.is_priced || lookup.calculated_cost_usd === undefined) {
    // Model is unpriced
    if (sourceReportedCostUsd !== null && sourceReportedCostUsd > 0) {
      return {
        calculated_cost_usd: null,
        resolved_cost_usd: sourceReportedCostUsd,
        cost_provenance: 'SOURCE_REPORTED',
        cost_confidence: 'ESTIMATED', // Source reported but unverified by our table
      };
    }
    return {
      calculated_cost_usd: null,
      resolved_cost_usd: 0,
      cost_provenance: 'UNPRICED',
      cost_confidence: 'UNPRICED',
    };
  }

  const calculated = lookup.calculated_cost_usd;

  // Case 1: Source reported cost is present
  if (sourceReportedCostUsd !== null && sourceReportedCostUsd > 0) {
    const diff = Math.abs(sourceReportedCostUsd - calculated);
    const pctDiff = calculated > 0 ? (diff / calculated) * 100 : 0;

    if (pctDiff <= 5) {
      // High agreement between source and registry
      return {
        calculated_cost_usd: calculated,
        resolved_cost_usd: sourceReportedCostUsd,
        cost_provenance: 'SOURCE_REPORTED',
        cost_confidence: 'HIGH',
      };
    } else {
      // Discrepancy detected (e.g. source has cached discount or custom markup)
      return {
        calculated_cost_usd: calculated,
        resolved_cost_usd: calculated,
        cost_provenance: 'CALCULATED',
        cost_confidence: 'MEDIUM',
      };
    }
  }

  // Case 2: Source reported $0 or was missing, but we calculated positive cost
  return {
    calculated_cost_usd: calculated,
    resolved_cost_usd: calculated,
    cost_provenance: 'CALCULATED',
    cost_confidence: 'HIGH',
  };
}
