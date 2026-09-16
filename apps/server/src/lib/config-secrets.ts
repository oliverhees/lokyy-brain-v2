// Secrets in config.json never travel to the browser (ASVS V8.3.4).
// GET /api/config returns MASKED_SECRET in place of a stored secret; the web
// UI round-trips whatever it got, so PUT keeps the stored secret whenever the
// client sends the mask or omits the field.
import type { AtlasConfig } from '../config';

export const MASKED_SECRET = '********';

export type PublicConfig = Omit<AtlasConfig, 'googleTokens'> & { hasApiKey: boolean };

function mask(value: string | undefined): string | undefined {
  return value ? MASKED_SECRET : value;
}

export function maskConfig(config: AtlasConfig): PublicConfig {
  const { googleTokens: _tokens, ...rest } = config;
  const out: PublicConfig = { ...rest, apiKey: mask(config.apiKey) ?? '', hasApiKey: !!config.apiKey };
  if (config.braveApiKey !== undefined) out.braveApiKey = mask(config.braveApiKey);
  if (config.dailyBrief) {
    out.dailyBrief = { ...config.dailyBrief, smtp: { ...config.dailyBrief.smtp, pass: mask(config.dailyBrief.smtp.pass) ?? '' } };
  }
  return out;
}

/** Stored value when the incoming one is the mask or not a string (omitted). */
function keep(incoming: unknown, stored: string | undefined): string | undefined {
  return typeof incoming === 'string' && incoming !== MASKED_SECRET ? incoming : stored;
}

export function mergeSecrets(incoming: Record<string, unknown>, stored: AtlasConfig): AtlasConfig {
  const { hasApiKey: _has, ...body } = incoming;
  const merged = { ...body } as unknown as AtlasConfig;
  merged.apiKey = keep(body['apiKey'], stored.apiKey) ?? '';
  const brave = keep(body['braveApiKey'], stored.braveApiKey);
  if (brave !== undefined) merged.braveApiKey = brave;
  if (merged.googleTokens === undefined && stored.googleTokens) merged.googleTokens = stored.googleTokens;
  if (merged.dailyBrief?.smtp) {
    merged.dailyBrief = {
      ...merged.dailyBrief,
      smtp: { ...merged.dailyBrief.smtp, pass: keep(merged.dailyBrief.smtp.pass, stored.dailyBrief?.smtp.pass) ?? '' },
    };
  }
  return merged;
}

/** For POST /api/config/test: the UI sends the mask when the key was not re-entered. */
export function unmaskApiKey(apiKey: string | undefined, stored: AtlasConfig): string {
  if (apiKey === MASKED_SECRET) return stored.apiKey;
  return apiKey ?? '';
}
