import { AssumeRoleCommand, type STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import type { TenantId } from '../domain/tenant';

export const TENANT_TAG = 'tenant_id';

/**
 * Issues short-lived credentials scoped to ONE tenant (ADR 0005).
 *
 * The API functions assume `TenantAccessRole` with a `tenant_id` session tag. That role's policy
 * only allows DynamoDB items whose partition key is `TENANT#${aws:PrincipalTag/tenant_id}`
 * (`dynamodb:LeadingKeys`) and S3 objects under `tenants/${aws:PrincipalTag/tenant_id}/`.
 * A bug that builds the wrong key — or a cursor/path injection that slips past validation —
 * is then denied by IAM instead of leaking another tenant's data.
 *
 * Without a role ARN (local runs, LocalStack) it returns undefined and callers fall back to the
 * function's own credentials.
 */
export class TenantSessionFactory {
  private readonly cache = new Map<TenantId, AwsCredentialIdentity>();

  constructor(
    private readonly sts: STSClient,
    private readonly roleArn: string | undefined,
    private readonly opts: {
      durationSeconds: number;
      maxCachedTenants: number;
      now?: () => number;
    } = {
      durationSeconds: 900,
      maxCachedTenants: 200,
    },
  ) {}

  get enabled(): boolean {
    return this.roleArn !== undefined;
  }

  async credentialsFor(tenantId: TenantId): Promise<AwsCredentialIdentity | undefined> {
    if (!this.roleArn) return undefined;
    const now = (this.opts.now ?? Date.now)();
    const cached = this.cache.get(tenantId);
    // Refresh one minute early so an in-flight request never carries expired credentials.
    if (cached?.expiration && cached.expiration.getTime() - now > 60_000) return cached;

    const { Credentials } = await this.sts.send(
      new AssumeRoleCommand({
        RoleArn: this.roleArn,
        RoleSessionName: `tenant-${tenantId}`.slice(0, 64),
        DurationSeconds: this.opts.durationSeconds,
        Tags: [{ Key: TENANT_TAG, Value: tenantId }],
      }),
    );
    if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey) {
      throw new Error('AssumeRole returned no credentials');
    }
    const identity: AwsCredentialIdentity = {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
      expiration: Credentials.Expiration,
    };
    // Bounded cache: evict the oldest entry (Map preserves insertion order).
    this.cache.delete(tenantId);
    if (this.cache.size >= this.opts.maxCachedTenants) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(tenantId, identity);
    return identity;
  }
}
