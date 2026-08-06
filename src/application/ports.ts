import type { Document, DocumentStatus } from '../domain/document';
import type { DocumentId, TenantId } from '../domain/tenant';
import type { SupportedContentType } from '../domain/upload-policy';

/** Persistence for document records. Implementations must keep tenants in separate partitions. */
export interface DocumentRepository {
  /** Inserts a new record; fails if the id already exists. */
  create(doc: Document): Promise<void>;
  get(tenantId: TenantId, documentId: DocumentId): Promise<Document | null>;
  /**
   * Writes `next` only if the stored status still equals `expected` (optimistic transition).
   * Returns false when another writer got there first.
   */
  transition(next: Document, expected: DocumentStatus): Promise<boolean>;
}

export interface UploadRequest {
  key: string;
  contentType: SupportedContentType;
  maxBytes: number;
  ttlSeconds: number;
}

export interface SignedUpload {
  /** Form action URL. */
  url: string;
  /** Form fields the client must send before the `file` field. */
  fields: Record<string, string>;
}

/** Issues a browser-compatible upload that S3 itself validates (key, size range, content type). */
export interface UploadSigner {
  sign(request: UploadRequest): Promise<SignedUpload>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
