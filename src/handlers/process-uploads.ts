import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { BatchProcessor, EventType, processPartialResponse } from '@aws-lambda-powertools/batch';
import { IdempotencyConfig, makeIdempotent } from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { DynamoDbDocumentRepository } from '../adapters/dynamodb-document-repository';
import { EventBridgeDocumentEvents } from '../adapters/eventbridge-events';
import { defaultExtractors } from '../adapters/extractors';
import { S3ObjectStore } from '../adapters/s3-object-store';
import { systemClock } from '../application/ports';
import { ProcessDocument } from '../application/process-document';
import { DEFAULT_UPLOAD_POLICY } from '../domain/upload-policy';
import { dynamoDbClient, dynamoDbDocumentClient, s3Client } from '../infra/aws-clients';
import { parseObjectKey } from '../domain/object-key';
import { awsEndpoint, intEnv, requireEnv } from '../infra/env';
import { logger, MetricUnit, metrics, observe, tracer } from '../infra/observability';
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
    tracer.captureAWSv3Client(new EventBridgeClient(endpoint ? { endpoint } : {})),
    requireEnv('EVENT_BUS_NAME'),
  ),
  extractors: defaultExtractors,
  clock: systemClock,
  maxBytes: intEnv('MAX_UPLOAD_BYTES', DEFAULT_UPLOAD_POLICY.maxBytes),
});

/** Compact, serializable result: this is what the idempotency table stores and replays. */
export interface ObjectResult {
  outcome: 'processed' | 'rejected' | 'duplicate' | 'ignored';
  key: string;
  status?: string;
  reason?: string;
}

async function processObject(ref: S3ObjectRef): Promise<ObjectResult> {
  if (ref.bucket !== bucket) {
    return { outcome: 'ignored', key: ref.key, reason: `unexpected bucket ${ref.bucket}` };
  }
  const result = await useCase.execute(ref.key, ref.versionId);
  switch (result.outcome) {
    case 'processed':
    case 'rejected': {
      const { doc } = result;
      metrics.addMetric(
        result.outcome === 'processed' ? 'DocumentsProcessed' : 'DocumentsRejected',
        MetricUnit.Count,
        1,
      );
      metrics.addMetric('DocumentBytes', MetricUnit.Bytes, doc.sizeBytes ?? 0);
      const latency = Date.now() - Date.parse(ref.eventTime);
      if (Number.isFinite(latency)) {
        metrics.addMetric('UploadToProcessedLatency', MetricUnit.Milliseconds, latency);
      }
      return {
        outcome: result.outcome,
        key: ref.key,
        status: doc.status,
        // Idempotency records are marshalled without removeUndefinedValues: omit, never undefined.
        ...(doc.rejectionReason ? { reason: doc.rejectionReason } : {}),
      };
    }
    case 'duplicate':
      metrics.addMetric('DuplicateDeliveries', MetricUnit.Count, 1);
      return { outcome: 'duplicate', key: ref.key };
    case 'ignored':
      metrics.addMetric('IgnoredObjects', MetricUnit.Count, 1);
      return { outcome: 'ignored', key: ref.key, reason: result.reason };
  }
}

/**
 * Idempotency layer 1 (ADR 0004): Powertools idempotency keyed on the S3 event identity
 * (bucket, key, sequencer). Duplicate deliveries of the same S3 event — from S3 itself or
 * from SQS redelivery after a lost delete — return the stored result without touching S3,
 * DynamoDB documents or EventBridge. A concurrent duplicate gets IdempotencyAlreadyInProgressError,
 * which fails only that SQS record; it is retried after the visibility timeout.
 *
 * Layer 2 is the conditional status transition inside ProcessDocument.
 */
const idempotencyConfig = new IdempotencyConfig({
  eventKeyJmesPath: '[bucket, key, sequencer]',
  expiresAfterSeconds: intEnv('IDEMPOTENCY_TTL_SECONDS', 24 * 3600),
  throwOnNoIdempotencyKey: true,
});

const processObjectOnce = makeIdempotent(processObject, {
  persistenceStore: new DynamoDBPersistenceLayer({
    tableName: requireEnv('IDEMPOTENCY_TABLE'),
    awsSdkV3Client: dynamoDbClient(),
  }),
  config: idempotencyConfig,
});

async function recordHandler(record: SQSRecord): Promise<ObjectResult[]> {
  const results: ObjectResult[] = [];
  // One SQS message may carry several S3 records; any failure fails the whole message,
  // and already-finished objects are short-circuited on retry by the idempotency layer.
  for (const ref of parseS3Notification(record.body)) {
    const tenantId = parseObjectKey(ref.key)?.tenantId;
    try {
      const result = await processObjectOnce(ref);
      logger.info('object handled', { messageId: record.messageId, tenantId, ...result });
      results.push(result);
    } catch (err) {
      metrics.addMetric('ProcessingFailures', MetricUnit.Count, 1);
      logger.error('object failed; message will be retried', {
        messageId: record.messageId,
        receiveCount: record.attributes.ApproximateReceiveCount,
        tenantId,
        key: ref.key,
        error: err as Error,
      });
      throw err;
    }
  }
  return results;
}

const processor = new BatchProcessor(EventType.SQS);

/**
 * SQS → Lambda with `ReportBatchItemFailures`: only failed message ids return to the queue,
 * successful ones are deleted. A poison message therefore never blocks its batch-mates and
 * reaches the DLQ after `maxReceiveCount` attempts.
 */
export const handler = (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  // Lets Powertools expire an INPROGRESS record if this invocation times out mid-record.
  idempotencyConfig.registerLambdaContext(context);
  return observe(context, { batchSize: String(event.Records.length) }, async () => {
    const response = await processPartialResponse(event, recordHandler, processor, {
      context,
      // Report every failure item-by-item instead of throwing; the effect is the same
      // (all messages retried) but the response shape stays uniform and observable.
      throwOnFullBatchFailure: false,
    });
    metrics.addMetric('BatchItemFailures', MetricUnit.Count, response.batchItemFailures.length);
    return response;
  });
};
