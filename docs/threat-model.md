# Threat model (STRIDE)

Scope: HTTP API + Cognito, upload bucket, processing path (SQS, Lambda, parsers), documents and idempotency tables, EventBridge bus. Assets: tenant documents and their metadata; tenant isolation; availability of the pipeline.

Trust boundaries: (1) internet → API Gateway / S3 presigned POST, (2) API functions → tenant-scoped STS session, (3) uploaded bytes → parsers in the processor, (4) EventBridge → downstream consumers.

## Malicious uploads

| Threat | Example | Mitigation | Where |
|---|---|---|---|
| **Tampering** – content-type spoofing | `.exe` uploaded as `application/pdf` | Presigned POST pins `Content-Type`; processor sniffs bytes (`%PDF-` header, strict UTF-8, no NUL) and rejects mismatches | `s3-upload-signer.ts`, `inspect-content.ts` |
| **DoS** – oversized upload | 5 GB file on a "10 MB" form | `content-length-range` in the signed policy (S3 refuses); processor re-checks `ContentLength` and never buffers bodies over the limit | ADR 0004/0006, `s3-object-store.ts` |
| **DoS / RCE** – parser exploit | crafted PDF with deep object graphs, embedded JavaScript | pdf-lib parses structure only (no rendering, no JS, no font/image decoding); processor has no network egress needs beyond AWS APIs, its role cannot read other buckets; 60 s timeout and 1 GB memory cap; failures go to DLQ, not retried forever | `extractors.ts`, `template.yaml` |
| **DoS** – CSV bombs | one 10 MiB line, millions of columns | `max_record_size` 1 MiB; header echoed back truncated to 50 columns × 100 chars | `extractors.ts` |
| **Tampering** – swap content after validation | re-POST to the same key while the 5-minute form is still valid | Bucket versioning; processed `versionId` pinned on the record; later versions ignored and never re-announced; consumers read by version | ADR 0004 |
| **Tampering** – CSV formula injection downstream | `=HYPERLINK(...)` in a cell | Out of scope for the pipeline (we do not render CSV), **flagged to consumers** in the event contract docs: never open tenant CSV in a spreadsheet without escaping |  |
| **Information disclosure** – malware distribution | bucket used to host files for others | No public access (Block Public Access, bucket-owner-enforced), no presigned GET issued by this service, rejected/orphan objects expire after 7 days | `template.yaml` |

Not implemented: antivirus scanning (e.g. GuardDuty Malware Protection for S3 or a ClamAV step). If added, it belongs as a consumer of `DocumentProcessed` or as a step before `PROCESSED`, with its own ADR.

## Tenant breakout

| Threat | Example | Mitigation | Where |
|---|---|---|---|
| **Spoofing** – forged token | self-made JWT with `custom:tenant_id=globex` | API Gateway JWT authorizer verifies signature, issuer and audience against the user pool before Lambda runs | `template.yaml` (HttpApi Auth) |
| **Elevation** – user edits own tenant claim | `UpdateUserAttributes custom:tenant_id=globex` | Attribute is immutable (`Mutable: false`) and not in the app client's `WriteAttributes`; users are admin-created only | `template.yaml` (UserPool) |
| **Elevation** – tenant from request | `{"tenantId":"globex"}` in the body or a header | Tenant only ever read from the verified claim; unit test sends a conflicting body | `http.ts`, `create-upload.spec.ts` |
| **Elevation** – key/path traversal | `fileName: "../../globex/x"`, tenant id `acme/../globex` | Server builds every key; file name is metadata; tenant ids `[a-z0-9-]`; document ids must be UUIDs | `object-key.ts`, `tenant.ts` |
| **Information disclosure** – IDOR | `GET /documents/<globex-id>` with an acme token | Lookup key is `TENANT#acme` + id; unknown and foreign ids are both 404 | `query-documents.ts` |
| **Information disclosure** – forged pagination cursor | base64 of `{"PK":"TENANT#globex"}` | Cursor re-validated against the caller's partition | `dynamodb-document-repository.ts` |
| **Elevation** – bug in our code builds the wrong key | regression in a refactor | API calls run on `TenantAccessRole` sessions tagged with the tenant: IAM `dynamodb:LeadingKeys` and the S3 prefix condition deny cross-tenant access even if the code tries | ADR 0005 |
| **Elevation** – confused deputy via S3 notifications | another bucket sends events to our queue | Queue policy accepts `s3.amazonaws.com` only with `aws:SourceArn` = our bucket and `aws:SourceAccount`; processor also ignores unexpected bucket names | `template.yaml`, `process-uploads.ts` |

## Other STRIDE categories

| Threat | Example | Mitigation |
|---|---|---|
| **Repudiation** | tenant denies uploading a file | API access logs (request id, tenant claim, status), processor logs with tenant and message id, record stores `createdAt`/`processedAt`/`sha256`/`versionId`. CloudTrail S3 data events can be enabled for regulated tenants (cost) |
| **Information disclosure** | credentials or signed forms in logs | Logger replacer redacts `Policy`, `X-Amz-Signature`, `X-Amz-Security-Token`, `authorization`; problem details never include internal error messages |
| **Information disclosure** | data at rest / in transit | SSE-KMS with rotation + bucket keys; DynamoDB SSE; SQS SSE; bucket and queue policies deny non-TLS |
| **DoS** | one tenant floods uploads | Stage throttling, reserved concurrency on every function, queue absorbs bursts. **Gap:** no per-tenant quota — a noisy tenant can delay others' processing. Next step: per-tenant counters in DynamoDB checked in `RequestUpload`, or API Gateway usage plans per tenant (REST API) |
| **DoS** | poison message blocks a batch | Partial batch responses; poison message isolated and dead-lettered after 5 receives |
| **Tampering** | replayed SQS/S3 events | Idempotency keyed on S3 event identity + conditional transitions (ADR 0004) |

## Accepted risks

- LocalStack does not enforce IAM or presigned POST size conditions; those controls are verified by unit tests on the signed policy, `cfn-lint`, and review — not by integration tests.
- The processor role can read all tenants' objects (it must). It is not reachable from the API and has no `Query`/`Scan`.
- Event consumers receive tenant metadata (CSV header names). Consumers are internal and subscribe through reviewed rules.
