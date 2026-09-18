/**
 * LBV2-32 D: the MCP server picks up mindbase.config.json changes (UI, setup
 * portal) without a restart; an invalid file keeps the last good config.
 * No network: fetch is stubbed. Run from apps/mcp/ after build: node test/config-reload.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContext, createReaderView } from '../dist/index.js';

let exitCode = 0;
const ok = (m) => console.log(`OK: ${m}`);
const fail = (m) => { console.error(`FAIL ${m}`); exitCode = 1; };

const dir = mkdtempSync(join(tmpdir(), 'mb-config-reload-'));
const file = join(dir, 'mindbase.config.json');
const urls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  urls.push(String(url));
  return new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
};
// Distinct mtimes even on coarse-timestamp filesystems.
let tick = Math.floor(Date.now() / 1000);
const write = (text) => { writeFileSync(file, text); tick += 10; utimesSync(file, tick, tick); };
const cfg = (model, baseUrl) => JSON.stringify({ provider: 'openai', model, apiKey: 'k', baseUrl });
const chatOnce = async (ctx) => {
  urls.length = 0;
  for await (const _c of ctx.getAdapter().chat({ model: ctx.config.model, messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
  return urls[0];
};

const stderr = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => { stderr.push(String(chunk)); return realWrite(chunk, ...rest); };

process.env.MINDBASE_MCP_CONFIG_RELOAD_MS = '0';
try {
  // Starts without a config: LLM tools report "not configured".
  const ctx = await loadContext({ dataDir: dir, allowLocalFilePaths: false });
  if (ctx.config === null) ok('no config at start'); else fail('expected null config');

  write(cfg('model-a', 'https://a.example/v1'));
  if (ctx.config?.model === 'model-a') ok('config created after start is picked up'); else fail(`config not picked up: ${JSON.stringify(ctx.config)}`);
  if ((await chatOnce(ctx)) === 'https://a.example/v1/chat/completions') ok('adapter uses the new config'); else fail(`adapter url ${urls[0]}`);

  write(cfg('model-b', 'https://b.example/v1'));
  if (ctx.config?.model === 'model-b') ok('changed config is picked up'); else fail(`change missed: ${ctx.config?.model}`);
  if ((await chatOnce(ctx)) === 'https://b.example/v1/chat/completions') ok('adapter follows the change'); else fail(`adapter url ${urls[0]}`);

  write('{ "provider": "openai", "model": '); // half-written / invalid
  if (ctx.config?.model === 'model-b') ok('invalid file keeps the last good config'); else fail(`invalid file replaced config: ${JSON.stringify(ctx.config)}`);
  if (stderr.some((l) => l.includes('mindbase.config.json') && /invalid|keeping/i.test(l))) ok('invalid file is logged');
  else fail('invalid file not logged');
  if (!stderr.join('').includes('"k"')) ok('log does not contain the api key'); else fail('api key in log');

  write(cfg('model-c', 'https://c.example/v1'));
  if (ctx.config?.model === 'model-c') ok('recovers once the file is valid again'); else fail(`no recovery: ${ctx.config?.model}`);

  // HTTP reader sessions (ask_wiki) see the change too, still without key or base URL.
  const reader = createReaderView(ctx).ctx;
  write(cfg('model-r', 'https://r.example/v1'));
  if (reader.config?.model === 'model-r') ok('reader view follows the change'); else fail(`reader view stale: ${JSON.stringify(reader.config)}`);
  if (reader.config && !('apiKey' in reader.config) && !('baseUrl' in reader.config)) ok('reader config still has no key/base URL');
  else fail('reader config leaks key or base URL');
  write(cfg('model-c', 'https://c.example/v1'));

  // Throttle: with a reload interval, a change inside the window is not seen yet.
  process.env.MINDBASE_MCP_CONFIG_RELOAD_MS = '60000';
  const throttled = await loadContext({ dataDir: dir, allowLocalFilePaths: false });
  if (throttled.config?.model === 'model-c') ok('throttled context loads current config'); else fail('throttled start');
  write(cfg('model-d', 'https://d.example/v1'));
  if (throttled.config?.model === 'model-c') ok('checks are debounced within the interval'); else fail('no debounce');
  ctx.wikiIndex.close?.();
  throttled.wikiIndex.close?.();
} catch (e) {
  fail(e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  process.stderr.write = realWrite;
  globalThis.fetch = realFetch;
  delete process.env.MINDBASE_MCP_CONFIG_RELOAD_MS;
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
