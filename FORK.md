# Fork maintenance policy

This repository keeps the full Git history of
[`alangrainger/immich-public-proxy`](https://github.com/alangrainger/immich-public-proxy).
The `upstream` remote is authoritative for the base application; fork-specific
work is committed separately and must remain reviewable.

## Supported base

The first fork release is based on upstream revision
`7c8df2f2b53cf938454ec2a7d2ce9c974a0a095e`, the same revision used by the
validated production image. Release tags use the form
`v<upstream-version>-immich-share.<revision>`.

`.github/upstream.json` is the machine-readable source of truth for the
selected upstream revision and release tag. The weekly `Upstream watch`
workflow compares that file with upstream `main` and the latest upstream
release. It opens or updates one maintenance issue when either changes; it
never merges code, creates a tag, publishes an image, or deploys anything.

## Fork delta

- One active ZIP lifecycle with a bounded, process-local FIFO.
- Visitor-bound opaque job identifiers and explicit prepare/status/file routes.
- English mobile dialog for queued, preparing, ready, failed and cancelled states.
- Disk-backed immutable ZIP cache with exact length and byte-range support.
- Aggregate source-size ceiling, free-space reserve and automatic cleanup.
- One non-terminal job per visitor, an absolute retry deadline, and bounded
  lightweight terminal status retention.
- Share-key log redaction and an exact-version AGPL source offer in the UI.
- Legacy direct ZIP endpoints disabled by default.
- Regression tests for queue isolation, FIFO ordering, size limits and resume.

The supported topology is one application replica. See
[`docs/zip-downloads.md`](./docs/zip-downloads.md) before deployment.

## Updating from upstream

Updates are never merged directly into a production release.

1. Fetch `upstream` and create `sync/upstream-<version>` from the current fork release.
2. Review upstream release notes, dependency changes and security fixes.
3. Merge the selected upstream tag or commit without squashing its history.
4. Resolve conflicts in small, auditable commits; do not patch generated files.
5. Update `.github/upstream.json` to the selected revision and release tag.
6. Run `npm ci`, `npm run build`, `npm test`, the container smoke test and the
   immich-share end-to-end ZIP suite.
7. Deploy to a non-public staging share and verify 200, 206, 403, 413, 429 and 507.
8. Tag only after review and preserve the prior immutable image digest for rollback.

Automation may open an update issue or pull request, but it must never deploy an
upstream change automatically.

## Contributing upstream

Generic fixes should be proposed to the upstream project when practical. Keep
deployment-specific policy in `immich-share`; keep reusable proxy behaviour in
this fork. Reducing the fork delta lowers long-term security and maintenance risk.
