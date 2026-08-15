import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { marshall } from '@aws-sdk/util-dynamodb';
import { GetObjectCommand, PutObjectTaggingCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { sdkStreamMixin } from '@smithy/util-stream';
import { mockClient } from 'aws-sdk-client-mock';
import { Readable } from 'node:stream';
import { corruptPdf, sampleCsv } from '../../test/fixtures/files';
import {
  lambdaContext,
  s3NotificationBody,
  sqsEvent,
  sqsRecord,
} from '../../test/fixtures/sqs-event';
import { toItem } from '../adapters/dynamodb-document-repository';
import { newPendingDocument } from '../domain/document';
import { parseDocumentId, parseTenantId } from '../domain/tenant';
import type { SupportedContentType } from '../domain/upload-policy';
import { handler } from './process-uploads';

const ddb = mockClient(DynamoDBDocumentClient);
// The idempotency persistence layer talks to the low-level client directly.
const idem = mockClient(DynamoDBClient);
const s3 = mockClient(S3Client);
const eb = mockClient(EventBridgeClient);

const csvId = parseDocumentId('0198a0b2-3c1d-7e8f-9a2b-5c6d7e8f9a01');
const pdfId = parseDocumentId('0198a0b2-3c1d-7e8f-9a2b-5c6d7e8f9a02');
const keyOf = (id: string) => `tenants/acme/documents/${id}`;

function pendingItem(documentId: typeof csvId, contentType: SupportedContentType) {
  return toItem(
    newPendingDocument({
      tenantId: parseTenantId('acme'),
      documentId,
      fileName: 'f',
      contentType,
      declaredSizeBytes: 10,
      now: new Date('2026-08-13T22:00:00Z'),
      pendingTtlSeconds: 60,
    }),
  );
}

function body(bytes: Buffer) {
  return { ContentLength: bytes.length, Body: sdkStreamMixin(Readable.from([bytes])) };
}

beforeEach(() => {
  ddb.reset();
  idem.reset();
  idem.on(PutItemCommand).resolves({});
  idem.on(UpdateItemCommand).resolves({});
  idem.on(DeleteItemCommand).resolves({});
  s3.reset();
  eb.reset();
  ddb.on(GetCommand, { Key: { PK: 'TENANT#acme', SK: `DOC#${csvId}` } }).resolves({
    Item: pendingItem(csvId, 'text/csv'),
  });
  ddb.on(GetCommand, { Key: { PK: 'TENANT#acme', SK: `DOC#${pdfId}` } }).resolves({
    Item: pendingItem(pdfId, 'application/pdf'),
  });
  ddb.on(PutCommand).resolves({});
  s3.on(GetObjectCommand, { Key: keyOf(csvId) }).callsFake(() => body(sampleCsv));
  s3.on(GetObjectCommand, { Key: keyOf(pdfId) }).callsFake(() => body(corruptPdf));
  s3.on(PutObjectTaggingCommand).resolves({});
  eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
});

describe('process-uploads handler', () => {
  it('reports only the poison message as a batch item failure', async () => {
    const res = await handler(
      sqsEvent(
        sqsRecord('good', s3NotificationBody(keyOf(csvId))),
        sqsRecord('poison', s3NotificationBody(keyOf(pdfId))),
      ),
      lambdaContext(),
    );

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'poison' }] });
    const written = ddb.commandCalls(PutCommand).map((c) => c.args[0].input.Item);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ documentId: csvId, status: 'PROCESSED' });
    expect(eb.commandCalls(PutEventsCommand)).toHaveLength(1);
  });

  it('acknowledges S3 test events and non-create events', async () => {
    const res = await handler(
      sqsEvent(
        sqsRecord('test', JSON.stringify({ Event: 's3:TestEvent', Bucket: 'uploads-test' })),
        sqsRecord(
          'delete',
          s3NotificationBody(keyOf(csvId), { eventName: 'ObjectRemoved:Delete' }),
        ),
      ),
      lambdaContext(),
    );
    expect(res.batchItemFailures).toEqual([]);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it('fails malformed messages so they reach the DLQ', async () => {
    const res = await handler(sqsEvent(sqsRecord('junk', 'not json')), lambdaContext());
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'junk' }]);
  });

  it('ignores objects from unexpected buckets', async () => {
    const res = await handler(
      sqsEvent(sqsRecord('other', s3NotificationBody(keyOf(csvId), { bucket: 'someone-else' }))),
      lambdaContext(),
    );
    expect(res.batchItemFailures).toEqual([]);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('retries transient infrastructure errors', async () => {
    ddb.on(PutCommand).rejects(new Error('ThrottlingException'));
    const res = await handler(
      sqsEvent(sqsRecord('m1', s3NotificationBody(keyOf(csvId)))),
      lambdaContext(),
    );
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });

  describe('idempotency', () => {
    it('stores the result keyed on bucket, key and sequencer', async () => {
      await handler(sqsEvent(sqsRecord('m1', s3NotificationBody(keyOf(csvId)))), lambdaContext());

      const put = idem.commandCalls(PutItemCommand)[0]!.args[0].input;
      expect(put.TableName).toBe('idempotency-test');
      expect(put.Item?.status?.S).toBe('INPROGRESS');
      const update = idem.commandCalls(UpdateItemCommand)[0]!.args[0].input;
      expect(JSON.stringify(update.ExpressionAttributeValues)).toContain('COMPLETED');
    });

    it('replays a completed record without reprocessing a duplicate delivery', async () => {
      const stored = [{ outcome: 'processed', key: keyOf(csvId), status: 'PROCESSED' }];
      idem.on(PutItemCommand).rejects(
        new ConditionalCheckFailedException({
          message: 'exists',
          $metadata: {},
          Item: marshall({
            id: 'doc-pipeline#hash',
            status: 'COMPLETED',
            expiration: Math.floor(Date.now() / 1000) + 3600,
            data: stored[0],
          }),
        }),
      );

      const res = await handler(
        sqsEvent(sqsRecord('dup', s3NotificationBody(keyOf(csvId)))),
        lambdaContext(),
      );

      expect(res.batchItemFailures).toEqual([]);
      expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
      expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
      expect(eb.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    it('fails the record while another delivery is still in progress', async () => {
      idem.on(PutItemCommand).rejects(
        new ConditionalCheckFailedException({
          message: 'exists',
          $metadata: {},
          Item: marshall({
            id: 'doc-pipeline#hash',
            status: 'INPROGRESS',
            expiration: Math.floor(Date.now() / 1000) + 3600,
            in_progress_expiration: Date.now() + 60_000,
          }),
        }),
      );

      const res = await handler(
        sqsEvent(sqsRecord('concurrent', s3NotificationBody(keyOf(csvId)))),
        lambdaContext(),
      );

      expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'concurrent' }]);
      expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
    });

    it('releases the idempotency record when processing fails so the retry can run', async () => {
      await handler(
        sqsEvent(sqsRecord('poison', s3NotificationBody(keyOf(pdfId)))),
        lambdaContext(),
      );
      expect(idem.commandCalls(DeleteItemCommand)).toHaveLength(1);
    });
  });
});
