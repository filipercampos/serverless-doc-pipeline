# 3. SQS between S3 and Lambda; EventBridge + SQS fan-out instead of Step Functions

- Status: Accepted
- Date: 2026-08-13

## Context

Every uploaded object must be validated and recorded exactly once *in effect*, even though:

- S3 event notifications are at-least-once and may be duplicated.
- Tenants upload in bursts (thousands of files in minutes at month end).
- A single bad file (or a parser bug) must not block or poison other tenants' files.
- Downstream consumers (indexing, billing, tenant webhooks) want to react to "document processed" without the pipeline knowing about them.

## Decision

1. **S3 → SQS → Lambda**, not S3 → Lambda directly.
   - The queue absorbs bursts; the processor's **reserved concurrency** caps how hard we hit DynamoDB and S3, and how much of the account's Lambda concurrency one tenant's burst can take.
   - Event source mapping with `ReportBatchItemFailures` (Powertools `BatchProcessor`): only failed message ids are retried; the rest of the batch is deleted.
   - `maxReceiveCount: 5` redrive policy to a DLQ (14-day retention). Visibility timeout = 6 × function timeout, as AWS recommends for SQS event sources, so a slow attempt is never redelivered while still running.
   - Recovery after a fix is a DLQ **redrive** (`start-message-move-task`), see the runbook.
2. **Multi-step processing = one in-process pipeline + EventBridge fan-out**, not Step Functions.
   - Validation, checksum and metadata extraction run in one invocation: each step is milliseconds of CPU on a file of at most 10 MiB, and all need the same bytes. Splitting them would mean downloading the object several times or passing it through state (256 KB limit).
   - Work that is genuinely independent (search indexing, tenant notifications, billing) subscribes to `DocumentProcessed` on a custom EventBridge bus; each consumer gets **its own SQS queue + DLQ** as the rule target (the template ships one example: `IndexingQueue`). Consumers fail, retry and scale independently.

## Alternatives considered

- **S3 → Lambda (async invoke).** Simpler, but Lambda's internal async queue gives only 2 retries, no visibility of backlog, no partial batch semantics, and concurrency grows with the burst until it throttles.
- **S3 → EventBridge → Lambda.** Nice filtering, but still async invoke semantics unless we add SQS anyway; EventBridge for S3 also costs US$ 1/M events on top.
- **Step Functions (Standard) orchestrating validate → extract → publish.** Great visibility and per-step retries, but US$ 25 per million state transitions; with ~5 transitions per document that is ~US$ 125 per million documents, more than all other pipeline costs combined (see `docs/cost-model.md`). Express workflows are cheaper but lose exactly-once step execution and long history. Worth revisiting if processing becomes long-running (OCR, virus scanning with an external engine, human review).
- **SNS fan-out.** Equivalent to EventBridge for one event type; EventBridge gives content-based filtering per consumer (e.g. only `metadata.kind = "pdf"`), schema discovery and archive/replay.

## Consequences

- Backlog is visible (`ApproximateAgeOfOldestMessage`, alarmed) and bounded by reserved concurrency.
- Duplicates still happen (S3 and SQS are both at-least-once): ADR 0004.
- One more hop adds ~tens of ms of latency between upload and processing; irrelevant for this workload.
- EventBridge delivery is at-least-once too, so consumers de-duplicate on `detail.eventId`.
