import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { BatchProcessor, EventType, processPartialResponse } from '@aws-lambda-powertools/batch';
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { DynamoDbDocumentRepository } from '../adapters/dynamodb-document-repository';
import { EventBridgeDocumentEvents } from '../adapters/eventbridge-events';
import { defaultExtractors } from '../adapters/extractors';
import { S3ObjectStore } from '../adapters/s3-object-store';
import { systemClock } from '../application/ports';
import { ProcessDocument, type ProcessOutcome } from '../application/process-document';
import { DEFAULT_UPLOAD_POLICY } from '../domain/upload-policy';
import { dynamoDbDocumentClient, s3Client } from '../infra/aws-clients';
import { awsEndpoint, intEnv, requireEnv } from '../infra/env';
import { parseS3Notification, type S3ObjectRef } from './s3-notification';

const bucket = requireEnv('UPLOAD_BUCKET');
const endpoint = awsEndpoint();

const useCase = new ProcessDocument({
  repository: new DynamoDbDocumentRepository(
    dynamoDbDocumentClient(),
    requireEnv('DOCUMENTS_TABLE'),
  ),
  objects: new S3ObjectStore(s3Client(), bucket),
  events: new EventBridgeDocumentEvents(
    new EventBridgeClient(endpoint ? { endpoint } : {}),
    requireEnv('EVENT_BUS_NAME'),
  ),
  extractors: defaultExtractors,
  clock: systemClock,
  maxBytes: intEnv('MAX_UPLOAD_BYTES', DEFAULT_UPLOAD_POLICY.maxBytes),
});

export function processObject(ref: S3ObjectRef): Promise<ProcessOutcome> {
  if (ref.bucket !== bucket) {
    return Promise.resolve({ outcome: 'ignored', reason: `unexpected bucket ${ref.bucket}` });
  }
  return useCase.execute(ref.key);
}

async function recordHandler(record: SQSRecord): Promise<ProcessOutcome[]> {
  const outcomes: ProcessOutcome[] = [];
  // One SQS message may carry several S3 records; any failure fails the whole message,
  // and already-finished objects are skipped on retry by the idempotency layer.
  for (const ref of parseS3Notification(record.body)) {
    outcomes.push(await processObject(ref));
  }
  return outcomes;
}

const processor = new BatchProcessor(EventType.SQS);

/**
 * SQS → Lambda with `ReportBatchItemFailures`: only failed message ids return to the queue,
 * successful ones are deleted. A poison message therefore never blocks its batch-mates and
 * reaches the DLQ after `maxReceiveCount` attempts.
 */
export const handler = (event: SQSEvent, context: Context): Promise<SQSBatchResponse> =>
  processPartialResponse(event, recordHandler, processor, {
    context,
    // Report every failure item-by-item instead of throwing; the effect is the same
    // (all messages retried) but the response shape stays uniform and observable.
    throwOnFullBatchFailure: false,
  });
