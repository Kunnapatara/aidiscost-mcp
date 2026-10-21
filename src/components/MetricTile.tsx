/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { CostProvenance } from '../types/domain';
import { ProvenanceBadge } from './ProvenanceBadge';

interface MetricTileProps {
  id?: string;
  label: string;
  value: string | number;
  subtext?: string;
  provenance?: CostProvenance | 'VERIFIED' | 'SAMPLE_DATA';
  trend?: {
    direction: 'down' | 'up' | 'neutral';
    label: string;
  };
  highlight?: boolean;
}

export const MetricTile: React.FC<MetricTileProps> = ({
  id,
  label,
  value,
  subtext,
  provenance,
  trend,
  highlight = false,
}) => {
  return (
    <div
      id={id}
      className={`p-4 rounded-xl border transition-colors ${
        highlight
          ? 'bg-slate-900 border-slate-800 text-white'
          : 'bg-white border-slate-200 text-slate-900 shadow-xs'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className={`text-xs font-semibold uppercase tracking-wider ${highlight ? 'text-slate-400' : 'text-slate-500'}`}>
          {label}
        </span>
        {provenance && <ProvenanceBadge provenance={provenance} size="sm" />}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl sm:text-3xl font-bold font-mono tracking-tight tabular-nums">
          {value}
        </span>
        {trend && (
          <span
            className={`text-xs font-semibold ${
              trend.direction === 'down'
                ? 'text-emerald-500'
                : trend.direction === 'up'
                ? 'text-amber-500'
                : 'text-slate-400'
            }`}
          >
            {trend.label}
          </span>
        )}
      </div>
      {subtext && (
        <p className={`mt-1.5 text-xs ${highlight ? 'text-slate-400' : 'text-slate-500'}`}>
          {subtext}
        </p>
      )}
    </div>
  );
};
