// Secrets in config.json never travel to the browser (ASVS V8.3.4).
// GET /api/config returns MASKED_SECRET in place of a stored secret; the web
// UI round-trips whatever it got, so PUT keeps the stored secret whenever the
// client sends the mask or omits the field — but only while the secret keeps
// going to the same destination. Pointing a kept secret at a new provider,
// endpoint or SMTP host would let anyone with UI access exfiltrate it, so that
// requires re-entering the secret (KeyReentryError → 400).
import type { AtlasConfig } from '../config';

export const MASKED_SECRET = '********';

export type PublicConfig = Omit<AtlasConfig, 'googleTokens'> & { hasApiKey: boolean };

export class KeyReentryError extends Error {
  constructor(what = 'API key') { super(`Re-enter the ${what} when changing provider or endpoint`); }
}

const SECRET_QUERY_PARAM = /key|token|secret|pass|auth|sig|credential/i;

function mask(value: string | undefined): string | undefined {
  return value ? MASKED_SECRET : value;
}

/** Hides URL userinfo and secret-looking query parameter values. Non-URLs pass unchanged. */
export function maskUrlCredentials(url: string): string {
  if (!url) return url;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return url; }
  let changed = false;
  if (parsed.username) { parsed.username = MASKED_SECRET; changed = true; }
  if (parsed.password) { parsed.password = MASKED_SECRET; changed = true; }
  for (const name of [...new Set(parsed.searchParams.keys())]) {
    if (SECRET_QUERY_PARAM.test(name)) { parsed.searchParams.set(name, MASKED_SECRET); changed = true; }
  }
  if (!changed) return url;
  // URLSearchParams percent-encodes '*'; keep the mask readable.
  return parsed.toString().replaceAll('%2A', '*');
}

export function maskConfig(config: AtlasConfig): PublicConfig {
  const { googleTokens: _tokens, ...rest } = config;
  const out: PublicConfig = {
    ...rest,
    apiKey: mask(config.apiKey) ?? '',
    hasApiKey: !!config.apiKey,
    baseUrl: maskUrlCredentials(config.baseUrl ?? ''),
  };
  if (config.braveApiKey !== undefined) out.braveApiKey = mask(config.braveApiKey);
  if (config.dailyBrief) {
    out.dailyBrief = { ...config.dailyBrief, smtp: { ...config.dailyBrief.smtp, pass: mask(config.dailyBrief.smtp.pass) ?? '' } };
  }
  return out;
}

function normalizeEndpoint(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '');
}

/** True when the incoming value asks to keep the stored secret (mask or not a string). */
function wantsStored(incoming: unknown): boolean {
  return typeof incoming !== 'string' || incoming === MASKED_SECRET;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The client echoes back the masked baseUrl; map it to the stored one. */
function resolveBaseUrl(incoming: unknown, stored: string): string {
  if (typeof incoming !== 'string') return stored;
  if (stored && incoming === maskUrlCredentials(stored) && incoming !== stored) return stored;
  return incoming;
}

/**
 * Builds the config to persist from a PUT body: the body is merged onto the
 * stored config (known sections deeply), googleTokens are never taken from
 * the client, and secrets are kept or replaced per the rules above.
 */
export function mergeSecrets(incoming: Record<string, unknown>, stored: AtlasConfig): AtlasConfig {
  const { hasApiKey: _has, googleTokens: _clientTokens, ...body } = incoming;
  const merged = { ...stored, ...body } as unknown as AtlasConfig;

  if (isRecord(body['rss']) && stored.rss) merged.rss = { ...stored.rss, ...body['rss'] } as AtlasConfig['rss'];
  if (isRecord(body['srs']) && stored.srs) merged.srs = { ...stored.srs, ...body['srs'] } as AtlasConfig['srs'];

  merged.baseUrl = resolveBaseUrl(body['baseUrl'], stored.baseUrl ?? '');

  if (wantsStored(body['apiKey'])) {
    const sameDestination = merged.provider === stored.provider
      && normalizeEndpoint(merged.baseUrl) === normalizeEndpoint(stored.baseUrl);
    if (stored.apiKey && !sameDestination) throw new KeyReentryError();
    merged.apiKey = stored.apiKey ?? '';
  }

  if (wantsStored(body['braveApiKey'])) {
    if (stored.braveApiKey !== undefined) merged.braveApiKey = stored.braveApiKey;
    else delete merged.braveApiKey;
  }

  if (isRecord(body['dailyBrief'])) {
    const inBrief = body['dailyBrief'];
    const storedBrief = stored.dailyBrief;
    const inSmtp = isRecord(inBrief['smtp']) ? inBrief['smtp'] : {};
    const smtp = { ...(storedBrief?.smtp ?? {}), ...inSmtp } as NonNullable<AtlasConfig['dailyBrief']>['smtp'];
    if (wantsStored(inSmtp['pass'])) {
      const storedPass = storedBrief?.smtp.pass ?? '';
      if (storedPass && (smtp.host ?? '').trim().toLowerCase() !== (storedBrief?.smtp.host ?? '').trim().toLowerCase()) {
        throw new KeyReentryError('SMTP password');
      }
      smtp.pass = storedPass;
    }
    merged.dailyBrief = { ...(storedBrief ?? {}), ...inBrief, smtp } as AtlasConfig['dailyBrief'];
  }

  if (stored.googleTokens) merged.googleTokens = stored.googleTokens;
  else delete merged.googleTokens;
  return merged;
}

/** For POST /api/config/test: the mask resolves to the stored key only for the stored provider and endpoint. */
export function unmaskApiKey(
  req: { apiKey?: string; provider?: string; baseUrl?: string },
  stored: AtlasConfig,
): string {
  if (req.apiKey !== MASKED_SECRET) return req.apiKey ?? '';
  const baseUrl = resolveBaseUrl(req.baseUrl ?? '', stored.baseUrl ?? '');
  if (req.provider !== stored.provider || normalizeEndpoint(baseUrl) !== normalizeEndpoint(stored.baseUrl)) {
    throw new KeyReentryError();
  }
  return stored.apiKey;
}
