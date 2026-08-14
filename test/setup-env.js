// Shared test environment: keep Powertools quiet and deterministic outside Lambda.
process.env.AWS_REGION ??= 'us-east-1';
process.env.POWERTOOLS_SERVICE_NAME ??= 'doc-pipeline';
process.env.POWERTOOLS_METRICS_NAMESPACE ??= 'DocPipeline';
process.env.POWERTOOLS_TRACE_ENABLED ??= 'false';
process.env.POWERTOOLS_LOG_LEVEL ??= 'SILENT';
process.env.POWERTOOLS_METRICS_DISABLED ??= 'true';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.DOCUMENTS_TABLE ??= 'documents-test';
process.env.UPLOAD_BUCKET ??= 'uploads-test';
process.env.EVENT_BUS_NAME ??= 'documents-test';
