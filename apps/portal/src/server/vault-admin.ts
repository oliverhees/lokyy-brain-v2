// Vault LLM configuration through Traefik's internal entrypoint for the portal (bound to Traefik's address
// on the portal's internal network, allow-listed to the portal). Traefik routes only GET|PUT
// /<vault>/api/config and POST /<vault>/api/config/test to that vault, strips the prefix and injects the
// vault's proxy secret plus the fixed identity lokyy-portal in lokyy-admins, so the vault's guarded config
// API accepts the change. The portal holds no vault secret and is on no vault network. Every call is
// audited by the service.
import { EUROUTER_BASE_URL } from '../shared/validation.ts';
import type { FetchFn } from './authentik.ts';
import type { VaultAdmin, VaultLlmConfig } from './service.ts';

const VAULT_RE = /^(firma|v\d{2,3})$/;

export class HttpVaultAdmin implements VaultAdmin {
  readonly #base: string;
  readonly #fetch: FetchFn;

  constructor(baseUrl: string, fetchFn: FetchFn = fetch) {
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetchFn;
  }

  async configureLlm(vault: string, llm: VaultLlmConfig): Promise<void> {
    if (!VAULT_RE.test(vault)) throw new Error(`invalid vault name ${JSON.stringify(vault)}`);
    const res = await this.#fetch(`${this.#base}/${vault}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // Vault config API of LBV2-30: route only (ruleId sent as rule_id, ruleName for display), no model.
      // Note: the vault's shared probe limit (20/min per vault) only applies to /api/config/test and rules.
      body: JSON.stringify({ provider: 'openai', baseUrl: EUROUTER_BASE_URL, apiKey: llm.apiKey, ruleId: llm.ruleId, ...(llm.ruleName ? { ruleName: llm.ruleName } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    await res.text().catch(() => '');
    if (!res.ok) throw new Error(`vault ${vault}: config update refused (HTTP ${res.status})`);
  }
}
