import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { bootstrap, handlerEnv, type LocalResources } from '../../scripts/localstack-bootstrap';
import type { HttpEvent, HttpResult } from '../../src/handlers/http';
import { lambdaContext } from '../fixtures/sqs-event';

type HttpHandler = (event: HttpEvent, context?: Context) => Promise<HttpResult>;
type SqsHandler = (event: SQSEvent, context: Context) => Promise<SQSBatchResponse>;

export interface Harness {
  endpoint: string;
  resources: LocalResources;
  sqs: SQSClient;
  createUpload: HttpHandler;
  queryDocuments: HttpHandler;
  processUploads: SqsHandler;
  stop(): Promise<void>;
}

/**
 * Starts LocalStack (Testcontainers, random host port) unless LOCALSTACK_ENDPOINT points at a
 * running one, creates the resources, sets the handler environment and only THEN imports the
 * handlers, because they read their configuration at module load (like a Lambda cold start).
 */
export async function startHarness(opts: {
  maxReceiveCount: number;
  visibilityTimeoutSeconds: number;
  maxUploadBytes: number;
}): Promise<Harness> {
  let container: StartedLocalStackContainer | undefined;
  let endpoint = process.env.LOCALSTACK_ENDPOINT;
  if (!endpoint) {
    container = await new LocalstackContainer('localstack/localstack:3.8')
      .withEnvironment({ SERVICES: 's3,sqs,dynamodb,events,sts' })
      .start();
    endpoint = container.getConnectionUri();
  }

  const resources = await bootstrap({
    endpoint,
    prefix: `it-${Date.now().toString(36)}`,
    maxReceiveCount: opts.maxReceiveCount,
    visibilityTimeoutSeconds: opts.visibilityTimeoutSeconds,
  });
  Object.assign(process.env, handlerEnv(endpoint, resources), {
    MAX_UPLOAD_BYTES: String(opts.maxUploadBytes),
  });
  delete process.env.TENANT_ROLE_ARN;

  /* eslint-disable @typescript-eslint/no-require-imports */
  const createUpload = (require('../../src/handlers/create-upload') as { handler: HttpHandler })
    .handler;
  const queryDocuments = (require('../../src/handlers/query-documents') as { handler: HttpHandler })
    .handler;
  const processUploads = (require('../../src/handlers/process-uploads') as { handler: SqsHandler })
    .handler;
  /* eslint-enable @typescript-eslint/no-require-imports */

  const sqs = new SQSClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  return {
    endpoint,
    resources,
    sqs,
    createUpload,
    queryDocuments,
    processUploads,
    stop: async () => {
      sqs.destroy();
      await container?.stop();
    },
  };
}

export function toSqsRecord(
  m: Message,
  queueArn = 'arn:aws:sqs:us-east-1:000000000000:uploads',
): SQSRecord {
  return {
    messageId: m.MessageId!,
    receiptHandle: m.ReceiptHandle!,
    body: m.Body!,
    attributes: {
      ApproximateReceiveCount: m.Attributes?.ApproximateReceiveCount ?? '1',
      SentTimestamp: m.Attributes?.SentTimestamp ?? '0',
      SenderId: 'localstack',
      ApproximateFirstReceiveTimestamp: m.Attributes?.ApproximateFirstReceiveTimestamp ?? '0',
    },
    messageAttributes: {},
    md5OfBody: m.MD5OfBody ?? '',
    eventSource: 'aws:sqs',
    eventSourceARN: queueArn,
    awsRegion: 'us-east-1',
  };
}

export async function receive(
  sqs: SQSClient,
  queueUrl: string,
  opts: { min?: number; timeoutMs?: number } = {},
): Promise<Message[]> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const out: Message[] = [];
  while (Date.now() < deadline && out.length < (opts.min ?? 1)) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['All'],
      }),
    );
    out.push(...(Messages ?? []));
  }
  return out;
}

/**
 * What the Lambda SQS poller does: invoke with a batch, then delete every message that is
 * NOT listed in batchItemFailures. Failed messages become visible again after the timeout.
 */
export async function deliver(h: Harness, messages: Message[]): Promise<SQSBatchResponse> {
  const response = await h.processUploads(
    { Records: messages.map((m) => toSqsRecord(m)) },
    lambdaContext(),
  );
  const failed = new Set(response.batchItemFailures.map((f) => f.itemIdentifier));
  for (const m of messages) {
    if (!failed.has(m.MessageId!)) {
      await h.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: h.resources.uploadsQueueUrl,
          ReceiptHandle: m.ReceiptHandle!,
        }),
      );
    }
  }
  return response;
}

/** Performs the browser side of a presigned POST. */
export async function postForm(
  url: string,
  fields: Record<string, string>,
  file: Buffer,
  contentType: string,
): Promise<Response> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([file], { type: contentType }), 'upload');
  return fetch(url, { method: 'POST', body: form });
}
