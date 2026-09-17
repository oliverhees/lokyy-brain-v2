/**
 * LBV2-14: MCP_HTTP_READONLY_* only configure the HTTP transport. Invalid values
 * must not stop a stdio server (the HTTP server still exits 1, see
 * http-readonly-ask-wiki.mjs).
 * Run from apps/mcp/ directory: node test/stdio-ignores-http-env.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dataDir = mkdtempSync(join(tmpdir(), 'mb-stdio-env-'));
let exitCode = 0;
const ok = (m) => console.log(`OK: ${m}`);
const fail = (m) => { console.error(`FAIL ${m}`); exitCode = 1; };

async function run() {
  const client = new Client({ name: 'stdio-env', version: '0' });
  const connect = client.connect(new StdioClientTransport({
    command: 'node',
    args: ['dist/cli.js', '--data-dir', dataDir],
    env: {
      ...process.env,
      MINDBASE_DATA_DIR: dataDir,
      MCP_HTTP_READONLY_LLM_RATE: 'abc',
      MCP_HTTP_READONLY_LLM_RATE_TOTAL: '-1',
      MCP_HTTP_READONLY_LLM_WINDOW_MS: '10',
    },
    stderr: 'ignore',
  }));
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout')), 20_000));
  try {
    await Promise.race([connect, timeout]);
    const tools = await client.listTools();
    tools.tools.length > 0
      ? ok('stdio server starts and lists tools despite invalid MCP_HTTP_READONLY_* values')
      : fail('stdio server listed no tools');
  } catch (e) {
    fail(`stdio server did not start with invalid MCP_HTTP_READONLY_* values: ${e.message}`);
  } finally {
    await client.close().catch(() => {});
  }
}

run()
  .catch((e) => fail(e.stack ?? String(e)))
  .finally(() => { rmSync(dataDir, { recursive: true, force: true }); process.exit(exitCode); });
