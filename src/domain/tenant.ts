import { ValidationError } from './errors';

declare const tenantBrand: unique symbol;
/** Tenant identifier taken from a verified token claim. Safe to embed in S3 keys and DynamoDB keys. */
export type TenantId = string & { readonly [tenantBrand]: true };

// Lowercase slug: no '/', '#', '.', so it can never escape its S3 prefix or DynamoDB partition.
const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function parseTenantId(raw: unknown): TenantId {
  if (typeof raw !== 'string' || !TENANT_ID.test(raw)) {
    throw new ValidationError('tenant id claim is missing or malformed');
  }
  return raw as TenantId;
}

declare const documentBrand: unique symbol;
export type DocumentId = string & { readonly [documentBrand]: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseDocumentId(raw: unknown): DocumentId {
  if (typeof raw !== 'string' || !UUID.test(raw)) {
    throw new ValidationError('document id must be a lowercase UUID');
  }
  return raw as DocumentId;
}
