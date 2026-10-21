/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ModelPricing {
  provider: string;
  model: string;
  model_aliases: string[];
  input_per_million_usd: number;
  output_per_million_usd: number;
  cached_input_per_million_usd?: number;
  effective_date: string;
  notes?: string;
}

export interface PricingLookupResult {
  is_priced: boolean;
  pricing?: ModelPricing;
  calculated_cost_usd?: number;
  unpriced_reason?: string;
}
