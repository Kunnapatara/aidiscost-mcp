/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { TelemetrySource } from '../types/domain';
import { Upload, FileText, Shield, Check, AlertTriangle, ArrowRight, Sparkles, HelpCircle } from 'lucide-react';
import { detectFormat } from '../engine/ingestion/detector';

interface ConnectViewProps {
  onIngestFile: (fileContent: string, source: TelemetrySource, fileName: string) => void;
  onLoadSample: () => void;
  isLoading: boolean;
  error?: string | null;
}

export const ConnectView: React.FC<ConnectViewProps> = ({
  onIngestFile,
  onLoadSample,
  isLoading,
  error,
}) => {
  const [selectedSource, setSelectedSource] = useState<TelemetrySource>('custom_logs');
  const [dragActive, setDragActive] = useState(false);
  const [pasteContent, setPasteContent] = useState('');
  const [showPasteBox, setShowPasteBox] = useState(false);
  const [validationWarning, setValidationWarning] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const processFile = (file: File) => {
    setValidationWarning(null);
    // Large file check: 15MB threshold for browser-safe memory consumption
    const MAX_SAFE_BYTES = 15 * 1024 * 1024;
    if (file.size > MAX_SAFE_BYTES) {
      alert(
        `File size (${(file.size / (1024 * 1024)).toFixed(1)}MB) exceeds browser processing threshold (15MB). Please provide an exported time window slice or contact support for batch streaming.`
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result;
      if (typeof content === 'string') {
        const format = detectFormat(content, file.name);
        if (format === 'UNSUPPORTED') {
          setValidationWarning(
            `"${file.name}" does not appear to be a valid CSV, JSON, JSONL, or NDJSON file. Please check file content.`
          );
        }
        onIngestFile(content, selectedSource, file.name);
      }
    };
    reader.readAsText(file);
  };

  const handlePasteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationWarning(null);
    const trimmed = pasteContent.trim();
    if (!trimmed) return;

    const format = detectFormat(trimmed, 'pasted_telemetry');
    if (format === 'UNSUPPORTED') {
      setValidationWarning(
        'Pasted content is not recognized as valid CSV, JSON, JSONL, or NDJSON. Proceeding with custom parser.'
      );
    }

    onIngestFile(trimmed, selectedSource, 'pasted_telemetry_payload');
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      {/* View Header */}
      <div>
        <span className="text-xs font-mono uppercase tracking-wider text-emerald-700 font-semibold">
          Step 1: Telemetry Ingestion
        </span>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight mt-1">
          Connect Your AI Telemetry
        </h1>
        <p className="text-sm text-slate-600 mt-1.5 max-w-2xl">
          Connect, not Integrate. AIDisCost parses exported telemetry traces client-side with zero proxy
          latency and zero modification to your production environment.
        </p>
      </div>

      {/* Error Banner */}
      {error && (
        <div id="ingest-error-banner" className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-900 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <div className="text-xs">
            <span className="font-bold block">Ingestion Error</span>
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Local Validation Warning Banner */}
      {validationWarning && (
        <div id="ingest-validation-warning" className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-xs">
            <span className="font-bold block">Format Warning</span>
            <span>{validationWarning}</span>
          </div>
        </div>
      )}

      {/* Source Selection Grid (All 4 Sources First-Class) */}
      <div>
        <label className="text-xs font-bold uppercase tracking-wider text-slate-600 block mb-3">
          Select Telemetry Source Format
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* Langfuse */}
          <button
            type="button"
            id="src-opt-langfuse"
            onClick={() => setSelectedSource('langfuse')}
            className={`p-3.5 rounded-xl border text-left transition-all relative ${
              selectedSource === 'langfuse'
                ? 'bg-slate-900 border-slate-900 text-white shadow-xs'
                : 'bg-white border-slate-200 text-slate-800 hover:border-slate-300'
            }`}
          >
            {selectedSource === 'langfuse' && (
              <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-emerald-400" />
            )}
            <div className="font-bold text-sm">Langfuse</div>
            <div className={`text-[11px] mt-1 ${selectedSource === 'langfuse' ? 'text-slate-300' : 'text-slate-500'}`}>
              JSON / JSONL export
            </div>
          </button>

          {/* Helicone */}
          <button
            type="button"
            id="src-opt-helicone"
            onClick={() => setSelectedSource('helicone')}
            className={`p-3.5 rounded-xl border text-left transition-all relative ${
              selectedSource === 'helicone'
                ? 'bg-slate-900 border-slate-900 text-white shadow-xs'
                : 'bg-white border-slate-200 text-slate-800 hover:border-slate-300'
            }`}
          >
            {selectedSource === 'helicone' && (
              <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-emerald-400" />
            )}
            <div className="font-bold text-sm">Helicone</div>
            <div className={`text-[11px] mt-1 ${selectedSource === 'helicone' ? 'text-slate-300' : 'text-slate-500'}`}>
              Requests / payload JSON
            </div>
          </button>

          {/* OpenTelemetry */}
          <button
            type="button"
            id="src-opt-opentelemetry"
            onClick={() => setSelectedSource('opentelemetry')}
            className={`p-3.5 rounded-xl border text-left transition-all relative ${
              selectedSource === 'opentelemetry'
                ? 'bg-slate-900 border-slate-900 text-white shadow-xs'
                : 'bg-white border-slate-200 text-slate-800 hover:border-slate-300'
            }`}
          >
            {selectedSource === 'opentelemetry' && (
              <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-emerald-400" />
            )}
            <div className="font-bold text-sm">OpenTelemetry</div>
            <div className={`text-[11px] mt-1 ${selectedSource === 'opentelemetry' ? 'text-slate-300' : 'text-slate-500'}`}>
              GenAI semantic traces
            </div>
          </button>

          {/* Custom Logs */}
          <button
            type="button"
            id="src-opt-custom-logs"
            onClick={() => setSelectedSource('custom_logs')}
            className={`p-3.5 rounded-xl border text-left transition-all relative ${
              selectedSource === 'custom_logs'
                ? 'bg-slate-900 border-slate-900 text-white shadow-xs'
                : 'bg-white border-slate-200 text-slate-800 hover:border-slate-300'
            }`}
          >
            {selectedSource === 'custom_logs' && (
              <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-emerald-400" />
            )}
            <div className="font-bold text-sm">Custom Logs</div>
            <div className={`text-[11px] mt-1 ${selectedSource === 'custom_logs' ? 'text-slate-300' : 'text-slate-500'}`}>
              CSV, JSON, JSONL
            </div>
          </button>
        </div>
      </div>

      {/* Upload Zone & Drag-and-Drop */}
      <div
        id="drop-zone"
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        className={`p-8 sm:p-12 rounded-2xl border-2 border-dashed text-center transition-all bg-white ${
          dragActive
            ? 'border-emerald-500 bg-emerald-50/40'
            : 'border-slate-300 hover:border-slate-400'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          id="file-upload-input"
          accept=".csv,.json,.jsonl,.ndjson,.txt"
          onChange={handleFileInput}
          className="hidden"
        />

        <div className="w-12 h-12 rounded-xl bg-slate-100 text-slate-700 mx-auto flex items-center justify-center mb-4">
          <Upload className="w-6 h-6" />
        </div>

        <h3 className="text-base font-bold text-slate-900 mb-1">
          Drop your {selectedSource.replace('_', ' ')} export file here
        </h3>
        <p className="text-xs text-slate-500 max-w-sm mx-auto mb-5 leading-relaxed">
          Supports CSV (.csv), JSON array (.json), or newline JSON streams (.jsonl, .ndjson) up to 15MB.
          Raw prompts are stripped immediately in memory.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            type="button"
            id="btn-browse-file"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className="px-5 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors shadow-xs"
          >
            {isLoading ? 'Processing Ingestion...' : 'Browse File'}
          </button>

          <button
            type="button"
            id="btn-toggle-paste"
            onClick={() => setShowPasteBox(!showPasteBox)}
            className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50 transition-colors"
          >
            {showPasteBox ? 'Hide Paste Area' : 'Or Paste Raw Payload'}
          </button>
        </div>
      </div>

      {/* Collapsible Direct Paste Box */}
      {showPasteBox && (
        <form onSubmit={handlePasteSubmit} className="p-4 rounded-xl bg-white border border-slate-200 space-y-3 shadow-xs">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-600 block">
              Paste JSON, JSONL, NDJSON, or CSV lines directly:
            </label>
            <span className="text-[11px] text-slate-400 font-mono">Max 15MB</span>
          </div>
          <textarea
            id="input-paste-payload"
            value={pasteContent}
            onChange={(e) => setPasteContent(e.target.value)}
            rows={6}
            placeholder={`{"timestamp": "2026-09-15T12:00:00Z", "model": "gpt-4o", "input_tokens": 140, "output_tokens": 20, "cost": 0.00055, "trace_id": "tr_1"}`}
            className="w-full font-mono text-xs p-3 rounded-lg border border-slate-300 focus:ring-2 focus:ring-slate-900 focus:outline-hidden"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-500">
              Format is auto-detected across CSV, JSON array, JSONL, and NDJSON.
            </span>
            <button
              type="submit"
              id="btn-submit-pasted"
              disabled={isLoading || !pasteContent.trim()}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition-colors disabled:opacity-50"
            >
              Parse Ingestion
            </button>
          </div>
        </form>
      )}

      {/* Sample Dataset Alternative */}
      <div className="p-5 rounded-2xl bg-purple-50/70 border border-purple-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-purple-100 text-purple-700 flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-purple-950">Don&apos;t have an export handy right now?</h4>
            <p className="text-xs text-purple-800 mt-0.5 leading-relaxed">
              Explore the audit flow with 120 representative production calls exhibiting model right-sizing, retry storms, and cache loops.
            </p>
          </div>
        </div>
        <button
          type="button"
          id="btn-load-sample-connect"
          onClick={onLoadSample}
          disabled={isLoading}
          className="px-4 py-2.5 rounded-xl bg-purple-900 text-white text-xs font-bold hover:bg-purple-800 transition-colors shrink-0 flex items-center gap-1.5"
        >
          <span>Run Sample Audit</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Read-Only Privacy Safeguards */}
      <div className="p-4 rounded-xl bg-slate-100 border border-slate-200 text-slate-600 text-xs flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>
            <strong>Read-Only Verification Guarantee:</strong> AIDisCost never writes to your infrastructure,
            injects proxies, or stores raw completions.
          </span>
        </div>
        <span className="font-mono text-[10px] text-slate-500 uppercase hidden sm:block">RFC-9457 Compliant</span>
      </div>
    </div>
  );
};
