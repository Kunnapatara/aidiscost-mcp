/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Authoritative whitelist of known, safe standardized canonical error tokens.
 * sanitizeErrorCode() is strictly prohibited from returning any string not present in this set.
 */
export const CANONICAL_ERROR_CODES = new Set([
  'ERR_GENERATION',
  'RATE_LIMITED',
  'TIMEOUT',
  'HTTP_429',
  'HTTP_400',
  'HTTP_401',
  'HTTP_403',
  'HTTP_404',
  'HTTP_408',
  'HTTP_500',
  'HTTP_502',
  'HTTP_503',
  'HTTP_504',
  'HTTP_4XX',
  'HTTP_5XX',
  'SPAN_ERROR',
  'CUSTOM_ERROR',
  'QUOTA_EXCEEDED',
  'CONTEXT_LENGTH_EXCEEDED',
  'CONTENT_FILTER',
  'MODEL_NOT_FOUND',
  'AUTH_ERROR',
  'CONNECTION_ERROR',
]);

/**
 * Sanitizes arbitrary error messages, exception strings, and status messages at the normalization boundary.
 *
 * Guarantees:
 * 1. Output is ALWAYS a canonical error code from CANONICAL_ERROR_CODES or undefined.
 * 2. Arbitrary strings, user prompts, PII, and identifiers (e.g. john_doe, request_abc123) are NEVER returned.
 * 3. Classifiable error indicators (timeouts, rate limits, quotas, permissions, 5xx) are mapped to canonical codes.
 * 4. Unclassifiable errors strictly fall back to 'ERR_GENERATION'.
 */
export function sanitizeErrorCode(
  rawStatusOrMessage: string | undefined,
  rawErrorToken: unknown,
  statusCode?: number | string
): string | undefined {
  const numStatus = Number(statusCode);

  // 1. Direct HTTP Status Code checks mapped to canonical tokens
  if (numStatus === 429) return 'HTTP_429';
  if (numStatus === 408) return 'TIMEOUT';
  if (numStatus === 401 || numStatus === 403) return 'AUTH_ERROR';
  if (numStatus === 400) return 'HTTP_400';
  if (numStatus === 404) return 'HTTP_404';
  if (numStatus === 500) return 'HTTP_500';
  if (numStatus === 502) return 'HTTP_502';
  if (numStatus === 503) return 'HTTP_503';
  if (numStatus === 504) return 'HTTP_504';
  if (numStatus >= 500 && numStatus < 600) return 'HTTP_5XX';
  if (numStatus >= 400 && numStatus < 500) return 'HTTP_4XX';

  // 2. Inspect raw error token / code / message if supplied
  const rawStr = String(rawErrorToken || rawStatusOrMessage || '').trim();
  if (!rawStr) return undefined;

  // Ignore benign non-error statuses
  const lower = rawStr.toLowerCase();
  if (lower === 'ok' || lower === 'success' || lower === 'unset' || lower === '200') {
    return undefined;
  }

  // 3. Exact match with canonical whitelist (e.g. RATE_LIMITED, TIMEOUT, etc.)
  const upper = rawStr.toUpperCase().replace(/-/g, '_');
  if (CANONICAL_ERROR_CODES.has(upper)) {
    return upper;
  }

  // 4. Normalized keyword classification across token or message
  // Replace underscores and hyphens with spaces to handle both snake_case, kebab-case, and natural language
  const normalizedText = ` ${lower.replace(/[_-]+/g, ' ')} `;

  // Rate limit / throttling
  if (
    normalizedText.includes(' 429 ') ||
    normalizedText.includes('rate limit') ||
    normalizedText.includes('ratelimit') ||
    normalizedText.includes('too many requests') ||
    normalizedText.includes('throttl') ||
    normalizedText.includes('tpm limit') ||
    normalizedText.includes('rpm limit')
  ) {
    return 'RATE_LIMITED';
  }

  // Timeout / deadline
  if (
    normalizedText.includes(' 408 ') ||
    normalizedText.includes('timeout') ||
    normalizedText.includes('timed out') ||
    normalizedText.includes('deadline exceeded') ||
    normalizedText.includes('gateway timeout') ||
    normalizedText.includes('request timeout')
  ) {
    return 'TIMEOUT';
  }

  // Quota / billing
  if (
    normalizedText.includes('quota') ||
    normalizedText.includes('insufficient balance') ||
    normalizedText.includes('billing') ||
    normalizedText.includes('credit limit')
  ) {
    return 'QUOTA_EXCEEDED';
  }

  // Context length / max tokens
  if (
    normalizedText.includes('context length') ||
    normalizedText.includes('maximum context') ||
    normalizedText.includes('max tokens') ||
    normalizedText.includes('token limit') ||
    normalizedText.includes('prompt is too long') ||
    normalizedText.includes('context window')
  ) {
    return 'CONTEXT_LENGTH_EXCEEDED';
  }

  // Content safety / moderation filter
  if (
    normalizedText.includes('content filter') ||
    normalizedText.includes('safety') ||
    normalizedText.includes('moderation') ||
    normalizedText.includes('content management policy') ||
    normalizedText.includes('harmful content') ||
    normalizedText.includes('policy violation')
  ) {
    return 'CONTENT_FILTER';
  }

  // Auth / permissions
  if (
    normalizedText.includes('unauthorized') ||
    normalizedText.includes('api key') ||
    normalizedText.includes('permission denied') ||
    normalizedText.includes('access denied') ||
    normalizedText.includes('forbidden') ||
    normalizedText.includes('authentication') ||
    normalizedText.includes('unauthenticated') ||
    normalizedText.includes('invalid key')
  ) {
    return 'AUTH_ERROR';
  }

  // Server error / 5xx
  if (
    normalizedText.includes(' 500 ') ||
    normalizedText.includes(' 502 ') ||
    normalizedText.includes(' 503 ') ||
    normalizedText.includes(' 504 ') ||
    normalizedText.includes('internal server') ||
    normalizedText.includes('bad gateway') ||
    normalizedText.includes('service unavailable') ||
    normalizedText.includes('server error')
  ) {
    return 'HTTP_5XX';
  }

  // Connection / network failure
  if (
    normalizedText.includes('connection reset') ||
    normalizedText.includes('econnreset') ||
    normalizedText.includes('connection error') ||
    normalizedText.includes('network error') ||
    normalizedText.includes('socket hang up') ||
    normalizedText.includes('connection refused') ||
    normalizedText.includes('econnrefused') ||
    normalizedText.includes('fetch failed')
  ) {
    return 'CONNECTION_ERROR';
  }

  // Model not found
  if (
    normalizedText.includes('model not found') ||
    normalizedText.includes('does not exist') ||
    normalizedText.includes('no such model')
  ) {
    return 'MODEL_NOT_FOUND';
  }

  // 5. Unknown identifiers or unclassifiable messages:
  // Strictly return 'ERR_GENERATION' - never return arbitrary input strings or identifiers
  return 'ERR_GENERATION';
}
