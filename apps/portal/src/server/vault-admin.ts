// Vault LLM configuration through the internal Traefik entrypoint "portal-admin" (only Traefik and
// the portal are on that network). Traefik routes /<vault>/api/config to that vault, strips the
// prefix and injects the vault's proxy secret plus the lokyy-admins group, so the vault's guarded
// config API (requireConfigAdmin) accepts the change. The portal itself holds no vault secret and is
// on no vault network.
import { EUROUTER_BASE_URL } from '../shared/validation.ts';
import type { FetchFn } from './authentik.ts';
import type { VaultAdmin } from './service.ts';

const VAULT_RE = /^(firma|v\d{2,3})$/;

export class HttpVaultAdmin implements VaultAdmin {
  readonly #base: string;
  readonly #fetch: FetchFn;

  constructor(baseUrl: string, fetchFn: FetchFn = fetch) {
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetchFn;
  }

  async configureLlm(vault: string, llm: { apiKey: string; model: string }): Promise<void> {
    if (!VAULT_RE.test(vault)) throw new Error(`invalid vault name ${JSON.stringify(vault)}`);
    const res = await this.#fetch(`${this.#base}/${vault}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', baseUrl: EUROUTER_BASE_URL, model: llm.model, apiKey: llm.apiKey }),
      signal: AbortSignal.timeout(15_000),
    });
    await res.text().catch(() => '');
    if (!res.ok) throw new Error(`vault ${vault}: config update refused (HTTP ${res.status})`);
  }
}
