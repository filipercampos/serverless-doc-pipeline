import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetObjectCommand, NoSuchKey, PutObjectTaggingCommand, S3Client } from '@aws-sdk/client-s3';
import { sdkStreamMixin } from '@smithy/util-stream';
import { mockClient } from 'aws-sdk-client-mock';
import { Readable } from 'node:stream';
import { newPendingDocument, markProcessed } from '../domain/document';
import { parseDocumentId, parseTenantId } from '../domain/tenant';
import { EventBridgeDocumentEvents } from './eventbridge-events';
import { S3ObjectStore } from './s3-object-store';

const s3 = mockClient(S3Client);
const eb = mockClient(EventBridgeClient);

beforeEach(() => {
  s3.reset();
  eb.reset();
});

describe('S3ObjectStore', () => {
  const store = new S3ObjectStore(new S3Client({}), 'bucket');

  it('buffers bodies within the limit', async () => {
    s3.on(GetObjectCommand).resolves({
      ContentLength: 3,
      Body: sdkStreamMixin(Readable.from([Buffer.from('abc')])),
    });
    const obj = await store.read('k', 10);
    expect(Buffer.from(obj!.bytes!).toString()).toBe('abc');
  });

  it('reports size only for oversized objects', async () => {
    s3.on(GetObjectCommand).resolves({
      ContentLength: 11,
      Body: sdkStreamMixin(Readable.from([Buffer.alloc(11)])),
    });
    await expect(store.read('k', 10)).resolves.toEqual({ sizeBytes: 11 });
  });

  it('returns null for missing objects', async () => {
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: 'gone', $metadata: {} }));
    await expect(store.read('k', 10)).resolves.toBeNull();
  });

  it('tags objects for lifecycle expiry', async () => {
    s3.on(PutObjectTaggingCommand).resolves({});
    await store.tag('k', 'rejected');
    expect(s3.commandCalls(PutObjectTaggingCommand)[0]!.args[0].input.Tagging).toEqual({
      TagSet: [{ Key: 'pipeline-status', Value: 'rejected' }],
    });
  });
});

describe('EventBridgeDocumentEvents', () => {
  const events = new EventBridgeDocumentEvents(new EventBridgeClient({}), 'bus');
  const now = new Date('2026-08-11T23:00:00Z');
  const doc = markProcessed(
    newPendingDocument({
      tenantId: parseTenantId('acme'),
      documentId: parseDocumentId('0198a0b2-3c1d-7e8f-9a2b-5c6d7e8f9a0b'),
      fileName: 'f.json',
      contentType: 'application/json',
      declaredSizeBytes: 2,
      now,
      pendingTtlSeconds: 60,
    }),
    {
      sizeBytes: 2,
      sha256: 'ab',
      metadata: { kind: 'json', topLevelType: 'object', topLevelKeys: 0 },
    },
    now,
  );

  it('publishes DocumentProcessed with a deterministic event id', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: '1' }] });
    await events.processed(doc);
    const entry = eb.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!;
    expect(entry).toMatchObject({ EventBusName: 'bus', DetailType: 'DocumentProcessed' });
    expect(JSON.parse(entry.Detail!)).toMatchObject({
      schemaVersion: 1,
      eventId: '0198a0b2-3c1d-7e8f-9a2b-5c6d7e8f9a0b:PROCESSED',
      tenantId: 'acme',
      sha256: 'ab',
    });
  });

  it('throws on per-entry failures reported with HTTP 200', async () => {
    eb.on(PutEventsCommand).resolves({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'slow down' }],
    });
    await expect(events.processed(doc)).rejects.toThrow('ThrottlingException');
  });

  it('refuses to publish a document in the wrong state', () => {
    expect(() => events.rejected(doc)).toThrow('not rejected');
  });
});
