import type { Document, DocumentMetadata } from '../domain/document';

/**
 * Public contract of the events this service emits on EventBridge.
 * Additive changes only; a breaking change means a new `detail-type` (e.g. DocumentProcessed.v2).
 */
export const EVENT_SOURCE = 'doc-pipeline.documents';

export interface DocumentProcessedDetail {
  schemaVersion: 1;
  /** Deterministic: consumers de-duplicate on it (events are at-least-once). */
  eventId: string;
  tenantId: string;
  documentId: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  metadata: DocumentMetadata;
  processedAt: string;
}

export interface DocumentRejectedDetail {
  schemaVersion: 1;
  eventId: string;
  tenantId: string;
  documentId: string;
  contentType: string;
  reason: string;
  rejectedAt: string;
}

export function processedDetail(doc: Document): DocumentProcessedDetail {
  if (doc.status !== 'PROCESSED' || !doc.sha256 || !doc.metadata || doc.sizeBytes === undefined) {
    throw new Error(`document ${doc.documentId} is not processed`);
  }
  return {
    schemaVersion: 1,
    eventId: `${doc.documentId}:PROCESSED`,
    tenantId: doc.tenantId,
    documentId: doc.documentId,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    sha256: doc.sha256,
    metadata: doc.metadata,
    processedAt: doc.processedAt ?? doc.updatedAt,
  };
}

export function rejectedDetail(doc: Document): DocumentRejectedDetail {
  if (doc.status !== 'REJECTED') throw new Error(`document ${doc.documentId} is not rejected`);
  return {
    schemaVersion: 1,
    eventId: `${doc.documentId}:REJECTED`,
    tenantId: doc.tenantId,
    documentId: doc.documentId,
    contentType: doc.contentType,
    reason: doc.rejectionReason ?? 'unknown',
    rejectedAt: doc.processedAt ?? doc.updatedAt,
  };
}
