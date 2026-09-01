# Changelog

All notable fork-specific changes are documented here. Upstream history and
release notes remain available in the upstream repository.

## 3.2.1-immich-share.6 — 2026-09-01

### Added

- Added opt-in one-scan unlock links whose password is carried only in the URL
  fragment and submitted through the existing CSRF-protected unlock flow.

### Security

- Clear the credential fragment with `history.replaceState` before making the
  unlock request and refuse malformed, duplicated or control-bearing values.
- Apply `Referrer-Policy: no-referrer` to password-protected responses.
- Moved password-page behaviour from an inline script to a versioned static
  module and added fragment parsing and ordering regression tests.

## 3.2.1-immich-share.3 — 2026-08-27

### Security

- Bound HEAD, Range and interrupted-transfer retries with an absolute ready
  deadline so one visitor cannot retain the global ZIP slot indefinitely.
- Limited each visitor session to one non-terminal ZIP job and capped
  lightweight terminal tombstones while dropping retained assets immediately.
- Released the active queue slot on every transfer exception.
- Removed queue-position disclosure and redacted share credentials from logs.
- Added a prominent AGPL source offer linked to the exact running release.
- Added adversarial regression tests for leases, cleanup, fairness and logs.

## 3.2.1-immich-share.2 — 2026-08-27

### Security

- Added HMAC-authenticated double-submit CSRF protection and Fetch Metadata
  validation to every state-changing browser endpoint.
- Restricted client-generated ZIP URLs to validated same-origin paths and
  opaque job identifiers.
- Rebuilt compatibility redirects from fixed path prefixes and encoded route
  parameters instead of redirecting to request-controlled URLs.
- Added CSRF regression tests and resolved all CodeQL alerts open on the first
  fork release.

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
