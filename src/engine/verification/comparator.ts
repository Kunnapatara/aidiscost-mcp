/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Finding, VerificationState, AIEvent, VerificationObservationResult, AuthoritativeVerification } from '../../types/domain';

/**
 * Enforced verification constraints
 */
export const VERIFICATION_CONSTRAINTS = {
  MIN_POST_DEPLOYMENT_EVENTS: 15,
  MIN_BASELINE_EVENTS: 5,
  MIN_UNIT_REDUCTION_PCT: 10.0,
} as const;

/**
 * Validates whether the baseline finding provides a legitimate, production-grade
 * starting baseline for post-deployment verification.
 */
export function isValidProductionBaseline(
  finding: Finding,
  state: VerificationState
): { valid: boolean; reason?: string } {
  // Synthetic sample datasets cannot produce authoritative verification
  if (finding.is_sample_data) {
    return {
      valid: false,
      reason: 'Baseline finding was derived from synthetic sample/demo dataset. Authoritative verification requires genuine production telemetry.',
    };
  }

  // Baseline sample count must be sufficient
  const sampleCount = state.baseline_window.sample_count || finding.eligible_event_count;
  if (!sampleCount || sampleCount < VERIFICATION_CONSTRAINTS.MIN_BASELINE_EVENTS) {
    return {
      valid: false,
      reason: `Baseline sample count (${sampleCount}) is below the required minimum of ${VERIFICATION_CONSTRAINTS.MIN_BASELINE_EVENTS} events.`,
    };
  }

  // Baseline spend must be positive
  if (!finding.baseline_spend_usd || finding.baseline_spend_usd <= 0) {
    return {
      valid: false,
      reason: 'Baseline spend basis must be strictly greater than $0.00.',
    };
  }

  // Baseline unit cost must be positive
  if (!state.baseline_window.avg_cost_per_call_usd || state.baseline_window.avg_cost_per_call_usd <= 0) {
    return {
      valid: false,
      reason: 'Baseline average unit cost per execution must be strictly greater than $0.00.',
    };
  }

  // Baseline scope must be defined
  if (!finding.affected_scope || !finding.affected_scope.trim()) {
    return {
      valid: false,
      reason: 'Baseline finding has an undefined or empty affected scope.',
    };
  }

  // Baseline time window sanity
  const startTime = new Date(state.baseline_window.start).getTime();
  const endTime = new Date(state.baseline_window.end).getTime();
  if (isNaN(startTime) || isNaN(endTime) || startTime >= endTime) {
    return {
      valid: false,
      reason: 'Baseline time window contains invalid or inverted timestamps.',
    };
  }

  return { valid: true };
}

/**
 * Validates technical event data quality:
 * Rejects missing/malformed ID, missing/corrupt timestamps, invalid/negative/zero cost,
 * non-SUCCESS status, or missing model.
 * 
 * For authoritative verification:
 * - Cost must be finite
 * - Cost must be strictly positive (resolved_cost_usd > 0)
 * - Zero cost is rejected from billable authoritative verification telemetry
 * - NaN, Infinity, negative, null, and undefined are rejected
 */
export function isValidEventData(e: AIEvent, deployTime: number): boolean {
  if (!e || typeof e !== 'object') return false;
  if (!e.id || typeof e.id !== 'string') return false;
  if (!e.timestamp || typeof e.timestamp !== 'string') return false;

  const eventTime = new Date(e.timestamp).getTime();
  if (isNaN(eventTime) || eventTime < deployTime) return false;

  if (
    typeof e.resolved_cost_usd !== 'number' ||
    !Number.isFinite(e.resolved_cost_usd) ||
    e.resolved_cost_usd <= 0
  ) {
    return false;
  }

  if (e.status !== 'SUCCESS') return false;
  if (!e.model || typeof e.model !== 'string' || !e.model.trim()) return false;

  return true;
}

/**
 * Determines whether a post-deployment event belongs to the comparable population
 * for the given finding (e.g. matches candidate/current model in right-sizing,
 * or matches affected model/workload context).
 */
