import type { Context } from 'aws-lambda';
import { DynamoDbDocumentRepository } from '../adapters/dynamodb-document-repository';
import { S3UploadSigner } from '../adapters/s3-upload-signer';
import { systemClock } from '../application/ports';
import { RequestUpload } from '../application/request-upload';
import { uuidv7 } from '../domain/ids';
import type { TenantId } from '../domain/tenant';
import { DEFAULT_UPLOAD_POLICY } from '../domain/upload-policy';
import { intEnv, requireEnv } from '../infra/env';
import { MetricUnit, metrics } from '../infra/observability';
import { tenantClientPoolFromEnv } from '../infra/tenant-clients';
import { handleHttp, json, parseJsonBody, type HttpEvent, type HttpResult } from './http';

// Composition root: runs once per cold start.
const tableName = requireEnv('DOCUMENTS_TABLE');
const bucket = requireEnv('UPLOAD_BUCKET');
const policy = {
  maxBytes: intEnv('MAX_UPLOAD_BYTES', DEFAULT_UPLOAD_POLICY.maxBytes),
  urlTtlSeconds: intEnv('UPLOAD_URL_TTL_SECONDS', DEFAULT_UPLOAD_POLICY.urlTtlSeconds),
};
const pendingTtlSeconds = intEnv('PENDING_TTL_SECONDS', 7 * 86_400);
const clients = tenantClientPoolFromEnv();

function useCaseFor(tenantId: TenantId): RequestUpload {
  // Both the record write and the POST signature use tenant-scoped credentials: S3 evaluates
  // the presigned POST against the *signer's* permissions, so even a wrong key would be denied.
  const { dynamo, s3 } = clients.for(tenantId);
  return new RequestUpload({
    repository: new DynamoDbDocumentRepository(dynamo, tableName),
    signer: new S3UploadSigner(s3, bucket),
    clock: systemClock,
    policy,
    pendingTtlSeconds,
    newId: () => uuidv7(),
  });
}

/** POST /documents — returns a presigned POST scoped to the caller's tenant prefix. */
export const handler = (event: HttpEvent, context?: Context): Promise<HttpResult> =>
  handleHttp(event, context, async (tenantId) => {
    const ticket = await useCaseFor(tenantId).execute(tenantId, parseJsonBody(event));
    metrics.addMetric('UploadTicketsIssued', MetricUnit.Count, 1);
    return json(201, ticket, { location: `/documents/${ticket.documentId}` });
  });
