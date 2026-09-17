// Host allow-list for configured LLM / embeddings endpoints (LBV2-19).
//
// The LLM base URL comes from config (an admin in the UI, or the config file on
// disk) and every request to it carries the API key. Without a check an admin
// could point it at an internal address (SSRF from the vault) or at a host that
// collects the key.
//
// - Enforced in guarded mode (VAULT_PROXY_SECRET or VAULT_REQUIRE_PROXY_SECRET
//   set; the MCP process in the image only sees the latter) and whenever
//   VAULT_LLM_ALLOWED_HOSTS is set.
// - VAULT_LLM_ALLOWED_HOSTS: comma-separated `host` or `host:port` entries,
//   exact match, case-insensitive. A bare host allows only https on 443;
//   plain http needs `host:80`; `host:443` allows only https, `host:80` only
//   http, any other listed port (`ollama:11434`) both. Listed hosts may be private (e.g. a local Ollama) and may
//   use http; unlisted hosts/ports are never called. Unset/empty while enforced = no
//   outbound LLM calls at all (fail closed).
// - While enforced, redirects are handled manually and only followed within
//   the same origin; a redirect to any other origin is refused.
// - Local single-user mode without the variable: unchanged.

export const LLM_ALLOWED_HOSTS_ENV = 'VAULT_LLM_ALLOWED_HOSTS';
export const LLM_HOST_NOT_ALLOWED_ERROR = 'LLM endpoint not allowed';
const MAX_REDIRECTS = 5;

type Env = Record<string, string | undefined>;

export class LlmHostNotAllowedError extends Error {
  constructor() {
    super(LLM_HOST_NOT_ALLOWED_ERROR);
    this.name = 'LlmHostNotAllowedError';
  }
}

export type LlmHostPolicy =
  | { enforced: false }
  | { enforced: true; allowedHosts: ReadonlySet<string> };

function processEnv(): Env {
  const p = (globalThis as { process?: { env?: Env } }).process;
  return p?.env ?? {};
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

const HOST_CHARS = /^[a-z0-9._:-]+$/;

/** `host`, `host:port`, `[v6]`, `[v6]:port` or a bare IPv6 address → canonical entry; undefined when invalid. */
function parseEntry(raw: string): string | undefined {
  const entry = raw.trim().toLowerCase();
  let host: string;
  let port: string | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  const plain = /^([^:[\]]+)(?::(\d+))?$/.exec(entry);
  if (bracketed) { host = bracketed[1]!; port = bracketed[2]; }
  else if ((entry.match(/:/g) ?? []).length > 1) { host = entry; }
  else if (plain) { host = plain[1]!; port = plain[2]; }
  else return undefined;
  host = host.replace(/\.$/, '');
  if (!host || !HOST_CHARS.test(host)) return undefined;
  if (port === undefined) return host;
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return `${host.includes(':') ? `[${host}]` : host}:${n}`;
}

/** Guarded mode: the proxy secret guard is on (web server) or required (MCP process in the image). */
export function isVaultGuarded(env: Env = processEnv()): boolean {
  return !!env['VAULT_PROXY_SECRET'] || !!env['VAULT_REQUIRE_PROXY_SECRET'];
}

function rawEntries(env: Env): string[] {
  return (env[LLM_ALLOWED_HOSTS_ENV] ?? '').split(',').map((e) => e.trim()).filter((e) => e.length > 0);
}

export function readLlmHostPolicy(env: Env = processEnv()): LlmHostPolicy {
  const entries = rawEntries(env);
  if (!isVaultGuarded(env) && entries.length === 0) return { enforced: false };
  const allowedHosts = new Set(entries.map(parseEntry).filter((e): e is string => e !== undefined));
  return { enforced: true, allowedHosts };
}

/** Startup log (web server and MCP): fail closed must be loud, not silent. */
export function logLlmHostPolicy(
  env: Env = processEnv(),
  logger: { warn: (msg: string) => void; info: (msg: string) => void } = { warn: console.warn, info: console.log },
): void {
  const policy = readLlmHostPolicy(env);
  if (!policy.enforced) {
    logger.info('[llm-host-policy] LLM host allowlist not configured; all LLM hosts allowed (unguarded mode)');
    return;
  }
  const invalid = rawEntries(env).filter((e) => parseEntry(e) === undefined);
  if (invalid.length > 0) logger.warn(`[llm-host-policy] ${LLM_ALLOWED_HOSTS_ENV}: ignored invalid entries: ${invalid.join(', ')}`);
  if (policy.allowedHosts.size === 0) {
    logger.warn(`[llm-host-policy] ${LLM_ALLOWED_HOSTS_ENV} is not set: all outbound LLM and embeddings calls are refused`);
    return;
  }
  logger.info(`[llm-host-policy] LLM endpoints limited to: ${[...policy.allowedHosts].join(', ')}`);
}

function hostAllowed(url: URL, policy: LlmHostPolicy & { enforced: true }): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = normalizeHost(url.hostname);
  const https = url.protocol === 'https:';
  // URL drops the scheme's default port, so url.port === '' means 443 (https) or 80 (http).
  const port = url.port || (https ? '443' : '80');
  // A bare host means https on 443 only: the API key must not travel in plaintext.
  if (https && port === '443' && policy.allowedHosts.has(host)) return true;
  if (!policy.allowedHosts.has(`${host.includes(':') ? `[${host}]` : host}:${port}`)) return false;
  // Explicit well-known ports keep their scheme: host:443 → https only, host:80 → http only.
  if (port === '443') return https;
  if (port === '80') return !https;
  return true;
}

