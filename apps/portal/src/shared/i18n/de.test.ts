import { describe, expect, it } from 'vitest';
import { de } from './de.ts';

describe('de', () => {
  it('shows the package name in upper case (QA Low: "Paket m")', () => {
    expect(de.app.package('m')).toBe('Paket M');
    expect(de.app.package('s')).toBe('Paket S');
    expect(de.app.package('team-10')).toBe('Paket team-10');
  });
});
