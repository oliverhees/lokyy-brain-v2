import { describe, it, expect, afterEach, vi } from 'vitest';
import { extractPdfText, readPdfLimits, PDF_LIMIT_DEFAULTS } from './extract-pdf';

// LBV2-30 audit M1: PDF extraction is bounded (bytes before parsing, pages, time, characters).

/** A minimal PDF with one text line per page ("Page N marker"). pdfjs rebuilds the missing xref. */
function makePdf(pages: number): Uint8Array {
  const objs: string[] = ['<</Type/Catalog/Pages 2 0 R>>'];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push(`<</Type/Pages/Kids[${kids}]/Count ${pages}>>`);
  objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 12 Tf 10 50 Td (Page ${i + 1} marker) Tj ET`;
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents ${5 + i * 2} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`);
    objs.push(`<</Length ${stream.length}>>stream\n${stream}\nendstream`);
  }
  const body = objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj`).join("\n");
  return new TextEncoder().encode(`%PDF-1.4\n${body}\ntrailer<</Root 1 0 R>>\n%%EOF`);
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('extractPdfText limits', () => {
  it('extracts every page of a normal PDF', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const text = await extractPdfText(makePdf(3));
    expect(text).toContain('Page 1 marker');
    expect(text).toContain('Page 3 marker');
  });

  it('refuses a document over the byte limit before parsing', async () => {
    await expect(extractPdfText(makePdf(3), { maxBytes: 100 })).rejects.toThrow(/^PDF is larger than 100 bytes$/);
  });

  it('refuses a document with more pages than the page cap', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(extractPdfText(makePdf(12), { maxPages: 10 })).rejects.toThrow('PDF has more than 10 pages');
  });

  it('stops reading pages as soon as the text passes maxChars', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const text = await extractPdfText(makePdf(200), { maxChars: 40 });
    expect(text.length).toBeGreaterThan(40);
    expect(text).not.toContain('Page 10 marker');
  });

  it('gives up after the time limit', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(extractPdfText(makePdf(400), { timeoutMs: 1 })).rejects.toThrow('PDF text extraction timed out');
  });

  it('reads limits from the environment with safe defaults and refuses invalid values', () => {
    expect(readPdfLimits({})).toEqual(PDF_LIMIT_DEFAULTS);
    expect(PDF_LIMIT_DEFAULTS).toEqual({ maxBytes: 25 * 1024 * 1024, maxPages: 500, timeoutMs: 60_000 });
    expect(readPdfLimits({ VAULT_PDF_MAX_BYTES: '1000', VAULT_PDF_MAX_PAGES: '5', VAULT_PDF_TIMEOUT_MS: '2000' }))
      .toEqual({ maxBytes: 1000, maxPages: 5, timeoutMs: 2000 });
    expect(() => readPdfLimits({ VAULT_PDF_MAX_PAGES: 'many' })).toThrow('VAULT_PDF_MAX_PAGES');
    expect(() => readPdfLimits({ VAULT_PDF_MAX_BYTES: '0' })).toThrow('VAULT_PDF_MAX_BYTES');
  });

  it('applies the environment limits by default', async () => {
    vi.stubEnv('VAULT_PDF_MAX_PAGES', '2');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(extractPdfText(makePdf(3))).rejects.toThrow('PDF has more than 2 pages');
  });
});
