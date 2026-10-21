/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TimeRange {
  start: string;
  end: string;
}

export interface AnnualizationResult {
  annualized_usd: number;
  observed_duration_hours: number;
  observed_duration_days: number;
  is_annualized: boolean;
  methodology_description: string;
  conservative_assumption?: string;
}

/**
 * Minimum observation duration required to extrapolate annual figures (1.0 hour).
 * Windows under 1 hour are too narrow to yield a truthful annual projection.
 */
export const MIN_ANNUALIZATION_HOURS = 1.0;

/**
 * Maximum reasonable observation duration (10 years = 3650 days).
 * Windows exceeding this indicate corrupted timestamps or clock skew.
 */
export const MAX_ANNUALIZATION_DAYS = 3650;

/**
 * Annualize observed savings based strictly on the actual telemetry time range.
 * Formula: (observed_savings_usd / observed_days) * 365
 * 
 * Rules:
 * 1. Zero, negative, NaN, or non-finite observed savings -> $0.00 projection.
 * 2. Missing, zero, negative, or invalid time range -> $0.00 projection with conservative assumption.
 * 3. Narrow window (< 1 hour) -> $0.00 projection with insufficient observation window assumption.
 * 4. Excessively long or corrupt window (> 10 years) -> $0.00 projection.
 * 5. Observed window >= 1 hour -> (observed_savings_usd / observed_days) * 365.
 * 6. Explicitly frames result as an extrapolated run-rate projection, not historical fact or guarantee.
 */
export function annualizeSavings(
  observedSavingsUsd: number,
  timeRange?: TimeRange
): AnnualizationResult {
  if (!Number.isFinite(observedSavingsUsd) || observedSavingsUsd <= 0) {
    return {
      annualized_usd: 0,
      observed_duration_hours: 0,
      observed_duration_days: 0,
      is_annualized: false,
      methodology_description: 'Zero or non-positive observed savings to extrapolate; annualized projection withheld.',
    };
  }

  if (!timeRange || !timeRange.start || !timeRange.end || timeRange.start === 'N/A' || timeRange.end === 'N/A') {
    return {
      annualized_usd: 0,
      observed_duration_hours: 0,
      observed_duration_days: 0,
      is_annualized: false,
      methodology_description: 'Observation window undefined; annualized projection withheld.',
      conservative_assumption: 'Telemetry lacks valid timestamp bounds; annualized projection held at $0.00 until a bounded observation window is established.',
    };
  }

  const startTime = new Date(timeRange.start).getTime();
  const endTime = new Date(timeRange.end).getTime();

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    return {
      annualized_usd: 0,
      observed_duration_hours: 0,
      observed_duration_days: 0,
      is_annualized: false,
      methodology_description: 'Observation window duration is non-positive or invalid.',
      conservative_assumption: 'Observation window contains invalid or inverted timestamps; annualized projection held at $0.00.',
    };
  }

  const durationMs = endTime - startTime;
  const durationHours = durationMs / (1000 * 60 * 60);
  const durationDays = durationHours / 24;

  if (durationHours < MIN_ANNUALIZATION_HOURS) {
    const minutes = Math.max(1, Math.round(durationHours * 60));
    return {
      annualized_usd: 0,
      observed_duration_hours: Number(durationHours.toFixed(2)),
      observed_duration_days: Number(durationDays.toFixed(4)),
      is_annualized: false,
      methodology_description: `Observation window (${minutes} min) is below minimum threshold (${MIN_ANNUALIZATION_HOURS}h) for annual extrapolation.`,
      conservative_assumption: `Observation window (${minutes} min) is too short (< ${MIN_ANNUALIZATION_HOURS} hour) to project annualized savings conservatively. Extrapolated projection held at $0.00.`,
    };
  }

  if (durationDays > MAX_ANNUALIZATION_DAYS) {
    return {
      annualized_usd: 0,
      observed_duration_hours: Number(durationHours.toFixed(2)),
      observed_duration_days: Number(durationDays.toFixed(4)),
      is_annualized: false,
      methodology_description: `Observation window exceeds maximum threshold (${MAX_ANNUALIZATION_DAYS} days); likely clock skew or timestamp corruption.`,
      conservative_assumption: 'Observation window duration is improbably large; annualized projection held at $0.00.',
    };
  }

  const rawAnnualized = (observedSavingsUsd / durationDays) * 365;
  if (!Number.isFinite(rawAnnualized) || rawAnnualized < 0) {
    return {
      annualized_usd: 0,
      observed_duration_hours: Number(durationHours.toFixed(2)),
      observed_duration_days: Number(durationDays.toFixed(4)),
      is_annualized: false,
      methodology_description: 'Mathematical calculation produced non-finite annualized result.',
    };
  }

  const annualized = Number(rawAnnualized.toFixed(2));

  return {
    annualized_usd: annualized,
    observed_duration_hours: Number(durationHours.toFixed(2)),
    observed_duration_days: Number(durationDays.toFixed(4)),
    is_annualized: true,
    methodology_description: `Extrapolated run-rate projection: modeled annual opportunity of $${annualized.toFixed(2)} based on observed $${observedSavingsUsd.toFixed(2)} across ${durationHours.toFixed(1)} hours (${durationDays.toFixed(2)} days) extrapolated to 365 calendar days (($${observedSavingsUsd.toFixed(2)} / ${durationDays.toFixed(3)} days) * 365). Extrapolated projection under constant-volume assumptions; not a historical fact or guaranteed savings.`,
    conservative_assumption: 'Annualized projection assumes observed traffic distribution and opportunity rate remain constant across 365 days; changes in seasonality, model catalog pricing, or workload volume will affect realized annual outcome.',
  };
}
