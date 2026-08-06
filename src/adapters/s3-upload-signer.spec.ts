import { S3Client } from '@aws-sdk/client-s3';
import { S3UploadSigner } from './s3-upload-signer';

describe('S3UploadSigner', () => {
  const s3 = new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' },
  });

  it('embeds size, content-type and exact-key conditions in the signed policy', async () => {
    const signer = new S3UploadSigner(s3, 'docs-bucket');

    const { url, fields } = await signer.sign({
      key: 'tenants/acme/documents/0b7e4f6a-3c1d-4e8f-9a2b-5c6d7e8f9a0b',
      contentType: 'application/pdf',
      maxBytes: 1024,
      ttlSeconds: 300,
    });

    expect(url).toContain('docs-bucket');
    expect(fields.key).toBe('tenants/acme/documents/0b7e4f6a-3c1d-4e8f-9a2b-5c6d7e8f9a0b');
    expect(fields['Content-Type']).toBe('application/pdf');
    expect(fields['X-Amz-Security-Token']).toBe('token');

    const policy = JSON.parse(Buffer.from(fields.Policy!, 'base64').toString('utf8')) as {
      expiration: string;
      conditions: unknown[];
    };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['content-length-range', 1, 1024],
        ['eq', '$Content-Type', 'application/pdf'],
        { bucket: 'docs-bucket' },
        { key: 'tenants/acme/documents/0b7e4f6a-3c1d-4e8f-9a2b-5c6d7e8f9a0b' },
      ]),
    );
    const ttl = new Date(policy.expiration).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThanOrEqual(300_000);
  });
});
