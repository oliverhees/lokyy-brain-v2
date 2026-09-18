import { describe, expect, it } from 'vitest';
import { isValidUsername as isValidContributorName } from '../../../../packages/core/src/storage/safe-names.ts';
import {
  EUROUTER_BASE_URL,
  validateCompanyName,
  validateDisplayName,
  validateEmail,
  validateEurouterKey,
  validateInvite,
  validateRole,
  validateSmtp,
  validateUsername,
} from './validation.ts';

describe('validateUsername', () => {
  it.each(['anna', 'ben-2', 'ab', 'a'.repeat(31), 'max-mustermann'])('accepts %s', (u) => {
    expect(validateUsername(u)).toBeNull();
  });

  it.each([
    ['a', 'length'],
    ['a'.repeat(32), 'length'],
    ['Anna', 'charset'],
    ['jürgen', 'charset'],
    ['anna@firma.de', 'charset'],
    ['anna.b', 'charset'],
    ['1anna', 'start'],
    ['-anna', 'start'],
    ['an--na', 'dashes'],
    ['anna-', 'dashes'],
    ['firma', 'reserved'],
    ['auth', 'reserved'],
    ['mcp', 'reserved'],
    ['app', 'reserved'],
    ['unknown', 'reserved'],
    ['akadmin', 'reserved'],
    ['v01', 'reserved'],
    ['v17', 'reserved'],
  ])('rejects %s (%s)', (u, code) => {
    expect(validateUsername(u)).toBe(code);
  });

  it('rejects non-strings', () => {
    expect(validateUsername(undefined)).toBe('required');
    expect(validateUsername(42)).toBe('required');
    expect(validateUsername('')).toBe('required');
  });

  it('every accepted name is also a valid contributor name in packages/core', () => {
    for (const u of ['anna', 'ben-2', 'max-mustermann', 'z9']) {
      expect(validateUsername(u)).toBeNull();
      expect(isValidContributorName(u)).toBe(true);
    }
  });
});

describe('validateEmail', () => {
  it.each(['anna@example.com', 'a.b+c@sub.example.de'])('accepts %s', (e) => {
    expect(validateEmail(e)).toBeNull();
  });
  it.each(['', 'anna', 'anna@', '@example.com', 'anna @example.com', 'anna@example', `${'a'.repeat(250)}@example.com`, 'a@b.c\n', 'a,b@example.com'])(
    'rejects %j', (e) => {
      expect(validateEmail(e)).not.toBeNull();
    });
});

describe('validateDisplayName / validateCompanyName', () => {
  it('accepts Unicode names', () => {
    expect(validateDisplayName('Jürgen Müller-Lüdenscheidt')).toBeNull();
    expect(validateCompanyName('Müller & Söhne GmbH')).toBeNull();
  });
  it('rejects empty, too long and control characters', () => {
    expect(validateDisplayName('   ')).toBe('required');
    expect(validateDisplayName('x'.repeat(81))).toBe('length');
    expect(validateDisplayName('a\x00b')).toBe('charset');
    expect(validateCompanyName('a\nb')).toBe('charset');
    expect(validateCompanyName('x'.repeat(101))).toBe('length');
  });
});

describe('validateRole', () => {
  it('accepts reader and writer only', () => {
    expect(validateRole('reader')).toBeNull();
    expect(validateRole('writer')).toBeNull();
    expect(validateRole('admin')).toBe('invalid');
  });
});

describe('validateEurouterKey', () => {
  it('pins the API host, not the website', () => {
    expect(EUROUTER_BASE_URL).toBe('https://api.eurouter.ai/api/v1');
  });
  it('accepts printable tokens and rejects whitespace, short or huge values', () => {
    expect(validateEurouterKey('sk-eu-0123456789abcdef')).toBeNull();
    expect(validateEurouterKey('short')).toBe('length');
    expect(validateEurouterKey('x'.repeat(513))).toBe('length');
    expect(validateEurouterKey('sk eu 0123456789')).toBe('charset');
    expect(validateEurouterKey('sk-äöü-0123456789')).toBe('charset');
  });
});

describe('validateSmtp', () => {
  const ok = { host: 'smtp.example.com', port: 587, secure: false, username: 'mailer', password: 'pw', from: 'Lokyy <noreply@example.com>' };
  it('accepts a normal submission config', () => {
    expect(validateSmtp(ok)).toEqual({});
  });
  it('flags every bad field', () => {
    expect(validateSmtp({ ...ok, host: 'smtp example' })).toHaveProperty('host');
    expect(validateSmtp({ ...ok, port: 0 })).toHaveProperty('port');
    expect(validateSmtp({ ...ok, port: 70000 })).toHaveProperty('port');
    expect(validateSmtp({ ...ok, from: 'not-an-address' })).toHaveProperty('from');
    expect(validateSmtp({ ...ok, secure: 'yes' })).toHaveProperty('secure');
  });
  it('accepts a bare from address', () => {
    expect(validateSmtp({ ...ok, from: 'noreply@example.com' })).toEqual({});
  });
});

describe('validateInvite', () => {
  it('returns field errors for every invalid field', () => {
    expect(validateInvite({ username: 'Anna', email: 'x', displayName: '', role: 'boss' })).toEqual({
      username: 'charset', email: 'format', displayName: 'required', role: 'invalid',
    });
  });
  it('returns no errors for a valid invite', () => {
    expect(validateInvite({ username: 'anna', email: 'anna@example.com', displayName: 'Anna', role: 'reader' })).toEqual({});
  });
});
