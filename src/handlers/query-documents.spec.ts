import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { httpEvent } from '../../test/fixtures/http-event';
import { toItem } from '../adapters/dynamodb-document-repository';
import { markProcessed, newPendingDocument } from '../domain/document';
import { parseDocumentId, parseTenantId } from '../domain/tenant';
import { handler } from './query-documents';

const ddb = mockClient(DynamoDBDocumentClient);
const documentId = parseDocumentId('0198a0b2-3c1d-7e8f-9a2b-5c6d7e8f9a0b');
const now = new Date('2026-08-16T12:00:00Z');
const processed = markProcessed(
  newPendingDocument({
    tenantId: parseTenantId('acme'),
    documentId,
    fileName: 'a.json',
    contentType: 'application/json',
    declaredSizeBytes: 2,
    now,
    pendingTtlSeconds: 60,
  }),
  {
    sizeBytes: 2,
    sha256: 'ff',
    metadata: { kind: 'json', topLevelType: 'array', topLevelKeys: 0 },
  },
  now,
);
const get = (id: string, tenantId = 'acme') =>
  handler(
    httpEvent({
      method: 'GET',
      path: `/documents/${id}`,
      pathParameters: { documentId: id },
      tenantId,
    }),
  );

beforeEach(() => ddb.reset());

describe('GET /documents/{documentId}', () => {
  it('returns status and metadata without internal fields', async () => {
    ddb.on(GetCommand).resolves({ Item: toItem({ ...processed, versionId: 'v1' }) });
    const res = await get(documentId);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ documentId, status: 'PROCESSED', sha256: 'ff' });
    expect(body).not.toHaveProperty('objectKey');
    expect(body).not.toHaveProperty('versionId');
    expect(body).not.toHaveProperty('PK');
  });

  it('looks documents up only inside the caller tenant partition', async () => {
    ddb.on(GetCommand).resolves({});
    const res = await get(documentId, 'globex');
    expect(res.statusCode).toBe(404);
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({
      PK: 'TENANT#globex',
      SK: `DOC#${documentId}`,
    });
  });

  it('answers 404, not 400, for malformed ids', async () => {
    const res = await get('../../etc');
    expect(res.statusCode).toBe(404);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });
});

describe('GET /documents', () => {
  const list = (query: Record<string, string> = {}, tenantId = 'acme') =>
    handler(
      httpEvent({ method: 'GET', path: '/documents', queryStringParameters: query, tenantId }),
    );

  it('pages newest first with an opaque cursor', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [toItem(processed)],
      LastEvaluatedKey: { PK: 'TENANT#acme', SK: `DOC#${documentId}` },
    });
    const res = await list({ limit: '1' });
    const body = JSON.parse(res.body!) as { items: unknown[]; nextCursor: string };
    expect(body.items).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
      ScanIndexForward: false,
      Limit: 1,
      ExpressionAttributeValues: { ':pk': 'TENANT#acme', ':doc': 'DOC#' },
    });

    ddb.on(QueryCommand).resolves({ Items: [] });
    await list({ cursor: body.nextCursor });
    expect(ddb.commandCalls(QueryCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual({
      PK: 'TENANT#acme',
      SK: `DOC#${documentId}`,
    });
  });

  it('rejects a cursor minted for another tenant', async () => {
    const foreign = Buffer.from(JSON.stringify({ PK: 'TENANT#acme', SK: 'DOC#x' })).toString(
      'base64url',
    );
    const res = await list({ cursor: foreign }, 'globex');
    expect(res.statusCode).toBe(400);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it.each(['0', '101', 'abc'])('rejects limit=%s', async (limit) => {
    expect((await list({ limit })).statusCode).toBe(400);
  });
});