export function isComparableEvent(event: AIEvent, finding: Finding): boolean {
  const eventModel = event.model.toLowerCase().trim();

  // Rule 1: Model Right-Sizing
  if (finding.rule_id === 'MODEL_RIGHT_SIZING') {
    // affected_scope is e.g. "gpt-4o → gpt-4o-mini"
    const scopeParts = finding.affected_scope.split(/→|->/).map(s => s.trim().toLowerCase());
    if (scopeParts.length === 2) {
      const [currentModel, candidateModel] = scopeParts;
      return eventModel === candidateModel || eventModel === currentModel;
    }
  }

  // Rule 2 & 3: Retry Loop or Repeated Call Pattern
  if (finding.affected_scope) {
    const scopeLower = finding.affected_scope.toLowerCase();
    if (scopeLower.includes(eventModel)) {
      return true;
    }
  }

  // Fallback to sample events models from finding evidence
  if (finding.evidence?.sample_events?.length) {
    const sampleModels = new Set(
      finding.evidence.sample_events
        .map(s => s.model?.toLowerCase().trim())
        .filter(Boolean)
    );
    if (sampleModels.size > 0) {
      return sampleModels.has(eventModel);
    }
  }

  // If no finding-specific model restriction was established, require chat/completion operation match
  return event.operation === 'chat' || event.operation === 'completion';
}

export interface AnnualizedCalculation {
  valid: boolean;
  annualized_savings_usd: number;
  duration_days: number;
  reason?: string;
}

/**
 * Calculates annualized verified savings strictly derived from observed unit-cost reduction
 * and actual post-deployment production event volume across the observation window duration.
 * 
 * Formula:
 *   (observed_savings / post_deployment_observation_days) * 365
 *   where observed_savings = costDeltaPerCall * postDeploymentEventCount
 * 
 * Strict guards:
 * - Withholds annualization if observation start or end is missing
 * - Withholds if timestamps are invalid or end <= start
 * - Withholds if duration is zero, negative, NaN, or non-finite
 * - Withholds if post-deployment event count is zero or non-positive
 * - Withholds if unit cost delta is non-positive, NaN, or non-finite
 */
export function calculateAnnualizedVerifiedSavings(
  costDeltaPerCall: number,
  postDeploymentEventCount: number,
  observationStart?: string,
  observationEnd?: string
): AnnualizedCalculation {
  if (!Number.isFinite(costDeltaPerCall) || costDeltaPerCall <= 0) {
    return {
      valid: false,
      annualized_savings_usd: 0,
      duration_days: 0,
      reason: 'Unit-cost delta is zero, negative, or non-finite',
    };
  }

  if (!Number.isFinite(postDeploymentEventCount) || postDeploymentEventCount <= 0) {
    return {
      valid: false,
      annualized_savings_usd: 0,
      duration_days: 0,
      reason: 'Post-deployment event count is zero, negative, or non-finite',
    };
  }

  if (!observationStart || !observationEnd || observationStart === 'N/A' || observationEnd === 'N/A') {
    return {
      valid: false,
      annualized_savings_usd: 0,
      duration_days: 0,
      reason: 'Post-deployment observation window timestamps are missing or undefined',
    };
  }

  const startTime = new Date(observationStart).getTime();
  const endTime = new Date(observationEnd).getTime();

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || isNaN(startTime) || isNaN(endTime)) {
    return {
      valid: false,
      annualized_savings_usd: 0,
      duration_days: 0,
      reason: 'Post-deployment observation window timestamps are invalid or unparseable',
    };
  }

  if (endTime <= startTime) {
    return {
      valid: false,
      annualized_savings_usd: 0,
      duration_days: 0,
      reason: 'Post-deployment observation window duration is zero or inverted (end <= start)',
    };
  }

  const durationMs = endTime - startTime;
  const durationDays = durationMs / 86_400_000;

  if (!Number.isFinite(durationDays) || durationDays <= 0) {
    return {
      valid: false,
      annualized_savings_usd: 0,
      duration_days: 0,
      reason: 'Post-deployment observation duration is non-positive or non-finite',
    };
  }

  const observedSavings = costDeltaPerCall * postDeploymentEventCount;
  const rawAnnualized = (observedSavings / durationDays) * 365;

  if (!Number.isFinite(rawAnnualized) || rawAnnualized <= 0) {
    return {
      valid: false,
      annualized_savings_usd: 0,
      duration_days: durationDays,
      reason: 'Calculated annualized savings resulted in non-finite or non-positive value',
    };
  }

  return {
    valid: true,
    annualized_savings_usd: Number(rawAnnualized.toFixed(2)),
    duration_days: durationDays,
  };
}

