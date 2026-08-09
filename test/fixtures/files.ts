import { PDFDocument } from 'pdf-lib';

export async function pdfWithPages(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return Buffer.from(await doc.save());
}

/** Passes the magic-byte check but crashes the PDF parser: our "poison" file. */
export const corruptPdf = Buffer.from('%PDF-1.4\nthis is not a pdf\n%%EOF', 'latin1');

export const sampleCsv = Buffer.from('id,amount,currency\n1,10.00,BRL\n2,20.00,BRL\n3,7.50,USD\n');

export const sampleJson = Buffer.from(JSON.stringify({ invoice: 'INV-1', lines: [], total: 0 }));
