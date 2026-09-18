import { describe, expect, it } from 'vitest';
import { emptyState, type PortalState, type SlotUser } from './state.ts';
import { nextFreeSlot, parseSlots, toUsersJson } from './slots.ts';

const user = (slot: string, username: string, extra: Partial<SlotUser> = {}): SlotUser => ({
  slot, username, email: `${username}@example.com`, displayName: username, role: 'reader', status: 'active',
  authentikPk: null, provisioning: 'ok', invitedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra,
});

const withUsers = (users: SlotUser[], retired: PortalState['retired'] = []): PortalState => ({ ...emptyState(), users, retired });

describe('parseSlots', () => {
  it('parses a comma list and keeps its order', () => {
    expect(parseSlots('v01, v02,v03')).toEqual(['v01', 'v02', 'v03']);
  });
  it('rejects empty lists, bad names, duplicates and the company vault', () => {
    expect(() => parseSlots('')).toThrow(/LOKYY_SLOTS/);
    expect(() => parseSlots(undefined)).toThrow(/LOKYY_SLOTS/);
    expect(() => parseSlots('v01,v1')).toThrow(/v1/);
    expect(() => parseSlots('v01,firma')).toThrow(/firma/);
    expect(() => parseSlots('v01,v01')).toThrow(/duplicate/);
  });
});

describe('nextFreeSlot', () => {
  const slots = ['v01', 'v02', 'v03'];
  it('returns the first slot when nobody is provisioned', () => {
    expect(nextFreeSlot(slots, emptyState())).toBe('v01');
  });
  it('skips slots held by users of any status', () => {
    const state = withUsers([user('v01', 'anna'), user('v02', 'ben', { status: 'disabled' })]);
    expect(nextFreeSlot(slots, state)).toBe('v03');
  });
  it('fills gaps left by removed users whose data was wiped', () => {
    expect(nextFreeSlot(slots, withUsers([user('v02', 'ben')]))).toBe('v01');
  });
  it('never hands out a slot that still holds a former user\'s data', () => {
    const state = withUsers([user('v02', 'ben')], [{ slot: 'v01', formerUsername: 'anna', retiredAt: '2026-09-02T00:00:00.000Z' }]);
    expect(nextFreeSlot(slots, state)).toBe('v03');
  });
  it('returns null when every slot is taken', () => {
    const state = withUsers([user('v01', 'a1'), user('v02', 'a2'), user('v03', 'a3')]);
    expect(nextFreeSlot(slots, state)).toBeNull();
  });
  it('ignores state entries for slots that are not deployed', () => {
    expect(nextFreeSlot(['v01'], withUsers([user('v09', 'ghost')]))).toBe('v01');
  });
});

describe('toUsersJson (deploy/stack/metamcp/provision.mjs input)', () => {
  it('lists invited and active users with their slot as vault, not disabled ones', () => {
    const state = withUsers([
      user('v01', 'anna', { role: 'reader' }),
      user('v02', 'ben', { role: 'writer', status: 'invited' }),
      user('v03', 'carl', { status: 'disabled' }),
    ]);
    expect(toUsersJson(state)).toEqual({
      companyVault: 'firma',
      users: [
        { username: 'anna', role: 'reader', vault: 'v01', allowVaultNameMismatch: true },
        { username: 'ben', role: 'writer', vault: 'v02', allowVaultNameMismatch: true },
      ],
    });
  });
  it('sorts by slot so the file is stable', () => {
    const state = withUsers([user('v03', 'carl'), user('v01', 'anna')]);
    expect(toUsersJson(state).users.map((u) => u.vault)).toEqual(['v01', 'v03']);
  });
});
