// Input validation shared by the portal API and the UI. Functions return an error code (null = valid);
// the UI maps codes to German text (src/client/i18n/de.ts), the API returns them as field errors.

export type Role = 'reader' | 'writer';
export const ROLES: readonly Role[] = ['reader', 'writer'];

/** EUrouter API host. https://www.eurouter.ai/api/v1 is the website and answers 404. */
export const EUROUTER_BASE_URL = 'https://api.eurouter.ai/api/v1';

export type FieldErrors = Record<string, string>;

/**
 * Usernames name the MetaMCP account and endpoint (/metamcp/<username>/mcp) and the Authentik user.
 * Rule of deploy/metamcp/provision.mjs and deploy/coolify/gen-env.sh: 2–31 chars, ASCII a-z 0-9 "-",
 * starting with a letter, no "--", no trailing "-". This is a subset of packages/core isValidUsername.
 */
const USERNAME_CHARSET = /^[a-z0-9-]+$/;
const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'unknown', 'firma', 'auth', 'mcp', 'app', 'akadmin', 'admin', 'portal', 'www', 'root',
]);
/** Slot names (v01…) are host names too (v01.<domain>); a user must not shadow one. */
const SLOT_NAME = /^v\d{2,3}$/;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function validateUsername(value: unknown): string | null {
  const u = asString(value);
  if (u === null) return 'required';
  if (u.length < 2 || u.length > 31) return 'length';
  if (!USERNAME_CHARSET.test(u)) return 'charset';
  if (!/^[a-z]/.test(u)) return 'start';
  if (u.includes('--') || u.endsWith('-')) return 'dashes';
  if (RESERVED_USERNAMES.has(u) || SLOT_NAME.test(u)) return 'reserved';
  return null;
}

// Deliberately strict: ASCII local part without quotes or commas, domain with at least one dot.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function validateEmail(value: unknown): string | null {
  const e = asString(value);
  if (e === null) return 'required';
  if (e.length > 254) return 'length';
  return EMAIL.test(e) ? null : 'format';
}

// C0/C1 control characters, line and paragraph separators
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function validateText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return 'required';
  if (value.length > max) return 'length';
  return CONTROL.test(value) ? 'charset' : null;
}

export const validateDisplayName = (value: unknown): string | null => validateText(value, 80);
export const validateCompanyName = (value: unknown): string | null => validateText(value, 100);

export function validateRole(value: unknown): string | null {
  return ROLES.includes(value as Role) ? null : 'invalid';
}

export function validateEurouterKey(value: unknown): string | null {
  const k = asString(value);
  if (k === null) return 'required';
  if (k.length < 10 || k.length > 512) return 'length';
  return /^[\x21-\x7e]+$/.test(k) ? null : 'charset';
}

/** Model id as listed by EUrouter, e.g. "mistral/mistral-small-3.2" */
export function validateModel(value: unknown): string | null {
  const m = asString(value);
  if (m === null) return 'required';
  if (m.length > 200) return 'length';
  return /^[A-Za-z0-9._:/@-]+$/.test(m) ? null : 'charset';
}

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export interface SmtpInput {
  host: unknown;
  port: unknown;
  secure: unknown;
  username: unknown;
  password: unknown;
  from: unknown;
}

/** "Name <addr>" or a bare address; returns the address or null. */
export function fromAddress(from: string): string | null {
  const m = /^([^<>\r\n]{0,80})<([^<>\s]+)>$/.exec(from.trim());
  const addr = m ? m[2]! : from.trim();
  return validateEmail(addr) === null ? addr : null;
}

export function validateSmtp(input: SmtpInput): FieldErrors {
  const errors: FieldErrors = {};
  if (typeof input.host !== 'string' || !HOSTNAME.test(input.host)) errors['host'] = 'format';
  if (!Number.isInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65535) errors['port'] = 'range';
  if (typeof input.secure !== 'boolean') errors['secure'] = 'invalid';
  if (input.username !== undefined && (typeof input.username !== 'string' || input.username.length > 200 || CONTROL.test(input.username))) errors['username'] = 'invalid';
  if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 500 || CONTROL.test(input.password))) errors['password'] = 'invalid';
  if (typeof input.from !== 'string' || CONTROL.test(input.from) || fromAddress(input.from) === null) errors['from'] = 'format';
  return errors;
}

export interface InviteInput {
  username: unknown;
  email: unknown;
  displayName: unknown;
  role: unknown;
}

export function validateInvite(input: InviteInput): FieldErrors {
  const errors: FieldErrors = {};
  const checks: [keyof InviteInput, string | null][] = [
    ['username', validateUsername(input.username)],
    ['email', validateEmail(input.email)],
    ['displayName', validateDisplayName(input.displayName)],
    ['role', validateRole(input.role)],
  ];
  for (const [field, code] of checks) if (code) errors[field] = code;
  return errors;
}
