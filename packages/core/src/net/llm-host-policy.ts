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
// - VAULT_LLM_ALLOWED_HOSTS: comma-separated host names, exact match, case-
//   insensitive. Listed hosts may be private (e.g. a local Ollama) and may use
//   http; unlisted hosts are never called. Unset/empty while enforced = no
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

export function readLlmHostPolicy(env: Env = processEnv()): LlmHostPolicy {
  const raw = env[LLM_ALLOWED_HOSTS_ENV] ?? '';
  const guarded = !!env['VAULT_PROXY_SECRET'] || !!env['VAULT_REQUIRE_PROXY_SECRET'];
  if (!guarded && raw.trim() === '') return { enforced: false };
  const allowedHosts = new Set(raw.split(',').map(normalizeHost).filter((h) => h.length > 0));
  return { enforced: true, allowedHosts };
}

function hostAllowed(url: URL, policy: LlmHostPolicy & { enforced: true }): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return policy.allowedHosts.has(normalizeHost(url.hostname));
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
  console.warn(`[llm-host-policy] refused ${reason} to ${host}: not in ${LLM_ALLOWED_HOSTS_ENV}`);
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

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
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

    let url = requestUrl(input);
    const origin = parseUrl(url);
    if (!origin || !hostAllowed(origin, policy)) refuse(url, 'request');

    let currentInit: RequestInit = { ...init, redirect: 'manual' };
    for (let hop = 0; ; hop++) {
      const response = await fetchImpl(url, currentInit);
      if (response.type === 'opaqueredirect') refuse(url, 'redirect');
      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;

      const target = parseUrl(new URL(location, url).toString());
      if (!target || target.origin !== origin.origin) refuse(target?.toString() ?? location, 'redirect');
      if (hop >= MAX_REDIRECTS) refuse(url, 'redirect chain');
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