function parseUrl(url: string): URL | undefined {
  try { return new URL(url); } catch { return undefined; }
}

export function isLlmUrlAllowed(url: string, env: Env = processEnv()): boolean {
  const policy = readLlmHostPolicy(env);
  if (!policy.enforced) return true;
  const parsed = parseUrl(url);
  return !!parsed && hostAllowed(parsed, policy);
}

function refuse(url: string, reason: string): never {
  const host = parseUrl(url)?.host ?? '<invalid url>';
  console.warn(`[llm-host-policy] refused ${reason} to ${host}: host or port not allowed by ${LLM_ALLOWED_HOSTS_ENV}`);
  throw new LlmHostNotAllowedError();
}

/** Same generic client error, but the log names the real cause. */
function refuseRedirectChain(url: string): never {
  const host = parseUrl(url)?.host ?? '<invalid url>';
  console.warn(`[llm-host-policy] refused request to ${host}: too many redirects (max ${MAX_REDIRECTS})`);
  throw new LlmHostNotAllowedError();
}

export function assertLlmUrlAllowed(url: string, env: Env = processEnv()): void {
  if (!isLlmUrlAllowed(url, env)) refuse(url, 'request');
}

const PROVIDER_DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com',
  deepseek: 'https://api.deepseek.com',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://localhost:11434',
};

/** The URL a provider actually calls: the configured baseUrl, or the adapter default. */
export function effectiveLlmBaseUrl(provider: string, baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? '').trim();
  return trimmed || PROVIDER_DEFAULT_BASE_URLS[provider] || PROVIDER_DEFAULT_BASE_URLS['openai']!;
}

/** Splits fetch input into URL + init; a Request's method, headers, body and signal are kept (init wins). */
async function splitInput(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Promise<[string, RequestInit]> {
  if (typeof input === 'string') return [input, { ...init }];
  if (input instanceof URL) return [input.toString(), { ...init }];
  const fromRequest: RequestInit = { method: input.method, headers: input.headers, signal: input.signal };
  if (input.body !== null && init?.body === undefined) fromRequest.body = await input.arrayBuffer();
  return [input.url, { ...fromRequest, ...init }];
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Wraps a fetch for requests to a configured LLM endpoint. The policy is read
 * on every call (env may change at runtime and in tests). Not enforced →
 * the call passes through unchanged.
 */
export function guardLlmFetch(fetchImpl: typeof fetch, env?: Env): typeof fetch {
  return async (input, init) => {
    const policy = readLlmHostPolicy(env ?? processEnv());
    if (!policy.enforced) return fetchImpl(input, init);

    const first = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const origin = parseUrl(first);
    if (!origin || !hostAllowed(origin, policy)) refuse(first, 'request');

    let [url, currentInit] = await splitInput(input, init);
    currentInit = { ...currentInit, redirect: 'manual' };
    for (let hop = 0; ; hop++) {
      const response = await fetchImpl(url, currentInit);
      if (response.type === 'opaqueredirect') refuse(url, 'redirect');
      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;

      const target = parseUrl(new URL(location, url).toString());
      if (!target || target.origin !== origin.origin) refuse(target?.toString() ?? location, 'redirect');
      if (hop >= MAX_REDIRECTS) refuseRedirectChain(url);
      await response.body?.cancel().catch(() => undefined);

      const method = (currentInit.method ?? 'GET').toUpperCase();
      const keepsBody = response.status === 307 || response.status === 308;
      if (!keepsBody && method !== 'GET' && method !== 'HEAD') {
        const { body: _body, ...rest } = currentInit;
        currentInit = { ...rest, method: 'GET' };
      }
      url = target.toString();
    }
  };
}
