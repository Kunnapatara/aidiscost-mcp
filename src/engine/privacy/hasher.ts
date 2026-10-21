/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fast deterministic string hash for prompt loop detection.
 * Never stores or returns raw prompt text.
 */
export async function computePromptHash(rawText?: string | null): Promise<string | undefined> {
  if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
    return undefined;
  }

  const normalized = rawText.trim().toLowerCase().replace(/\s+/g, ' ');

  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoder = new TextEncoder();
      const data = encoder.encode(normalized);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      return `ph_${hashHex.substring(0, 16)}`;
    }
  } catch {
    // Fallback if crypto.subtle is restricted
  }

  // Pure deterministic 64-bit FNV-1a hash fallback
  let h1 = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h1 ^= normalized.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, '0');
  return `ph_${hex}`;
}

/**
 * Synchronous prompt hash computation for bulk ingestion
 */
export function computePromptHashSync(rawText?: string | null): string | undefined {
  if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
    return undefined;
  }
  const normalized = rawText.trim().toLowerCase().replace(/\s+/g, ' ');
  let h1 = 0x811c9dc5;
  let h2 = 0x55555555;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ ch, 0x01000193);
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `ph_${part1}${part2}`.substring(0, 19);
}
