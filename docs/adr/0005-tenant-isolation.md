# 5. Tenant isolation: pooled storage, tenant-scoped IAM sessions

- Status: Accepted
- Date: 2026-08-18

## Context

All tenants share one bucket, one documents table and one set of functions (pooled model). The failure we fear most is not an outside attacker but **our own bug**: a handler that builds a key from the wrong variable, a pagination cursor that is trusted, a path parameter that is not validated. In a pooled model one such bug leaks every tenant's data.

The tenant identity comes from the Cognito custom attribute `custom:tenant_id`, set by an admin flow at sign-up and **not writable** by the user's app client. API Gateway's JWT authorizer verifies the token (signature, issuer, audience, expiry) before any code runs.

## Decision

Defense in depth, each layer sufficient on its own for the common bugs:

1. **Identity only from the token.** Handlers read the tenant from `requestContext.authorizer.jwt.claims["custom:tenant_id"]`, never from the body, path or query. A token without a well-formed claim gets 403.
2. **Tenant is the partition key.** `PK = TENANT#<tenantId>`, `SK = DOC#<uuidv7>`; S3 keys are `tenants/<tenantId>/documents/<uuid>` and built only by the server. Tenant ids are restricted to `[a-z0-9-]` so they cannot contain `/`, `#` or `..`.
3. **Tenant-scoped IAM sessions on the API path.** API functions call `sts:AssumeRole` on `TenantAccessRole` with session tag `tenant_id=<tenant>` (cached ~14 min per tenant). The role allows only:
   - `dynamodb:GetItem|PutItem|Query` with `ForAllValues:StringEquals dynamodb:LeadingKeys = TENANT#${aws:PrincipalTag/tenant_id}`;
   - `s3:PutObject` on `arn:aws:s3:::<bucket>/tenants/${aws:PrincipalTag/tenant_id}/*`.
   The presigned POST is signed with these credentials, so S3 evaluates the upload against the tenant session: a POST for another tenant's prefix is denied by S3 even if our code produced it.
4. **Opaque cursors are re-validated** against the caller's partition before use; ids that fail validation return 404, never 400/403, so existence of other tenants' documents is not observable.
5. **Processor runs with its own role**, not per tenant: it is driven by S3 events, derives the tenant from the key layout, and requires a matching record created through the API. Its role can read objects and write document records but cannot list the bucket or query the table.

## Alternatives considered

- **Silo (bucket + table per tenant).** Strongest isolation and per-tenant KMS keys, but CloudFormation-per-tenant onboarding, account limits (1,000 buckets default; table counts), and cross-tenant operations (dashboards, migrations) multiply. Reasonable for a handful of regulated tenants; the template could be stamped per tenant if that tier is ever sold.
- **Application checks only.** Cheapest; one bug away from a breach.
- **One IAM role per tenant.** IAM role quotas (default 1,000 per account) and onboarding churn; ABAC with session tags gives the same effect with one role.
- **Lambda authorizer that returns a tenant-scoped policy.** Moves the same STS work into the authorizer and adds latency to every request; the JWT authorizer is free of code and caches nothing we need.

## Consequences

- One `AssumeRole` per tenant per ~14 minutes per warm instance (STS is free; adds ~tens of ms on that request).
- `TenantAccessRole` trust policy must allow `sts:TagSession` from the API function roles only.
- Local runs and LocalStack do not enforce IAM; isolation layer 3 is validated by `cfn-lint` and review, not by integration tests. Layers 1, 2 and 4 are covered by unit tests.
- The processor's role is broader than a tenant session; its blast radius is limited by not having `Query`/`Scan` and by never being reachable from the API.
