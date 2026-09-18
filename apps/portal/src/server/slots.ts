// Vault slots (v01…vNN) are deployed up front; the portal assigns one per employee.
import type { Role } from '../shared/validation.ts';
import type { PortalState } from './state.ts';

export const COMPANY_VAULT = 'firma';
const SLOT_RE = /^v\d{2,3}$/;

/** LOKYY_SLOTS="v01,v02,…" → ['v01', 'v02', …]; throws on anything unexpected. */
export function parseSlots(raw: string | undefined): string[] {
  const slots = (raw ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (slots.length === 0) throw new Error('LOKYY_SLOTS must list the deployed vault slots, e.g. "v01,v02,v03"');
  const seen = new Set<string>();
  for (const s of slots) {
    if (s === COMPANY_VAULT) throw new Error(`LOKYY_SLOTS: "${COMPANY_VAULT}" is the company vault, not a slot`);
    if (!SLOT_RE.test(s)) throw new Error(`LOKYY_SLOTS: invalid slot name "${s}" (expected v01, v02, …)`);
    if (seen.has(s)) throw new Error(`LOKYY_SLOTS: duplicate slot "${s}"`);
    seen.add(s);
  }
  return slots;
}

/** First deployed slot that no user (of any status) holds and that holds no retained data. */
export function nextFreeSlot(slots: readonly string[], state: PortalState): string | null {
  const taken = new Set([...state.users.map((u) => u.slot), ...state.retired.map((r) => r.slot)]);
  return slots.find((s) => !taken.has(s)) ?? null;
}

export interface UsersJson {
  companyVault: string;
  users: { username: string; role: Role; vault: string; allowVaultNameMismatch: true }[];
}

/**
 * Input for MetaMCP provisioning (same format as deploy/stack/users.json). Disabled users are left out,
 * so provisioning removes their MetaMCP account and API key.
 */
export function toUsersJson(state: PortalState): UsersJson {
  return {
    companyVault: COMPANY_VAULT,
    users: state.users
      .filter((u) => u.status !== 'disabled')
      .sort((a, b) => a.slot.localeCompare(b.slot))
      .map((u) => ({ username: u.username, role: u.role, vault: u.slot, allowVaultNameMismatch: true as const })),
  };
}
