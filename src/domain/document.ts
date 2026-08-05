import { InvalidTransitionError } from './errors';
import { objectKeyFor } from './object-key';
import type { DocumentId, TenantId } from './tenant';
import type { SupportedContentType } from './upload-policy';

/**
 * PENDING_UPLOAD -> PROCESSED
 *                -> REJECTED   (content failed validation; terminal, never retried)
 */
export type DocumentStatus = 'PENDING_UPLOAD' | 'PROCESSED' | 'REJECTED';

export type DocumentMetadata =
  | { kind: 'pdf'; pageCount: number; pdfVersion: string | null; encrypted: boolean }
  | { kind: 'csv'; rowCount: number; columnCount: number; header: string[] }
  | { kind: 'json'; topLevelType: 'object' | 'array'; topLevelKeys: number };

export interface Document {
  tenantId: TenantId;
  documentId: DocumentId;
  objectKey: string;
  fileName: string;
  contentType: SupportedContentType;
  declaredSizeBytes: number;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
  /** Epoch seconds; pending records that never receive an upload are expired by DynamoDB TTL. */
  expiresAt?: number;
  sizeBytes?: number;
  sha256?: string;
  metadata?: DocumentMetadata;
  rejectionReason?: string;
  processedAt?: string;
}

export interface NewDocumentInput {
  tenantId: TenantId;
  documentId: DocumentId;
  fileName: string;
  contentType: SupportedContentType;
  declaredSizeBytes: number;
  now: Date;
  /** Seconds the pending record is kept if the client never uploads. */
  pendingTtlSeconds: number;
}

export function newPendingDocument(input: NewDocumentInput): Document {
  const now = input.now.toISOString();
  return {
    tenantId: input.tenantId,
    documentId: input.documentId,
    objectKey: objectKeyFor(input.tenantId, input.documentId),
    fileName: input.fileName,
    contentType: input.contentType,
    declaredSizeBytes: input.declaredSizeBytes,
    status: 'PENDING_UPLOAD',
    createdAt: now,
    updatedAt: now,
    expiresAt: Math.floor(input.now.getTime() / 1000) + input.pendingTtlSeconds,
  };
}

export interface ProcessingResult {
  sizeBytes: number;
  sha256: string;
  metadata: DocumentMetadata;
}

function assertPending(doc: Document, target: DocumentStatus): void {
  if (doc.status !== 'PENDING_UPLOAD') {
    throw new InvalidTransitionError(
      `document ${doc.documentId} is ${doc.status}, cannot become ${target}`,
    );
  }
}

export function markProcessed(doc: Document, result: ProcessingResult, now: Date): Document {
  assertPending(doc, 'PROCESSED');
  const { expiresAt: _expiresAt, ...rest } = doc;
  return {
    ...rest,
    ...result,
    status: 'PROCESSED',
    processedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function markRejected(
  doc: Document,
  reason: string,
  now: Date,
  observed?: { sizeBytes: number; sha256?: string },
): Document {
  assertPending(doc, 'REJECTED');
  const { expiresAt: _expiresAt, ...rest } = doc;
  return {
    ...rest,
    ...observed,
    status: 'REJECTED',
    rejectionReason: reason,
    processedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}
