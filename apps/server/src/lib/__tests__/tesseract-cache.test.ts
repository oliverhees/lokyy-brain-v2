import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensurePrivateCacheDir, tesseractCachePath } from '../tesseract-cache';

// LBV2-14: tesseract.js wrote language data to the (non-writable) working directory.
describe('tesseractCachePath', () => {
  const writable = (dirs: string[]) => (dir: string) => dirs.includes(dir);

  it('uses MINDBASE_MODEL_CACHE/tesseract when set and writable', () => {
    expect(tesseractCachePath({ MINDBASE_MODEL_CACHE: '/cache' }, writable(['/cache', '/models']))).toBe(join('/cache', 'tesseract'));
  });

  it('falls back to /models/tesseract when /models is writable', () => {
    expect(tesseractCachePath({}, writable(['/models']))).toBe(join('/models', 'tesseract'));
    expect(tesseractCachePath({ MINDBASE_MODEL_CACHE: '/ro' }, writable(['/models']))).toBe(join('/models', 'tesseract'));
  });

  it('falls back to the OS temp dir otherwise', () => {
    expect(tesseractCachePath({}, writable([]))).toBe(join(tmpdir(), 'mindbase-tesseract'));
  });

  it('ignores a relative MINDBASE_MODEL_CACHE', () => {
    expect(tesseractCachePath({ MINDBASE_MODEL_CACHE: 'cache' }, () => true)).toBe(join('/models', 'tesseract'));
  });
});

// LBV2-14 security Low: the temp fallback name is predictable, so another local user
// could pre-create it (symlink or group/other-writable dir) to plant language data.
describe('ensurePrivateCacheDir', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'tess-cache-test-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('creates the directory with mode 0700 and uses it', () => {
    const dir = join(base, 'mindbase-tesseract');
    expect(ensurePrivateCacheDir(dir)).toBe(dir);
    const st = lstatSync(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('reuses an existing private directory', () => {
    const dir = join(base, 'mindbase-tesseract');
    mkdirSync(dir, { mode: 0o700 });
    expect(ensurePrivateCacheDir(dir)).toBe(dir);
  });

  it('refuses a symlink and falls back to a fresh private temp dir', () => {
    const target = join(base, 'attacker');
    mkdirSync(target, { mode: 0o700 });
    const dir = join(base, 'mindbase-tesseract');
    symlinkSync(target, dir);
    const got = ensurePrivateCacheDir(dir);
    expect(got).not.toBe(dir);
    expect(got.startsWith(join(tmpdir(), 'mindbase-tesseract-'))).toBe(true);
    expect(lstatSync(got).isDirectory()).toBe(true);
    expect(lstatSync(got).mode & 0o777).toBe(0o700);
    rmSync(got, { recursive: true, force: true });
  });

  it('refuses a group/other-writable directory and falls back', () => {
    const dir = join(base, 'mindbase-tesseract');
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    const got = ensurePrivateCacheDir(dir);
    expect(got).not.toBe(dir);
    expect(lstatSync(got).mode & 0o022).toBe(0);
    rmSync(got, { recursive: true, force: true });
  });
});
