// Authentik admin API adapter (API token = AUTHENTIK_BOOTSTRAP_TOKEN of the stack).
// Invitation model: the portal creates the user with its groups up front and hands out a recovery
// link of the brand's recovery flow (portal blueprint: lokyy-set-password), where the user sets their
// own password. Authentik's invitation + enrollment flow cannot assign groups from invitation data
// (user_write discards "groups", checked in 2026.8.2), so a user created that way would have no access.
import type { Role } from '../shared/validation.ts';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Group names owned by the portal; every other group of a user (e.g. lokyy-admins) is left alone. */
const MANAGED_GROUP = /^vault-/;
/** Users the portal created carry these attributes; it never touches any other account. */
const PATH = 'lokyy';

export function managedGroupsFor(slot: string, role: Role): string[] {
  return [`vault-${slot}`, role === 'writer' ? 'vault-firma-write' : 'vault-firma-read'];
}

export type AuthentikErrorCode = 'http' | 'username_taken' | 'group_missing' | 'no_recovery_flow' | 'unreachable';

export class AuthentikError extends Error {
  readonly code: AuthentikErrorCode;
  readonly status: number | null;
  constructor(code: AuthentikErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'AuthentikError';
    this.code = code;
    this.status = status;
  }
}

export interface AuthentikUser {
  pk: number;
  username: string;
  isActive: boolean;
  attributes: Record<string, unknown>;
  groups: { pk: string; name: string }[];
}

interface RawUser {
  pk: number;
  username: string;
  is_active: boolean;
  attributes?: Record<string, unknown>;
  groups?: string[];
  groups_obj?: { pk: string; name: string }[] | null;
}

const toUser = (u: RawUser): AuthentikUser => ({
  pk: u.pk, username: u.username, isActive: u.is_active, attributes: u.attributes ?? {}, groups: u.groups_obj ?? [],
});

export interface AuthentikOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

export interface EnsureUserInput {
  username: string;
  name: string;
  email: string;
  slot: string;
  groups: string[];
}

export class AuthentikClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: FetchFn;
  readonly #timeoutMs: number;
  readonly #groupPks = new Map<string, string>();

  constructor(opts: AuthentikOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, '');
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async #call<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; data: T }> {
    const url = new URL(`${this.#base}/api/v3${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: { authorization: `Bearer ${this.#token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new AuthentikError('unreachable', `Authentik ${method} ${path}: ${(e as Error).name}`);
    }
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok && res.status !== 404) {
      // Response bodies can echo request data; only field names of validation errors are reported.
      const fields = data && typeof data === 'object' ? Object.keys(data).join(',') : '';
      const err = new AuthentikError('http', `Authentik ${method} ${path}: HTTP ${res.status}${fields ? ` (${fields})` : ''}`, res.status);
      if (res.status === 400 && JSON.stringify(data).includes('No recovery flow')) {
        throw new AuthentikError('no_recovery_flow', 'Authentik brand has no recovery flow (portal blueprint not applied?)', 400);
      }
      throw err;
    }
    return { status: res.status, data: data as T };
  }

  async findUser(username: string): Promise<AuthentikUser | null> {
    const { data } = await this.#call<{ results: RawUser[] }>('GET', '/core/users/', undefined, { username });
    const hit = (data?.results ?? []).find((u) => u.username === username);
    return hit ? toUser(hit) : null;
  }

  async getUser(pk: number): Promise<AuthentikUser | null> {
    const { status, data } = await this.#call<RawUser>('GET', `/core/users/${pk}/`);
    return status === 404 ? null : toUser(data);
  }

  async #groupPk(name: string): Promise<string> {
    const cached = this.#groupPks.get(name);
    if (cached) return cached;
    const { data } = await this.#call<{ results: { pk: string; name: string }[] }>('GET', '/core/groups/', undefined, { name });
    const hit = (data?.results ?? []).find((g) => g.name === name);
    if (!hit) throw new AuthentikError('group_missing', `Authentik group ${name} does not exist (blueprint not applied?)`);
    this.#groupPks.set(name, hit.pk);
    return hit.pk;
  }

  static isPortalUser(u: AuthentikUser, slot: string): boolean {
    return u.attributes['lokyy_managed'] === true && u.attributes['lokyy_slot'] === slot;
  }

  /** Creates or updates the portal user of a slot; returns its pk. Never adopts a foreign account. */
  async ensureUser(input: EnsureUserInput): Promise<number> {
    const desired = await Promise.all(input.groups.map((g) => this.#groupPk(g)));
    const existing = await this.findUser(input.username);
    if (existing) {
      if (!AuthentikClient.isPortalUser(existing, input.slot)) {
        throw new AuthentikError('username_taken', `Authentik user ${input.username} exists and is not the portal user of ${input.slot}`);
      }
      await this.#call('PATCH', `/core/users/${existing.pk}/`, { name: input.name, email: input.email });
      await this.#applyGroups(existing, desired);
      return existing.pk;
    }
    const { data } = await this.#call<RawUser>('POST', '/core/users/', {
      username: input.username, name: input.name, email: input.email, is_active: true, path: PATH,
      attributes: { lokyy_managed: true, lokyy_slot: input.slot }, groups: desired,
    });
    return data.pk;
  }

  async #applyGroups(user: AuthentikUser, desiredPks: string[]): Promise<void> {
    const keep = user.groups.filter((g) => !MANAGED_GROUP.test(g.name)).map((g) => g.pk);
    await this.#call('PATCH', `/core/users/${user.pk}/`, { groups: [...new Set([...keep, ...desiredPks])] });
  }

  /** Replaces the portal-managed (vault-*) groups of a user; other groups stay. */
  async setGroups(pk: number, groups: string[]): Promise<void> {
    const user = await this.getUser(pk);
    if (!user) throw new AuthentikError('http', `Authentik user ${pk} not found`, 404);
    await this.#applyGroups(user, await Promise.all(groups.map((g) => this.#groupPk(g))));
  }

  async setActive(pk: number, active: boolean): Promise<void> {
    await this.#call('PATCH', `/core/users/${pk}/`, { is_active: active });
  }

  /** One-time link to the brand's recovery flow; the user sets their own password there. */
  async inviteLink(pk: number, tokenDuration: string): Promise<string> {
    const { data } = await this.#call<{ link: string }>('POST', `/core/users/${pk}/recovery/`, { token_duration: tokenDuration });
    if (!data?.link || !/^https?:\/\//.test(data.link)) throw new AuthentikError('http', 'Authentik returned no recovery link');
    return data.link;
  }

  /** Ends all Authentik sessions of a user (forward-auth cookies stop working). */
  async endSessions(username: string): Promise<void> {
    const { data } = await this.#call<{ results: { uuid: string }[] }>('GET', '/core/authenticated_sessions/', undefined, { user__username: username });
    for (const s of data?.results ?? []) await this.#call('DELETE', `/core/authenticated_sessions/${s.uuid}/`);
  }

  async deleteUser(pk: number): Promise<void> {
    await this.#call('DELETE', `/core/users/${pk}/`);
  }
}
