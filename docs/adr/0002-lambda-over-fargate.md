# 2. Lambda (plain TypeScript, hexagonal) over Fargate / NestJS

- Status: Accepted
- Date: 2026-08-01

## Context

Workload shape:

- Upload requests and status queries: small JSON requests, bursty (tenants batch-upload at month end), long idle periods at night.
- Processing: one unit of work per uploaded file, bounded by the 10 MiB upload limit, CPU-light (hash + parse header/rows), I/O-dominated (S3 GetObject, DynamoDB writes).
- Multi-tenant SaaS: cost should track usage, idle tenants should cost nothing.

The other services in this portfolio run NestJS on ECS/EKS. Consistency would argue for the same stack here.

## Decision

1. **AWS Lambda for every compute path**, defined in a single SAM template:
   API Gateway HTTP API → Lambda for the API, SQS → Lambda for processing.
2. **Plain TypeScript handlers with a hexagonal layout instead of NestJS**:
   - `src/domain` — entities, invariants, no I/O, no AWS imports (enforced by an ESLint `no-restricted-imports` rule).
   - `src/application` — use cases and the ports they need (`DocumentRepository`, `ObjectStore`, `UploadSigner`, `EventPublisher`).
   - `src/adapters` — DynamoDB, S3, EventBridge, STS implementations of those ports.
   - `src/handlers` — thin driving adapters: parse the event, call one use case, map the result. Composition happens at module scope so it runs once per cold start.

## Alternatives considered

- **ECS Fargate (NestJS) behind an ALB, polling SQS.** Predictable latency and no cold starts, but at least two always-on tasks per environment for HA (~US$ 9/month each for 0.25 vCPU / 0.5 GB, us-east-1 on-demand list price) before the first document arrives, plus an ALB (~US$ 16/month + LCUs), and we would own SQS polling, back-pressure and autoscaling on queue depth. Better fit if processing grows beyond 15 minutes or needs > 10 GB memory (large PDFs, OCR).
- **NestJS inside Lambda.** Works, but the DI container, reflection metadata and module graph add cold-start time and bundle size for no benefit: each function has one entry point and three or four collaborators, which plain constructor injection handles. The hexagonal boundaries give the same testability NestJS modules would.
- **Step Functions as the processing backbone.** See ADR 0003.

## Consequences

- Pay per request; idle environments cost close to zero (DynamoDB on-demand, no NAT, no ALB).
- Cold starts on the API path must be managed (bundling, lazy clients) — ADR 0007.
- Hard limits apply: 15-minute timeout, 10 GB memory, 6 MB synchronous payload (irrelevant here: files never pass through Lambda on upload, they go straight to S3 via presigned POST).
- No framework conventions to lean on; the layering is enforced by lint and by review.
