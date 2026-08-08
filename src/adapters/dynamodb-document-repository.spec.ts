import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { newPendingDocument } from '../domain/document';
import { parseDocumentId, parseTenantId } from '../domain/tenant';
import { DynamoDbDocumentRepository } from './dynamodb-document-repository';

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new DynamoDbDocumentRepository(ddb as unknown as DynamoDBDocumentClient, 'docs');
const tenantId = parseTenantId('acme');
const documentId = parseDocumentId('0198a0b2-3c1d-7e8f-9a2b-5c6d7e8f9a0b');
const doc = newPendingDocument({
  tenantId,
  documentId,
  fileName: 'a.json',
  contentType: 'application/json',
  declaredSizeBytes: 10,
  now: new Date('2026-08-08T14:00:00Z'),
  pendingTtlSeconds: 60,
});

beforeEach(() => ddb.reset());

describe('DynamoDbDocumentRepository', () => {
  it('creates items in the tenant partition with an existence guard', async () => {
    ddb.on(PutCommand).resolves({});
    await repo.create(doc);
    const input = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input.Item).toMatchObject({
      PK: 'TENANT#acme',
      SK: `DOC#${documentId}`,
      status: 'PENDING_UPLOAD',
    });
    expect(input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('reads with strong consistency and strips key attributes', async () => {
    ddb
      .on(GetCommand)
      .resolves({
        Item: { PK: 'TENANT#acme', SK: `DOC#${documentId}`, entity: 'Document', ...doc },
      });
    await expect(repo.get(tenantId, documentId)).resolves.toEqual(doc);
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({
      Key: { PK: 'TENANT#acme', SK: `DOC#${documentId}` },
      ConsistentRead: true,
    });
  });

  it('returns null for unknown documents', async () => {
    ddb.on(GetCommand).resolves({});
    await expect(repo.get(tenantId, documentId)).resolves.toBeNull();
  });

  it('reports a lost race on transition instead of overwriting', async () => {
    ddb
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'no', $metadata: {} }));
    await expect(repo.transition({ ...doc, status: 'PROCESSED' }, 'PENDING_UPLOAD')).resolves.toBe(
      false,
    );
  });

  it('propagates unexpected errors', async () => {
    ddb.on(PutCommand).rejects(new Error('ProvisionedThroughputExceeded'));
    await expect(
      repo.transition({ ...doc, status: 'PROCESSED' }, 'PENDING_UPLOAD'),
    ).rejects.toThrow('ProvisionedThroughputExceeded');
  });
});
