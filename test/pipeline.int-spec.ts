import { DeleteItemCommand, DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { GetObjectTaggingCommand, S3Client } from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { corruptPdf, pdfWithPages, sampleCsv } from './fixtures/files';
import { httpEvent } from './fixtures/http-event';
import { deliver, postForm, receive, startHarness, type Harness } from './support/pipeline-harness';

const MAX_RECEIVE = 2;
const MAX_UPLOAD_BYTES = 64 * 1024;

let h: Harness;
let ddb: DynamoDBClient;
let s3: S3Client;

beforeAll(async () => {
  h = await startHarness({
    maxReceiveCount: MAX_RECEIVE,
    visibilityTimeoutSeconds: 1,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  });
  const base = {
    endpoint: h.endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  };
  ddb = new DynamoDBClient(base);
  s3 = new S3Client({ ...base, forcePathStyle: true });

  // S3 sends an s3:TestEvent when the notification is configured; the processor must ack it.
  const testEvents = await receive(h.sqs, h.resources.uploadsQueueUrl, { timeoutMs: 5000 });
  if (testEvents.length > 0) expect((await deliver(h, testEvents)).batchItemFailures).toEqual([]);
}, 180_000);

afterAll(async () => {
  ddb?.destroy();
  s3?.destroy();
  await h?.stop();
});

afterEach(async () => {
  // Isolate tests from each other's leftovers.
  for (const url of [h.resources.uploadsQueueUrl, h.resources.eventsQueueUrl]) {
    await h.sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
  }
});

interface Ticket {
  documentId: string;
  upload: { url: string; fields: Record<string, string> };
}

async function requestUpload(
  fileName: string,
  contentType: string,
  sizeBytes: number,
  tenantId = 'acme',
): Promise<Ticket> {
  const res = await h.createUpload(
    httpEvent({ body: { fileName, contentType, sizeBytes }, tenantId }),
  );
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body!) as Ticket;
}

async function upload(file: Buffer, contentType: string, fileName = 'file', tenantId = 'acme') {
  const ticket = await requestUpload(fileName, contentType, file.length, tenantId);
  const res = await postForm(ticket.upload.url, ticket.upload.fields, file, contentType);
  expect(res.status).toBeLessThan(300);
  return ticket;
}

async function getDocument(documentId: string, tenantId = 'acme') {
  const res = await h.queryDocuments(
    httpEvent({
      method: 'GET',
      path: `/documents/${documentId}`,
      pathParameters: { documentId },
      tenantId,
    }),
  );
  return { statusCode: res.statusCode, body: JSON.parse(res.body!) as Record<string, unknown> };
}

async function capturedEvents(min: number, timeoutMs = 8000) {
  const messages = await receive(h.sqs, h.resources.eventsQueueUrl, { min, timeoutMs });
  return messages.map(
    (m) => JSON.parse(m.Body!) as { 'detail-type': string; detail: Record<string, unknown> },
  );
}

async function queueDepth(url: string): Promise<number> {
  const { Attributes } = await h.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

describe('upload -> S3 -> SQS -> processor -> status (LocalStack)', () => {
  it('processes a CSV end to end and publishes DocumentProcessed', async () => {
    const ticket = await upload(sampleCsv, 'text/csv', 'q3.csv');
    expect((await getDocument(ticket.documentId)).body.status).toBe('PENDING_UPLOAD');

    const messages = await receive(h.sqs, h.resources.uploadsQueueUrl);
    expect(messages).toHaveLength(1);
    const response = await deliver(h, messages);
    expect(response.batchItemFailures).toEqual([]);

    const { statusCode, body } = await getDocument(ticket.documentId);
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      status: 'PROCESSED',
      fileName: 'q3.csv',
      sizeBytes: sampleCsv.length,
      metadata: { kind: 'csv', rowCount: 3, columnCount: 3 },
    });
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);

    const events = await capturedEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      'detail-type': 'DocumentProcessed',
      detail: {
        tenantId: 'acme',
        documentId: ticket.documentId,
        eventId: `${ticket.documentId}:PROCESSED`,
      },
    });
  });

  it('counts PDF pages', async () => {
    const ticket = await upload(await pdfWithPages(3), 'application/pdf', 'contract.pdf');
    await deliver(h, await receive(h.sqs, h.resources.uploadsQueueUrl));
    expect((await getDocument(ticket.documentId)).body).toMatchObject({
      status: 'PROCESSED',
      metadata: { kind: 'pdf', pageCount: 3 },
    });
  });

  it('keeps tenants apart: another tenant gets 404 for the same id', async () => {
    const ticket = await upload(sampleCsv, 'text/csv');
    expect((await getDocument(ticket.documentId, 'globex')).statusCode).toBe(404);
    expect(ticket.upload.fields.key).toBe(`tenants/acme/documents/${ticket.documentId}`);
  });
});

