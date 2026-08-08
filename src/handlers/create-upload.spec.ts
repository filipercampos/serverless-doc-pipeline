import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { httpEvent } from '../../test/fixtures/http-event';
import { handler } from './create-upload';

const ddb = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddb.reset();
  ddb.on(PutCommand).resolves({});
});

describe('POST /documents', () => {
  it('returns 201 with a presigned POST under the caller tenant prefix', async () => {
    const res = await handler(
      httpEvent({ body: { fileName: 'q3.pdf', contentType: 'application/pdf', sizeBytes: 1000 } }),
    );

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body!) as {
      documentId: string;
      upload: { url: string; fields: Record<string, string> };
    };
    expect(body.upload.fields.key).toBe(`tenants/acme/documents/${body.documentId}`);
    expect(res.headers?.location).toBe(`/documents/${body.documentId}`);
    const item = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item;
    expect(item).toMatchObject({ PK: 'TENANT#acme', fileName: 'q3.pdf' });
  });

  it('isolates tenants: the key prefix comes from the token, never from the body', async () => {
    const res = await handler(
      httpEvent({
        tenantId: 'globex',
        body: { fileName: 'x.csv', contentType: 'text/csv', sizeBytes: 1, tenantId: 'acme' },
      }),
    );
    const body = JSON.parse(res.body!) as { upload: { fields: Record<string, string> } };
    expect(body.upload.fields.key).toMatch(/^tenants\/globex\/documents\//);
  });

  it('returns 403 when the token has no tenant claim', async () => {
    const res = await handler(httpEvent({ tenantId: null, body: {} }));
    expect(res.statusCode).toBe(403);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('returns 400 problem details for invalid input', async () => {
    const res = await handler(
      httpEvent({ body: { fileName: 'a.svg', contentType: 'image/svg+xml', sizeBytes: 10 } }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers?.['content-type']).toBe('application/problem+json');
    expect(JSON.parse(res.body!)).toMatchObject({
      title: 'validation_failed',
      requestId: 'req-123',
    });
  });

  it('hides internal errors behind a generic 500', async () => {
    ddb
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'secret detail', $metadata: {} }));
    const res = await handler(
      httpEvent({ body: { fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 } }),
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret detail');
  });
});
