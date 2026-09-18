/**
 * EUrouter routing rule (LBV2-30): a ruleId in mindbase.config.json reaches the
 * provider as `rule_id` through the MCP context's adapter. No network: fetch is stubbed.
 * Run from apps/mcp/ directory after build: node test/eurouter-rule.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContext } from '../dist/index.js';

const RULE = '3f1c2b9a-8d4e-4f6a-9b2c-1d2e3f4a5b6c';
let exitCode = 0;
const ok = (m) => console.log(`OK: ${m}`);
const fail = (m) => { console.error(`FAIL ${m}`); exitCode = 1; };

const dir = mkdtempSync(join(tmpdir(), 'mb-eurouter-'));
const bodies = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  bodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
  return new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
};
try {
  writeFileSync(join(dir, 'mindbase.config.json'), JSON.stringify({
    provider: 'openai', model: 'qwen3.6-27b', apiKey: 'eur_test', baseUrl: 'https://api.eurouter.ai/api/v1', ruleId: RULE,
  }));
  const ctx = await loadContext({ dataDir: dir, allowLocalFilePaths: false });
  if (ctx.config?.ruleId === RULE) ok('config carries ruleId'); else fail('config lost ruleId');
  for await (const _c of ctx.getAdapter().chat({ model: ctx.config.model, messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
  const sent = bodies[0];
  if (sent?.url === 'https://api.eurouter.ai/api/v1/chat/completions') ok('chat goes to EUrouter'); else fail(`unexpected url ${sent?.url}`);
  if (sent?.body.rule_id === RULE) ok('rule_id sent'); else fail(`rule_id missing: ${JSON.stringify(sent?.body)}`);
  if (!('model' in (sent?.body ?? {}))) ok('no model with a route (rule brings its models)'); else fail('model sent with a route');
  // PDF chat: extracted locally, sent via chat/completions with rule_id, never /responses.
  const pdf = ['%PDF-1.4', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj', '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    '4 0 obj<</Length 44>>stream', 'BT /F1 12 Tf 10 50 Td (Hello EU PDF) Tj ET', 'endstream endobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj', 'trailer<</Root 1 0 R>>', '%%EOF'].join('\n');
  bodies.length = 0;
  const messages = [{ role: 'user', content: [
    { type: 'text', text: 'Summarize.' },
    { type: 'document', media_type: 'application/pdf', data: Buffer.from(pdf).toString('base64') },
  ] }];
  for await (const _c of ctx.getAdapter().chat({ model: ctx.config.model, messages })) { /* drain */ }
  const pdfCall = bodies[0];
  if (pdfCall?.url === 'https://api.eurouter.ai/api/v1/chat/completions') ok('PDF chat uses chat/completions'); else fail(`PDF chat went to ${pdfCall?.url}`);
  if (pdfCall?.body.rule_id === RULE && JSON.stringify(pdfCall?.body.messages).includes('Hello EU PDF')) ok('PDF text extracted locally and sent with rule_id');
  else fail('PDF text or rule_id missing');
  // Bounded extraction (audit M1): an oversized PDF is refused before parsing, no provider call.
  bodies.length = 0;
  process.env.VAULT_PDF_MAX_BYTES = '10';
  let limitError = '';
  for await (const c of ctx.getAdapter().chat({ model: ctx.config.model, messages })) if (c.kind === 'error') limitError = c.error;
  delete process.env.VAULT_PDF_MAX_BYTES;
  if (limitError === 'Could not extract text from the PDF: PDF is larger than 10 bytes' && bodies.length === 0) ok('oversized PDF refused before parsing');
  else fail(`oversized PDF not refused: ${limitError} / calls ${bodies.length}`);
  ctx.wikiIndex.close?.();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
