import { Logger } from '@aws-lambda-powertools/logger';
import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import type { Context } from 'aws-lambda';

/**
 * One logger / tracer / metrics instance per execution environment.
 * - Logger: JSON lines with service, cold start, function request id and our correlation keys.
 * - Tracer: X-Ray; AWS SDK clients are instrumented in aws-clients.ts.
 * - Metrics: CloudWatch Embedded Metric Format — written to stdout, extracted by CloudWatch
 *   asynchronously, so emitting a metric costs no API call and no latency.
 *
 * Service name and namespace come from POWERTOOLS_SERVICE_NAME / POWERTOOLS_METRICS_NAMESPACE.
 * Tenant ids are log keys and EMF metadata, never metric dimensions (unbounded cardinality).
 */
export const logger = new Logger({
  // Never log credentials or presigned form fields, even at debug level.
  jsonReplacerFn: (key: string, value: unknown) =>
    ['Policy', 'X-Amz-Signature', 'X-Amz-Security-Token', 'authorization'].includes(key)
      ? '[redacted]'
      : value,
});
export const tracer = new Tracer();
export const metrics = new Metrics();
export { MetricUnit };

/**
 * Wraps a handler invocation: Lambda context in logs, a handler subsegment with cold-start
 * annotation, cold-start metric, and a guaranteed EMF flush even when the handler throws.
 */
export async function observe<T>(
  context: Context | undefined,
  keys: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  if (context) logger.addContext(context);
  logger.appendKeys(keys);
  metrics.captureColdStartMetric();

  const parent = tracer.getSegment();
  const subsegment = parent?.addNewSubsegment(`## ${process.env._HANDLER ?? 'handler'}`);
  if (subsegment) {
    tracer.setSegment(subsegment);
    tracer.annotateColdStart();
    tracer.addServiceNameAnnotation();
  }
  try {
    return await fn();
  } catch (err) {
    if (subsegment) tracer.addErrorAsMetadata(err as Error);
    throw err;
  } finally {
    subsegment?.close();
    if (parent) tracer.setSegment(parent);
    // Read-only invocations may record nothing; skip the flush instead of logging a warning.
    if (metrics.hasStoredMetrics()) metrics.publishStoredMetrics();
    logger.resetKeys();
  }
}
