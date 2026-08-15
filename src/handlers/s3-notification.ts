import type { S3Event } from 'aws-lambda';

export interface S3ObjectRef {
  bucket: string;
  /** Decoded object key (S3 event keys are URL-encoded with '+' for spaces). */
  key: string;
  size: number;
  eTag?: string;
  /** Present when bucket versioning is enabled. */
  versionId?: string;
  /** Orders events for the same key; identical across duplicate deliveries of one event. */
  sequencer: string;
}

export class MalformedNotificationError extends Error {}

/**
 * Parses the body of an SQS message produced by an S3 event notification.
 * - `s3:TestEvent` (sent once when the notification is configured) yields no objects.
 * - Non-`ObjectCreated` events are skipped.
 * - A body that is not an S3 notification throws: it can only be fixed by a human, so it
 *   is allowed to fail through to the DLQ.
 */
export function parseS3Notification(body: string): S3ObjectRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new MalformedNotificationError('SQS body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MalformedNotificationError('SQS body is not an object');
  }
  if ((parsed as { Event?: unknown }).Event === 's3:TestEvent') return [];

  const records = (parsed as Partial<S3Event>).Records;
  if (!Array.isArray(records)) {
    throw new MalformedNotificationError('SQS body is not an S3 event notification');
  }

  return records
    .filter((r) => typeof r.eventName === 'string' && r.eventName.startsWith('ObjectCreated:'))
    .map((r) => ({
      bucket: r.s3.bucket.name,
      key: decodeURIComponent(r.s3.object.key.replace(/\+/g, ' ')),
      size: r.s3.object.size,
      eTag: r.s3.object.eTag,
      versionId: r.s3.object.versionId,
      sequencer: r.s3.object.sequencer,
    }));
}
