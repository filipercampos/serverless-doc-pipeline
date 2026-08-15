import { corruptPdf, pdfWithPages, sampleCsv } from '../../test/fixtures/files';
import { defaultExtractors } from '../adapters/extractors';
import { newPendingDocument, type Document } from '../domain/document';
import { parseDocumentId, parseTenantId } from '../domain/tenant';
import type { SupportedContentType } from '../domain/upload-policy';
import type { DocumentRepository } from './ports';
import { ProcessDocument, type DocumentEvents, type ObjectStore } from './process-document';

const tenantId = parseTenantId('acme');
const documentId = parseDocumentId('0198a0b2-3c1d-7e8f-9a2b-5c6d7e8f9a0b');
const key = `tenants/acme/documents/${documentId}`;
const now = new Date('2026-08-11T23:00:00Z');

function pending(contentType: SupportedContentType): Document {
  return newPendingDocument({
    tenantId,
    documentId,
    fileName: 'f',
    contentType,
    declaredSizeBytes: 10,
    now,
    pendingTtlSeconds: 60,
  });
}

function setup(opts: { doc?: Document | null; bytes?: Uint8Array | null; size?: number }) {
  let stored: Document | null = opts.doc === undefined ? pending('text/csv') : opts.doc;
  const repository: DocumentRepository = {
    create: jest.fn(),
    get: jest.fn(() => Promise.resolve(stored)),
    transition: jest.fn((next: Document, expected) => {
      if (stored?.status !== expected) return Promise.resolve(false);
      stored = next;
      return Promise.resolve(true);
    }),
  };
  const objects: ObjectStore = {
    read: jest.fn(() =>
      Promise.resolve(
        opts.bytes === null
          ? null
          : opts.bytes
            ? { sizeBytes: opts.bytes.length, bytes: opts.bytes }
            : { sizeBytes: opts.size ?? 0 },
      ),
    ),
    tag: jest.fn(() => Promise.resolve()),
  };
  const events: DocumentEvents = {
    processed: jest.fn(() => Promise.resolve()),
    rejected: jest.fn(() => Promise.resolve()),
  };
  const useCase = new ProcessDocument({
    repository,
    objects,
    events,
    extractors: defaultExtractors,
    clock: { now: () => now },
    maxBytes: 1024 * 1024,
  });
  return { useCase, repository, objects, events, current: () => stored };
}

describe('ProcessDocument', () => {
  it('processes valid content, stores metadata and emits DocumentProcessed', async () => {
    const { useCase, events, current } = setup({ bytes: sampleCsv });
    const result = await useCase.execute(key);
    expect(result.outcome).toBe('processed');
    expect(current()).toMatchObject({
      status: 'PROCESSED',
      sizeBytes: sampleCsv.length,
      metadata: { kind: 'csv', rowCount: 3 },
    });
    expect(events.processed).toHaveBeenCalledTimes(1);
  });

  it('counts pages of a PDF', async () => {
    const pdf = await pdfWithPages(4);
    const { useCase, current } = setup({ doc: pending('application/pdf'), bytes: pdf });
    await useCase.execute(key);
    expect(current()?.metadata).toMatchObject({ kind: 'pdf', pageCount: 4 });
  });

  it('rejects content that does not match the declared type and tags the object', async () => {
    const { useCase, objects, events, current } = setup({
      doc: pending('application/pdf'),
      bytes: Buffer.from('MZ-not-a-pdf'),
    });
    const result = await useCase.execute(key);
    expect(result.outcome).toBe('rejected');
    expect(current()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: expect.stringMatching(/PDF header/),
    });
    expect(objects.tag).toHaveBeenCalledWith(key, 'rejected');
    expect(events.rejected).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized objects without downloading them', async () => {
    const { useCase, current } = setup({ size: 5 * 1024 * 1024 });
    await useCase.execute(key);
    expect(current()).toMatchObject({ status: 'REJECTED', sizeBytes: 5 * 1024 * 1024 });
  });

  it('throws on parser crashes so the record is retried and eventually dead-lettered', async () => {
    const { useCase, repository, current } = setup({
      doc: pending('application/pdf'),
      bytes: corruptPdf,
    });
    await expect(useCase.execute(key)).rejects.toThrow();
    expect(repository.transition).not.toHaveBeenCalled();
    expect(current()?.status).toBe('PENDING_UPLOAD');
  });

  it('re-publishes instead of re-processing a document that is already terminal', async () => {
    const { useCase, objects, events } = setup({ bytes: sampleCsv });
    await useCase.execute(key);
    const second = await useCase.execute(key);
    expect(second).toEqual({ outcome: 'duplicate', documentId, republished: true });
    expect(objects.read).toHaveBeenCalledTimes(1);
    expect(events.processed).toHaveBeenCalledTimes(2);
  });

  it('does not publish when it loses the transition race', async () => {
    const { useCase, repository, events } = setup({ bytes: sampleCsv });
    (repository.transition as jest.Mock).mockResolvedValueOnce(false);
    await expect(useCase.execute(key)).resolves.toEqual({
      outcome: 'duplicate',
      documentId,
      republished: false,
    });
    expect(events.processed).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign key', 'uploads/evil.pdf', undefined],
    ['unknown document', key, null],
  ])('ignores and tags orphans (%s)', async (_name, objectKey, doc) => {
    const { useCase, objects } = setup({ doc, bytes: sampleCsv });
    await expect(useCase.execute(objectKey)).resolves.toMatchObject({ outcome: 'ignored' });
    expect(objects.tag).toHaveBeenCalledWith(objectKey, 'orphan');
  });

  it('ignores objects deleted before processing', async () => {
    const { useCase } = setup({ bytes: null });
    await expect(useCase.execute(key)).resolves.toMatchObject({ outcome: 'ignored' });
  });

  it('pins the processed S3 version and ignores later overwrites of the same key', async () => {
    const { useCase, objects, events, current } = setup({ bytes: sampleCsv });
    await useCase.execute(key, 'v1');
    expect(current()?.versionId).toBe('v1');
    expect(objects.read).toHaveBeenCalledWith(key, 1024 * 1024, 'v1');

    await expect(useCase.execute(key, 'v2')).resolves.toEqual({
      outcome: 'ignored',
      reason: 'object overwritten after processing',
    });
    expect(events.processed).toHaveBeenCalledTimes(1);
  });
});
