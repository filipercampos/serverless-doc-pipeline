import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';

export function s3NotificationBody(
  key: string,
  opts: { bucket?: string; size?: number; sequencer?: string; eventName?: string } = {},
): string {
  return JSON.stringify({
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: 'us-east-1',
        eventTime: '2026-08-13T22:00:00.000Z',
        eventName: opts.eventName ?? 'ObjectCreated:Post',
        s3: {
          s3SchemaVersion: '1.0',
          configurationId: 'uploads',
          bucket: { name: opts.bucket ?? 'uploads-test', arn: 'arn:aws:s3:::uploads-test' },
          object: {
            key: encodeURIComponent(key).replace(/%2F/g, '/'),
            size: opts.size ?? 10,
            eTag: 'etag',
            sequencer: opts.sequencer ?? '0066F1A2B3C4D5E6F7',
          },
        },
      },
    ],
  });
}

export function sqsRecord(messageId: string, body: string): SQSRecord {
  return {
    messageId,
    receiptHandle: `rh-${messageId}`,
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '1786658400000',
      SenderId: 'AIDA',
      ApproximateFirstReceiveTimestamp: '1786658400000',
    },
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:uploads',
    awsRegion: 'us-east-1',
  };
}

export function sqsEvent(...records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

export function lambdaContext(overrides: Partial<Context> = {}): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'process-uploads',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:process-uploads',
    memoryLimitInMB: '1024',
    awsRequestId: 'invocation-1',
    logGroupName: '/aws/lambda/process-uploads',
    logStreamName: 'stream',
    getRemainingTimeInMillis: () => 60_000,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
    ...overrides,
  };
}
