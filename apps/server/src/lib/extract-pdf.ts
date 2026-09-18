// apps/server/src/lib/extract-pdf.ts
//
// Local PDF text extraction via pdfjs-dist (no API roundtrip). Dynamic
// import keeps startup fast — pdfjs only loads when a PDF is ingested.
// Bounded (LBV2-30 audit M1): byte size before parsing, page count, total
// time, and an optional character budget that stops reading pages early.
// Mirrored in apps/mcp/src/lib/extract-pdf.ts.

export interface PdfLimits {
  maxBytes: number;
  maxPages: number;
  timeoutMs: number;
}

export const PDF_LIMIT_DEFAULTS: Readonly<PdfLimits> = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  maxPages: 500,
  timeoutMs: 60_000,
});

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer >= 1 (got "${raw}")`);
  }
  return value;
}

/** VAULT_PDF_MAX_BYTES / VAULT_PDF_MAX_PAGES / VAULT_PDF_TIMEOUT_MS; invalid values throw instead of lifting a limit. */
export function readPdfLimits(env: NodeJS.ProcessEnv = process.env): PdfLimits {
  return {
    maxBytes: intFromEnv(env, 'VAULT_PDF_MAX_BYTES', PDF_LIMIT_DEFAULTS.maxBytes),
    maxPages: intFromEnv(env, 'VAULT_PDF_MAX_PAGES', PDF_LIMIT_DEFAULTS.maxPages),
    timeoutMs: intFromEnv(env, 'VAULT_PDF_TIMEOUT_MS', PDF_LIMIT_DEFAULTS.timeoutMs),
  };
}

export interface ExtractPdfOptions extends Partial<PdfLimits> {
  /** Stop reading pages once the text is longer than this (the caller refuses it anyway). */
  maxChars?: number;
}

export async function extractPdfText(data: Uint8Array, opts: ExtractPdfOptions = {}): Promise<string> {
  const limits = { ...readPdfLimits(), ...opts };
  if (data.byteLength > limits.maxBytes) throw new Error(`PDF is larger than ${limits.maxBytes} bytes`);

  const deadline = Date.now() + limits.timeoutMs;
  const timedOut = (): Error => new Error('PDF text extraction timed out');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timedOut()), limits.timeoutMs);
  });
  const extract = async (): Promise<string> => {
    const doc = await task.promise;
    if (doc.numPages > limits.maxPages) throw new Error(`PDF has more than ${limits.maxPages} pages`);
    const parts: string[] = [];
    let chars = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      // pdfjs runs its fake worker on the main thread: the work can be one long
      // promise chain that never yields to the timer, so the deadline is also
      // checked here, between pages. A single expensive page still runs to completion.
      if (Date.now() > deadline) throw timedOut();
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((it) => ('str' in it ? (it as { str: string }).str : ''))
        .join(' ');
      parts.push(pageText);
      chars += pageText.length;
      if (opts.maxChars !== undefined && chars > opts.maxChars) break;
    }
    return parts.join('\n\n').trim();
  };
  try {
    const work = extract();
    work.catch(() => undefined); // a late failure after the timeout must not go unhandled
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    void task.destroy().catch(() => undefined);
  }
}
