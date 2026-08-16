import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { DocumentRepository, Page, PageRequest } from '../application/ports';
import type { Document, DocumentStatus } from '../domain/document';
import { ValidationError } from '../domain/errors';
import type { DocumentId, TenantId } from '../domain/tenant';

/**
 * Single-table layout:
 *
 *   PK = TENANT#<tenantId>   SK = DOC#<documentId (UUIDv7)>
 *
 * The tenant is the partition key, so IAM `dynamodb:LeadingKeys` can pin a session
 * to one tenant's items (ADR 0005). Records are written with full-item Puts guarded by a
 * condition on the previous status, so a transition is atomic and last-writer-wins is impossible.
 */
export const tenantPk = (tenantId: TenantId) => `TENANT#${tenantId}`;
export const documentSk = (documentId: DocumentId) => `DOC#${documentId}`;

type Item = Document & { PK: string; SK: string; entity: 'Document' };

export function toItem(doc: Document): Item {
  return { PK: tenantPk(doc.tenantId), SK: documentSk(doc.documentId), entity: 'Document', ...doc };
}

export function fromItem(item: Record<string, unknown>): Document {
  const { PK: _pk, SK: _sk, entity: _entity, ...doc } = item;
  return doc as unknown as Document;
}

export class DynamoDbDocumentRepository implements DocumentRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create(doc: Document): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: toItem(doc),
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  }

  async get(tenantId: TenantId, documentId: DocumentId): Promise<Document | null> {
    const { Item } = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: tenantPk(tenantId), SK: documentSk(documentId) },
        ConsistentRead: true,
      }),
    );
    return Item ? fromItem(Item) : null;
  }

  async transition(next: Document, expected: DocumentStatus): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: toItem(next),
          ConditionExpression: '#status = :expected',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':expected': expected },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async list(tenantId: TenantId, page: PageRequest): Promise<Page<Document>> {
    const pk = tenantPk(tenantId);
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :doc)',
        ExpressionAttributeValues: { ':pk': pk, ':doc': 'DOC#' },
        // UUIDv7 sort keys: descending order = newest first.
        ScanIndexForward: false,
        Limit: page.limit,
        ExclusiveStartKey: page.cursor ? decodeCursor(page.cursor, pk) : undefined,
      }),
    );
    return {
      items: (res.Items ?? []).map(fromItem),
      nextCursor: res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : undefined,
    };
  }
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ PK: key.PK, SK: key.SK })).toString('base64url');
}

/**
 * Cursors come back from clients: never trust them as a DynamoDB key. A cursor minted for
 * another tenant would otherwise make the query start inside that tenant's partition range.
 */
function decodeCursor(cursor: string, expectedPk: string): Record<string, string> {
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof key === 'object' &&
      key !== null &&
      (key as { PK?: unknown }).PK === expectedPk &&
      typeof (key as { SK?: unknown }).SK === 'string' &&
      (key as { SK: string }).SK.startsWith('DOC#')
    ) {
      return { PK: expectedPk, SK: (key as { SK: string }).SK };
    }
  } catch {
    // fall through
  }
  throw new ValidationError('cursor is invalid');
}
