/**
 * mindbase_ingest_file over stdio keeps accepting local paths (LBV2-11 only
 * disables them for the HTTP transport), and its errors do not echo the path.
 * Run from apps/mcp/ directory: node test/ingest-local-stdio.mjs
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const outer = mkdtempSync(join(tmpdir(), 'mb-ingest-stdio-'));
const dataDir = join(outer, 'vault');
mkdirSync(join(dataDir, 'projects', 'demo'), { recursive: true });
const localFile = join(outer, 'notes.md');
writeFileSync(localFile, '# Local\nSTDIO-LOCAL-OK');

let exitCode = 0;
const ok = (m) => console.log(`OK: ${m}`);
const fail = (m) => { console.error(`FAIL ${m}`); exitCode = 1; };

async function run() {
  const client = new Client({ name: 'ingest-stdio', version: '0' });
  await client.connect(new StdioClientTransport({
    command: 'node',
    args: ['dist/cli.js', '--data-dir', dataDir],
    env: { ...process.env, MINDBASE_DATA_DIR: dataDir },
    stderr: 'ignore',
  }));

  const res = await client.callTool({ name: 'mindbase_ingest_file', arguments: { projectId: 'demo', path: localFile } });
  !res.isError && JSON.stringify(res).includes('STDIO-LOCAL-OK')
    ? ok('local path ingest works over stdio')
    : fail(`local path ingest failed over stdio: ${JSON.stringify(res).slice(0, 300)}`);

  const missing = await client.callTool({ name: 'mindbase_ingest_file', arguments: { projectId: 'demo', path: join(outer, 'missing.md') } });
  missing.isError && !JSON.stringify(missing).includes(outer)
    ? ok('missing local file error does not echo the path')
    : fail(`missing file error leaked the path or succeeded: ${JSON.stringify(missing).slice(0, 300)}`);

  await client.close().catch(() => {});
}

run()
  .catch((e) => fail(e.message))
  .finally(() => { rmSync(outer, { recursive: true, force: true }); process.exit(exitCode); });
