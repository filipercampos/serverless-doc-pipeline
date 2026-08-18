import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { parseTenantId } from '../domain/tenant';
import { TenantClientPool } from '../infra/tenant-clients';
import { S3UploadSigner } from './s3-upload-signer';
import { TenantSessionFactory } from './tenant-session';

const sts = mockClient(STSClient);
const acme = parseTenantId('acme');
const globex = parseTenantId('globex');
let clock = Date.parse('2026-08-18T23:00:00Z');

function credentials(id: string) {
  return {
    Credentials: {
      AccessKeyId: id,
      SecretAccessKey: 's',
      SessionToken: 't',
      Expiration: new Date(clock + 15 * 60_000),
    },
  };
}

beforeEach(() => {
  sts.reset();
  clock = Date.parse('2026-08-18T23:00:00Z');
});

describe('TenantSessionFactory', () => {
  const factory = (max = 10) =>
    new TenantSessionFactory(new STSClient({}), 'arn:aws:iam::123456789012:role/tenant-access', {
      durationSeconds: 900,
      maxCachedTenants: max,
      now: () => clock,
    });

  it('assumes the tenant role with a tenant_id session tag', async () => {
    sts.on(AssumeRoleCommand).resolves(credentials('AKIA1'));
    const creds = await factory().credentialsFor(acme);
    expect(creds?.accessKeyId).toBe('AKIA1');
    expect(sts.commandCalls(AssumeRoleCommand)[0]!.args[0].input).toMatchObject({
      RoleSessionName: 'tenant-acme',
      DurationSeconds: 900,
      Tags: [{ Key: 'tenant_id', Value: 'acme' }],
    });
  });

  it('caches per tenant and refreshes shortly before expiry', async () => {
    let n = 0;
    sts.on(AssumeRoleCommand).callsFake(() => credentials(`AKIA${++n}`));
    const f = factory();
    const first = await f.credentialsFor(acme);
    expect(await f.credentialsFor(acme)).toBe(first);
    expect((await f.credentialsFor(globex))?.accessKeyId).not.toBe(first?.accessKeyId);

    clock += 14.5 * 60_000;
    expect(await f.credentialsFor(acme)).not.toBe(first);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(3);
  });

  it('bounds the cache', async () => {
    sts.on(AssumeRoleCommand).callsFake(() => credentials('AKIA'));
    const f = factory(1);
    await f.credentialsFor(acme);
    await f.credentialsFor(globex);
    await f.credentialsFor(acme);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(3);
  });

  it('is a no-op without a role ARN (local mode)', async () => {
    const local = new TenantSessionFactory(new STSClient({}), undefined);
    expect(local.enabled).toBe(false);
    await expect(local.credentialsFor(acme)).resolves.toBeUndefined();
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('signs presigned POSTs with the tenant session, not the function role', async () => {
    sts.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: 'ASIATENANTACME',
        SecretAccessKey: 's',
        SessionToken: 'tenant-token',
        Expiration: new Date(Date.now() + 900_000),
      },
    });
    const pool = new TenantClientPool(factory());
    const { fields } = await new S3UploadSigner(pool.for(acme).s3, 'bucket').sign({
      key: 'tenants/acme/documents/x',
      contentType: 'text/csv',
      maxBytes: 10,
      ttlSeconds: 60,
    });
    expect(fields['X-Amz-Credential']).toMatch(/^ASIATENANTACME\//);
    expect(fields['X-Amz-Security-Token']).toBe('tenant-token');
    expect(pool.for(acme)).toBe(pool.for(acme));
    expect(pool.for(globex)).not.toBe(pool.for(acme));
  });
});
