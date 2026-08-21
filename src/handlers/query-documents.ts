import type { Context } from 'aws-lambda';
import { DynamoDbDocumentRepository } from '../adapters/dynamodb-document-repository';
import { QueryDocuments } from '../application/query-documents';
import type { TenantId } from '../domain/tenant';
import { requireEnv } from '../infra/env';
import { tenantClientPoolFromEnv } from '../infra/tenant-clients';
import { handleHttp, json, type HttpEvent, type HttpResult } from './http';

const tableName = requireEnv('DOCUMENTS_TABLE');
const clients = tenantClientPoolFromEnv();

const useCaseFor = (tenantId: TenantId) =>
  new QueryDocuments(new DynamoDbDocumentRepository(clients.for(tenantId).dynamo, tableName));

/**
 * GET /documents/{documentId} — status and extracted metadata.
 * GET /documents              — newest first, `?limit=&cursor=`.
 * One function for both read routes: same IAM permissions, shared warm pool.
 */
export const handler = (event: HttpEvent, context?: Context): Promise<HttpResult> =>
  handleHttp(event, context, async (tenantId) => {
    const useCase = useCaseFor(tenantId);
    const documentId = event.pathParameters?.documentId;
    if (documentId !== undefined) {
      return json(200, await useCase.get(tenantId, documentId));
    }
    const { limit, cursor } = event.queryStringParameters ?? {};
    return json(200, await useCase.list(tenantId, { limit, cursor }));
  });
