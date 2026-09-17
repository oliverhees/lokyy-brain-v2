// LBV2-14 in the stack: OCR with a read-only /models. Runs inside a vault container (stdin module).
// Mirrors apps/server/src/lib/tesseract-cache.ts (MINDBASE_MODEL_CACHE → /models → private tmp), renders
// a text image with sharp and recognizes it with the server's tesseract.js. OCR is not reachable through
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

const sharp = require(require.resolve('sharp'));
const { createWorker } = require(require.resolve('tesseract.js'));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="120"><rect width="100%" height="100%" fill="white"/><text x="20" y="80" font-size="64" font-family="sans-serif" fill="black">LOKYY 4711</text></svg>';
const png = await sharp(Buffer.from(svg)).png().toBuffer();
const worker = await createWorker('eng', undefined, { cachePath });
const { data } = await worker.recognize(png);
await worker.terminate();
if (kind === 'tmp') rmSync(cachePath, { recursive: true, force: true });
console.log(`cache=${kind} text=${data.text.replace(/\s+/g, ' ').trim()}`);
