// Client of the authentik-gate (deploy/stack/authentik-gate): the portal holds no Authentik token. The
// gate alone holds it and only lets the portal manage its own employees (lokyy_managed, never superusers,
// "authentik Admins" or lokyy-admins members, groups from an allowlist, no password endpoint).
// Invitation model: the portal creates the user with its groups up front and hands out a recovery link of
// the brand's recovery flow (portal blueprint: lokyy-set-password), where the user sets their own
// password. Authentik's invitation + enrollment flow cannot assign groups from invitation data
// (user_write discards "groups", checked in 2026.8.2), so a user created that way would have no access.
import type { Role } from '../shared/validation.ts';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Admits a user to the portal (forward-auth of app.<domain> is bound to it). */
export const USERS_GROUP = 'lokyy-users';

export function managedGroupsFor(slot: string, role: Role): string[] {
  return [`vault-${slot}`, role === 'writer' ? 'vault-firma-write' : 'vault-firma-read', USERS_GROUP];
}

export type AuthentikErrorCode = 'http' | 'username_taken' | 'group_missing' | 'no_recovery_flow' | 'forbidden' | 'unreachable';

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

export interface GateUser {
  pk: number;
  username: string;
  slot: string | null;
  isActive: boolean;
  groups: string[];
}

export interface GateClientOptions {
  /** http://authentik-gate:8080 on the internal portal↔gate network */
  gateUrl: string;
  /** Public Authentik URL (https://auth.<domain>): links Authentik builds from its internal host are rewritten to it */
  publicUrl?: string;
  /** Shared bearer secret (AUTHENTIK_GATE_SECRET) */
  secret: string;
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

const GATE_ERRORS: Record<number, AuthentikErrorCode> = { 403: 'forbidden', 409: 'username_taken', 422: 'group_missing', 424: 'no_recovery_flow' };

export class AuthentikGateClient {
  readonly #base: string;
  readonly #public: string | null;
  readonly #secret: string;
  readonly #fetch: FetchFn;
  readonly #timeoutMs: number;

  constructor(opts: GateClientOptions) {
    this.#base = opts.gateUrl.replace(/\/+$/, '');
    this.#public = opts.publicUrl ? opts.publicUrl.replace(/\/+$/, '') : null;
    this.#secret = opts.secret;
    this.#fetch = opts.fetch ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /** 404 is returned to the caller (some operations accept it); every other failure throws. */
  async #call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.#secret}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new AuthentikError('unreachable', `authentik-gate ${method} ${path}: ${(e as Error).name}`);
    }
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok && res.status !== 404) {
      const error = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : '';
      throw new AuthentikError(GATE_ERRORS[res.status] ?? 'http', `authentik-gate ${method} ${path}: HTTP ${res.status}${error ? ` (${error})` : ''}`, res.status);
    }
    return { status: res.status, data: data as T };
  }

  /** Creates or updates the portal user of a slot; returns its pk. Never adopts a foreign account. */
  async ensureUser(input: EnsureUserInput): Promise<number> {
    const { data: found } = await this.#call<{ status: 'absent' | 'managed' | 'foreign'; user?: GateUser }>('POST', '/v1/users/lookup', { username: input.username });
    if (found.status === 'foreign' || (found.status === 'managed' && found.user?.slot !== input.slot)) {
      throw new AuthentikError('username_taken', `Authentik user ${input.username} exists and is not the portal user of ${input.slot}`);
    }
    if (found.status === 'managed' && found.user) {
      await this.#must('PATCH', `/v1/users/${found.user.pk}`, { name: input.name, email: input.email, groups: input.groups });
      return found.user.pk;
    }
    const { data } = await this.#call<{ user: GateUser }>('POST', '/v1/users', input);
    return data.user.pk;
  }

  async #must(method: string, path: string, body?: unknown): Promise<void> {
    const { status } = await this.#call(method, path, body);
    if (status === 404) throw new AuthentikError('http', `authentik-gate ${method} ${path}: user not found`, 404);
  }

  /** Replaces the portal-managed groups (vault-*, lokyy-users) of a user; the gate leaves other groups alone. */
  async setGroups(pk: number, groups: string[]): Promise<void> {
    await this.#must('PATCH', `/v1/users/${pk}`, { groups });
  }

  async setActive(pk: number, active: boolean): Promise<void> {
    await this.#must('PATCH', `/v1/users/${pk}`, { isActive: active });
  }

  /** One-time link to the brand's recovery flow; the user sets their own password there. */
  async inviteLink(pk: number, tokenDuration: string): Promise<string> {
    const { status, data } = await this.#call<{ link?: string }>('POST', `/v1/users/${pk}/recovery`, { tokenDuration });
    if (status === 404 || typeof data?.link !== 'string' || !/^https?:\/\//.test(data.link)) throw new AuthentikError('http', 'authentik-gate returned no recovery link');
    if (!this.#public) return data.link;
    const u = new URL(data.link);
    return `${this.#public}${u.pathname}${u.search}`;
  }

  /** Ends all Authentik sessions of a user (forward-auth cookies stop working); a missing user has none. */
  async endSessions(pk: number): Promise<void> {
    await this.#call('DELETE', `/v1/users/${pk}/sessions`);
  }

  /** Deleting a user that is already gone is not an error. */
  async deleteUser(pk: number): Promise<void> {
    await this.#call('DELETE', `/v1/users/${pk}`);
  }
}
