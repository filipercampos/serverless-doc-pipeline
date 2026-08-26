/**
 * Local stand-in for API Gateway + the SQS event source mapping, running the real handlers
 * against LocalStack:
 *
 *   docker compose up -d
 *   npm run local            # http://localhost:3300
 *
 * DEV ONLY: there is no Cognito locally, so `Authorization: Bearer <tenant-id>` is turned into
 * the `custom:tenant_id` claim the JWT authorizer would provide. Never deploy this file.
 */
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { httpEvent } from '../test/fixtures/http-event';
import { lambdaContext } from '../test/fixtures/sqs-event';
import { toSqsRecord } from '../test/support/pipeline-harness';
import { bootstrap, handlerEnv } from './localstack-bootstrap';

const PORT = Number(process.env.PORT ?? 3300);
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4569';

type HttpHandler = typeof import('../src/handlers/create-upload').handler;
type SqsHandler = typeof import('../src/handlers/process-uploads').handler;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const resources = await bootstrap({ endpoint, visibilityTimeoutSeconds: 30 });
  Object.assign(process.env, handlerEnv(endpoint, resources), {
    POWERTOOLS_SERVICE_NAME: 'doc-pipeline',
    POWERTOOLS_TRACE_ENABLED: 'false',
    POWERTOOLS_METRICS_DISABLED: 'true',
    POWERTOOLS_DEV: 'true',
  });

  // Imported after the environment is set: handlers read it at module load, like a cold start.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const createUpload = (require('../src/handlers/create-upload') as { handler: HttpHandler })
    .handler;
  const queryDocuments = (require('../src/handlers/query-documents') as { handler: HttpHandler })
    .handler;
  const processUploads = (require('../src/handlers/process-uploads') as { handler: SqsHandler })
    .handler;
  /* eslint-enable @typescript-eslint/no-require-imports */

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
      const tenantId = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
      const match = /^\/documents(?:\/([^/]+))?$/.exec(url.pathname);
      let handler: HttpHandler | undefined;
      if (match && req.method === 'POST' && !match[1]) handler = createUpload;
      if (match && req.method === 'GET') handler = queryDocuments;
      if (!handler) {
        res.writeHead(404).end();
        return;
      }
      const event = httpEvent({
        method: req.method,
        path: url.pathname,
        body:
          req.method === 'POST'
            ? (JSON.parse((await readBody(req)) || 'null') as unknown)
            : undefined,
        tenantId,
        pathParameters: match?.[1] ? { documentId: match[1] } : undefined,
        queryStringParameters: Object.fromEntries(url.searchParams),
      });
      event.requestContext.requestId = randomUUID();
      const result = await handler(event, lambdaContext({ functionName: 'local-api' }));
      res.writeHead(result.statusCode ?? 200, result.headers as Record<string, string>);
      res.end(result.body);
    })().catch((err: unknown) => {
      console.error(err);
      res.writeHead(500).end();
    });
  });
  server.listen(PORT, () => console.log(`local API on http://localhost:${PORT}`));

  // Minimal event source mapping: long-poll, invoke, delete what did not fail.
  const sqs = new SQSClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  for (;;) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: resources.uploadsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        MessageSystemAttributeNames: ['All'],
      }),
    );
    if (!Messages?.length) continue;
    const response = await processUploads(
      { Records: Messages.map((m) => toSqsRecord(m)) },
      lambdaContext({ functionName: 'local-processor' }),
    );
    const failed = new Set(response.batchItemFailures.map((f) => f.itemIdentifier));
    for (const m of Messages) {
      if (failed.has(m.MessageId!)) continue;
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: resources.uploadsQueueUrl,
          ReceiptHandle: m.ReceiptHandle!,
        }),
      );
    }
    console.log(`processed batch of ${Messages.length}, failures: ${failed.size}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
