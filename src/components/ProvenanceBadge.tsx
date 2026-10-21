/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { CostProvenance } from '../types/domain';

interface ProvenanceBadgeProps {
  provenance: CostProvenance | 'VERIFIED' | 'SAMPLE_DATA';
  size?: 'sm' | 'md';
}

export const ProvenanceBadge: React.FC<ProvenanceBadgeProps> = ({ provenance, size = 'sm' }) => {
  const sizeClasses = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs';

  switch (provenance) {
    case 'SOURCE_REPORTED':
      return (
        <span
          className={`inline-flex items-center font-mono font-medium rounded border border-emerald-200 bg-emerald-50 text-emerald-800 ${sizeClasses}`}
          title="Directly reported by source telemetry provider"
        >
          SOURCE_REPORTED
        </span>
      );
    case 'CALCULATED':
      return (
        <span
          className={`inline-flex items-center font-mono font-medium rounded border border-blue-200 bg-blue-50 text-blue-800 ${sizeClasses}`}
          title="Calculated deterministically by AIDisCost internal pricing registry"
        >
          CALCULATED
        </span>
      );
    case 'ESTIMATED':
      return (
        <span
          className={`inline-flex items-center font-mono font-medium rounded border border-amber-200 bg-amber-50 text-amber-800 ${sizeClasses}`}
          title="Estimated extrapolation based on observed token distribution"
        >
          ESTIMATED
        </span>
      );
    case 'VERIFIED':
      return (
        <span
          className={`inline-flex items-center font-mono font-medium rounded border border-teal-200 bg-teal-50 text-teal-800 ${sizeClasses}`}
          title="Empirically confirmed through post-deployment observation window"
        >
          VERIFIED
        </span>
      );
    case 'UNPRICED':
      return (
        <span
          className={`inline-flex items-center font-mono font-medium rounded border border-slate-300 bg-slate-100 text-slate-700 ${sizeClasses}`}
          title="Unlisted proprietary model; cost excluded from calculated totals"
        >
          UNPRICED
        </span>
      );
    case 'SAMPLE_DATA':
      return (
        <span
          className={`inline-flex items-center font-mono font-semibold rounded border border-purple-200 bg-purple-50 text-purple-700 ${sizeClasses}`}
          title="Synthetic telemetry generated for validation and testing"
        >
          SAMPLE DATA
        </span>
      );
    default:
      return (
        <span className={`inline-flex items-center font-mono font-medium rounded border border-slate-200 bg-slate-50 text-slate-600 ${sizeClasses}`}>
          UNKNOWN
        </span>
      );
  }
};
