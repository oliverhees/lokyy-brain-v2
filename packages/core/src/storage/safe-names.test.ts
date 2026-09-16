import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  isValidTrashEntryId,
  isValidUsername,
  isValidIsoDate,
  isSafePathSegment,
  isPlainSlug,
  resolveInside,
  USERNAME_MAX_LENGTH,
} from './safe-names';

describe('isValidTrashEntryId', () => {
  it('accepts ids in the format moveToTrash generates', () => {
    const isoTs = new Date('2026-09-16T12:34:56.789Z').toISOString().replace(/[:.]/g, '-');
    expect(isValidTrashEntryId(`${isoTs}-a1b2c`)).toBe(true);
    expect(isValidTrashEntryId('2026-09-16T12-34-56-789Z-x')).toBe(true);
  });

  it.each([
    '', '..', '../..', '../../..', '.trash', 'foo',
    '2026-09-16T12-34-56-789Z-a1b2c/..',
    '2026-09-16T12-34-56-789Z-../x',
    '2026-09-16T12-34-56-789Z-ABCDE',
    '2026-09-16T12-34-56-789Z-abcdef',
    '/2026-09-16T12-34-56-789Z-abc',
    '2026-09-16T12-34-56-789Z-abc\n',
  ])('rejects %j', (id) => {
    expect(isValidTrashEntryId(id)).toBe(false);
  });
});

describe('isValidUsername', () => {
  it.each(['alice', 'Alice_B', 'bob-1', 'j.doe', 'jürgen', 'x'])('accepts %j', (name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it.each([
    '', '.', '..', '.hidden', '../../../../tmp', 'a/b', 'a\\b', 'a..b', 'with space',
    'nul\0byte', '-leading', 'x'.repeat(USERNAME_MAX_LENGTH + 1),
  ])('rejects %j', (name) => {
    expect(isValidUsername(name)).toBe(false);
  });

  it('accepts a name of exactly the max length', () => {
    expect(isValidUsername('x'.repeat(USERNAME_MAX_LENGTH))).toBe(true);
  });
});

describe('isValidIsoDate', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(isValidIsoDate('2026-06-09')).toBe(true);
  });
  it.each(['', '..', '2026-6-9', '2026-06-09/..', '../2026-06-09', '20260609', '2026-06-09\n'])('rejects %j', (d) => {
    expect(isValidIsoDate(d)).toBe(false);
  });
});

describe('isSafePathSegment', () => {
  it.each(['doc-1.md', 'report.extracted.md', '.hidden.md', 'file name.txt'])('accepts %j', (s) => {
    expect(isSafePathSegment(s)).toBe(true);
  });
  it.each(['', '.', '..', 'a/b', '../x', 'a\\b', 'nul\0', 'x'.repeat(256)])('rejects %j', (s) => {
    expect(isSafePathSegment(s)).toBe(false);
  });
});

describe('isPlainSlug', () => {
  it.each(['transformer-basics', 'a', 'gpt4-notes'])('accepts %j', (s) => {
    expect(isPlainSlug(s)).toBe(true);
  });
  it.each(['', '../x', 'a/b', 'Upper', '-lead', 'trail-', 'a--b', 'a.b', 'a b', 'x'.repeat(201)])('rejects %j', (s) => {
    expect(isPlainSlug(s)).toBe(false);
  });
});

describe('resolveInside', () => {
  const root = path.resolve('/vault/projects/p');

  it('returns the absolute path for descendants', () => {
    expect(resolveInside(root, 'sources', 'raw', '2026-06-09', 'a.md')).toBe(path.join(root, 'sources/raw/2026-06-09/a.md'));
  });

  it.each([
    [['..']],
    [['../../etc/passwd']],
    [['sources', '../../x']],
    [['/etc/passwd']],
    [['.']],
    [[]],
  ])('returns null for %j', (segments) => {
    expect(resolveInside(root, ...segments)).toBeNull();
  });

  it('does not treat a sibling with a shared prefix as inside', () => {
    expect(resolveInside(root, '../p-evil/x')).toBeNull();
  });
});
