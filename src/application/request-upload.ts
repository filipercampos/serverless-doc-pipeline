import { randomUUID } from 'node:crypto';
import { newPendingDocument } from '../domain/document';
import { ValidationError } from '../domain/errors';
import { parseDocumentId, type DocumentId, type TenantId } from '../domain/tenant';
import {
  parseContentType,
  parseDeclaredSize,
  parseFileName,
  type UploadPolicy,
} from '../domain/upload-policy';
import type { Clock, DocumentRepository, SignedUpload, UploadSigner } from './ports';

export interface RequestUploadDeps {
  repository: DocumentRepository;
  signer: UploadSigner;
  clock: Clock;
  policy: UploadPolicy;
  /** How long a PENDING_UPLOAD record lives if the client never uploads (DynamoDB TTL). */
  pendingTtlSeconds: number;
  newId?: () => string;
}

export interface UploadTicket {
  documentId: DocumentId;
  upload: SignedUpload;
  expiresAt: string;
  maxBytes: number;
}

export class RequestUpload {
  private readonly newId: () => string;

  constructor(private readonly deps: RequestUploadDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  async execute(tenantId: TenantId, body: unknown): Promise<UploadTicket> {
    if (typeof body !== 'object' || body === null) {
      throw new ValidationError('request body must be a JSON object');
    }
    const input = body as Record<string, unknown>;
    const fileName = parseFileName(input.fileName);
    const contentType = parseContentType(input.contentType);
    const declaredSizeBytes = parseDeclaredSize(input.sizeBytes, this.deps.policy);

    const now = this.deps.clock.now();
    const doc = newPendingDocument({
      tenantId,
      documentId: parseDocumentId(this.newId()),
      fileName,
      contentType,
      declaredSizeBytes,
      now,
      pendingTtlSeconds: this.deps.pendingTtlSeconds,
    });

    // Record first, then sign: an upload can never arrive for a document we do not know about.
    await this.deps.repository.create(doc);

    const upload = await this.deps.signer.sign({
      key: doc.objectKey,
      contentType,
      // The declared size is advisory; S3 enforces the policy maximum, so a client that lied
      // about the size is caught by the processor (size mismatch is not a rejection reason).
      maxBytes: this.deps.policy.maxBytes,
      ttlSeconds: this.deps.policy.urlTtlSeconds,
    });

    return {
      documentId: doc.documentId,
      upload,
      expiresAt: new Date(now.getTime() + this.deps.policy.urlTtlSeconds * 1000).toISOString(),
      maxBytes: this.deps.policy.maxBytes,
    };
  }
}