/**
 * Initialize baseline state from finding
 */
export function initializeVerificationState(finding: Finding): VerificationState {
  const avgCost = finding.eligible_event_count > 0
    ? finding.baseline_spend_usd / finding.eligible_event_count
    : 0;

  const start = finding.evidence?.baseline_period?.start
    || new Date(Date.now() - 7 * 86_400_000).toISOString();
  const end = finding.evidence?.baseline_period?.end
    || new Date().toISOString();

  return {
    finding_id: finding.id,
    stage: 'BASELINE',
    baseline_window: {
      start,
      end,
      avg_cost_per_call_usd: Number(avgCost.toFixed(6)),
      sample_count: finding.eligible_event_count,
    },
    is_simulated: finding.is_sample_data,
  };
}

/**
 * Evaluates post-deployment verification against empirical telemetry.
 * 
 * CORE TRUTH INVARIANTS:
 * 1. DEMO / SIMULATION telemetry can NEVER produce stage: 'VERIFIED_RESULT'.
 * 2. Ambiguous / unknown provenance (is_simulated === undefined) is strictly excluded
 *    from production verification sets.
 * 3. Authoritative VERIFIED_RESULT requires:
 *    - Genuine non-sample baseline
 *    - Strictly non-simulated production events (is_simulated === false)
 *    - Valid event data quality (valid timestamps >= deployTime, positive cost, SUCCESS status)
 *    - Finding scope comparability
 *    - Minimum 15 eligible post-deployment observations
 *    - Observed unit cost reduction >= 10.0% across comparable production sample
 */
