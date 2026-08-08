import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { DocumentNotFoundError, DomainError, ValidationError } from '../domain/errors';
import { parseTenantId, type TenantId } from '../domain/tenant';

export type HttpEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type HttpResult = APIGatewayProxyStructuredResultV2;

/** Cognito custom attribute carrying the tenant. Users cannot write it (not in the app client's write attributes). */
export const TENANT_CLAIM = 'custom:tenant_id';

export class UnauthorizedError extends Error {}

/**
 * The JWT has already been verified by the API Gateway authorizer (issuer, audience, expiry,
 * signature). Here we only extract and validate the tenant claim; a token without one is
 * rejected even though it is otherwise valid.
 */
export function tenantFromEvent(event: HttpEvent): TenantId {
  const claim = event.requestContext.authorizer?.jwt?.claims?.[TENANT_CLAIM];
  try {
    return parseTenantId(claim);
  } catch {
    throw new UnauthorizedError('token has no valid tenant claim');
  }
}

export function parseJsonBody(event: HttpEvent): unknown {
  if (!event.body) throw new ValidationError('request body is required');
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ValidationError('request body is not valid JSON');
  }
}

export function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body),
  };
}

/** RFC 9457 problem details. Never includes internal error messages for 5xx. */
export function problem(
  status: number,
  code: string,
  detail: string,
  requestId?: string,
): HttpResult {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
    body: JSON.stringify({
      type: `https://docs.example.com/problems/${code}`,
      title: code,
      status,
      detail,
      ...(requestId ? { requestId } : {}),
    }),
  };
}

export interface ErrorReporter {
  (err: unknown): void;
}

export function toHttpError(err: unknown, requestId: string, report: ErrorReporter): HttpResult {
  if (err instanceof UnauthorizedError) return problem(403, 'forbidden', err.message, requestId);
  if (err instanceof DocumentNotFoundError) return problem(404, err.code, err.message, requestId);
  if (err instanceof DomainError) return problem(400, err.code, err.message, requestId);
  report(err);
  return problem(500, 'internal_error', 'unexpected error, retry later', requestId);
}

/** Wraps a route: resolves the tenant, runs the action, maps failures to problem details. */
export async function handleHttp(
  event: HttpEvent,
  action: (tenantId: TenantId) => Promise<HttpResult>,
  report: ErrorReporter = () => undefined,
): Promise<HttpResult> {
  const requestId = event.requestContext.requestId;
  try {
    return await action(tenantFromEvent(event));
  } catch (err) {
    return toHttpError(err, requestId, report);
  }
}
