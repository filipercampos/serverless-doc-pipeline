import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

/** Builds an HTTP API (payload v2) event as delivered after the Cognito JWT authorizer. */
export function httpEvent(opts: {
  method?: string;
  path?: string;
  body?: unknown;
  tenantId?: string | null;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims: Record<string, string> = { sub: 'user-1', 'cognito:username': 'alice' };
  if (opts.tenantId !== null) claims['custom:tenant_id'] = opts.tenantId ?? 'acme';
  return {
    version: '2.0',
    routeKey: `${opts.method ?? 'POST'} ${opts.path ?? '/documents'}`,
    rawPath: opts.path ?? '/documents',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    pathParameters: opts.pathParameters,
    queryStringParameters: opts.queryStringParameters,
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: opts.method ?? 'POST',
        path: opts.path ?? '/documents',
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.10',
        userAgent: 'jest',
      },
      requestId: 'req-123',
      routeKey: `${opts.method ?? 'POST'} ${opts.path ?? '/documents'}`,
      stage: '$default',
      time: '08/Aug/2026:14:00:00 +0000',
      timeEpoch: 1786197600000,
      authorizer: {
        principalId: '',
        integrationLatency: 0,
        jwt: { claims, scopes: [] },
      },
    },
  };
}
