// EUrouter helpers for the settings UI (LBV2-30). Mirrors isEurouterBaseUrl in
// packages/core/src/adapters/eurouter.ts (web may not import core values).

export const EUROUTER_BASE_URL = 'https://api.eurouter.ai/api/v1';

/** A routing rule as returned by /api/config/eurouter/rules. */
export interface EurouterRule {
  id: string;
  name: string;
  model: string | null;
}

/** Model chip / status bar text: the route name for an EUrouter route, else the model, else "unconfigured". */
export function modelChipLabel(model: string, ruleId: string | undefined, ruleName: string | undefined): string {
  if (ruleId) return ruleName || 'EUrouter route';
  return model || 'unconfigured';
}

export function isEurouterUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.toLowerCase() === 'api.eurouter.ai';
  } catch {
    return false;
  }
}
