# Cost model per 1 million documents (estimate)

> **Labelled estimate, not a bill.** Unit prices are us-east-1 on-demand list prices for the services below, snapshot dated **2026-08-29**; re-check the AWS pricing pages before relying on them. No free tier applied. Durations and sizes are **assumptions**, not measurements from a deployed stack (this project has not been load-tested on AWS).

## Assumptions

| Input | Value | Note |
|---|---|---|
| Documents | 1,000,000 | 99% valid |
| Average file size | 500 KB | |
| API calls per document | 1 `POST /documents` + 3 `GET /documents/{id}` (status polling) | 4M requests |
| API Lambda | 512 MB arm64, 60 ms billed average | assumption; init excluded |
| Processor Lambda | 1024 MB arm64, 300 ms billed per document | assumption for 500 KB files |
| Processor batch | 5 messages per invocation on average | 200k invocations |
| Log volume | ~4 KB per document (all functions, incl. EMF) | 4 GB |
| X-Ray | default sampling (~5% of requests) | ~250k traces |

## Per-million estimate

| Service | Usage | Unit price | Cost (US$) |
|---|---|---|---|
| API Gateway HTTP API | 4M requests | 1.00 / M | 4.00 |
| Lambda requests | 4.2M | 0.20 / M | 0.84 |
| Lambda compute – API | 4M × 0.5 GB × 0.06 s = 120k GB-s | 0.0000133334 / GB-s (arm64) | 1.60 |
| Lambda compute – processor | 1M × 1 GB × 0.3 s = 300k GB-s | 0.0000133334 / GB-s (arm64) | 4.00 |
| S3 POST (PUT-class) | 1M | 0.005 / 1k | 5.00 |
| S3 GET | 1M | 0.0004 / 1k | 0.40 |
| SQS | ~1.4M requests (notify, batched receive/delete) | 0.40 / M | 0.56 |
| DynamoDB writes | ~5 WRU/doc (create 1, transition 2, idempotency 2) = 5M WRU | 0.625 / M WRU | 3.13 |
| DynamoDB reads | ~4 RRU/doc (processor 1, status 3; strongly consistent) = 4M RRU | 0.125 / M RRU | 0.50 |
| EventBridge custom events | 1M `PutEvents` entries | 1.00 / M | 1.00 |
| EventBridge archive | ~1 GB | 0.10 / GB | 0.10 |
| CloudWatch Logs ingestion | 4 GB | 0.50 / GB | 2.00 |
| X-Ray traces | ~250k | 5.00 / M | 1.25 |
| KMS | S3 Bucket Keys → negligible requests | 0.03 / 10k | < 0.10 |
| STS `AssumeRole` | – | free | 0.00 |
| **Total (variable)** | | | **≈ 24.5** |

Roughly **US$ 25 per million documents**, dominated by S3 POST requests, API Gateway and processor compute. Doubling status polling adds ~US$ 2.

## Not per-document (monthly, separate)

| Item | Estimate (US$/month) |
|---|---|
| S3 storage: 1M × 500 KB = ~500 GB Standard (moves to Intelligent-Tiering after 30 days) | ~11.50 per month that data is kept |
| Noncurrent versions (30 days) | only for overwrites; usually ~0 |
| KMS customer managed key | 1.00 |
| Custom metrics (≈10 EMF metrics × service dimension) | ~3.00 |
| Alarms (10: 8 standard, 2 with metric math) | ~1.50 |
| Dashboard | 3.00 |
| Cognito | per monthly active user, by tier — depends on tenant user count |
| Provisioned concurrency (prod: 2 × 512 MB on the upload alias) | ~8.60 (2 × 0.5 GB × 2.592M s × 0.0000033334 GB-s) + reduced duration price |

## Alternatives priced the same way

| Option | Extra cost per 1M documents | Why not chosen |
|---|---|---|
| Step Functions Standard (~5 state transitions/document) | +125 (0.025 per 1k transitions) | ADR 0003 |
| S3 → EventBridge → SQS instead of S3 → SQS | +1 (S3 events to EventBridge) | No benefit for a single consumer of S3 events |
| Fargate processor, 2 × 0.25 vCPU / 0.5 GB always on | ~18 / month fixed + ALB ~16 / month if exposed, before any document | ADR 0002 |

## Levers if cost matters

1. Status polling → push (`DocumentProcessed` to a WebSocket/AppSync or a tenant webhook) removes most of the GET traffic.
2. Eventually consistent status reads halve read RRUs (at the cost of a possible stale `PENDING_UPLOAD` right after processing).
3. Lower log level in prod (`INFO` already) and X-Ray sampling rules for the read path.
