# Architecture

## Context (C4 level 1)

```mermaid
flowchart LR
  user[Tenant user<br/>browser / API client] -->|ID token| api[(doc-pipeline)]
  admin[Tenant admin] -->|provisions users with custom:tenant_id| cognito[Amazon Cognito]
  user -->|sign in| cognito
  api -->|DocumentProcessed / DocumentRejected| consumers[Downstream consumers<br/>indexing, billing, webhooks]
  ops[On-call engineer] -->|dashboard, alarms, DLQ redrive| api
```

## Containers (C4 level 2)

```mermaid
flowchart TB
  subgraph Client
    b[Browser / SDK]
  end
  subgraph AWS["AWS account (one stack per environment)"]
    cog[Cognito user pool]
    apigw[API Gateway HTTP API<br/>JWT authorizer]
    cu[CreateUpload λ]
    qd[QueryDocuments λ]
    sts[STS<br/>TenantAccessRole + tenant_id tag]
    s3[(S3 uploads bucket<br/>SSE-KMS, versioned, BPA)]
    q[[SQS uploads]]
    dlq[[SQS uploads DLQ]]
    pu[ProcessUploads λ<br/>reserved concurrency 20]
    ddb[(DynamoDB documents<br/>PK=TENANT#id)]
    idem[(DynamoDB idempotency)]
    bus{{EventBridge bus}}
    arch[(Archive 30 d)]
    iq[[Indexing queue + DLQ]]
    cw[CloudWatch logs, EMF metrics,<br/>alarms, dashboard, X-Ray]
  end
  b -->|1 sign in| cog
  b -->|2 POST /documents| apigw --> cu
  cu -->|AssumeRole + TagSession| sts
  cu -->|PutItem PENDING_UPLOAD<br/>tenant session| ddb
  cu -->|presigned POST signed<br/>with tenant session| b
  b -->|3 multipart POST| s3
  s3 -->|ObjectCreated| q --> pu
  q -. 5 receives .-> dlq
  pu -->|GetObject versionId| s3
  pu --> idem
  pu -->|conditional Put| ddb
  pu -->|PutEvents| bus --> iq
  bus --> arch
  b -->|4 GET /documents/id| apigw --> qd --> ddb
  cu & qd & pu --> cw
```

## Code layout (hexagonal)

| Layer | Path | Depends on | Notes |
|---|---|---|---|
| Domain | `src/domain` | nothing | Document lifecycle, tenant/document ids, object-key layout, upload policy. ESLint forbids AWS imports. |
| Application | `src/application` | domain | Use cases (`RequestUpload`, `ProcessDocument`, `QueryDocuments`), ports, content inspection, event contract. |
| Adapters | `src/adapters` | application, AWS SDK, parsers | DynamoDB repository, S3 signer/object store, EventBridge publisher, STS tenant sessions, CSV/JSON/PDF extractors. |
| Handlers | `src/handlers` | everything | Lambda entry points: parse event → use case → response. Composition at module scope. |
| Infra | `src/infra` | AWS SDK, Powertools | Env parsing, client factories (X-Ray instrumented), tenant client pool, observability wrapper. |

## Upload and processing sequence

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant A as API (CreateUpload)
  participant D as DynamoDB
  participant S as S3
  participant Q as SQS
  participant P as ProcessUploads
  participant I as Idempotency table
  participant E as EventBridge
  C->>A: POST /documents {fileName, contentType, sizeBytes} + ID token
  A->>D: PutItem PENDING_UPLOAD (attribute_not_exists, tenant session)
  A-->>C: 201 {documentId, upload: {url, fields}} (exact key, content-length-range, Content-Type)
  C->>S: multipart POST (fields + file)
  S->>Q: ObjectCreated (key, versionId, sequencer)
  Q->>P: batch (≤10)
  P->>I: PutItem INPROGRESS key=hash(bucket,key,sequencer)
  P->>D: GetItem (must be PENDING_UPLOAD)
  P->>S: GetObject(versionId)
  P->>P: sniff → SHA-256 → extract metadata
  P->>D: Put PROCESSED/REJECTED if status = PENDING_UPLOAD
  P->>E: PutEvents DocumentProcessed / DocumentRejected
  P->>I: UpdateItem COMPLETED (stores compact result)
  P-->>Q: {batchItemFailures: [...failed ids]}
  C->>A: GET /documents/{id}
```

## Data model (documents table)

| Attribute | Example | Notes |
|---|---|---|
| `PK` | `TENANT#acme` | Partition = tenant; IAM `LeadingKeys` pins sessions to it |
| `SK` | `DOC#01a2093c-6894-74bd-…` | UUIDv7: sort order = creation order, so listing needs no GSI |
| `status` | `PENDING_UPLOAD` / `PROCESSED` / `REJECTED` | Transitions are conditional Puts |
| `objectKey`, `versionId` | `tenants/acme/documents/<id>`, `M2Ia…` | Version pinned at processing time |
| `sizeBytes`, `sha256`, `metadata` | `{"kind":"csv","rowCount":3,…}` | Metadata is a tagged union per content type |
| `expiresAt` | epoch s | TTL only while pending (7 days); removed on transition |

## Event contract

`source = doc-pipeline.documents`, `detail-type ∈ {DocumentProcessed, DocumentRejected}`, `detail.schemaVersion = 1`, `detail.eventId = <documentId>:<status>` for consumer de-duplication. Types: [`src/application/events.ts`](../src/application/events.ts). Breaking changes get a new detail-type.

## Limits and quotas to watch

| Limit | Value here | Why |
|---|---|---|
| Max upload | 10 MiB (`MaxUploadBytes`) | Enforced by S3 (policy) and again by the processor |
| Presigned POST TTL | 5 min | Bounded also by the tenant session lifetime |
| Processor reserved concurrency / ESM max concurrency | 20 / 18 | Caps DynamoDB/S3 pressure; ESM below reserved avoids throttles |
| API reserved concurrency | 50 each | Protects the account pool; throttles are alarmed |
| HTTP API stage throttling | 100 rps, burst 200 | Coarse; per-tenant quotas are a known gap (threat model) |
