/**
 * LBV2-14: quick_capture returns a data-dir-relative path, never the absolute host path.
 * Run from apps/mcp/ directory: node test/quick-capture-path.mjs
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dataDir = mkdtempSync(join(tmpdir(), 'mb-quick-capture-'));
let exitCode = 0;
const ok = (m) => console.log(`OK: ${m}`);
const fail = (m) => { console.error(`FAIL ${m}`); exitCode = 1; };

async function run() {
  const client = new Client({ name: 'quick-capture-path', version: '0' });
  await client.connect(new StdioClientTransport({
    command: 'node',
    args: ['dist/cli.js', '--data-dir', dataDir],
    env: { ...process.env, MINDBASE_DATA_DIR: dataDir },
    stderr: 'ignore',
  }));
  try {
    const res = await client.callTool({ name: 'quick_capture', arguments: { content: 'QC-PATH-TEST' } });
    const text = res.content?.[0]?.text ?? '';
    if (res.isError) { fail(`quick_capture errored: ${text}`); return; }
    const body = JSON.parse(text);
    !text.includes(dataDir) ? ok('response does not contain the data dir') : fail(`response leaks the host path: ${text}`);
    /^inbox\/[^/]+-capture\.md$/.test(body.path)
      ? ok(`path is data-dir-relative (${body.path})`)
      : fail(`unexpected path: ${body.path}`);
    try {
      readFileSync(join(dataDir, body.path), 'utf-8').includes('QC-PATH-TEST')
        ? ok('relative path resolves to the captured file')
        : fail('captured file lacks the content');
    } catch (e) {
      fail(`relative path does not resolve: ${e.message}`);
    }
  } finally {
    await client.close().catch(() => {});
  }
}

run()
  .catch((e) => fail(e.stack ?? String(e)))
  .finally(() => { rmSync(dataDir, { recursive: true, force: true }); process.exit(exitCode); });
