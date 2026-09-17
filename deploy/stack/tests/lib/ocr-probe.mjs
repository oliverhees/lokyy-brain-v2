// LBV2-14 in the stack: OCR with a read-only /models. Runs inside a vault container (stdin module).
// Mirrors apps/server/src/lib/tesseract-cache.ts (MINDBASE_MODEL_CACHE → /models → private tmp), reads
// tests/fixtures/ocr-lokyy.png (passed base64 in OCR_PNG_B64) and recognizes it with the server's tesseract.js. OCR is not reachable through
// a vault route today (ocr-worker is unused), so this checks the library path the adapter uses.
// Prints: "cache=<dir-kind> text=<recognized>".
import { createRequire } from 'node:module';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire('/app/apps/server/');
const writable = (d) => { try { accessSync(d, constants.W_OK); return true; } catch { return false; } };
const configured = process.env.MINDBASE_MODEL_CACHE;
const kind = configured && writable(configured) ? 'MINDBASE_MODEL_CACHE' : writable('/models') ? '/models' : 'tmp';
const cachePath = kind === 'tmp' ? mkdtempSync(join(tmpdir(), 'mindbase-tesseract-')) : join(kind === '/models' ? '/models' : configured, 'tesseract');

const { createWorker } = require(require.resolve('tesseract.js'));
const png = Buffer.from(process.env.OCR_PNG_B64 ?? "", "base64");
const worker = await createWorker('eng', undefined, { cachePath });
const { data } = await worker.recognize(png);
await worker.terminate();
if (kind === 'tmp') rmSync(cachePath, { recursive: true, force: true });
console.log(`cache=${kind} text=${data.text.replace(/\s+/g, ' ').trim()}`);
