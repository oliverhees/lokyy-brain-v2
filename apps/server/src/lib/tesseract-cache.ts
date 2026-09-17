import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
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

/**
 * Creates `dir` with mode 0700 (or reuses it) and returns it only if it is a real
 * directory (not a symlink) owned by this process's user with no group/other write
 * bit. Otherwise a fresh `mkdtemp` directory is returned, because a predictable
 * shared path (e.g. in /tmp) could have been pre-created by another local user.
 */
export function ensurePrivateCacheDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
    if (st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o022) === 0) return dir;
  } catch {
    // fall through to a fresh private directory
  }
  return mkdtempSync(join(tmpdir(), 'mindbase-tesseract-'));
}

/** Worker options for tesseract.js createWorker, with a safe cache directory. */
export function tesseractWorkerOptions(): { cachePath: string } {
  return { cachePath: ensurePrivateCacheDir(tesseractCachePath()) };
}
