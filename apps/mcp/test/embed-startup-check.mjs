/**
 * LBV2-26 QA: exactly one of MINDBASE_EMBED_URL / MINDBASE_EMBED_TOKEN (or an invalid URL) must stop
 * the MCP server at startup — stdio (dist/cli.js) and HTTP (dist/http.js) — with a clear message
 * that never contains the token. Run from apps/mcp/ after `pnpm build`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'embed-token-0123456789abcdef0123456789';
const cases = [
  [{ MINDBASE_EMBED_URL: 'http://embed:8080', MINDBASE_EMBED_TOKEN: '' }, /MINDBASE_EMBED_TOKEN/],
  [{ MINDBASE_EMBED_URL: '', MINDBASE_EMBED_TOKEN: TOKEN }, /MINDBASE_EMBED_URL/],
  [{ MINDBASE_EMBED_URL: 'ftp://embed', MINDBASE_EMBED_TOKEN: TOKEN }, /MINDBASE_EMBED_URL/],
];
let failures = 0;
const dataDir = mkdtempSync(join(tmpdir(), 'mb-mcp-embed-start-'));
try {
  for (const [entry, extraArgs] of [['dist/cli.js', ['--data-dir', dataDir]], ['dist/http.js', []]]) {
    for (const [extra, message] of cases) {
      const env = { ...process.env, MINDBASE_DATA_DIR: dataDir, MCP_HTTP_TOKEN: 'http-token-0123456789abcdef0123456789', MCP_HTTP_PORT: '18995', ...extra };
      const run = spawnSync('node', [entry, ...extraArgs], { env, input: '', encoding: 'utf-8', timeout: 30_000 });
      const out = `${run.stderr}${run.stdout}`;
      const ok = run.status === 1 && message.test(out) && !out.includes(TOKEN);
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${entry} exits 1 at startup for ${JSON.stringify(Object.keys(extra).filter((k) => extra[k]))}${ok ? '' : ` — status=${run.status} ${out.slice(0, 200)}`}`);
      if (!ok) failures += 1;
    }
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures === 0 ? '\n✓ embed startup checks passed' : `\n✗ ${failures} embed startup checks failed`);
process.exit(failures === 0 ? 0 : 1);
