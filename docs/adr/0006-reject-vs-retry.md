# 6. Rejected content vs. retried failures

- Status: Accepted
- Date: 2026-08-13

## Context

The processor sees three kinds of failure, and treating them alike is wrong in both directions:

- Retrying a file that is definitively invalid wastes five attempts and floods the DLQ with noise that nobody can fix.
- Rejecting a file because DynamoDB throttled once (or because our PDF parser has a bug) tells the tenant their valid file is bad — a silent, permanent false negative.

## Decision

| Failure | Example | Handling |
|---|---|---|
| **Content we understand to be invalid** (`ContentRejectedError`) | empty file, declared PDF without `%PDF-` header, invalid UTF-8 in CSV/JSON, malformed JSON, ragged CSV, size above limit | Document → `REJECTED` with reason; object tagged `pipeline-status=rejected` (expired by lifecycle after 7 days); `DocumentRejected` event; **message acknowledged** |
| **Not ours** | key outside `tenants/<id>/documents/<uuid>`, no document record (pending record expired), object deleted before processing | Logged + counted, object tagged `orphan`; **message acknowledged** |
| **Everything else** | S3/DynamoDB/EventBridge errors, Lambda timeout, *third-party parser exceptions* (pdf-lib throwing on a corrupt PDF), malformed SQS body | **Thrown** → batch item failure → retried → DLQ after `maxReceiveCount` → alarm |

Parser exceptions are deliberately in the last bucket. A file that passed sniffing but crashes the parser may be corrupt, or may expose a bug in our code or the library. Only a human can tell; the DLQ plus the runbook's redrive procedure lets us fix the parser and recover the documents without asking tenants to re-upload.

## Alternatives considered

- **Reject on any processing error.** Simple, but turns transient infrastructure errors into permanent customer-visible failures.
- **Retry everything.** Invalid content would cycle five times and land in the DLQ, making the DLQ alarm meaningless.
- **A `FAILED` status written after N attempts by the processor itself.** Requires reading `ApproximateReceiveCount` and duplicating the redrive policy in code. The DLQ already is that state; the document stays `PENDING_UPLOAD` and the status API tells the tenant it is still processing.

## Consequences

- A DLQ message always means "a human needs to look": the DLQ depth alarm is actionable.
- Documents whose message is in the DLQ remain `PENDING_UPLOAD` until redriven; the pending-record TTL (7 days) must be longer than the DLQ triage SLO (2 business days), or redrives find no record (they are then acknowledged as orphans — documented in the runbook).
- New extractors must decide explicitly which of their errors are `ContentRejectedError`.
