import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { awsEndpoint } from './env';

/**
 * Clients are created once per execution environment (module scope) and reused across
 * invocations: TLS sessions and credential resolution are paid only on cold start.
 * `AWS_ENDPOINT_URL` points everything at LocalStack in local runs and tests.
 */
type Credentials = AwsCredentialIdentity | AwsCredentialIdentityProvider;

export function s3Client(credentials?: Credentials): S3Client {
  const endpoint = awsEndpoint();
  return new S3Client({
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(credentials ? { credentials } : {}),
  });
}

export function dynamoDbClient(credentials?: Credentials): DynamoDBClient {
  const endpoint = awsEndpoint();
  return new DynamoDBClient({
    ...(endpoint ? { endpoint } : {}),
    ...(credentials ? { credentials } : {}),
  });
}

export function dynamoDbDocumentClient(credentials?: Credentials): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(dynamoDbClient(credentials), {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
}
