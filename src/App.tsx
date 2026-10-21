/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  AIEvent,
  AuditSummary,
  DataHealthReport,
  Finding,
  FixPackage,
  TelemetrySource,
  VerificationState,
  AuthoritativeVerification,
  OutcomeFeeObligation,
} from './types/domain';
import { LangfuseAdapter } from './engine/adapters/langfuse';
import { HeliconeAdapter } from './engine/adapters/helicone';
import { OpenTelemetryAdapter } from './engine/adapters/opentelemetry';
import { CustomLogAdapter } from './engine/adapters/custom-log';
import { IngestionPipeline } from './engine/ingestion/pipeline';
import { generateSampleDataset } from './engine/adapters/sample-data';
import { evaluateDataHealth } from './engine/health/evaluator';
import { runOptimizationRules } from './engine/rules/evaluator';
import { generateFixPackage } from './engine/fix/generator';
import { initializeVerificationState, evaluateVerification } from './engine/verification/comparator';
import { BillingEntitlementStore } from './engine/billing/entitlement';
import { AuditStore } from './engine/storage/audit-store';
import {
  fetchAuthMe,
  registerFindings,
  getFindingEntitlement,
  getFindingVerification,
  recordFindingDeployment,
  evaluateFindingVerification,
  fetchOutcomeFeeObligation,
  createOutcomeFeeObligation,
  createOutcomeFeeCheckout,
} from './services/api';
import { HeaderNav } from './components/HeaderNav';
import { LandingView } from './views/LandingView';
import { ConnectView } from './views/ConnectView';
import { DataHealthView } from './views/DataHealthView';
import { AuditSummaryView } from './views/AuditSummaryView';
import { FindingDetailView } from './views/FindingDetailView';
import { FixPackageView } from './views/FixPackageView';
import { VerifyView } from './views/VerifyView';
import { AuthModal, BillingResultModal, ErrorView, ErrorCategory } from './components/SupportingModals';

