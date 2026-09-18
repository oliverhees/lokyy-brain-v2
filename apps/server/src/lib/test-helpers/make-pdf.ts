// Test helper (LBV2-30): a minimal PDF with one text line per page ("Page N marker").
// There is no xref table; pdfjs rebuilds it, which is enough for text extraction.
export function makePdf(pages: number): Uint8Array {
  const objs: string[] = ['<</Type/Catalog/Pages 2 0 R>>'];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push(`<</Type/Pages/Kids[${kids}]/Count ${pages}>>`);
  objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 12 Tf 10 50 Td (Page ${i + 1} marker) Tj ET`;
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents ${5 + i * 2} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`);
    objs.push(`<</Length ${stream.length}>>stream\n${stream}\nendstream`);
  }
  const body = objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj`).join('\n');
  return new TextEncoder().encode(`%PDF-1.4\n${body}\ntrailer<</Root 1 0 R>>\n%%EOF`);
}
