/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { TelemetrySource } from '../types/domain';
import { Layers, ShieldCheck, Zap, AlertCircle } from 'lucide-react';

interface HeaderNavProps {
  currentRoute: string;
  onNavigate: (route: string) => void;
  isSampleData?: boolean;
  hasActiveAudit?: boolean;
  activeFindingId?: string;
  source?: TelemetrySource;
  onOpenAuth?: () => void;
  isAuthenticated?: boolean;
  userEmail?: string;
}

export const HeaderNav: React.FC<HeaderNavProps> = ({
  currentRoute,
  onNavigate,
  isSampleData = false,
  hasActiveAudit = false,
  activeFindingId,
  onOpenAuth,
  isAuthenticated = false,
  userEmail,
}) => {
  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-xs border-b border-slate-200">
      {/* Sample Data Banner */}
      {isSampleData && (
        <div className="bg-purple-900 text-purple-100 px-4 py-1.5 text-xs font-semibold flex items-center justify-between">
          <div className="flex items-center gap-2 max-w-5xl mx-auto w-full">
            <span className="px-1.5 py-0.5 rounded bg-purple-700 font-mono text-[10px] tracking-wider uppercase">
              SAMPLE DATA
            </span>
            <span className="truncate">
              Financial results and findings generated from synthetic telemetry dataset for demonstration and verification testing.
            </span>
          </div>
        </div>
      )}

      {/* Main Header Container */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        {/* Brand & Category */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            id="nav-logo"
            onClick={() => onNavigate('/')}
            className="flex items-center gap-2 group text-left focus:outline-hidden"
          >
            <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold text-sm tracking-tight shadow-xs group-hover:bg-slate-800 transition-colors">
              AI
            </div>
            <div>
              <span className="text-base font-extrabold tracking-tight text-slate-900 group-hover:text-slate-700 transition-colors">
                AIDisCost<span className="text-emerald-600 font-mono text-xs">.com</span>
              </span>
              <span className="hidden sm:block text-[11px] font-medium text-slate-500 leading-none">
                AI Cost Optimization &amp; Verification
              </span>
            </div>
          </button>
        </div>

        {/* Workflow Pipeline Pills (Desktop) */}
        <nav className="hidden md:flex items-center bg-slate-100 p-1 rounded-xl text-xs font-semibold text-slate-600 border border-slate-200">
          <button
            type="button"
            id="nav-pill-home"
            onClick={() => onNavigate('/')}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              currentRoute === '/' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
            }`}
          >
            Overview
          </button>
          <button
            type="button"
            id="nav-pill-connect"
            onClick={() => onNavigate('/connect')}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              currentRoute === '/connect' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
            }`}
          >
            1. Connect
          </button>
          <button
            type="button"
            id="nav-pill-health"
            onClick={() => onNavigate('/audit/health')}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              currentRoute === '/audit/health' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
            }`}
          >
            2. Data Health
          </button>
          <button
            type="button"
            id="nav-pill-audit"
            onClick={() => onNavigate('/audit')}
            disabled={!hasActiveAudit}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              currentRoute === '/audit'
                ? 'bg-white text-slate-900 shadow-xs'
                : hasActiveAudit
                ? 'hover:text-slate-900'
                : 'opacity-40 cursor-not-allowed'
            }`}
          >
            3. Audit Summary
          </button>
          {activeFindingId && (
            <button
              type="button"
              id="nav-pill-finding"
              onClick={() => onNavigate(`/finding/${activeFindingId}`)}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                currentRoute.startsWith('/finding') ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
              }`}
            >
              4. Evidence
            </button>
          )}
        </nav>

        {/* Right CTA / Auth Status */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            id="btn-auth-toggle"
            onClick={onOpenAuth}
            className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 transition-colors flex items-center gap-1.5"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>{userEmail ? `Workspace: ${userEmail}` : 'Identity: Standalone (SSO Adapter Ready)'}</span>
          </button>

          {currentRoute !== '/connect' && (
            <button
              type="button"
              id="btn-nav-audit-cta"
              onClick={() => onNavigate('/connect')}
              className="px-3.5 py-2 text-xs font-bold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors shadow-xs flex items-center gap-1.5"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{hasActiveAudit ? 'New Audit' : 'Start Audit'}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
