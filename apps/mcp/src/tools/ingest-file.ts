// apps/mcp/src/tools/ingest-file.ts
import { z } from 'zod';
import { join, extname, basename } from 'node:path';
import { mkdir, writeFile, appendFile, stat, readFile } from 'node:fs/promises';
import type { Context } from '../context.js';
import { textResult, errorResult } from '../lib/error.js';
import { resolveProjectId } from '../lib/resolve-project.js';
import { extractPdfText } from '../lib/extract-pdf.js';
import { projectPaths, isoToday, fetchUntrusted, UNTRUSTED_FETCH_ERROR, type SafeFetchResponse } from '@mindbase/core';

const MAX_BYTES = 50 * 1024 * 1024; // 50MB, local files (stdio only)
const REMOTE_MAX_BYTES = 20 * 1024 * 1024; // 20MB, URL downloads (server memory, LBV2-13)
const RETURN_CHAR_CAP = 40_000;
const ALLOWED_EXTS = new Set(['.pdf', '.md', '.txt']);

export const inputSchema = z.object({
  path: z.string().min(1),
  projectId: z.string().optional(),
  title: z.string().optional(),
});

export const definition = {
  name: 'mindbase_ingest_file',
  description:
    'Ingest a file (PDF, .md, or .txt) into a project: archives the original into sources/raw/<date>/, extracts text locally (pdfjs for PDFs — no API call), writes an .extracted.md sidecar for PDFs, and returns the text. Accepts a local absolute path OR an http(s) URL that points directly at a file (e.g. an arXiv PDF link) — URLs are downloaded first. After calling this, discuss the key takeaways with the user and file a summary via mindbase_contribute.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path on disk, or a direct http(s) URL to a PDF/.md/.txt file' },
      projectId: { type: 'string', description: 'Project id; defaults to the current project (config.json)' },
      title: { type: 'string', description: 'Optional human title; defaults to the filename' },
    },
    required: ['path'],
  },
};

interface Fetched { buf: Buffer; filename: string; ext: string }

async function fetchRemoteFile(url: string): Promise<Fetched | { error: string }> {
  let res: SafeFetchResponse;
  try {
    // SSRF-safe: private/loopback/metadata targets are refused on every redirect hop, and every
    // failure (policy, DNS, connection, status, size) gets one generic message (LBV2-13).
    // Details are logged to stderr only.
    res = await fetchUntrusted(url, { timeoutMs: 60_000, maxBytes: REMOTE_MAX_BYTES });
  } catch {
    return { error: `${UNTRUSTED_FETCH_ERROR} (downloads are limited to ${REMOTE_MAX_BYTES / 1024 / 1024}MB)` };
  }

  const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
  const urlPath = new URL(res.url).pathname;
  const urlExt = extname(urlPath).toLowerCase();

  let ext: string;
  if (ctype.includes('application/pdf') || urlExt === '.pdf') ext = '.pdf';
  else if (ctype.includes('text/markdown') || urlExt === '.md') ext = '.md';
  else if (ctype.includes('text/plain') || urlExt === '.txt') ext = '.txt';
  else if (ctype.includes('text/html')) {
    return { error: 'That URL serves an HTML page, not a file. Fetch the page content yourself and use mindbase_contribute — or find the direct PDF link (on arXiv, the /pdf/ URL).' };
  } else {
    return { error: `Unsupported content-type '${ctype}'. Supported: PDF, markdown, plain text.` };
  }

  const buf = res.body;

  // Filename: Content-Disposition beats URL basename.
  const dispo = res.headers.get('content-disposition') ?? '';
  const dispoMatch = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(dispo);
  const rawName = dispoMatch?.[1] ?? basename(urlPath) ?? 'download';
  return { buf, filename: rawName, ext };
}

