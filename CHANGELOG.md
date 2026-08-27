# Changelog

All notable fork-specific changes are documented here. Upstream history and
release notes remain available in the upstream repository.

## 3.2.1-immich-share.1 — 2026-08-27

Based on upstream revision `7c8df2f2b53cf938454ec2a7d2ce9c974a0a095e`.

### Added

- Bounded process-local FIFO with one active ZIP lifecycle and three waiters.
- Visitor-bound opaque queue jobs and explicit prepare/status/file endpoints.
- Mobile-friendly English preparation dialog with Close and Leave queue actions.
- Immutable disk-backed ZIP cache with exact length, HEAD and byte-range resume.
- Aggregate 2 GiB ceiling, 5 GiB reserve and cache/staging cleanup.
- Tests for FIFO ordering, visitor isolation, 413 responses and 206 retries.
- Hardened non-root image, production dependency audit, CodeQL, Dependabot,
  container vulnerability scanning, SBOM and provenance attestations.
- CI coverage for application and documentation dependency audits and builds.

### Changed

- Default ZIP source-fetch concurrency reduced from 20 to 3.
- Legacy direct ZIP endpoints are disabled by default so they cannot bypass the queue.
- Development dependencies and GitHub Actions runtimes updated to resolve all
  advisories open at release time.

### Operational note

This release supports one application replica. Queue state, session signing and
prepared-job ownership are process-local; horizontal scaling requires a separate
coordination design and is intentionally out of scope for this release.
