import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// LBV2-13 re-audit: an invalid MINDBASE_FETCH_CONCURRENCY must stop the web server at startup
// (exit 1, clear message), like the MCP HTTP server, instead of failing every later fetch.
describe('web server startup validation', () => {
  it.each(['0', 'many', '65'])('exits 1 for MINDBASE_FETCH_CONCURRENCY=%s', (value) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mb-startup-'));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, MINDBASE_DATA_DIR: dataDir, PORT: '0', MINDBASE_MDNS: 'off', MINDBASE_FETCH_CONCURRENCY: value };
      delete env['VAULT_PROXY_SECRET'];
      delete env['VAULT_REQUIRE_PROXY_SECRET'];
      const run = spawnSync('npx', ['tsx', 'src/index.ts'], { cwd: join(__dirname, '..'), env, encoding: 'utf-8', timeout: 60_000 });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/MINDBASE_FETCH_CONCURRENCY must be an integer between 1 and 64/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 70_000);
});

// LBV2-26 QA: exactly one of MINDBASE_EMBED_URL / MINDBASE_EMBED_TOKEN is a configuration error that
// must stop the web server at startup, not surface lazily on the first embedding.
describe('web server startup: shared embedding service configuration', () => {
  it.each([
    [{ MINDBASE_EMBED_URL: 'http://embed:8080' }, /MINDBASE_EMBED_TOKEN/],
    [{ MINDBASE_EMBED_TOKEN: 'embed-token-0123456789abcdef0123456789' }, /MINDBASE_EMBED_URL/],
    [{ MINDBASE_EMBED_URL: 'ftp://embed', MINDBASE_EMBED_TOKEN: 'embed-token-0123456789abcdef0123456789' }, /MINDBASE_EMBED_URL/],
  ])('exits 1 for %o', (extra, message) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mb-startup-'));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, MINDBASE_DATA_DIR: dataDir, PORT: '0', MINDBASE_MDNS: 'off', ...extra };
      delete env['VAULT_PROXY_SECRET'];
      delete env['VAULT_REQUIRE_PROXY_SECRET'];
      const run = spawnSync('npx', ['tsx', 'src/index.ts'], { cwd: join(__dirname, '..'), env, encoding: 'utf-8', timeout: 60_000 });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(message);
      expect(run.stderr).not.toContain('embed-token-0123456789abcdef0123456789');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 70_000);
});
