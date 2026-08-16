import type { Document } from '../domain/document';
import { ValidationError } from '../domain/errors';
import { parseTenantId } from '../domain/tenant';
import { DEFAULT_UPLOAD_POLICY } from '../domain/upload-policy';
import type { DocumentRepository, UploadSigner } from './ports';
import { RequestUpload } from './request-upload';

const tenantId = parseTenantId('acme');
const id = '0b7e4f6a-3c1d-4e8f-9a2b-5c6d7e8f9a0b';

function setup() {
  const created: Document[] = [];
  const repository: DocumentRepository = {
    create: jest.fn((doc: Document) => {
      created.push(doc);
      return Promise.resolve();
    }),
    get: jest.fn(),
    list: jest.fn(),
    transition: jest.fn(),
  };
  const signer: UploadSigner = {
    sign: jest.fn(() => Promise.resolve({ url: 'https://bucket', fields: { key: 'k' } })),
  };
  const useCase = new RequestUpload({
    repository,
    signer,
    clock: { now: () => new Date('2026-08-06T23:00:00.000Z') },
    policy: DEFAULT_UPLOAD_POLICY,
    pendingTtlSeconds: 3600,
    newId: () => id,
  });
  return { useCase, repository, signer, created };
}

describe('RequestUpload', () => {
  it('persists a pending record and signs a tenant-scoped upload', async () => {
    const { useCase, signer, created } = setup();

    const ticket = await useCase.execute(tenantId, {
      fileName: 'q3.csv',
      contentType: 'text/csv',
      sizeBytes: 2048,
    });

    expect(ticket).toEqual({
      documentId: id,
      upload: { url: 'https://bucket', fields: { key: 'k' } },
      expiresAt: '2026-08-06T23:05:00.000Z',
      maxBytes: DEFAULT_UPLOAD_POLICY.maxBytes,
    });
    expect(created[0]).toMatchObject({
      tenantId: 'acme',
      status: 'PENDING_UPLOAD',
      objectKey: `tenants/acme/documents/${id}`,
      declaredSizeBytes: 2048,
    });
    expect(signer.sign).toHaveBeenCalledWith({
      key: `tenants/acme/documents/${id}`,
      contentType: 'text/csv',
      maxBytes: DEFAULT_UPLOAD_POLICY.maxBytes,
      ttlSeconds: DEFAULT_UPLOAD_POLICY.urlTtlSeconds,
    });
  });

  it.each([
    [null],
    [{ fileName: 'a.exe', contentType: 'application/x-msdownload', sizeBytes: 1 }],
    [{ fileName: '../a.pdf', contentType: 'application/pdf', sizeBytes: 1 }],
    [{ fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 50 * 1024 * 1024 }],
  ])('rejects invalid input %p without side effects', async (body) => {
    const { useCase, repository, signer } = setup();
    await expect(useCase.execute(tenantId, body)).rejects.toBeInstanceOf(ValidationError);
    expect(repository.create).not.toHaveBeenCalled();
    expect(signer.sign).not.toHaveBeenCalled();
  });

  it('does not sign when the record cannot be stored', async () => {
    const { useCase, repository, signer } = setup();
    (repository.create as jest.Mock).mockRejectedValueOnce(new Error('throttled'));
    await expect(
      useCase.execute(tenantId, {
        fileName: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 9,
      }),
    ).rejects.toThrow('throttled');
    expect(signer.sign).not.toHaveBeenCalled();
  });
});
