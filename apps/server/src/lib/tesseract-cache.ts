import { accessSync, constants, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directory for tesseract.js language data. tesseract.js defaults to the working
 * directory, which is read-only in the container image (LBV2-14). Order:
 * MINDBASE_MODEL_CACHE (absolute, writable) -> /models (image model volume) -> OS temp dir.
 */
export function tesseractCachePath(
  env: Record<string, string | undefined> = process.env,
  writable: (dir: string) => boolean = isWritableDir,
): string {
  const configured = env['MINDBASE_MODEL_CACHE'];
  if (configured && isAbsolute(configured) && writable(configured)) return join(configured, 'tesseract');
  if (writable('/models')) return join('/models', 'tesseract');
  return join(tmpdir(), 'mindbase-tesseract');
}

/** Worker options for tesseract.js createWorker, with the cache directory created. */
export function tesseractWorkerOptions(): { cachePath: string } {
  const cachePath = tesseractCachePath();
  mkdirSync(cachePath, { recursive: true });
  return { cachePath };
}
