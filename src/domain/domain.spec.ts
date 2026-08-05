import { markProcessed, markRejected, newPendingDocument } from './document';
import { InvalidTransitionError, ValidationError } from './errors';
import { objectKeyFor, parseObjectKey } from './object-key';
import { parseDocumentId, parseTenantId } from './tenant';
import {
  DEFAULT_UPLOAD_POLICY,
  parseContentType,
  parseDeclaredSize,
  parseFileName,
} from './upload-policy';

const tenantId = parseTenantId('acme');
const documentId = parseDocumentId('0b7e4f6a-3c1d-4e8f-9a2b-5c6d7e8f9a0b');
const now = new Date('2026-08-04T12:00:00.000Z');

describe('tenant and document ids', () => {
  it.each(['acme', 'tenant-42', 'a1'])('accepts %s', (raw) => {
    expect(parseTenantId(raw)).toBe(raw);
  });

  it.each(['', 'A', 'ACME', '../acme', 'acme/other', 'acme#1', 'a', '-acme', 42, undefined])(
    'rejects tenant %p',
    (raw) => {
      expect(() => parseTenantId(raw)).toThrow(ValidationError);
    },
  );

  it('rejects non-uuid document ids', () => {
    expect(() => parseDocumentId('not-a-uuid')).toThrow(ValidationError);
    expect(() => parseDocumentId(documentId.toUpperCase())).toThrow(ValidationError);
  });
});

describe('object keys', () => {
  it('round-trips tenant-scoped keys', () => {
    const key = objectKeyFor(tenantId, documentId);
    expect(key).toBe(`tenants/acme/documents/${documentId}`);
    expect(parseObjectKey(key)).toEqual({ tenantId, documentId });
  });

  it.each([
    'tenants/acme/documents',
    `tenants/acme/documents/${documentId}/extra`,
    `tenants/ACME/documents/${documentId}`,
    `other/acme/documents/${documentId}`,
    `tenants/acme/files/${documentId}`,
    'tenants/acme/documents/../../x',
  ])('returns null for foreign key %s', (key) => {
    expect(parseObjectKey(key)).toBeNull();
  });
});

describe('upload policy', () => {
  it('normalizes content types and rejects unsupported ones', () => {
    expect(parseContentType('Text/CSV; charset=utf-8')).toBe('text/csv');
    expect(() => parseContentType('image/svg+xml')).toThrow(ValidationError);
    expect(() => parseContentType(undefined)).toThrow(ValidationError);
  });

  it('rejects file names with path separators or control characters', () => {
    expect(parseFileName(' invoice 2026-08.pdf ')).toBe('invoice 2026-08.pdf');
    for (const bad of ['', '..', 'a/b.pdf', 'a\\b.pdf', 'a\u0000.pdf', 'x'.repeat(256)]) {
      expect(() => parseFileName(bad)).toThrow(ValidationError);
    }
  });

  it('bounds the declared size', () => {
    expect(parseDeclaredSize(1024, DEFAULT_UPLOAD_POLICY)).toBe(1024);
    expect(() => parseDeclaredSize(0, DEFAULT_UPLOAD_POLICY)).toThrow(ValidationError);
    expect(() => parseDeclaredSize(1.5, DEFAULT_UPLOAD_POLICY)).toThrow(ValidationError);
    expect(() =>
      parseDeclaredSize(DEFAULT_UPLOAD_POLICY.maxBytes + 1, DEFAULT_UPLOAD_POLICY),
    ).toThrow(ValidationError);
  });
});

describe('document lifecycle', () => {
  const pending = newPendingDocument({
    tenantId,
    documentId,
    fileName: 'report.csv',
    contentType: 'text/csv',
    declaredSizeBytes: 100,
    now,
    pendingTtlSeconds: 86_400,
  });

  it('starts pending with a TTL and a tenant-scoped key', () => {
    expect(pending.status).toBe('PENDING_UPLOAD');
    expect(pending.objectKey).toBe(`tenants/acme/documents/${documentId}`);
    expect(pending.expiresAt).toBe(Math.floor(now.getTime() / 1000) + 86_400);
  });

  it('becomes processed and drops the TTL', () => {
    const done = markProcessed(
      pending,
      {
        sizeBytes: 90,
        sha256: 'ab'.repeat(32),
        metadata: { kind: 'csv', rowCount: 2, columnCount: 3, header: ['a', 'b', 'c'] },
      },
      now,
    );
    expect(done.status).toBe('PROCESSED');
    expect(done.expiresAt).toBeUndefined();
    expect(() => markRejected(done, 'late', now)).toThrow(InvalidTransitionError);
  });

  it('can be rejected once, terminally', () => {
    const rejected = markRejected(pending, 'content does not match declared type', now, {
      sizeBytes: 5,
    });
    expect(rejected).toMatchObject({ status: 'REJECTED', sizeBytes: 5 });
    expect(() =>
      markProcessed(
        rejected,
        {
          sizeBytes: 1,
          sha256: 'x',
          metadata: { kind: 'json', topLevelType: 'array', topLevelKeys: 0 },
        },
        now,
      ),
    ).toThrow(InvalidTransitionError);
  });
});
