# 7. Cold starts: esbuild bundles, arm64, provisioned concurrency only on the upload API

- Status: Accepted
- Date: 2026-08-23

## Context

Two very different latency profiles:

- **API (upload ticket, status):** a user is waiting. A cold start on the first request of a session is visible.
- **Processor:** asynchronous; nobody waits on a single invocation, and the SQS poller keeps instances warm during bursts. A cold start only adds to upload-to-processed latency, which is alarmed at p95 > 60 s.

Cold start = sandbox + runtime bootstrap (AWS-controlled) + **our init**: loading and parsing the bundle and running module-scope code (SDK clients, Powertools, composition root). Only the last part is ours to optimise.

## Decision

1. **Bundle each handler separately with esbuild** (`Metadata: BuildMethod: esbuild` in SAM; `npm run build` reproduces it locally): minified, tree-shaken, source maps enabled with `NODE_OPTIONS=--enable-source-maps`.
2. **Bundle the AWS SDK v3** instead of relying on the copy in the Node.js runtime. We get pinned, tested versions and tree-shaking; the runtime copy can change under us between deployments.
3. **arm64 (Graviton)**: ~20% cheaper per GB-s at the same memory, and init times comparable to x86 for Node.js.
4. **Composition at module scope, clients created once**: credentials resolution and TLS setup are paid once per sandbox. Per-tenant clients are created lazily and cached (ADR 0005).
5. **Provisioned concurrency only on the upload API alias, only in prod, parameterised** (`UploadApiProvisionedConcurrency`, default 0; `samconfig.toml` prod profile sets 2). Not on the query API (polling clients tolerate one slow response), never on the processor.
6. **Memory**: 512 MB for API functions (CPU scales with memory; init is CPU-bound), 1024 MB for the processor (PDF parsing and SHA-256 of up to 10 MiB).

## Measurements

Bundle sizes from `npm run build` and module init time from `npm run measure:init` (fresh `node` process per sample, `require()` of the bundle including module-scope composition; 15 samples each). Measured 2026-08-23 on a developer laptop (Windows 11, Node 22.21, x64) while other projects were building on the same machine, so absolute numbers are noisy and not Lambda numbers; they are useful to compare changes against each other.

| Handler | Bundle (minified) | Init p50 | Init p90 |
|---|---|---|---|
| create-upload | 879 KiB | 150 ms | 174 ms |
| query-documents | 874 KiB | 216 ms | 276 ms |
| process-uploads | 1,485 KiB | 280 ms | 355 ms |

Largest contributors to the API bundle: `@smithy/core` (165 KiB), `@aws-sdk/client-s3` (141 KiB), `aws-xray-sdk-core` (96 KiB), `@aws-sdk/client-dynamodb` (80 KiB). The processor additionally carries `pdf-lib` and `csv-parse`.

Not measured: real Lambda `Init Duration` (requires a deployment). The README states this explicitly.

## Alternatives considered

- **SnapStart for Node.js.** Not available for the Node.js runtime at the time of writing (Java, Python, .NET only).
- **Externalise `@aws-sdk/*`.** Smaller zip, but the runtime's SDK is a full, un-tree-shaken install whose load time is also paid at init, and its version is outside our control.
- **Provisioned concurrency everywhere.** Pays for idle capacity on paths where nobody waits.
- **Lazy-load `pdf-lib`/`csv-parse` per content type.** Possible next step for the processor; not worth it while its cold starts are invisible to users.
- **LLRT (low-latency runtime).** Faster init, but experimental and not compatible with every Node API we use.

## Consequences

- Bundle size is a reviewed number: a dependency that adds hundreds of KiB to an API handler needs a reason.
- Provisioned concurrency costs money even when idle (priced in `docs/cost-model.md`); it is off by default.
- `query-documents` currently also bundles the S3 client because the tenant client pool creates both clients; splitting the pool per use would shave ~140 KiB if its cold starts ever matter.
