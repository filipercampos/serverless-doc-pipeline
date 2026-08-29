# Runbook

All alarms are defined in [`template.yaml`](../template.yaml); the `<stack>-pipeline` CloudWatch dashboard shows the same signals. Replace `<stack>` with the stack name (for example `doc-pipeline-prod`).

## Useful queries (CloudWatch Logs Insights)

Processor failures for the last hour, grouped by error:

```
fields @timestamp, tenantId, key, receiveCount, error.name, error.message
| filter message = "object failed; message will be retried"
| stats count() by error.name, error.message
```

Everything about one API request (the `requestId` is returned in every problem response):

```
fields @timestamp, @log, message, statusCode, errorCode
| filter correlationId = "<requestId>"
```

One document's journey (processor side):

```
fields @timestamp, outcome, status, reason, messageId
| filter key like "<documentId>"
```

## Alarm: Uploads DLQ not empty (`UploadsDlqDepthAlarm`)

Meaning: an upload failed 5 times. By design (ADR 0006) this is never invalid content: that would have been REJECTED. It is an infrastructure error, a malformed notification or a parser exception.

1. Look at the messages without consuming them for long: `aws sqs receive-message --queue-url <UploadsDlqUrl> --max-number-of-messages 10 --visibility-timeout 30 --attribute-names All`.
2. Find the error with the first Logs Insights query above (filter by `key`).
3. Decide:
   - **Transient** (throttling, AWS incident, timeout) and resolved → redrive (below).
   - **Parser bug** (e.g. pdf-lib throws on a valid PDF) → fix, deploy, then redrive. Add the file as a regression fixture.
   - **Corrupt file** that will never parse → leave the document as is and ask the tenant to re-upload, or mark it REJECTED by hand. Delete the message.
4. Redrive to the source queue:
   ```bash
   aws sqs start-message-move-task \
     --source-arn <UploadsDlqArn> \
     --destination-arn <UploadsQueueArn> \
     --max-number-of-messages-per-second 10
   aws sqs list-message-move-tasks --source-arn <UploadsDlqArn>
   ```
   Redriven messages are processed normally; the idempotency layer and conditional transition make a redrive of an already-processed document harmless.
5. Redrive must happen within the 7-day pending-record TTL. After that the record is gone and the processor acknowledges the object as an orphan (tagged, expired by lifecycle).

## Alarm: Backlog growing (`UploadsQueueAgeAlarm`, `UploadToProcessedLatencyAlarm`)

1. Dashboard → *Processor*: are `Errors` or `Throttles` non-zero? Is `ConcurrentExecutions` pinned at 18?
2. Pinned at max with no errors: genuine burst. The queue will drain; if the SLO matters, raise `ReservedConcurrentExecutions` and `ScalingConfig.MaximumConcurrency` together (keep the ESM value below the reserved one) — check DynamoDB and S3 KMS request headroom first.
3. Errors: see the DLQ section; failing messages also slow everyone else (retries after the 6-minute visibility timeout).
4. Zero concurrency with a backlog: the event source mapping is disabled or the function cannot be invoked. `aws lambda list-event-source-mappings --function-name <ProcessUploadsFunction>`.

## Alarm: Processor error rate / item failures

Whole-invocation errors mean something outside the batch processor failed: init error (bad env var after a deploy), timeout, or out-of-memory. Check `Init Duration`/`Max Memory Used` in the REPORT lines; roll back with `sam deploy` of the previous version if it started with a deploy.

## Alarm: Throttles (API or processor)

- API: tenants get 5xx. Check for a single tenant flooding (`stats count() by tenantId` on the API log group). Short term: raise reserved concurrency; long term: per-tenant usage plans (known gap).
- Processor: should not happen with `MaximumConcurrency < ReservedConcurrentExecutions`; check someone did not change one of them, or that the account concurrency pool is not exhausted by another workload.

## Alarm: API 5xx rate

Problem responses carry `requestId`; use the correlation query. Common causes: `AssumeRole` denied after an IAM change to `TenantAccessRole` (the trust policy uses the fixed API role name), DynamoDB throttling, KMS throttling on presigned POST signing (it is not KMS-bound; check the logs before assuming).

## Tenant reports "my document is stuck in PENDING_UPLOAD"

1. Get the `documentId`. Query the processor log by key. No log line → the upload never reached S3 (expired form, CORS, size over the limit — S3 answered the browser directly). Ask for the browser's response.
2. Failures logged → it is in retry or in the DLQ: follow the DLQ section.
3. Processed log line but record still pending → should be impossible (conditional write); escalate with the log lines.

## Consumer missed events

EventBridge archive keeps 30 days of `doc-pipeline.documents` events. Replay to the bus for a time window; consumers de-duplicate on `detail.eventId`:

```bash
aws events start-replay --replay-name fix-<date> \
  --event-source-arn <ArchiveArn> \
  --event-start-time 2026-08-28T00:00:00Z --event-end-time 2026-08-28T06:00:00Z \
  --destination Arn=<DocumentsBusArn>
```

## Tenant offboarding (data deletion)

1. Disable the tenant's Cognito users.
2. Delete objects under `tenants/<tenantId>/` (all versions) with a batch operation or a lifecycle rule scoped to the prefix.
3. Query `PK = TENANT#<tenantId>` and batch-delete the items. Idempotency records hold no tenant content and expire in 24 h.
4. Record the deletion (ticket, date, counts).
