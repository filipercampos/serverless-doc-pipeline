import type { Document, DocumentMetadata, DocumentStatus } from '../domain/document';
import { DocumentNotFoundError, ValidationError } from '../domain/errors';
import { parseDocumentId, type TenantId } from '../domain/tenant';
import type { DocumentRepository, Page } from './ports';

/** Public representation. Internal fields (object key, S3 version, TTL) are not exposed. */
export interface DocumentView {
  documentId: string;
  fileName: string;
  contentType: string;
  status: DocumentStatus;
  createdAt: string;
  processedAt?: string;
  sizeBytes?: number;
  sha256?: string;
  metadata?: DocumentMetadata;
  rejectionReason?: string;
}

export function toView(doc: Document): DocumentView {
  return {
    documentId: doc.documentId,
    fileName: doc.fileName,
    contentType: doc.contentType,
    status: doc.status,
    createdAt: doc.createdAt,
    processedAt: doc.processedAt,
    sizeBytes: doc.sizeBytes,
    sha256: doc.sha256,
    metadata: doc.metadata,
    rejectionReason: doc.rejectionReason,
  };
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export class QueryDocuments {
  constructor(private readonly repository: DocumentRepository) {}

  /** Unknown ids and other tenants' ids are indistinguishable: both are 404. */
  async get(tenantId: TenantId, rawId: unknown): Promise<DocumentView> {
    let documentId;
    try {
      documentId = parseDocumentId(rawId);
    } catch {
      throw new DocumentNotFoundError('document not found');
    }
    const doc = await this.repository.get(tenantId, documentId);
    if (!doc) throw new DocumentNotFoundError('document not found');
    return toView(doc);
  }

  async list(
    tenantId: TenantId,
    query: { limit?: string; cursor?: string } = {},
  ): Promise<Page<DocumentView>> {
    const limit = query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new ValidationError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }
    const page = await this.repository.list(tenantId, { limit, cursor: query.cursor });
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }
}
