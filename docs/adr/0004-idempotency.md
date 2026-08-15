# 4. Idempotent processing: Powertools idempotency + conditional transitions

- Status: Accepted
- Date: 2026-08-15

## Context

The same upload can reach the processor more than once:

1. S3 event notifications are at-least-once; duplicates of one event share the same `sequencer`.
2. SQS redelivers a message whose Lambda invocation succeeded but whose delete was lost, or whose batch partially failed and the function was retried.
3. Two copies may be in flight **concurrently** on different Lambda instances.
4. A client may re-POST with a still-valid presigned form (5-minute TTL), creating a new object *version* under the same key.

Side effects that must not repeat: the document record transition, the `DocumentProcessed` event (downstream billing/indexing), and the S3 GetObject (cost).

## Decision

Two independent layers plus version pinning:

1. **Powertools for AWS Lambda (TypeScript) idempotency utility**, `makeIdempotent` around the per-object function, persisted in a dedicated DynamoDB table (`id` hash key, TTL on `expiration`).
   - Key: JMESPath `[bucket, key, sequencer]` — the identity of an S3 event, not of the SQS message (the same event can arrive in two messages).
   - Expiry 24 h (longer than the worst-case retry window: 5 receives × 6-minute visibility timeout).
   - `registerLambdaContext` per invocation, so a record left `INPROGRESS` by a timed-out invocation expires with the invocation instead of blocking retries for 24 h.
   - Concurrent duplicate → `IdempotencyAlreadyInProgressError` → only that SQS record fails and is retried later, when it gets the stored result.
   - Failure → record deleted → the retry runs again from scratch.
2. **Conditional status transition** in the documents table: `PutItem … ConditionExpression: status = PENDING_UPLOAD`. Even if layer 1 is bypassed (record expired, table unavailable and bypassed by a future change, manual redrive weeks later), only one writer can move a document to a terminal state, and only the winner publishes.
3. **Bucket versioning + version pinning.** The processor reads the `versionId` from the event and stores it on the record. A later version of the same key (re-POST within the URL TTL) finds the document terminal with a different version and is ignored; consumers read the pinned version, so the content always matches the published `sha256`.

Events stay **at-least-once**: if an attempt dies after the transition but before `PutEvents`, the retry finds the document terminal (same version) and re-publishes. `detail.eventId = <documentId>:<status>` lets consumers de-duplicate.

## Alternatives considered

- **Only the conditional write (layer 2).** Correct for the record, but every duplicate would re-download the object and re-run parsers before discovering it lost; and there would be no way to distinguish "lost the race" from "retry after crash" to decide whether to re-publish.
- **SQS FIFO with content-based deduplication.** S3 cannot target FIFO queues, and the 5-minute dedup window would not cover redrives.
- **Hand-rolled idempotency table.** Powertools already implements in-progress leases, expiry, payload validation and Lambda-timeout awareness, and is maintained by AWS.
- **Idempotency key on `messageId`.** Wrong identity: S3 duplicates arrive as different SQS messages.

## Consequences

- One extra DynamoDB write (`PutItem` INPROGRESS) and one update (COMPLETED) per object: ~2 WRU, priced in `docs/cost-model.md`.
- Idempotency records hold only a compact summary (`outcome`, `key`, `status`) — no tenant content.
- Consumers must be idempotent on `eventId`; this is part of the published event contract.