describe('duplicate delivery', () => {
  it('is idempotent for sequential and concurrent redeliveries of the same S3 event', async () => {
    const ticket = await upload(sampleCsv, 'text/csv');
    const [message] = await receive(h.sqs, h.resources.uploadsQueueUrl);

    await deliver(h, [message!]);
    const first = await getDocument(ticket.documentId);

    // Same S3 event delivered again, once sequentially and twice concurrently.
    await deliver(h, [message!]);
    const concurrent = await Promise.all([deliver(h, [message!]), deliver(h, [message!])]);
    for (const r of concurrent) expect(r.batchItemFailures).toEqual([]);

    const after = await getDocument(ticket.documentId);
    expect(after.body).toEqual(first.body);
    const events = await capturedEvents(2, 4000);
    expect(events.filter((e) => e.detail.documentId === ticket.documentId)).toHaveLength(1);

    const { Items } = await ddb.send(new ScanCommand({ TableName: h.resources.idempotencyTable }));
    const completed = (Items ?? []).filter((i) => i.status?.S === 'COMPLETED');
    expect(completed.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the conditional transition when the idempotency record is gone', async () => {
    const ticket = await upload(sampleCsv, 'text/csv');
    const [message] = await receive(h.sqs, h.resources.uploadsQueueUrl);
    await deliver(h, [message!]);
    const first = await getDocument(ticket.documentId);
    await capturedEvents(1);

    // Simulate an expired idempotency record (e.g. a redrive days later).
    const { Items } = await ddb.send(new ScanCommand({ TableName: h.resources.idempotencyTable }));
    for (const item of Items ?? []) {
      await ddb.send(
        new DeleteItemCommand({ TableName: h.resources.idempotencyTable, Key: { id: item.id! } }),
      );
    }

    const response = await deliver(h, [message!]);
    expect(response.batchItemFailures).toEqual([]);
    // Record untouched; event re-published (at-least-once) with the same eventId.
    expect((await getDocument(ticket.documentId)).body).toEqual(first.body);
    const events = await capturedEvents(1);
    expect(events[0]?.detail.eventId).toBe(`${ticket.documentId}:PROCESSED`);
  });
});

describe('failure handling', () => {
  it('rejects content that does not match its declared type without retrying', async () => {
    const ticket = await upload(Buffer.from('MZ\x90\x00 not a pdf', 'latin1'), 'application/pdf');
    const response = await deliver(h, await receive(h.sqs, h.resources.uploadsQueueUrl));
    expect(response.batchItemFailures).toEqual([]);

    expect((await getDocument(ticket.documentId)).body).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'content does not start with a PDF header',
    });
    const events = await capturedEvents(1);
    expect(events[0]?.['detail-type']).toBe('DocumentRejected');
    const { TagSet } = await s3.send(
      new GetObjectTaggingCommand({ Bucket: h.resources.bucket, Key: ticket.upload.fields.key }),
    );
    expect(TagSet).toEqual([{ Key: 'pipeline-status', Value: 'rejected' }]);
  });

  it('moves a poison file to the DLQ after maxReceiveCount attempts and keeps good batch-mates', async () => {
    const poison = await upload(corruptPdf, 'application/pdf', 'broken.pdf');
    const good = await upload(sampleCsv, 'text/csv', 'fine.csv');

    // First delivery: both in one batch; only the poison message fails.
    const batch = await receive(h.sqs, h.resources.uploadsQueueUrl, { min: 2 });
    expect(batch).toHaveLength(2);
    const first = await deliver(h, batch);
    expect(first.batchItemFailures).toHaveLength(1);
    expect((await getDocument(good.documentId)).body.status).toBe('PROCESSED');

    // Keep redelivering (as the poller would) until SQS redrives the message to the DLQ.
    for (let attempt = 2; attempt <= MAX_RECEIVE + 1; attempt++) {
      await new Promise((r) => setTimeout(r, 1200));
      const again = await receive(h.sqs, h.resources.uploadsQueueUrl, { timeoutMs: 3000 });
      if (again.length > 0) {
        expect((await deliver(h, again)).batchItemFailures).toHaveLength(again.length);
      }
    }

    const dlq = await receive(h.sqs, h.resources.uploadsDlqUrl, { timeoutMs: 10_000 });
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.Body).toContain(poison.documentId);
    expect(await queueDepth(h.resources.uploadsQueueUrl)).toBe(0);
    // Never rejected: a human decides after looking at the DLQ (ADR 0006).
    expect((await getDocument(poison.documentId)).body.status).toBe('PENDING_UPLOAD');
  });
});

describe('size limit', () => {
  // AWS S3 refuses such a POST with 400 EntityTooLarge because of the policy's
  // content-length-range (asserted on the signed policy in s3-upload-signer.spec.ts).
  // LocalStack 3.8 does not enforce that condition, which lets us exercise the processor's
  // own size check: defense in depth if the bucket is ever written by another path.
  it('rejects an object above the limit without buffering it', async () => {
    const ticket = await requestUpload('big.csv', 'text/csv', 1000);
    const res = await postForm(
      ticket.upload.url,
      ticket.upload.fields,
      Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61),
      'text/csv',
    );
    expect(res.status).toBeLessThan(300);

    await deliver(h, await receive(h.sqs, h.resources.uploadsQueueUrl));
    expect((await getDocument(ticket.documentId)).body).toMatchObject({
      status: 'REJECTED',
      sizeBytes: MAX_UPLOAD_BYTES + 1,
      rejectionReason: `file exceeds ${MAX_UPLOAD_BYTES} bytes`,
    });
  });
});
