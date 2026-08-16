import { DynamoDbDocumentRepository } from '../adapters/dynamodb-document-repository';
import { QueryDocuments } from '../application/query-documents';
import { dynamoDbDocumentClient } from '../infra/aws-clients';
import { requireEnv } from '../infra/env';
import { handleHttp, json, type HttpEvent, type HttpResult } from './http';

const useCase = new QueryDocuments(
  new DynamoDbDocumentRepository(dynamoDbDocumentClient(), requireEnv('DOCUMENTS_TABLE')),
);

/**
 * GET /documents/{documentId} — status and extracted metadata.
 * GET /documents              — newest first, `?limit=&cursor=`.
 * One function for both read routes: same IAM permissions, shared warm pool.
 */
export const handler = (event: HttpEvent): Promise<HttpResult> =>
  handleHttp(event, async (tenantId) => {
    const documentId = event.pathParameters?.documentId;
    if (documentId !== undefined) {
      return json(200, await useCase.get(tenantId, documentId));
    }
    const { limit, cursor } = event.queryStringParameters ?? {};
    return json(200, await useCase.list(tenantId, { limit, cursor }));
  });
