# Bounded and resumable ZIP downloads

## Lifecycle

1. The browser asks the server to plan the album with `POST .../download/plan`.
   IPP reads the selected download endpoint's `Content-Length` without staging
   file bodies and orders assets by capture time then opaque asset id.
2. Albums at or below the split threshold continue automatically as one part.
   Larger albums are divided into deterministic, contiguous parts and the
   visitor chooses which independent part to prepare.
3. The browser creates that part's job with `POST .../download/prepare`. Both
   the opaque plan and job identifiers are bound to the signed visitor session.
4. Only one archive is prepared at a time. A bounded number of completed
   archives may be ready or downloading concurrently; additional jobs wait in
   FIFO order, including a returning multipart visitor.
5. Source bytes are counted while staging. The operation stops with 413 when the
   configured ceiling is crossed.
6. Only after every source succeeds does IPP build an immutable STORE archive.
7. The ready response exposes the exact size. A separate user click starts the
   file response, which supports HEAD and HTTP byte ranges within an absolute,
   non-renewable ready deadline.
8. The archive expires automatically. Stale staging paths and cache files are
   swept after restart.

The UI does not promise an ETA. Upstream throughput, file sizes, retries and
mobile connectivity make a reliable estimate impossible, and publishing one
would expose unnecessary capacity information.

## Resource model

- One preparation runs at a time. `downloadZipMaxParallelDownloads` bounds the
  number of retained ready/downloading jobs, and the reverse proxy remains the
  hard connection backstop.
- The waiting list is bounded and lives only in memory.
- The ZIP cache lives on the filesystem selected by `TMPDIR`; do not put a
  multi-gigabyte ceiling on a small RAM tmpfs.
- Preflight capacity is conservative. After subtracting
  `minDownloadZipFreeBytes`, staged originals plus the final STORE archive must
  fit inside `downloadZipDiskBudgetPercent` of the remaining free space. With
  the default 50%, a preparation can consume at most half of that safe pool.
  A conservative fixed and per-entry allowance covers ZIP metadata overhead.
- Archives use STORE because photos and videos are already compressed.

## Security properties

- A queue job is authorized by share access, scope, visitor session and an
  opaque 144-bit identifier.
- A plan is also visitor- and share-bound. The browser cannot submit its own
  asset membership, size ceiling or part boundaries.
- Repeated planning by the same visitor reuses the current plan. Per-plan asset
  count, total retained asset references, plan count and TTL are all bounded.
- One visitor session may own only one non-terminal job, independent of asset
  selection or share scope.
- Status responses do not expose other visitors, throughput or share details.
- Invalid or unauthorized job access returns 404.
- Cache files and partial archives are created privately and never become
  downloadable until finalization succeeds.
- Direct legacy ZIP routes are disabled by default.
- Queue capacity and reverse-proxy rate limits are complementary: the queue
  controls application work while the edge remains the hard connection and
  bandwidth backstop.

## Availability and scaling

The fork deliberately supports a single application replica. Jobs, session
signing and queue ownership are process-local. Do not place multiple replicas
behind round-robin load balancing: a follow-up status or file request could hit
a process that does not own the job. A future multi-replica design would require
shared coordination, stable session secrets and cache ownership semantics.

An application restart clears waiting jobs. Prepared cache files are disposable
and are removed according to their TTL; visitors can simply create a new job.
