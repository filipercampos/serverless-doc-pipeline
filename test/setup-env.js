// Shared test environment: keep Powertools quiet and deterministic outside Lambda.
process.env.AWS_REGION ??= 'us-east-1';
process.env.POWERTOOLS_SERVICE_NAME ??= 'doc-pipeline';
process.env.POWERTOOLS_METRICS_NAMESPACE ??= 'DocPipeline';
process.env.POWERTOOLS_TRACE_ENABLED ??= 'false';
process.env.POWERTOOLS_LOG_LEVEL ??= 'SILENT';
process.env.POWERTOOLS_METRICS_DISABLED ??= 'true';
