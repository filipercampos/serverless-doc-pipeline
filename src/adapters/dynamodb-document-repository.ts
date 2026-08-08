import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DocumentRepository } from '../application/ports';
import type { Document, DocumentStatus } from '../domain/document';
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
}
