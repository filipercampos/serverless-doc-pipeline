import { markProcessed, markRejected, type Document } from '../domain/document';
import { ContentRejectedError } from '../domain/errors';
import { parseObjectKey } from '../domain/object-key';
import { inspectContent, type MetadataExtractors } from './inspect-content';
import type { Clock, DocumentRepository } from './ports';

export interface StoredObject {
  sizeBytes: number;
  /** Absent when the object is larger than the read limit (body not downloaded). */
  bytes?: Uint8Array;
}

export interface ObjectStore {
  /** Returns null if the object no longer exists. Never buffers more than `maxBytes`. */
  read(key: string, maxBytes: number): Promise<StoredObject | null>;
  /** Marks an object so the bucket lifecycle can expire it (rejected / orphaned uploads). */
  tag(key: string, status: 'rejected' | 'orphan'): Promise<void>;
}

export interface DocumentEvents {
  processed(doc: Document): Promise<void>;
  rejected(doc: Document): Promise<void>;
}

export type ProcessOutcome =
  | { outcome: 'processed'; doc: Document }
  | { outcome: 'rejected'; doc: Document }
  /**
   * Already terminal. Reached only when the idempotency layer let a redelivery through
   * (previous attempt failed after the write, or the idempotency record expired).
   * The event is re-published because the failed attempt may have died before publishing:
   * events are at-least-once and carry a deterministic `eventId` for consumer de-duplication.
   */
  | { outcome: 'duplicate'; documentId: string; republished: boolean }
  /** Not a document we issued an upload for, or it disappeared. Acknowledged, never retried. */
  | { outcome: 'ignored'; reason: string };

export interface ProcessDocumentDeps {
  repository: DocumentRepository;
  objects: ObjectStore;
  events: DocumentEvents;
  extractors: MetadataExtractors;
  clock: Clock;
  maxBytes: number;
}

/**
 * Validates one uploaded object and records the result.
 *
 * Error contract (ADR 0006):
 * - content problems → REJECTED, resolved normally (message deleted);
 * - anything else (S3/DynamoDB failures, parser crashes) → thrown, so the SQS record is
 *   reported as a batch item failure, retried, and eventually dead-lettered.
 */
export class ProcessDocument {
  constructor(private readonly deps: ProcessDocumentDeps) {}

  async execute(objectKey: string): Promise<ProcessOutcome> {
    const { repository, objects, clock } = this.deps;

    const parsed = parseObjectKey(objectKey);
    if (!parsed) {
      await objects.tag(objectKey, 'orphan');
      return { outcome: 'ignored', reason: 'key outside tenant layout' };
    }

    const doc = await repository.get(parsed.tenantId, parsed.documentId);
    if (!doc) {
      await objects.tag(objectKey, 'orphan');
      return { outcome: 'ignored', reason: 'no document record' };
    }
    if (doc.status !== 'PENDING_UPLOAD') {
      await this.publish(doc);
      return { outcome: 'duplicate', documentId: doc.documentId, republished: true };
    }

    const object = await objects.read(objectKey, this.deps.maxBytes);
    if (!object) return { outcome: 'ignored', reason: 'object no longer exists' };

    let next: Document;
    if (!object.bytes) {
      next = markRejected(doc, `file exceeds ${this.deps.maxBytes} bytes`, clock.now(), {
        sizeBytes: object.sizeBytes,
      });
    } else {
      try {
        const result = await inspectContent(object.bytes, doc.contentType, this.deps.extractors);
        next = markProcessed(doc, result, clock.now());
      } catch (err) {
        if (!(err instanceof ContentRejectedError)) throw err;
        next = markRejected(doc, err.message, clock.now(), { sizeBytes: object.sizeBytes });
      }
    }

    // Conditional write: only one concurrent delivery can move the document out of PENDING_UPLOAD.
    const applied = await repository.transition(next, 'PENDING_UPLOAD');
    // The winner of the race publishes; the loser must not.
    if (!applied) return { outcome: 'duplicate', documentId: doc.documentId, republished: false };

    if (next.status === 'REJECTED') await objects.tag(objectKey, 'rejected');
    await this.publish(next);
    return next.status === 'PROCESSED'
      ? { outcome: 'processed', doc: next }
      : { outcome: 'rejected', doc: next };
  }

  private publish(doc: Document): Promise<void> {
    if (doc.status === 'PROCESSED') return this.deps.events.processed(doc);
    if (doc.status === 'REJECTED') return this.deps.events.rejected(doc);
    return Promise.resolve();
  }
}