export function evaluateVerification(
  currentState: VerificationState,
  finding: Finding,
  postDeploymentEvents: AIEvent[],
  postDeploymentFileName?: string
): VerificationState {
  // If not deployed yet
  if (currentState.stage === 'BASELINE') {
    return currentState;
  }

  const fileName = postDeploymentFileName || currentState.post_deployment_file_name;

  const deployTime = currentState.deployment_timestamp
    ? new Date(currentState.deployment_timestamp).getTime()
    : Date.now() - 3600_000;

  // Classify events by strict provenance
  const simulatedEvents = postDeploymentEvents.filter(e => e.is_simulated === true);
  const productionEvents = postDeploymentEvents.filter(e => e.is_simulated === false);
  const unknownProvenanceEvents = postDeploymentEvents.filter(e => e.is_simulated === undefined);

  // -------------------------------------------------------------------------
  // PATH A: DEMO / SIMULATION Telemetry Evaluation
  // If all post events are simulated, or there are zero production events:
  // -------------------------------------------------------------------------
  if (simulatedEvents.length > 0 && productionEvents.length === 0) {
    // Deduplicate simulated events by event ID
    const seenSimIds = new Set<string>();
    const uniqueSimulated: AIEvent[] = [];
    for (const ev of simulatedEvents) {
      if (!seenSimIds.has(ev.id)) {
        seenSimIds.add(ev.id);
        uniqueSimulated.push(ev);
      }
    }

    const validSimulatedCandidates = uniqueSimulated.filter(e => isValidEventData(e, deployTime));

    const hasExplicitWindow = Boolean(
      currentState.observation_window?.start &&
      currentState.observation_window?.end &&
      currentState.observation_window.start !== currentState.observation_window.end
    );

    let observationStart: string;
    let observationEnd: string;
    let validSimulated: AIEvent[] = [];

    if (hasExplicitWindow) {
      observationStart = currentState.observation_window!.start;
      observationEnd = currentState.observation_window!.end;
      const startMs = new Date(observationStart).getTime();
      const endMs = new Date(observationEnd).getTime();

      if (!isNaN(startMs) && !isNaN(endMs) && endMs > startMs) {
        validSimulated = validSimulatedCandidates.filter(e => {
          const t = new Date(e.timestamp).getTime();
          return t >= startMs && t <= endMs;
        });
      }
    } else {
      observationStart = currentState.observation_window?.start || new Date(deployTime).toISOString();
      const startMs = new Date(observationStart).getTime();
      if (validSimulatedCandidates.length > 0) {
        const maxTime = Math.max(...validSimulatedCandidates.map(e => new Date(e.timestamp).getTime()));
        observationEnd = maxTime > startMs ? new Date(maxTime).toISOString() : observationStart;
        validSimulated = validSimulatedCandidates.filter(e => {
          const t = new Date(e.timestamp).getTime();
          return t >= startMs && t <= maxTime;
        });
      } else {
        observationEnd = observationStart;
      }
    }

    const observationWindow = {
      start: observationStart,
      end: observationEnd,
      sample_event_count: validSimulated.length,
    };

    const preAvgCost = currentState.baseline_window.avg_cost_per_call_usd;
    const totalSimCost = validSimulated.reduce((s, e) => s + e.resolved_cost_usd, 0);
    const postAvgCost = validSimulated.length > 0 ? totalSimCost / validSimulated.length : 0;
    const costDelta = preAvgCost - postAvgCost;
    const reductionPct = preAvgCost > 0 ? (costDelta / preAvgCost) * 100 : 0;

    // Derived annualized projection from observed simulated volume and observation window
    const simAnnualization = calculateAnnualizedVerifiedSavings(
      costDelta,
      validSimulated.length,
      observationWindow.start,
      observationWindow.end
    );
    const simulatedAnnualSavings = simAnnualization.valid ? simAnnualization.annualized_savings_usd : 0;

    const isThresholdMet = validSimulated.length >= VERIFICATION_CONSTRAINTS.MIN_POST_DEPLOYMENT_EVENTS;

    const simResult: VerificationObservationResult = {
      pre_cost_per_call_usd: Number(preAvgCost.toFixed(6)),
      post_cost_per_call_usd: Number(postAvgCost.toFixed(6)),
      observed_reduction_pct: Number(reductionPct.toFixed(1)),
      annualized_realized_savings_usd: Number(simulatedAnnualSavings.toFixed(2)),
      verification_confidence: isThresholdMet ? 'MEDIUM' : 'INSUFFICIENT_OBSERVATION',
      verification_notes: isThresholdMet
        ? `[SIMULATION PREVIEW] Simulated empirical reduction of ${reductionPct.toFixed(1)}% across ${validSimulated.length} synthetic events. Non-authoritative preview for demonstration; cannot produce commercial billing verification.`
        : `[SIMULATION PREVIEW] Insufficient sample: observed ${validSimulated.length} of ${VERIFICATION_CONSTRAINTS.MIN_POST_DEPLOYMENT_EVENTS} required post-deployment events.`,
      is_authoritative: false,
    };

    // STRICT TRUTH BOUNDARY:
    // stage REMAINS 'OBSERVATION_ACTIVE'. It is NEVER 'VERIFIED_RESULT'.
    // Authoritative verified savings is strictly 0.
    return {
      ...currentState,
      stage: 'OBSERVATION_ACTIVE',
      is_simulated: true,
      post_deployment_file_name: fileName,
      observation_window: observationWindow,
      simulated_result: simResult,
      observed_result: {
        pre_cost_per_call_usd: Number(preAvgCost.toFixed(6)),
        post_cost_per_call_usd: Number(postAvgCost.toFixed(6)),
        observed_reduction_pct: 0,
        annualized_realized_savings_usd: 0, // No authoritative savings from simulation!
        verification_confidence: 'INSUFFICIENT_OBSERVATION',
        verification_notes: '[SIMULATION ONLY] Synthetic telemetry cannot produce authoritative commercial verification.',
        is_authoritative: false,
      },
    };
  }

  // -------------------------------------------------------------------------
  // PATH B: Authoritative Production Telemetry Evaluation
  // (Simulated and unknown provenance events are strictly excluded)
  // -------------------------------------------------------------------------
  const baselineCheck = isValidProductionBaseline(finding, currentState);
  if (!baselineCheck.valid) {
    return {
      ...currentState,
      stage: 'OBSERVATION_ACTIVE',
      is_simulated: false,
      post_deployment_file_name: fileName,
      observation_window: {
        start: new Date(deployTime).toISOString(),
        end: new Date(deployTime).toISOString(),
        sample_event_count: 0,
      },
      observed_result: {
        pre_cost_per_call_usd: currentState.baseline_window.avg_cost_per_call_usd,
        post_cost_per_call_usd: 0,
        observed_reduction_pct: 0,
        annualized_realized_savings_usd: 0,
        verification_confidence: 'INSUFFICIENT_OBSERVATION',
        verification_notes: `Production verification rejected: ${baselineCheck.reason}`,
        is_authoritative: false,
      },
    };
  }

  // Deduplicate production events by event ID to prevent double-counting
  const seenProdIds = new Set<string>();
  const uniqueProdEvents: AIEvent[] = [];
  let duplicateCount = 0;
  for (const ev of productionEvents) {
    if (seenProdIds.has(ev.id)) {
      duplicateCount++;
    } else {
      seenProdIds.add(ev.id);
      uniqueProdEvents.push(ev);
    }
  }

  // Pre-filter candidate production events: valid data format, positive cost, comparable finding scope
  const candidateEvents = uniqueProdEvents.filter(
    e => isValidEventData(e, deployTime) && isComparableEvent(e, finding)
  );

  // Authoritative Observation Window Determination:
  // 1. If currentState has an explicitly declared observation window (start !== end),
  //    strictly enforce [start, end] boundaries on telemetry.
  // 2. If end is unclosed / equal to start / missing, derive end directly from the actual
  //    telemetry population (max timestamp among eligible production events).
  const hasExplicitWindow = Boolean(
    currentState.observation_window?.start &&
    currentState.observation_window?.end &&
    currentState.observation_window.start !== currentState.observation_window.end
  );

  let observationStart: string;
  let observationEnd: string;
  let eligiblePostEvents: AIEvent[] = [];
  let isWindowInvalid = false;
  let invalidWindowReason = '';

  if (hasExplicitWindow) {
    observationStart = currentState.observation_window!.start;
    observationEnd = currentState.observation_window!.end;
    const startMs = new Date(observationStart).getTime();
    const endMs = new Date(observationEnd).getTime();

    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) {
      isWindowInvalid = true;
      invalidWindowReason = 'Authoritative verification withheld: observation window is invalid or inverted (end <= start).';
      observationStart = currentState.observation_window!.start;
      observationEnd = currentState.observation_window!.end;
      eligiblePostEvents = [];
    } else if (startMs < deployTime) {
      isWindowInvalid = true;
      invalidWindowReason = `Authoritative verification withheld: observation window begins before deployment timestamp (${observationStart} < ${currentState.deployment_timestamp || new Date(deployTime).toISOString()}).`;
      observationStart = currentState.observation_window!.start;
      observationEnd = currentState.observation_window!.end;
      eligiblePostEvents = [];
    } else {
      // Strictly filter to explicit observation window: event.timestamp >= start AND event.timestamp <= end
      eligiblePostEvents = candidateEvents.filter(e => {
        const t = new Date(e.timestamp).getTime();
        return t >= startMs && t <= endMs;
      });
    }
  } else {
    // Event-derived observation window:
    // Check if an explicit open/unclosed window start was provided that begins before deployment
    const explicitStart = currentState.observation_window?.start;
    const explicitStartMs = explicitStart ? new Date(explicitStart).getTime() : NaN;

    if (explicitStart && !isNaN(explicitStartMs) && explicitStartMs < deployTime) {
      isWindowInvalid = true;
      invalidWindowReason = `Authoritative verification withheld: observation window begins before deployment timestamp (${explicitStart} < ${currentState.deployment_timestamp || new Date(deployTime).toISOString()}).`;
      observationStart = explicitStart;
      observationEnd = currentState.observation_window?.end || explicitStart;
      eligiblePostEvents = [];
    } else {
      // start = deployment boundary
      // end = maximum timestamp among eligible production events (never arbitrary current time)
      observationStart = currentState.deployment_timestamp || new Date(deployTime).toISOString();
      const startMs = new Date(observationStart).getTime();

      if (candidateEvents.length > 0) {
        const maxEventTime = Math.max(...candidateEvents.map(e => new Date(e.timestamp).getTime()));
        if (isNaN(maxEventTime) || maxEventTime <= startMs) {
          observationEnd = observationStart;
          eligiblePostEvents = [];
        } else {
          observationEnd = new Date(maxEventTime).toISOString();
          eligiblePostEvents = candidateEvents.filter(e => {
            const t = new Date(e.timestamp).getTime();
            return t >= startMs && t <= maxEventTime;
          });
        }
      } else {
        observationEnd = observationStart;
        eligiblePostEvents = [];
      }
    }
  }

  const observationWindow = {
    start: observationStart,
    end: observationEnd,
    sample_event_count: eligiblePostEvents.length,
  };

  // Immediate guard: Invalid, inverted, or pre-deployment observation window withholds authoritative annualization
  if (isWindowInvalid) {
    return {
      ...currentState,
      stage: 'OBSERVATION_ACTIVE',
      is_simulated: false,
      post_deployment_file_name: fileName,
      observation_window: observationWindow,
      observed_result: {
        pre_cost_per_call_usd: currentState.baseline_window.avg_cost_per_call_usd,
        post_cost_per_call_usd: 0,
        observed_reduction_pct: 0,
        annualized_realized_savings_usd: 0,
        verification_confidence: 'INSUFFICIENT_OBSERVATION',
        verification_notes: invalidWindowReason || 'Authoritative verification withheld: observation window is invalid or inverted (end <= start).',
        is_authoritative: false,
      },
    };
  }

  // Compute exclusion breakdown for transparent reporting
  const outsideWindowCount = candidateEvents.length - eligiblePostEvents.length;
  const nonComparableOrInvalid = productionEvents.length - candidateEvents.length - duplicateCount;
  const totalExcluded = postDeploymentEvents.length - eligiblePostEvents.length;

  const exclusionDetails: string[] = [];
  if (simulatedEvents.length > 0) exclusionDetails.push(`${simulatedEvents.length} simulated`);
  if (unknownProvenanceEvents.length > 0) exclusionDetails.push(`${unknownProvenanceEvents.length} unknown provenance`);
  if (duplicateCount > 0) exclusionDetails.push(`${duplicateCount} duplicate IDs`);
  if (outsideWindowCount > 0) exclusionDetails.push(`${outsideWindowCount} outside observation window`);
  if (nonComparableOrInvalid > 0) exclusionDetails.push(`${nonComparableOrInvalid} non-comparable/invalid`);

  const exclusionNote = exclusionDetails.length > 0
    ? ` (${totalExcluded} events excluded: ${exclusionDetails.join(', ')}).`
    : '';

  // Check minimum post-deployment observation threshold (>= 15 events)
  if (eligiblePostEvents.length < VERIFICATION_CONSTRAINTS.MIN_POST_DEPLOYMENT_EVENTS) {
    const totalPostCost = eligiblePostEvents.reduce((s, e) => s + e.resolved_cost_usd, 0);
    const postAvgCost = eligiblePostEvents.length > 0 ? totalPostCost / eligiblePostEvents.length : 0;

    return {
      ...currentState,
      stage: 'OBSERVATION_ACTIVE',
      is_simulated: false,
      post_deployment_file_name: fileName,
      observation_window: observationWindow,
      observed_result: {
        pre_cost_per_call_usd: currentState.baseline_window.avg_cost_per_call_usd,
        post_cost_per_call_usd: Number(postAvgCost.toFixed(6)),
        observed_reduction_pct: 0,
        annualized_realized_savings_usd: 0,
        verification_confidence: 'INSUFFICIENT_OBSERVATION',
        verification_notes: eligiblePostEvents.length === 0
          ? `Verification cannot be completed from the available comparable telemetry: 0 comparable events found after deployment timestamp.${exclusionNote}`
          : `Observed ${eligiblePostEvents.length} of ${VERIFICATION_CONSTRAINTS.MIN_POST_DEPLOYMENT_EVENTS} required post-deployment events.${exclusionNote} Minimum 15 comparable events required over active window.`,
        is_authoritative: false,
      },
    };
  }

  // Compute production metrics across eligible production events
  const totalPostCost = eligiblePostEvents.reduce((s, e) => s + e.resolved_cost_usd, 0);
  const postAvgCost = totalPostCost / eligiblePostEvents.length;
  const preAvgCost = currentState.baseline_window.avg_cost_per_call_usd;

  const costDelta = preAvgCost - postAvgCost;
  const reductionPct = preAvgCost > 0 ? (costDelta / preAvgCost) * 100 : 0;

  // Realized annualized savings calculation:
  // Derived strictly from observed savings across the actual post-deployment observation duration and event volume
  // Formula: (observed_unit_reduction * post_deployment_event_count / post_deployment_observation_days) * 365
  const annualization = calculateAnnualizedVerifiedSavings(
    costDelta,
    eligiblePostEvents.length,
    observationWindow.start,
    observationWindow.end
  );

  const isReductionThresholdMet = reductionPct >= VERIFICATION_CONSTRAINTS.MIN_UNIT_REDUCTION_PCT;
  // Authoritative verification requires both unit cost reduction and valid annualization
  const isAuthoritative = isReductionThresholdMet && annualization.valid;

  let verificationNotes: string;
  if (isAuthoritative) {
    verificationNotes = `Confirmed unit cost reduction of ${reductionPct.toFixed(1)}% across ${eligiblePostEvents.length} eligible production events inside observation window.${exclusionNote}`;
  } else if (isReductionThresholdMet && !annualization.valid) {
    verificationNotes = `Observed unit cost reduction of ${reductionPct.toFixed(1)}% across ${eligiblePostEvents.length} eligible production events, but annualization projection is withheld: ${annualization.reason}.${exclusionNote}`;
  } else {
    verificationNotes = `Observed ${reductionPct.toFixed(1)}% delta across ${eligiblePostEvents.length} production events, below the required ${VERIFICATION_CONSTRAINTS.MIN_UNIT_REDUCTION_PCT}% unit reduction threshold.${exclusionNote} Observation remains active.`;
  }

  return {
    ...currentState,
    stage: isAuthoritative ? 'VERIFIED_RESULT' : 'OBSERVATION_ACTIVE',
    is_simulated: false,
    is_authoritative: isAuthoritative,
    post_deployment_file_name: fileName,
    observation_window: observationWindow,
    observed_result: {
      pre_cost_per_call_usd: Number(preAvgCost.toFixed(6)),
      post_cost_per_call_usd: Number(postAvgCost.toFixed(6)),
      observed_reduction_pct: Number(reductionPct.toFixed(1)),
      annualized_realized_savings_usd: isAuthoritative ? annualization.annualized_savings_usd : 0,
      verification_confidence: isAuthoritative ? 'HIGH' : 'MEDIUM',
      verification_notes: verificationNotes,
      is_authoritative: isAuthoritative,
    },
  };
}

