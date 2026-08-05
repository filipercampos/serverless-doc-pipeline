import { parseDocumentId, parseTenantId, type DocumentId, type TenantId } from './tenant';

/**
 * Every object lives under `tenants/<tenantId>/documents/<documentId>`.
 * The client never chooses any part of the key: the file name is metadata, not a path,
 * which removes path traversal and cross-tenant overwrite from the attack surface.
 */
export const TENANT_ROOT = 'tenants';

export function tenantPrefix(tenantId: TenantId): string {
  return `${TENANT_ROOT}/${tenantId}/`;
}

export function objectKeyFor(tenantId: TenantId, documentId: DocumentId): string {
  return `${tenantPrefix(tenantId)}documents/${documentId}`;
}

export interface ParsedObjectKey {
  tenantId: TenantId;
  documentId: DocumentId;
}

/** Returns null for keys that were not produced by {@link objectKeyFor}. */
export function parseObjectKey(key: string): ParsedObjectKey | null {
  const parts = key.split('/');
  if (parts.length !== 4 || parts[0] !== TENANT_ROOT || parts[2] !== 'documents') return null;
  try {
    return { tenantId: parseTenantId(parts[1]), documentId: parseDocumentId(parts[3]) };
  } catch {
    return null;
  }
}
