import { DynamoDbDocumentRepository } from '../adapters/dynamodb-document-repository';
import { S3UploadSigner } from '../adapters/s3-upload-signer';
import { systemClock } from '../application/ports';
import { RequestUpload } from '../application/request-upload';
import { uuidv7 } from '../domain/ids';
import { DEFAULT_UPLOAD_POLICY } from '../domain/upload-policy';
import { dynamoDbDocumentClient, s3Client } from '../infra/aws-clients';
import { intEnv, requireEnv } from '../infra/env';
import { handleHttp, json, parseJsonBody, type HttpEvent, type HttpResult } from './http';

// Composition root: runs once per cold start.
const tableName = requireEnv('DOCUMENTS_TABLE');
const bucket = requireEnv('UPLOAD_BUCKET');
const policy = {
  maxBytes: intEnv('MAX_UPLOAD_BYTES', DEFAULT_UPLOAD_POLICY.maxBytes),
  urlTtlSeconds: intEnv('UPLOAD_URL_TTL_SECONDS', DEFAULT_UPLOAD_POLICY.urlTtlSeconds),
};

const useCase = new RequestUpload({
  repository: new DynamoDbDocumentRepository(dynamoDbDocumentClient(), tableName),
  signer: new S3UploadSigner(s3Client(), bucket),
  clock: systemClock,
  policy,
  pendingTtlSeconds: intEnv('PENDING_TTL_SECONDS', 86_400),
  newId: () => uuidv7(),
});

/** POST /documents — returns a presigned POST scoped to the caller's tenant prefix. */
export const handler = (event: HttpEvent): Promise<HttpResult> =>
  handleHttp(event, async (tenantId) => {
    const ticket = await useCase.execute(tenantId, parseJsonBody(event));
    return json(201, ticket, { location: `/documents/${ticket.documentId}` });
  });
