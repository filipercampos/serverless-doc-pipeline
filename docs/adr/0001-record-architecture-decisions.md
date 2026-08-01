# 1. Record architecture decisions

- Status: Accepted
- Date: 2026-08-01

## Context

This pipeline makes several decisions that are cheap to make and expensive to revisit: compute model, queueing between S3 and Lambda, idempotency, tenant isolation, packaging. Reviewers and future maintainers need the *why*, not only the *what* that is visible in the SAM template.

## Decision

Keep Architecture Decision Records in `docs/adr/`, numbered, in the format described by Michael Nygard (Context, Decision, Alternatives, Consequences). An ADR is immutable once accepted; a change of mind is a new ADR that supersedes the old one.

## Consequences

- Every non-obvious line in `template.yaml` should be traceable to an ADR, the runbook or the threat model.
- Small overhead per decision; accepted.
