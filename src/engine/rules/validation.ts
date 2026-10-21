/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AIEvent } from '../../types/domain';

/**
 * Validates canonical event integrity prior to rules evaluation.
 *
 * Rules:
 * 1. Must be a non-null object with valid non-empty id and model.
 * 2. Timestamp must parse to a valid, positive finite millisecond epoch.
 * 3. Token counts (input and output) must be non-negative, finite numbers.
 * 4. Cost values (resolved_cost_usd) must be non-negative, finite numbers.
 * 5. Rejects NaN, Infinity, negative costs, negative tokens, and corrupt records.
 */
export function isValidRuleEvent(ev: unknown): ev is AIEvent {
  if (!ev || typeof ev !== 'object') return false;

  const event = ev as Record<string, unknown>;

  // Identifier & Model
  if (typeof event.id !== 'string' || !event.id.trim()) return false;
  if (typeof event.model !== 'string' || !event.model.trim()) return false;

  // Timestamp
  if (typeof event.timestamp !== 'string' || !event.timestamp.trim()) return false;
  const timeMs = new Date(event.timestamp).getTime();
  if (!Number.isFinite(timeMs) || timeMs <= 0) return false;

  // Token Sanity
  if (
    typeof event.input_tokens !== 'number' ||
    !Number.isFinite(event.input_tokens) ||
    event.input_tokens < 0
  ) {
    return false;
  }

  if (
    typeof event.output_tokens !== 'number' ||
    !Number.isFinite(event.output_tokens) ||
    event.output_tokens < 0
  ) {
    return false;
  }

  // Cost Sanity
  if (
    typeof event.resolved_cost_usd !== 'number' ||
    !Number.isFinite(event.resolved_cost_usd) ||
    event.resolved_cost_usd < 0
  ) {
    return false;
  }

  // Source reported cost sanity if present
  if (
    event.source_reported_cost_usd !== null &&
    event.source_reported_cost_usd !== undefined
  ) {
    if (
      typeof event.source_reported_cost_usd !== 'number' ||
      !Number.isFinite(event.source_reported_cost_usd) ||
      event.source_reported_cost_usd < 0
    ) {
      return false;
    }
  }

  // Calculated cost sanity if present
  if (
    event.calculated_cost_usd !== null &&
    event.calculated_cost_usd !== undefined
  ) {
    if (
      typeof event.calculated_cost_usd !== 'number' ||
      !Number.isFinite(event.calculated_cost_usd) ||
      event.calculated_cost_usd < 0
    ) {
      return false;
    }
  }

  return true;
}
