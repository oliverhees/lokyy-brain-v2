// EUrouter helpers for the settings UI (LBV2-30). Mirrors isEurouterBaseUrl in
// packages/core/src/adapters/eurouter.ts (web may not import core values).

export const EUROUTER_BASE_URL = 'https://api.eurouter.ai/api/v1';

/** A routing rule as returned by /api/config/eurouter/rules. */
export interface EurouterRule {
  id: string;
  name: string;
  model: string | null;
}

export function isEurouterUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === 'api.eurouter.ai';
  } catch {
    return false;
  }
}
