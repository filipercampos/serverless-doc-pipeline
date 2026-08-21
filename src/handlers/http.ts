import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { DocumentNotFoundError, DomainError, ValidationError } from '../domain/errors';
import { parseTenantId, type TenantId } from '../domain/tenant';
import { logger, observe, tracer } from '../infra/observability';

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

export type ErrorReporter = (err: unknown) => void;

const reportToLogs: ErrorReporter = (err) => logger.error('unhandled error', err as Error);

export function toHttpError(
  err: unknown,
  requestId: string,
  report: ErrorReporter = reportToLogs,
): HttpResult {
  if (err instanceof UnauthorizedError) return problem(403, 'forbidden', err.message, requestId);
  if (err instanceof DocumentNotFoundError) return problem(404, err.code, err.message, requestId);
  if (err instanceof DomainError) return problem(400, err.code, err.message, requestId);
  report(err);
  return problem(500, 'internal_error', 'unexpected error, retry later', requestId);
}

/**
 * Wraps a route: resolves the tenant, runs the action, maps failures to problem details.
 * The API Gateway request id is the correlation id: it is in every log line, in the X-Ray
 * annotations and in problem responses, so a tenant's support ticket can be traced end to end.
 */
export function handleHttp(
  event: HttpEvent,
  context: Context | undefined,
  action: (tenantId: TenantId) => Promise<HttpResult>,
): Promise<HttpResult> {
  const requestId = event.requestContext.requestId;
  const claim = event.requestContext.authorizer?.jwt?.claims?.[TENANT_CLAIM];
  return observe(
    context,
    {
      correlationId: requestId,
      route: event.routeKey,
      tenantId: typeof claim === 'string' ? claim : undefined,
    },
    async () => {
      try {
        const tenantId = tenantFromEvent(event);
        tracer.putAnnotation('tenantId', tenantId);
        const result = await action(tenantId);
        logger.info('request completed', { statusCode: result.statusCode });
        return result;
      } catch (err) {
        const result = toHttpError(err, requestId);
        logger.info('request failed', {
          statusCode: result.statusCode,
          errorCode: err instanceof DomainError ? err.code : undefined,
        });
        return result;
      }
    },
  );
}
