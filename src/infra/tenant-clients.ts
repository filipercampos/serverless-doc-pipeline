import type { S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TenantSessionFactory } from '../adapters/tenant-session';
import type { TenantId } from '../domain/tenant';
import { dynamoDbDocumentClient, s3Client } from './aws-clients';
import { awsEndpoint, optionalEnv } from './env';

export interface TenantClients {
  dynamo: DynamoDBDocumentClient;
  s3: S3Client;
}

/**
 * Per-tenant SDK clients for the API functions. Each client resolves its credentials through
 * the session factory, so every request a client sends is signed as `tenant-<id>` and is
 * subject to the LeadingKeys / prefix conditions of TenantAccessRole.
 */
export class TenantClientPool {
  private readonly pool = new Map<TenantId, TenantClients>();
  private readonly shared: TenantClients;

  constructor(
    private readonly sessions: TenantSessionFactory,
    private readonly maxTenants = 200,
  ) {
    this.shared = { dynamo: dynamoDbDocumentClient(), s3: s3Client() };
  }

  for(tenantId: TenantId): TenantClients {
    if (!this.sessions.enabled) return this.shared;
    const existing = this.pool.get(tenantId);
    if (existing) return existing;

    const provider = async () => {
      const creds = await this.sessions.credentialsFor(tenantId);
      if (!creds) throw new Error('tenant session unavailable');
      return creds;
    };
    const clients = { dynamo: dynamoDbDocumentClient(provider), s3: s3Client(provider) };
    if (this.pool.size >= this.maxTenants) {
      const oldest = this.pool.keys().next().value;
      if (oldest !== undefined) this.pool.delete(oldest);
    }
    this.pool.set(tenantId, clients);
    return clients;
  }
}

export function tenantClientPoolFromEnv(): TenantClientPool {
  const endpoint = awsEndpoint();
  return new TenantClientPool(
    new TenantSessionFactory(
      new STSClient(endpoint ? { endpoint } : {}),
      optionalEnv('TENANT_ROLE_ARN'),
    ),
  );
}
