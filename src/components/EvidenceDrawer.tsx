/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { FindingEvidence } from '../types/domain';
import { ProvenanceBadge } from './ProvenanceBadge';
import { ChevronDown, ChevronUp, ShieldCheck, Hash, GitCommit } from 'lucide-react';

interface EvidenceDrawerProps {
  evidence: FindingEvidence;
  defaultExpanded?: boolean;
}

export const EvidenceDrawer: React.FC<EvidenceDrawerProps> = ({
  evidence,
  defaultExpanded = false,
}) => {
  const [isOpen, setIsOpen] = useState(defaultExpanded);

  return (
    <div className="border border-slate-200 rounded-xl bg-white overflow-hidden shadow-xs">
      <button
        type="button"
        id="btn-toggle-evidence"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3.5 flex items-center justify-between text-left hover:bg-slate-50 transition-colors focus:outline-hidden focus:ring-2 focus:ring-slate-400"
      >
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
          <div>
            <h4 className="text-sm font-semibold text-slate-900">Deterministic Mathematical Proof &amp; Telemetry Evidence</h4>
            <p className="text-xs text-slate-500">
              Verified across {evidence.affected_event_count} sampled events &bull; Zero raw prompts stored
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <span>{isOpen ? 'Collapse' : 'Inspect Proof'}</span>
          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </button>

      {isOpen && (
        <div className="border-t border-slate-200 p-4 sm:p-5 bg-slate-50/70 space-y-5">
          {/* Mathematical Proof */}
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-slate-600 block mb-1.5">
              Deterministic Mathematical Calculation
            </span>
            <div className="p-3 bg-white rounded-lg border border-slate-200 font-mono text-xs text-slate-800 leading-relaxed overflow-x-auto">
              {evidence.mathematical_proof}
            </div>
          </div>

          {/* Metrics Comparison */}
          {evidence.metrics_comparison.length > 0 && (
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-600 block mb-2">
                Baseline vs Target Comparison
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {evidence.metrics_comparison.map((m, idx) => (
                  <div key={idx} className="p-3 bg-white rounded-lg border border-slate-200">
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-xs font-medium text-slate-600">{m.label}</span>
                      <ProvenanceBadge provenance={m.provenance} size="sm" />
                    </div>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="font-mono text-slate-600 tabular-nums">{m.current_value}</span>
                      <span className="text-slate-400 text-xs px-2">&rarr;</span>
                      <span className="font-mono font-bold text-slate-900 tabular-nums">{m.target_value}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sample Trace IDs */}
          {evidence.trace_samples.length > 0 && (
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-600 block mb-1.5 flex items-center gap-1.5">
                <GitCommit className="w-3.5 h-3.5 text-slate-500" />
                Sample Correlated Trace IDs
              </span>
              <div className="flex flex-wrap gap-1.5">
                {evidence.trace_samples.map((trace, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center px-2 py-1 rounded bg-white border border-slate-200 font-mono text-[11px] text-slate-700"
                  >
                    {trace}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Privacy & Event Sample Audit Table */}
          {evidence.sample_events.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                  <Hash className="w-3.5 h-3.5 text-slate-500" />
                  Sampled Event Records (Prompt Hashes Only)
                </span>
                <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  Zero Raw Text Persisted
                </span>
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                    <tr>
                      <th className="p-2.5">Event ID</th>
                      <th className="p-2.5">Model</th>
                      <th className="p-2.5 text-right">In / Out Tokens</th>
                      <th className="p-2.5 text-right">Resolved Cost</th>
                      <th className="p-2.5">Provenance</th>
                      <th className="p-2.5 font-mono">Prompt SHA-256</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                    {evidence.sample_events.map((evt, idx) => (
                      <tr key={idx} className="hover:bg-slate-50">
                        <td className="p-2.5 text-slate-600 truncate max-w-[100px]">{evt.id}</td>
                        <td className="p-2.5 font-sans font-medium text-slate-900">{evt.model}</td>
                        <td className="p-2.5 text-right tabular-nums text-slate-600">
                          {evt.input_tokens} / {evt.output_tokens}
                        </td>
                        <td className="p-2.5 text-right font-bold tabular-nums text-slate-900">
                          ${evt.resolved_cost_usd?.toFixed(4)}
                        </td>
                        <td className="p-2.5">
                          {evt.cost_provenance && <ProvenanceBadge provenance={evt.cost_provenance} size="sm" />}
                        </td>
                        <td className="p-2.5 text-slate-500 truncate max-w-[140px]" title={evt.prompt_hash}>
                          {evt.prompt_hash || 'none'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
