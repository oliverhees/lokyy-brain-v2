import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tesseractCachePath } from '../tesseract-cache';

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
