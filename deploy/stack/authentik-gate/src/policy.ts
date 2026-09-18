// What the gate lets the portal do in Authentik. The portal is not trusted with more than managing its
// own employees: every target is fetched from Authentik and checked here before any change.
export const ALLOWED_GROUP = /^(vault-v\d{2,3}|vault-firma-read|vault-firma-write|lokyy-users)$/;
/** Groups whose members are never touched, whatever else they carry */
const PRIVILEGED_GROUPS: ReadonlySet<string> = new Set(['authentik Admins', 'lokyy-admins']);
const RESERVED_USERNAMES: ReadonlySet<string> = new Set(['akadmin', 'admin', 'root', 'lokyy-portal']);

export const isAllowedGroup = (name: unknown): boolean => typeof name === 'string' && ALLOWED_GROUP.test(name);

export interface AuthentikUserLike {
  username?: unknown;
  type?: unknown;
  is_superuser?: unknown;
  attributes?: unknown;
  groups_obj?: unknown;
}

/** null = the portal may act on this user; otherwise the reason it may not. */
export function targetRefusal(u: AuthentikUserLike): 'not_managed' | 'privileged' | 'unknown_groups' | null {
  const attrs = (u.attributes && typeof u.attributes === 'object' ? u.attributes : {}) as Record<string, unknown>;
  if (u.is_superuser !== false) return 'privileged';
  if (typeof u.username !== 'string' || RESERVED_USERNAMES.has(u.username)) return 'privileged';
  if (u.type !== undefined && u.type !== 'internal' && u.type !== 'external') return 'privileged';
  if (!Array.isArray(u.groups_obj)) return 'unknown_groups';
  for (const g of u.groups_obj as { name?: unknown; is_superuser?: unknown }[]) {
    if (g?.is_superuser === true || PRIVILEGED_GROUPS.has(String(g?.name))) return 'privileged';
  }
  if (attrs['lokyy_managed'] !== true) return 'not_managed';
  return null;
}

// ------------------------------------------------------------------ input validation
type Result<T> = { ok: true; value: T } | { ok: false; field: string };
// C0/C1 control characters plus line/paragraph separators
const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`);
const USERNAME = /^[a-z][a-z0-9-]{1,30}$/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const SLOT = /^v\d{2,3}$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const okName = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 80 && !CONTROL.test(v);
const okEmail = (v: unknown) => typeof v === 'string' && v.length <= 254 && EMAIL.test(v);
const okGroups = (v: unknown) => Array.isArray(v) && v.length <= 10 && v.every(isAllowedGroup);
const extraKey = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).find((k) => !keys.includes(k));

export interface CreateInput { username: string; name: string; email: string; slot: string; groups: string[] }
export interface UpdateInput { name?: string; email?: string; isActive?: boolean; groups?: string[] }

export function validateCreate(v: unknown): Result<CreateInput> {
  if (!isObject(v)) return { ok: false, field: 'body' };
  const extra = extraKey(v, ['username', 'name', 'email', 'slot', 'groups']);
  if (extra) return { ok: false, field: extra };
  const u = v['username'];
  if (typeof u !== 'string' || !USERNAME.test(u) || u.includes('--') || u.endsWith('-') || RESERVED_USERNAMES.has(u)) return { ok: false, field: 'username' };
  if (!okName(v['name'])) return { ok: false, field: 'name' };
  if (!okEmail(v['email'])) return { ok: false, field: 'email' };
  if (typeof v['slot'] !== 'string' || !SLOT.test(v['slot'])) return { ok: false, field: 'slot' };
  if (!okGroups(v['groups'])) return { ok: false, field: 'groups' };
  return { ok: true, value: v as unknown as CreateInput };
}

export function validateUpdate(v: unknown): Result<UpdateInput> {
  if (!isObject(v) || Object.keys(v).length === 0) return { ok: false, field: 'body' };
  const extra = extraKey(v, ['name', 'email', 'isActive', 'groups']);
  if (extra) return { ok: false, field: extra };
  if ('name' in v && !okName(v['name'])) return { ok: false, field: 'name' };
  if ('email' in v && !okEmail(v['email'])) return { ok: false, field: 'email' };
  if ('isActive' in v && typeof v['isActive'] !== 'boolean') return { ok: false, field: 'isActive' };
  if ('groups' in v && !okGroups(v['groups'])) return { ok: false, field: 'groups' };
  return { ok: true, value: v as UpdateInput };
}