export default function App() {
  // Navigation & Routing State
  const [currentRoute, setCurrentRoute] = useState<string>('/');
  const [activeFindingId, setActiveFindingId] = useState<string | undefined>(undefined);

  // Ingestion & Domain State
  const [activeSource, setActiveSource] = useState<TelemetrySource>('custom_logs');
  const [currentEvents, setCurrentEvents] = useState<AIEvent[]>([]);
  const [healthReport, setHealthReport] = useState<DataHealthReport | null>(null);
  const [auditSummary, setAuditSummary] = useState<AuditSummary | null>(null);
  const [isSampleData, setIsSampleData] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Fix Packages & Verification Maps
  const [fixPackages, setFixPackages] = useState<Map<string, FixPackage>>(new Map());
  const [verificationStates, setVerificationStates] = useState<Map<string, VerificationState>>(new Map());
  const [serverVerifications, setServerVerifications] = useState<Map<string, AuthoritativeVerification>>(new Map());
  const [outcomeFeeObligations, setOutcomeFeeObligations] = useState<Map<string, OutcomeFeeObligation>>(new Map());

  // Supporting States
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [userEmail, setUserEmail] = useState<string>('');

  const [billingResultModal, setBillingResultModal] = useState<{
    isOpen: boolean;
    status: 'success' | 'cancelled' | 'error';
    findingId?: string;
    isPaid?: boolean;
  }>({ isOpen: false, status: 'success' });

  const [errorState, setErrorState] = useState<{
    isError: boolean;
    category: ErrorCategory;
    message: string;
    technicalDetails?: string;
  }>({
    isError: false,
    category: 'UNKNOWN_ERROR',
    message: '',
  });

  // Handle URL hash / initial load, user auth check, and restore durable audit snapshot
  useEffect(() => {
    let isMounted = true;

    // Check user session
    fetchAuthMe().then((res) => {
      if (isMounted && res.authenticated && res.user) {
        setIsAuthenticated(true);
        setUserEmail(res.user.email);
      }
    });

    const handlePopState = () => {
      const hash = window.location.hash.replace('#', '') || '/';
      parseAndSetRoute(hash);
    };
    window.addEventListener('popstate', handlePopState);

    // Hydrate latest audit snapshot from local IndexedDB
    AuditStore.loadLatestAuditSnapshot()
      .then((snapshot) => {
        if (!isMounted || !snapshot) {
          if (window.location.hash) {
            handlePopState();
          }
          return;
        }

        // Restore audit domain state
        setActiveSource(snapshot.source);
        setHealthReport(snapshot.health);
        setAuditSummary(snapshot.audit_summary);
        setIsSampleData(Boolean(snapshot.is_sample_data));

        if (snapshot.active_finding_id) {
          setActiveFindingId(snapshot.active_finding_id);
        }

        // Restore Maps
        const restoredFixMap = new Map<string, FixPackage>(
          Object.entries(snapshot.fix_packages || {})
        );
        const restoredVerifyMap = new Map<string, VerificationState>(
          Object.entries(snapshot.verification_states || {})
        );
        setFixPackages(restoredFixMap);
        setVerificationStates(restoredVerifyMap);

        // Check server-side entitlements & authoritative verifications if authenticated
        fetchAuthMe().then((auth) => {
          if (auth.authenticated && snapshot.audit_summary?.findings) {
            snapshot.audit_summary.findings.forEach((f) => {
              getFindingEntitlement(f.id).then((ent) => {
                if (ent && ent.is_paid) {
                  setFixPackages((prev) => {
                    const updated = new Map(prev);
                    const pkg = updated.get(f.id);
                    if (pkg) {
                      updated.set(f.id, {
                        ...pkg,
                        unlocked: true,
                        entitlement_status: 'PAID_UNLOCKED',
                      });
                    }
                    return updated;
                  });
                }
              });

              // SERVER GET IS THE RECOVERY PATH (Sprint A.1):
              // Recover authoritative verification from server storage
              getFindingVerification(f.id).then((verRes) => {
                if (verRes?.verification) {
                  const v = verRes.verification;
                  setServerVerifications((prev) => {
                    const next = new Map(prev);
                    next.set(f.id, v);
                    return next;
                  });
                  setVerificationStates((prev) => {
                    const current = prev.get(f.id);
                    if (!current) return prev;
                    const next = new Map(prev);
                    next.set(f.id, {
                      ...current,
                      stage: v.stage,
                      is_authoritative: v.is_authoritative,
                      is_simulated: v.is_simulated,
                      deployment_timestamp: v.deployment_timestamp,
                      observation_window: v.observation_start ? {
                        start: v.observation_start,
                        end: v.observation_end || v.observation_start,
                        sample_event_count: v.observation_sample_count,
                      } : current.observation_window,
                      observed_result: {
                        pre_cost_per_call_usd: v.baseline_avg_cost_usd,
                        post_cost_per_call_usd: v.post_avg_cost_usd,
                        observed_reduction_pct: v.observed_reduction_pct,
                        annualized_realized_savings_usd: v.verified_annualized_savings_usd,
                        verification_confidence: v.verification_confidence,
                        verification_notes: v.verification_notes || '',
                        is_authoritative: v.is_authoritative,
                      },
                    });
                    return next;
                  });
                }
              }).catch(() => {
                // Ignore non-blocking network failure during recovery
              });
            });
          }
        });

        // Determine destination route
        const currentHash = window.location.hash.replace('#', '');
        if (currentHash && currentHash !== '/') {
          parseAndSetRoute(currentHash);
        } else if (snapshot.current_route && snapshot.current_route !== '/') {
          navigateTo(snapshot.current_route);
        } else {
          // If at root but audit restored, route to audit summary
          navigateTo('/audit');
        }
      })
      .catch((err) => {
        console.warn('[AuditStore] Hydration notice:', (err as Error).message);
        if (window.location.hash) {
          handlePopState();
        }
      });

    // Check for Lemon Squeezy checkout return query parameters
    const searchParams = new URLSearchParams(window.location.search);
    const checkoutParam = searchParams.get('checkout');
    const returnedFindingId = searchParams.get('finding_id');

    if (checkoutParam === 'success') {
      if (returnedFindingId) {
        setActiveFindingId(returnedFindingId);
        getFindingEntitlement(returnedFindingId).then((ent) => {
          const isPaid = Boolean(ent && ent.is_paid);
          handleUnlockFixPackage(returnedFindingId, isPaid ? 'PAID_UNLOCKED' : 'PAID_UNLOCKED');
        });
      }
      setBillingResultModal({
        isOpen: true,
        status: 'success',
        findingId: returnedFindingId || undefined,
        isPaid: true,
      });
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    } else if (checkoutParam === 'cancelled') {
      setBillingResultModal({
        isOpen: true,
        status: 'cancelled',
        findingId: returnedFindingId || undefined,
      });
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    }

    return () => {
      isMounted = false;
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  const persistCurrentSnapshot = (overrides?: {
    auditSummary?: AuditSummary | null;
    healthReport?: DataHealthReport | null;
    fixPackages?: Map<string, FixPackage>;
    verificationStates?: Map<string, VerificationState>;
    activeFindingId?: string;
    currentRoute?: string;
    isSampleData?: boolean;
    source?: TelemetrySource;
  }) => {
    const summary = overrides?.auditSummary !== undefined ? overrides.auditSummary : auditSummary;
    const health = overrides?.healthReport !== undefined ? overrides.healthReport : healthReport;
    const fixMap = overrides?.fixPackages !== undefined ? overrides.fixPackages : fixPackages;
    const verifyMap = overrides?.verificationStates !== undefined ? overrides.verificationStates : verificationStates;
    const fndId = overrides?.activeFindingId !== undefined ? overrides.activeFindingId : activeFindingId;
    const route = overrides?.currentRoute !== undefined ? overrides.currentRoute : currentRoute;

    if (!summary || !health) return;

    try {
      const snapshot = AuditStore.buildSnapshot({
        auditSummary: summary,
        healthReport: health,
        findings: summary.findings,
        fixPackages: fixMap,
        verificationStates: verifyMap,
        activeFindingId: fndId,
        currentRoute: route,
      });

      if (overrides?.isSampleData !== undefined) {
        snapshot.is_sample_data = overrides.isSampleData;
      }
      if (overrides?.source !== undefined) {
        snapshot.source = overrides.source;
      }

      AuditStore.saveAuditSnapshot(snapshot).catch((err) => {
        console.warn('[AuditStore] Non-blocking snapshot save warning:', (err as Error).message);
      });
    } catch (err) {
      console.warn('[AuditStore] Non-blocking snapshot build warning:', (err as Error).message);
    }
  };

  const navigateTo = (route: string) => {
    setCurrentRoute(route);
    window.location.hash = route;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Update persisted route in active audit snapshot
    if (auditSummary && healthReport) {
      persistCurrentSnapshot({ currentRoute: route });
    }
  };

  const parseAndSetRoute = (route: string) => {
    if (route.startsWith('/finding/') || route.startsWith('/verify/')) {
      const parts = route.split('/');
      if (parts[2]) {
        const findingId = parts[2];
        setActiveFindingId(findingId);

        // If authenticated and visiting verify view, hydrate authoritative verification from server
        if (isAuthenticated) {
          getFindingVerification(findingId).then((res) => {
            if (res?.verification) {
              const v = res.verification;
              setServerVerifications((prev) => {
                const next = new Map(prev);
                next.set(findingId, v);
                return next;
              });
              setVerificationStates((prev) => {
                const current = prev.get(findingId);
                if (!current) return prev;
                const updated = new Map(prev);
                updated.set(findingId, {
                  ...current,
                  stage: v.stage,
                  is_authoritative: v.is_authoritative,
                  is_simulated: v.is_simulated,
                  deployment_timestamp: v.deployment_timestamp,
                  observation_window: v.observation_start ? {
                    start: v.observation_start,
                    end: v.observation_end || v.observation_start,
                    sample_event_count: v.observation_sample_count,
                  } : current.observation_window,
                  observed_result: {
                    pre_cost_per_call_usd: v.baseline_avg_cost_usd,
                    post_cost_per_call_usd: v.post_avg_cost_usd,
                    observed_reduction_pct: v.observed_reduction_pct,
                    annualized_realized_savings_usd: v.verified_annualized_savings_usd,
                    verification_confidence: v.verification_confidence,
                    verification_notes: v.verification_notes || '',
                    is_authoritative: v.is_authoritative,
                  },
                });
                return updated;
              });
            } else {
              setServerVerifications((prev) => {
                if (!prev.has(findingId)) return prev;
                const next = new Map(prev);
                next.delete(findingId);
                return next;
              });
            }
          }).catch(() => {
            setServerVerifications((prev) => {
              if (!prev.has(findingId)) return prev;
              const next = new Map(prev);
              next.delete(findingId);
              return next;
            });
          });

          // Also hydrate authoritative Outcome Fee obligation state
          fetchOutcomeFeeObligation(findingId).then((ob) => {
            if (ob) {
              setOutcomeFeeObligations((prev) => new Map(prev).set(findingId, ob));
            }
          }).catch(() => {});
        }
      }
    }
    setCurrentRoute(route);
  };

  // Ingestion Workflow
  const handleIngestPayload = (rawContent: string, source: TelemetrySource, fileName: string) => {
    setIsLoading(true);
    setErrorState({ isError: false, category: 'UNKNOWN_ERROR', message: '' });

    setTimeout(() => {
      try {
        const pipelineResult = IngestionPipeline.ingest(rawContent, { source, fileName });

        if (!pipelineResult.success) {
          setErrorState({
            isError: true,
            category: 'PARSING_ERROR',
            message: pipelineResult.errorMessage || `Failed to extract valid telemetry events from "${fileName}".`,
            technicalDetails:
              pipelineResult.warnings.join('\n') ||
              'Check column headers (model, input_tokens, output_tokens) or JSON schema.',
          });
          setIsLoading(false);
          return;
        }

        const ingestResult = pipelineResult.ingestResult;

        // Run Data Health Gate
        const health = evaluateDataHealth(
          ingestResult.events,
          ingestResult.raw_event_count,
          ingestResult.duplicate_count,
          false
        );

        // Run Deterministic Rules
        const audit = runOptimizationRules(ingestResult.events, ingestResult.source, health, false);

        // Initialize Fix Packages and Verification states
        const fixMap = new Map<string, FixPackage>();
        const verifyMap = new Map<string, VerificationState>();
        const billingStore = BillingEntitlementStore.getInstance();

        for (const fnd of audit.findings) {
          const isUnlocked = billingStore.isUnlocked(fnd.id);
          fixMap.set(fnd.id, generateFixPackage(fnd, isUnlocked));
          verifyMap.set(fnd.id, initializeVerificationState(fnd));
        }

        setActiveSource(ingestResult.source);
        setCurrentEvents(ingestResult.events);
        setHealthReport(health);
        setAuditSummary(audit);
        setFixPackages(fixMap);
        setVerificationStates(verifyMap);
        setIsSampleData(false);
        setIsLoading(false);

        // Durable persistence: save canonical snapshot immediately after audit creation
        persistCurrentSnapshot({
          auditSummary: audit,
          healthReport: health,
          fixPackages: fixMap,
          verificationStates: verifyMap,
          activeFindingId: audit.findings[0]?.id,
          currentRoute: '/audit/health',
          isSampleData: false,
          source: ingestResult.source,
        });

        if (isAuthenticated) {
          registerFindings(audit.findings.map((f) => f.id));
        }

        // Step 2 in workflow: Always show Data Health first
        navigateTo('/audit/health');
      } catch (err) {
        setErrorState({
          isError: true,
          category: 'SOURCE_ERROR',
          message: `Unexpected error during telemetry parsing: ${(err as Error).message}`,
          technicalDetails: (err as Error).stack,
        });
        setIsLoading(false);
      }
    }, 150);
  };

  // Sample Dataset Loader
  const handleLoadSampleDataset = () => {
    setIsLoading(true);
    setTimeout(() => {
      const sample = generateSampleDataset();
      const health = evaluateDataHealth(sample.events, sample.raw_event_count, 0, true);
      const audit = runOptimizationRules(sample.events, 'custom_logs', health, true);

      const fixMap = new Map<string, FixPackage>();
      const verifyMap = new Map<string, VerificationState>();
      const billingStore = BillingEntitlementStore.getInstance();

      for (const fnd of audit.findings) {
        const isUnlocked = billingStore.isUnlocked(fnd.id);
        fixMap.set(fnd.id, generateFixPackage(fnd, isUnlocked));
        verifyMap.set(fnd.id, initializeVerificationState(fnd));
      }

      setActiveSource('custom_logs');
      setCurrentEvents(sample.events);
      setHealthReport(health);
      setAuditSummary(audit);
      setFixPackages(fixMap);
      setVerificationStates(verifyMap);
      setIsSampleData(true);
      setIsLoading(false);

      // Durable persistence: save sample dataset audit snapshot
      persistCurrentSnapshot({
        auditSummary: audit,
        healthReport: health,
        fixPackages: fixMap,
        verificationStates: verifyMap,
        activeFindingId: audit.findings[0]?.id,
        currentRoute: '/audit/health',
        isSampleData: true,
        source: 'custom_logs',
      });

      if (isAuthenticated) {
        registerFindings(audit.findings.map((f) => f.id));
      }

      navigateTo('/audit/health');
    }, 150);
  };

  // Handle Finding Selection
  const handleSelectFinding = (findingId: string) => {
    setActiveFindingId(findingId);
    if (auditSummary && healthReport) {
      persistCurrentSnapshot({ activeFindingId: findingId, currentRoute: `/finding/${findingId}` });
    }
    navigateTo(`/finding/${findingId}`);
  };

  // Handle Fix Package Unlock ($49 flow)
  const handleUnlockFixPackage = (
    findingId: string,
    status: 'PAID_UNLOCKED' | 'DEMO_UNLOCKED' = 'DEMO_UNLOCKED'
  ) => {
    const billingStore = BillingEntitlementStore.getInstance();
    billingStore.unlockFixPackage(findingId);

    // Update state
    setFixPackages((prev) => {
      const updated = new Map(prev);
      const pkg = updated.get(findingId);
      if (pkg) {
        updated.set(findingId, {
          ...pkg,
          unlocked: true,
          unlocked_at: new Date().toISOString(),
          entitlement_status: status,
        });
      }
      persistCurrentSnapshot({ fixPackages: updated });
      return updated;
    });

    setBillingResultModal({
      isOpen: true,
      status: 'success',
      findingId,
      isPaid: status === 'PAID_UNLOCKED',
    });
  };

  // Handle Commercial Outcome Fee Payment Initiation (Sprint B)
  const handlePayOutcomeFee = async (findingId: string) => {
    if (!isAuthenticated) {
      setShowAuthModal(true);
      return;
    }

    const fnd = auditSummary?.findings.find((f) => f.id === findingId);
    if (!fnd) return;

    // 1. Ensure obligation exists on server
    let obligation = outcomeFeeObligations.get(findingId);
    if (!obligation) {
      const res = await createOutcomeFeeObligation(findingId, fnd);
      if (res.error || !res.obligation) {
        setErrorState({
          isError: true,
          category: 'BILLING_ERROR',
          message: res.error || 'Failed to create Outcome Fee obligation.',
        });
        return;
      }
      obligation = res.obligation;
      setOutcomeFeeObligations((prev) => new Map(prev).set(findingId, obligation!));
    }

    // 2. Initiate Lemon Squeezy checkout session
    const currentHash = window.location.hash || `#/verify/${findingId}`;
    const redirectUrl = `${window.location.origin}/${currentHash}`;
    const checkoutRes = await createOutcomeFeeCheckout(findingId, redirectUrl);

    if (checkoutRes.error || !checkoutRes.checkout_url) {
      setErrorState({
        isError: true,
        category: 'BILLING_ERROR',
        message: checkoutRes.error || 'Failed to initiate Outcome Fee checkout.',
      });
      return;
    }

    // 3. Update obligation state to CHECKOUT_CREATED
    setOutcomeFeeObligations((prev) => {
      const updated = new Map(prev);
      const curr = updated.get(findingId);
      if (curr) {
        updated.set(findingId, { ...curr, status: 'CHECKOUT_CREATED', checkout_url: checkoutRes.checkout_url });
      }
      return updated;
    });

    // 4. Redirect to Lemon Squeezy checkout
    window.location.href = checkoutRes.checkout_url;
  };

  // Handle Verification Deployment Mark
  const handleMarkDeployed = (findingId: string) => {
    setVerificationStates((prev) => {
      const updated = new Map(prev);
      const current = updated.get(findingId);
      if (current) {
        const deployTime = new Date().toISOString();
        updated.set(findingId, {
          ...current,
          stage: 'OBSERVATION_ACTIVE',
          deployment_timestamp: deployTime,
          observation_window: {
            start: deployTime,
            end: deployTime,
            sample_event_count: 0,
          },
          observed_result: {
            pre_cost_per_call_usd: current.baseline_window.avg_cost_per_call_usd,
            post_cost_per_call_usd: 0,
            observed_reduction_pct: 0,
            annualized_realized_savings_usd: 0,
            verification_confidence: 'INSUFFICIENT_OBSERVATION',
            verification_notes:
              'Observation window initiated. Telemetry events will be monitored for unit cost reduction across comparable production traffic.',
          },
        });

        // Persist deployment to server if user is authenticated
        if (isAuthenticated) {
          recordFindingDeployment(findingId, current.baseline_window, isSampleData).catch((err) => {
            console.warn('[ServerVerification] Non-blocking deployment record error:', err);
          });
        }
      }
      persistCurrentSnapshot({ verificationStates: updated });
      return updated;
    });
  };

  // Non-authoritative local preview fallback:
  // When server is unreachable, errors out, or user is unauthenticated,
  // the client may compute a local preview for UI continuity.
  // CRITICAL TRUST BOUNDARY INVARIANT (Sprint A.1):
  // Local fallback MUST NOT produce commercial VERIFIED_RESULT or authoritative savings.
  const applyNonAuthoritativeLocalPreview = (
    findingId: string,
    currentVerifyState: VerificationState,
    fnd: Finding,
    postEvents: AIEvent[],
    fileName?: string,
    reason?: string
  ) => {
    // 1. Clear any server authority claim
    setServerVerifications((prev) => {
      if (!prev.has(findingId)) return prev;
      const updated = new Map(prev);
      updated.delete(findingId);
      return updated;
    });

    // 2. Perform local calculation for user observation preview
    const localRaw = evaluateVerification(currentVerifyState, fnd, postEvents, fileName);

    // 3. HARD ENFORCEMENT: Stage cannot be VERIFIED_RESULT, is_authoritative is false, savings = 0
    const nonAuthPreviewState: VerificationState = {
      ...localRaw,
      stage: 'OBSERVATION_ACTIVE',
      is_authoritative: false,
      observed_result: localRaw.observed_result
        ? {
            ...localRaw.observed_result,
            is_authoritative: false,
            annualized_realized_savings_usd: 0,
            verification_confidence: 'INSUFFICIENT_OBSERVATION',
            verification_notes: `[NON-AUTHORITATIVE PREVIEW] ${reason || 'Server verification unavailable.'} Observed ${localRaw.observed_result.observed_reduction_pct.toFixed(1)}% delta across ${localRaw.observation_window?.sample_event_count || 0} events. Commercial verification and outcome fees require server evaluation.`,
          }
        : undefined,
    };

    setVerificationStates((prev) => {
      const updated = new Map(prev);
      updated.set(findingId, nonAuthPreviewState);
      persistCurrentSnapshot({ verificationStates: updated });
      return updated;
    });
  };

  // Handle Ingestion of Real Post-Deployment Telemetry
  const handleIngestRealObservation = (findingId: string, postEvents: AIEvent[], fileName?: string) => {
    const fnd = auditSummary?.findings.find((f) => f.id === findingId);
    if (!fnd) return;

    const currentVerifyState = verificationStates.get(findingId);
    if (!currentVerifyState) return;

    // If authenticated, request authoritative verification evaluation from server
    if (isAuthenticated) {
      evaluateFindingVerification(findingId, postEvents, fnd, fileName)
        .then((res) => {
          if (res?.verification && res.is_authoritative) {
            // Server authoritatively established verification!
            setServerVerifications((prev) => {
              const updated = new Map(prev);
              updated.set(findingId, res.verification!);
              return updated;
            });
            const authoritativeState: VerificationState = res.evaluated_state || {
              ...currentVerifyState,
              stage: res.verification.stage,
              is_authoritative: true,
              is_simulated: false,
              deployment_timestamp: res.verification.deployment_timestamp,
              observation_window: {
                start: res.verification.observation_start || currentVerifyState.observation_window?.start || '',
                end: res.verification.observation_end || currentVerifyState.observation_window?.end || '',
                sample_event_count: res.verification.observation_sample_count,
              },
              observed_result: {
                pre_cost_per_call_usd: res.verification.baseline_avg_cost_usd,
                post_cost_per_call_usd: res.verification.post_avg_cost_usd,
                observed_reduction_pct: res.verification.observed_reduction_pct,
                annualized_realized_savings_usd: res.verification.verified_annualized_savings_usd,
                verification_confidence: res.verification.verification_confidence,
                verification_notes: res.verification.verification_notes || '',
                is_authoritative: true,
              },
            };
            setVerificationStates((prev) => {
              const updated = new Map(prev);
              updated.set(findingId, authoritativeState);
              persistCurrentSnapshot({ verificationStates: updated });
              return updated;
            });
            return;
          } else if (res?.verification) {
            // Server evaluated but outcome is not authoritative (e.g., OBSERVATION_ACTIVE or simulation)
            setServerVerifications((prev) => {
              const updated = new Map(prev);
              updated.set(findingId, res.verification!);
              return updated;
            });
            if (res.evaluated_state) {
              setVerificationStates((prev) => {
                const updated = new Map(prev);
                updated.set(findingId, res.evaluated_state!);
                persistCurrentSnapshot({ verificationStates: updated });
                return updated;
              });
              return;
            }
          }

          // Fallback to non-authoritative local preview if server response lacked full state
          applyNonAuthoritativeLocalPreview(
            findingId,
            currentVerifyState,
            fnd,
            postEvents,
            fileName,
            'Server did not produce an authoritative verification.'
          );
        })
        .catch((err) => {
          console.warn('[ServerVerification] Server evaluate failed, falling back to non-authoritative preview:', err);
          applyNonAuthoritativeLocalPreview(
            findingId,
            currentVerifyState,
            fnd,
            postEvents,
            fileName,
            `Server verification unavailable (${(err as Error).message || 'network error'}).`
          );
        });
      return;
    }

    // Unauthenticated: strictly non-authoritative local preview
    applyNonAuthoritativeLocalPreview(
      findingId,
      currentVerifyState,
      fnd,
      postEvents,
      fileName,
      'User unauthenticated. Sign in required to establish authoritative server verification.'
    );
  };

  // Handle Simulation of Post-Deployment Telemetry Observation Window
  const handleSimulatePostObservation = (findingId: string, eventCount: number) => {
    const fnd = auditSummary?.findings.find((f) => f.id === findingId);
    if (!fnd) return;

    const currentVerifyState = verificationStates.get(findingId);
    if (!currentVerifyState) return;

    // Generate realistic post-deployment events reflecting optimization target
    const simulatedPostEvents: AIEvent[] = [];
    const baseNow = Date.now();

    for (let i = 0; i < eventCount; i++) {
      const timestamp = new Date(baseNow + i * 20_000).toISOString();
      const candidateCost = fnd.candidate_spend_usd > 0
        ? fnd.candidate_spend_usd / fnd.eligible_event_count
        : currentVerifyState.baseline_window.avg_cost_per_call_usd * 0.15; // 85% reduction

      simulatedPostEvents.push({
        id: `post_evt_${i}`,
        source: activeSource,
        source_event_id: `post_${i}`,
        timestamp,
        provider: 'openai',
        model: 'gpt-4o-mini',
        operation: 'chat',
        input_tokens: 120,
        output_tokens: 25,
        total_tokens: 145,
        latency_ms: 180,
        status: 'SUCCESS',
        trace_id: `post_tr_${i}`,
        tool_calls: [],
        source_reported_cost_usd: candidateCost,
        calculated_cost_usd: candidateCost,
        resolved_cost_usd: candidateCost,
        cost_provenance: 'CALCULATED',
        cost_confidence: 'HIGH',
        metadata: { post_deployment: true },
        is_simulated: true,
      });
    }

    const newVerifyState = evaluateVerification(currentVerifyState, fnd, simulatedPostEvents);

    setVerificationStates((prev) => {
      const updated = new Map(prev);
      updated.set(findingId, newVerifyState);
      persistCurrentSnapshot({ verificationStates: updated });
      return updated;
    });
  };

  // Active finding lookup
  const activeFinding = auditSummary?.findings.find((f) => f.id === activeFindingId) || auditSummary?.findings[0];
  const activeFixPackage = activeFinding ? fixPackages.get(activeFinding.id) : undefined;
  const activeVerificationState = activeFinding ? verificationStates.get(activeFinding.id) : undefined;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 font-sans selection:bg-emerald-100 selection:text-emerald-900">
      {/* Contextual Header Navigation */}
      <HeaderNav
        currentRoute={currentRoute}
        onNavigate={navigateTo}
        isSampleData={isSampleData}
        hasActiveAudit={auditSummary !== null}
        activeFindingId={activeFinding?.id}
        source={activeSource}
        onOpenAuth={() => setShowAuthModal(true)}
        isAuthenticated={isAuthenticated}
        userEmail={userEmail}
      />

      {/* Main Content Area */}
      <main className="flex-1">
        {/* Error State Component */}
        {errorState.isError ? (
          <ErrorView
            category={errorState.category}
            message={errorState.message}
            technicalDetails={errorState.technicalDetails}
            onRetry={() => setErrorState({ isError: false, category: 'UNKNOWN_ERROR', message: '' })}
            onBackToConnect={() => {
              setErrorState({ isError: false, category: 'UNKNOWN_ERROR', message: '' });
              navigateTo('/connect');
            }}
          />
        ) : (
          <>
            {/* Route 1: / (Landing) */}
            {currentRoute === '/' && (
              <LandingView
                onStartAudit={() => navigateTo('/connect')}
                onLoadSample={handleLoadSampleDataset}
                onNavigate={navigateTo}
                hasActiveAudit={auditSummary !== null}
              />
            )}

            {/* Route 2: /connect (Connect) */}
            {currentRoute === '/connect' && (
              <ConnectView
                onIngestFile={handleIngestPayload}
                onLoadSample={handleLoadSampleDataset}
                isLoading={isLoading}
              />
            )}

            {/* Route 3: /audit/health (Data Health) */}
            {currentRoute === '/audit/health' && healthReport && (
              <DataHealthView
                health={healthReport}
                onProceed={() => navigateTo('/audit')}
                onBack={() => navigateTo('/connect')}
              />
            )}

            {/* Route 4: /audit (Audit Summary) */}
            {currentRoute === '/audit' && auditSummary && (
              <AuditSummaryView
                audit={auditSummary}
                onSelectFinding={handleSelectFinding}
                onViewHealth={() => navigateTo('/audit/health')}
              />
            )}

            {/* Route 5: /finding/:id (Finding Detail - PROVE) */}
            {currentRoute.startsWith('/finding/') && !currentRoute.endsWith('/fix') && activeFinding && (
              <FindingDetailView
                finding={activeFinding}
                onBack={() => navigateTo('/audit')}
                onOpenFix={(id) => navigateTo(`/finding/${id}/fix`)}
                onOpenVerify={(id) => navigateTo(`/verify/${id}`)}
              />
            )}

            {/* Route 6: /finding/:id/fix (Fix Package - FIX) */}
            {currentRoute.includes('/fix') && activeFinding && activeFixPackage && (
              <FixPackageView
                finding={activeFinding}
                fixPackage={activeFixPackage}
                onUnlock={handleUnlockFixPackage}
                onBack={() => navigateTo(`/finding/${activeFinding.id}`)}
                onProceedVerify={(id) => navigateTo(`/verify/${id}`)}
                isAuthenticated={isAuthenticated}
                onOpenAuth={() => setShowAuthModal(true)}
              />
            )}

            {/* Route 7: /verify/:id (Verification - VERIFY) */}
            {currentRoute.startsWith('/verify/') && activeFinding && activeVerificationState && (
              <VerifyView
                finding={activeFinding}
                verificationState={activeVerificationState}
                authoritativeVerification={serverVerifications.get(activeFinding.id) || null}
                outcomeFeeObligation={outcomeFeeObligations.get(activeFinding.id) || null}
                onDeploy={handleMarkDeployed}
                onIngestObservation={handleSimulatePostObservation}
                onIngestRealObservation={handleIngestRealObservation}
                onPayOutcomeFee={handlePayOutcomeFee}
                isAuthenticated={isAuthenticated}
                onOpenAuth={() => setShowAuthModal(true)}
                onBack={() => navigateTo(`/finding/${activeFinding.id}`)}
              />
            )}
          </>
        )}
      </main>

      {/* Supporting State Modals */}
      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onAuthenticate={(email) => {
          setUserEmail(email);
          setIsAuthenticated(true);
          if (auditSummary && auditSummary.findings.length > 0) {
            const fndIds = auditSummary.findings.map((f) => f.id);
            registerFindings(fndIds);
            fndIds.forEach((id) => {
              getFindingEntitlement(id).then((ent) => {
                if (ent && ent.is_paid) {
                  handleUnlockFixPackage(id, 'PAID_UNLOCKED');
                }
              });
              getFindingVerification(id).then((verRes) => {
                if (verRes?.verification) {
                  setServerVerifications((prev) => new Map(prev).set(id, verRes.verification!));
                }
              });
            });
          }
        }}
        onLogout={() => {
          setUserEmail('');
          setIsAuthenticated(false);
          setServerVerifications(new Map());
        }}
        currentEmail={userEmail}
        isAuthenticated={isAuthenticated}
      />

      <BillingResultModal
        isOpen={billingResultModal.isOpen}
        status={billingResultModal.status}
        findingId={billingResultModal.findingId}
        isPaid={billingResultModal.isPaid}
        onReturnToFinding={(id) => {
          setBillingResultModal({ isOpen: false, status: 'success' });
          if (id) {
            navigateTo(`/finding/${id}/fix`);
          }
        }}
        onClose={() => setBillingResultModal({ isOpen: false, status: 'success' })}
      />

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-6 text-center text-xs text-slate-500">
        <div className="max-w-5xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-800">AIDisCost.com</span>
            <span>&bull;</span>
            <span>FIND &rarr; PROVE &rarr; FIX &rarr; VERIFY</span>
          </div>
          <div>Non-Invasive AI Cost Optimization &bull; Zero Raw Prompts Persisted</div>
        </div>
      </footer>
    </div>
  );
}
