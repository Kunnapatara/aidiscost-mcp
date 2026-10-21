/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, CheckCircle2, AlertTriangle, ArrowRight, ShieldCheck, Mail, Lock, UserCheck, LogIn, UserPlus } from 'lucide-react';
import { loginUser, registerUser, logoutUser, AuthUser } from '../services/api';

/**
 * Supporting State A: /auth
 */
interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthenticate: (email: string, user?: AuthUser) => void;
  onLogout?: () => void;
  currentEmail?: string;
  isAuthenticated?: boolean;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  onAuthenticate,
  onLogout,
  currentEmail,
  isAuthenticated = false,
}) => {
  const [tab, setTab] = useState<'LOGIN' | 'REGISTER'>('LOGIN');
  const [email, setEmail] = useState(currentEmail || '');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!email.trim() || !email.includes('@')) {
      setErrorMsg('Please enter a valid email address.');
      return;
    }

    if (password.length < 6) {
      setErrorMsg('Password must be at least 6 characters.');
      return;
    }

    setIsLoading(true);

    try {
      if (tab === 'LOGIN') {
        const res = await loginUser(email, password);
        if (res.error || !res.user) {
          setErrorMsg(res.message || 'Invalid email or password.');
          setIsLoading(false);
          return;
        }
        setSuccessMsg(`Welcome back, ${res.user.email}`);
        onAuthenticate(res.user.email, res.user);
        setTimeout(() => onClose(), 800);
      } else {
        const res = await registerUser(email, password);
        if (res.error || !res.user) {
          setErrorMsg(res.message || 'Registration failed.');
          setIsLoading(false);
          return;
        }
        setSuccessMsg(`Account created for ${res.user.email}`);
        onAuthenticate(res.user.email, res.user);
        setTimeout(() => onClose(), 800);
      }
    } catch (err) {
      setErrorMsg((err as Error).message || 'Authentication error.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    setIsLoading(true);
    await logoutUser();
    if (onLogout) onLogout();
    setIsLoading(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200 relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center mb-3 shadow-xs">
          <Lock className="w-5 h-5 text-emerald-400" />
        </div>

        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
            Server-Authoritative Session &bull; HttpOnly
          </span>
        </div>

        {isAuthenticated ? (
          <div>
            <h3 className="text-lg font-bold text-slate-900">Account Session</h3>
            <div className="mt-4 p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                <UserCheck className="w-4 h-4 text-emerald-600" />
                <span>Signed in as: <strong className="text-slate-900">{currentEmail}</strong></span>
              </div>
              <p className="text-[11px] text-slate-500">
                Authenticated session is secured via server-side HttpOnly cookie. Finding purchases and entitlements are tied to this account.
              </p>
            </div>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={handleLogout}
                disabled={isLoading}
                className="w-full py-2.5 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 text-xs font-bold transition-colors"
              >
                Sign Out
              </button>
              <button
                type="button"
                onClick={onClose}
                className="w-full py-2.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800 text-xs font-bold transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <div>
            <h3 className="text-lg font-bold text-slate-900">
              {tab === 'LOGIN' ? 'Sign In to AIDisCost' : 'Create an Account'}
            </h3>
            <p className="text-xs text-slate-500 mt-1 mb-4 leading-relaxed">
              Authenticate to associate audits, unlock Fix Packages, and manage finding entitlements securely.
            </p>

            {/* Tabs */}
            <div className="flex bg-slate-100 p-1 rounded-xl mb-4 text-xs font-bold">
              <button
                type="button"
                onClick={() => { setTab('LOGIN'); setErrorMsg(null); }}
                className={`flex-1 py-1.5 rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                  tab === 'LOGIN' ? 'bg-white text-slate-950 shadow-xs' : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Sign In</span>
              </button>
              <button
                type="button"
                onClick={() => { setTab('REGISTER'); setErrorMsg(null); }}
                className={`flex-1 py-1.5 rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                  tab === 'REGISTER' ? 'bg-white text-slate-950 shadow-xs' : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>Create Account</span>
              </button>
            </div>

            {errorMsg && (
              <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {successMsg && (
              <div className="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs flex items-center gap-2 font-medium">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="w-full text-xs p-3 rounded-lg border border-slate-300 focus:ring-2 focus:ring-slate-900 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">Password</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  className="w-full text-xs p-3 rounded-lg border border-slate-300 focus:ring-2 focus:ring-slate-900 focus:outline-hidden"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 mt-2 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <span>Authenticating...</span>
                ) : tab === 'LOGIN' ? (
                  <span>Sign In</span>
                ) : (
                  <span>Create Account</span>
                )}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Supporting State B: /billing/result
 */
interface BillingResultModalProps {
  isOpen: boolean;
  status: 'success' | 'cancelled' | 'error';
  findingId?: string;
  isPaid?: boolean;
  onReturnToFinding: (findingId?: string) => void;
  onClose: () => void;
}

export const BillingResultModal: React.FC<BillingResultModalProps> = ({
  isOpen,
  status,
  findingId,
  isPaid = false,
  onReturnToFinding,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200 text-center">
        {status === 'success' ? (
          <>
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 mx-auto flex items-center justify-center mb-3">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            {isPaid ? (
              <div className="inline-block px-2.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-emerald-100 text-emerald-900 border border-emerald-300 mb-2">
                Verified Lemon Squeezy Order &bull; $49 Captured
              </div>
            ) : (
              <div className="inline-block px-2.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-amber-100 text-amber-900 border border-amber-300 mb-2">
                Preview Mode &bull; Adapter Ready
              </div>
            )}
            <h3 className="text-lg font-bold text-slate-900">
              {isPaid ? 'Production Fix Package Unlocked' : 'Optimization Fix Package Unlocked'}
            </h3>
            <p className="text-xs text-slate-600 mt-1 mb-5 leading-relaxed">
              {isPaid
                ? 'Commercial Contract: $49 one-time payment verified server-side. Production fix implementation code, canary harness config, acceptance criteria, and rollback protocol are permanently accessible.'
                : 'Commercial Contract: $49 one-time per finding. In this standalone MVP preview, no live credit card was charged. Root cause analysis, canary harness config, acceptance criteria, and rollback protocol are now accessible.'}
            </p>
            <button
              type="button"
              onClick={() => onReturnToFinding(findingId)}
              className="w-full py-2.5 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors"
            >
              View Unlocked Fix Package
            </button>
          </>
        ) : (
          <>
            <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-600 mx-auto flex items-center justify-center mb-3">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-slate-900">Action Cancelled</h3>
            <p className="text-xs text-slate-600 mt-1 mb-5 leading-relaxed">
              No changes or charges were made. You can return to the evidence finding at any time.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2.5 rounded-lg border border-slate-300 text-slate-700 text-xs font-bold hover:bg-slate-50 transition-colors"
            >
              Return to Finding
            </button>
          </>
        )}
      </div>
    </div>
  );
};

/**
 * Supporting State C: /error (Explicit Diagnostics)
 */
export type ErrorCategory =
  | 'SOURCE_ERROR'
  | 'PARSING_ERROR'
  | 'NORMALIZATION_ERROR'
  | 'PRICING_ERROR'
  | 'RULE_ERROR'
  | 'PERSISTENCE_ERROR'
  | 'BILLING_ERROR'
  | 'UNKNOWN_ERROR';

interface ErrorViewProps {
  category: ErrorCategory;
  message: string;
  technicalDetails?: string;
  onRetry: () => void;
  onBackToConnect: () => void;
}

export const ErrorView: React.FC<ErrorViewProps> = ({
  category,
  message,
  technicalDetails,
  onRetry,
  onBackToConnect,
}) => {
  return (
    <div className="max-w-2xl mx-auto px-4 py-12 text-center space-y-6">
      <div className="w-14 h-14 rounded-2xl bg-red-100 text-red-700 mx-auto flex items-center justify-center">
        <AlertTriangle className="w-7 h-7" />
      </div>

      <div>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded">
          {category}
        </span>
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight mt-2">
          Diagnostic Audit Exception
        </h2>
        <p className="text-xs sm:text-sm text-slate-600 mt-1 max-w-md mx-auto leading-relaxed">
          {message}
        </p>
      </div>

      {technicalDetails && (
        <div className="p-4 rounded-xl bg-slate-900 text-slate-200 text-left font-mono text-xs overflow-x-auto">
          {technicalDetails}
        </div>
      )}

      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="px-5 py-2.5 rounded-xl border border-slate-300 text-slate-800 text-xs font-bold hover:bg-slate-50 transition-colors"
        >
          Try Again
        </button>
        <button
          type="button"
          onClick={onBackToConnect}
          className="px-5 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors"
        >
          Connect Different Source
        </button>
      </div>
    </div>
  );
};
