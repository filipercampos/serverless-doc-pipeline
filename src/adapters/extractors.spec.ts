import { corruptPdf, pdfWithPages, sampleCsv, sampleJson } from '../../test/fixtures/files';
import { inspectContent, sha256Hex } from '../application/inspect-content';
import { ContentRejectedError } from '../domain/errors';
import { defaultExtractors } from './extractors';

const inspect = (bytes: Uint8Array, type: 'application/pdf' | 'text/csv' | 'application/json') =>
  inspectContent(bytes, type, defaultExtractors);

describe('content inspection', () => {
  it('counts PDF pages and reads the header version', async () => {
    const pdf = await pdfWithPages(3);
    const result = await inspect(pdf, 'application/pdf');
    expect(result).toEqual({
      sizeBytes: pdf.length,
      sha256: sha256Hex(pdf),
      metadata: { kind: 'pdf', pageCount: 3, pdfVersion: '1.7', encrypted: false },
    });
  });

  it('describes CSV shape without returning row data', async () => {
    const result = await inspect(sampleCsv, 'text/csv');
    expect(result.metadata).toEqual({
      kind: 'csv',
      rowCount: 3,
      columnCount: 3,
      header: ['id', 'amount', 'currency'],
    });
  });

  it('accepts a UTF-8 BOM in text formats', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), sampleCsv]);
    await expect(inspect(withBom, 'text/csv')).resolves.toMatchObject({
      metadata: { header: ['id', 'amount', 'currency'] },
    });
  });

  it('describes JSON top-level structure', async () => {
    await expect(inspect(sampleJson, 'application/json')).resolves.toMatchObject({
      metadata: { kind: 'json', topLevelType: 'object', topLevelKeys: 3 },
    });
    await expect(inspect(Buffer.from('[1,2]'), 'application/json')).resolves.toMatchObject({
      metadata: { topLevelType: 'array', topLevelKeys: 2 },
    });
  });

  it.each([
    ['empty file', Buffer.alloc(0), 'text/csv'],
    ['executable disguised as PDF', Buffer.from('MZ\x90\x00binary', 'latin1'), 'application/pdf'],
    ['PDF disguised as CSV', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe]), 'text/csv'],
    ['NUL bytes in JSON', Buffer.from('{"a":"\u0000"}'), 'application/json'],
    ['malformed JSON', Buffer.from('{"a":'), 'application/json'],
    ['JSON scalar', Buffer.from('42'), 'application/json'],
    ['ragged CSV', Buffer.from('a,b\n1,2,3\n'), 'text/csv'],
    ['unterminated CSV quote', Buffer.from('a,b\n"1,2\n'), 'text/csv'],
  ] as const)('rejects %s', async (_name, bytes, type) => {
    await expect(inspect(bytes, type)).rejects.toBeInstanceOf(ContentRejectedError);
  });

  it('lets parser crashes on corrupt PDFs surface as unknown errors (retry, then DLQ)', async () => {
    const error = await inspect(corruptPdf, 'application/pdf').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ContentRejectedError);
  });
});