function sanitizeBase(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'file';
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export async function handle(ctx: Context, rawInput: unknown) {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) return errorResult(`Invalid input: ${parsed.error.issues[0]?.message}`);
  const { path } = parsed.data;

  const resolved = await resolveProjectId(ctx, parsed.data.projectId);
  if (!resolved.ok) return errorResult(resolved.error);
  const projectId = resolved.projectId;

  // Obtain the file bytes — remote URL or local path.
  let buf: Buffer;
  let ext: string;
  let base: string;
  if (/^https?:\/\//i.test(path)) {
    const fetched = await fetchRemoteFile(path);
    if ('error' in fetched) return errorResult(fetched.error);
    buf = fetched.buf;
    ext = fetched.ext;
    base = sanitizeBase(basename(fetched.filename, extname(fetched.filename)));
  } else {
    if (!ctx.allowLocalFilePaths) {
      return errorResult('Local file paths are not accepted on this server. Pass an http(s) URL to the file instead.');
    }
    // Errors below do not echo `path`: absolute paths stay out of client responses.
    let info;
    try {
      info = await stat(path);
    } catch {
      return errorResult('File not found. Pass an absolute path to an existing file, or an http(s) URL.');
    }
    if (!info.isFile()) return errorResult('Not a file. Pass an absolute path to a regular file.');
    if (info.size > MAX_BYTES) {
      return errorResult(`File is ${(info.size / 1024 / 1024).toFixed(1)}MB — the limit is 50MB.`);
    }
    ext = extname(path).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return errorResult(`Unsupported extension '${ext}'. Supported: .pdf, .md, .txt. For web pages, fetch the content yourself and use mindbase_contribute.`);
    }
    buf = await readFile(path);
    base = sanitizeBase(basename(path, extname(path)));
  }

  // Archive the original into sources/raw/<today>/, avoiding name collisions.
  const p = projectPaths();
  const today = isoToday();
  const rawDirAbs = join(ctx.dataDir, 'projects', projectId, p.rawDir, today);
  await mkdir(rawDirAbs, { recursive: true });

  let finalBase = base;
  for (let i = 2; await fileExists(join(rawDirAbs, `${finalBase}${ext}`)); i++) {
    finalBase = `${base}-${i}`;
  }
  const archivedAbs = join(rawDirAbs, `${finalBase}${ext}`);
  await writeFile(archivedAbs, buf);

  // Extract text.
  let text: string;
  if (ext === '.pdf') {
    try {
      text = await extractPdfText(new Uint8Array(buf));
    } catch (e) {
      return errorResult(`PDF extraction failed: ${(e as Error).message}. The original was archived at ${p.rawDir}/${today}/${finalBase}${ext}.`);
    }
  } else {
    text = buf.toString('utf-8').trim();
  }

  // PDF sidecar so the archived copy stays readable without re-extraction.
  let extractedPath: string | null = null;
  if (ext === '.pdf') {
    extractedPath = `${p.rawDir}/${today}/${finalBase}.extracted.md`;
    await writeFile(join(rawDirAbs, `${finalBase}.extracted.md`), text, 'utf-8');
  }

  // Log the operation.
  const hhmm = new Date().toISOString().slice(11, 16);
  const logAbs = join(ctx.dataDir, 'projects', projectId, p.logsDay(today));
  await mkdir(join(ctx.dataDir, 'projects', projectId, p.logsRoot), { recursive: true });
  await appendFile(logAbs, `## [${today} ${hhmm}] ingest-file | ${finalBase}${ext} chars=${text.length}\n`, 'utf-8');

  const truncated = text.length > RETURN_CHAR_CAP;
  const note = text.length === 0
    ? 'No extractable text — likely a scanned PDF (OCR is not applied). The original is archived; tell the user extraction came up empty.'
    : `Original archived. Now discuss the key takeaways of this text with the user, then file a summary via mindbase_contribute (projectId: ${projectId}).${truncated ? ` Text truncated to ${RETURN_CHAR_CAP} chars of ${text.length}; read the archived sidecar for the rest.` : ''}`;

  return textResult({
    projectId,
    archivedPath: `${p.rawDir}/${today}/${finalBase}${ext}`,
    extractedPath,
    chars: text.length,
    truncated,
    text: text.slice(0, RETURN_CHAR_CAP),
    note,
  });
}

export function register(handlers: Map<string, (input: unknown) => Promise<unknown>>, defs: object[], ctx: Context): void {
  handlers.set(definition.name, (input) => handle(ctx, input));
  defs.push(definition);
}