/**
 * Authoritative check: returns true iff the verification state represents a genuine,
 * non-simulated, production-verified outcome.
 */
export function isAuthoritativeVerified(state: VerificationState): boolean {
  return (
    state.stage === 'VERIFIED_RESULT' &&
    state.is_simulated !== true &&
    state.is_authoritative !== false &&
    state.observed_result?.is_authoritative === true &&
    (state.observed_result?.annualized_realized_savings_usd || 0) > 0
  );
}

/**
 * Returns the authoritative verified annualized savings in USD.
 * Returns 0 if unverified, simulated, or invalid.
 */
export function getAuthoritativeVerifiedSavings(state: VerificationState): number {
  return isAuthoritativeVerified(state)
    ? (state.observed_result?.annualized_realized_savings_usd || 0)
    : 0;
}

/**
 * Commercial Authority Invariant Evaluator
 * 
 * Commercial verification strictly requires:
 * 1. Server authoritative verification record exists
 * 2. serverVerification.is_authoritative === true
 * 3. serverVerification.is_simulated === false
 * 4. serverVerification.stage === 'VERIFIED_RESULT'
 * 5. clientState.stage === 'VERIFIED_RESULT'
 * 6. clientState.is_simulated !== true
 * 
 * Neither local calculation, client-side fallback, nor IndexedDB cache
 * can establish commercial authority on their own.
 */
export function isCommerciallyVerified(
  clientState?: VerificationState | null,
  serverVerification?: AuthoritativeVerification | null
): boolean {
  if (!clientState || !serverVerification) return false;
  return (
    serverVerification.is_authoritative === true &&
    serverVerification.is_simulated === false &&
    serverVerification.stage === 'VERIFIED_RESULT' &&
    clientState.stage === 'VERIFIED_RESULT' &&
    clientState.is_simulated !== true
  );
}
