/**
 * Creates the pipeline's AWS resources in LocalStack: the local equivalent of template.yaml
 * (minus IAM, Cognito, API Gateway and alarms, which LocalStack Community does not enforce
 * or provide). Used by `docker compose` runs and by the integration tests.
 *
 *   AWS_ENDPOINT_URL=http://localhost:4569 npm run local:bootstrap
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import {
  CreateEventBusCommand,
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  CreateBucketCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

export interface LocalResources {
  bucket: string;
  documentsTable: string;
  idempotencyTable: string;
  uploadsQueueUrl: string;
  uploadsDlqUrl: string;
  eventBus: string;
  /** Captures everything published on the bus, so tests and the demo can see the events. */
  eventsQueueUrl: string;
}

export interface BootstrapOptions {
  endpoint: string;
  region?: string;
  prefix?: string;
  /** Lower than production (5) so poison-message tests finish quickly. */
  maxReceiveCount?: number;
  visibilityTimeoutSeconds?: number;
}

const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };

export async function bootstrap(opts: BootstrapOptions): Promise<LocalResources> {
  const region = opts.region ?? 'us-east-1';
  const prefix = opts.prefix ?? 'doc-pipeline';
  const base = { endpoint: opts.endpoint, region, credentials };
  const s3 = new S3Client({ ...base, forcePathStyle: true });
  const sqs = new SQSClient(base);
  const ddb = new DynamoDBClient(base);
  const eb = new EventBridgeClient(base);

  const names = {
    bucket: `${prefix}-uploads`,
    documentsTable: `${prefix}-documents`,
    idempotencyTable: `${prefix}-idempotency`,
    eventBus: `${prefix}-documents`,
  };

  const queueArn = async (url: string) =>
    (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] })))
      .Attributes!.QueueArn!;

  // Queues: uploads -> DLQ, and an events capture queue.
  const { QueueUrl: uploadsDlqUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: `${prefix}-uploads-dlq` }),
  );
  const { QueueUrl: uploadsQueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${prefix}-uploads`,
      Attributes: {
        VisibilityTimeout: String(opts.visibilityTimeoutSeconds ?? 30),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: await queueArn(uploadsDlqUrl!),
          maxReceiveCount: opts.maxReceiveCount ?? 5,
        }),
      },
    }),
  );
  const { QueueUrl: eventsQueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: `${prefix}-events-capture` }),
  );

  // Bucket with versioning and S3 -> SQS notifications for the tenant prefix.
  try {
    await s3.send(new CreateBucketCommand({ Bucket: names.bucket }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'BucketAlreadyOwnedByYou') throw err;
  }
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: names.bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );
  await s3.send(
    new PutBucketNotificationConfigurationCommand({
      Bucket: names.bucket,
      NotificationConfiguration: {
        QueueConfigurations: [
          {
            QueueArn: await queueArn(uploadsQueueUrl!),
            Events: ['s3:ObjectCreated:*'],
            Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'tenants/' }] } },
          },
        ],
      },
    }),
  );

  // Tables.
  await createTable(ddb, names.documentsTable, [
    { name: 'PK', type: 'HASH' },
    { name: 'SK', type: 'RANGE' },
  ]);
  await ddb.send(
    new UpdateTimeToLiveCommand({
      TableName: names.documentsTable,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    }),
  );
  await createTable(ddb, names.idempotencyTable, [{ name: 'id', type: 'HASH' }]);

  // Event bus with a catch-all rule into the capture queue.
  try {
    await eb.send(new CreateEventBusCommand({ Name: names.eventBus }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ResourceAlreadyExistsException') throw err;
  }
  await eb.send(
    new PutRuleCommand({
      Name: `${prefix}-capture`,
      EventBusName: names.eventBus,
      EventPattern: JSON.stringify({ source: ['doc-pipeline.documents'] }),
    }),
  );
  await eb.send(
    new PutTargetsCommand({
      Rule: `${prefix}-capture`,
      EventBusName: names.eventBus,
      Targets: [{ Id: 'capture', Arn: await queueArn(eventsQueueUrl!) }],
    }),
  );

  return {
    ...names,
    uploadsQueueUrl: uploadsQueueUrl!,
    uploadsDlqUrl: uploadsDlqUrl!,
    eventsQueueUrl: eventsQueueUrl!,
  };
}

async function createTable(
  ddb: DynamoDBClient,
  name: string,
  keys: { name: string; type: 'HASH' | 'RANGE' }[],
): Promise<void> {
  try {
    await ddb.send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: keys.map((k) => ({ AttributeName: k.name, AttributeType: 'S' })),
        KeySchema: keys.map((k) => ({ AttributeName: k.name, KeyType: k.type })),
      }),
    );
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
  }
  for (let i = 0; i < 30; i++) {
    const { Table } = await ddb.send(new DescribeTableCommand({ TableName: name }));
    if (Table?.TableStatus === 'ACTIVE') return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`table ${name} did not become ACTIVE`);
}

/** Environment the handlers need to run against the bootstrapped resources. */
export function handlerEnv(endpoint: string, r: LocalResources): Record<string, string> {
  return {
    AWS_ENDPOINT_URL: endpoint,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    DOCUMENTS_TABLE: r.documentsTable,
    IDEMPOTENCY_TABLE: r.idempotencyTable,
    UPLOAD_BUCKET: r.bucket,
    EVENT_BUS_NAME: r.eventBus,
  };
}

if (require.main === module) {
  const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4569';
  bootstrap({ endpoint })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      console.log('\nExport for local runs:');
      for (const [k, v] of Object.entries(handlerEnv(endpoint, r))) console.log(`${k}=${v}`);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
