import { describe, it, expect, afterEach, vi } from 'vitest';
import { extractPdfText, readPdfLimits, PDF_LIMIT_DEFAULTS } from './extract-pdf';
import { makePdf } from './test-helpers/make-pdf';

// LBV2-30 audit M1: PDF extraction is bounded (bytes before parsing, pages, time, characters).

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
