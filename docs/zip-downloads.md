# Bounded and resumable ZIP downloads

## Lifecycle

1. The browser creates a job with `POST .../download/prepare`.
2. The server binds a random job identifier to the visitor's signed session.
3. One job fetches originals from Immich with bounded concurrency; up to three
   additional jobs wait in FIFO order.
4. Source bytes are counted while staging. The operation stops with 413 when the
   configured ceiling is crossed.
5. Only after every source succeeds does IPP build an immutable STORE archive.
6. The ready response exposes the exact size. A separate user click starts the
   file response, which supports HEAD and HTTP byte ranges within an absolute,
   non-renewable ready deadline.
7. The archive expires automatically. Stale staging paths and cache files are
   swept after restart.

The UI does not promise an ETA. Upstream throughput, file sizes, retries and
mobile connectivity make a reliable estimate impossible, and publishing one
would expose unnecessary capacity information.

## Resource model

- One active lifecycle covers preparation, ready lease and transfer.
- The waiting list is bounded and lives only in memory.
- The ZIP cache lives on the filesystem selected by `TMPDIR`; do not put a
  multi-gigabyte ceiling on a small RAM tmpfs.
- Preflight capacity is conservative: `2 × maxDownloadZipBytes` plus
  `minDownloadZipFreeBytes` must be available.
- Archives use STORE because photos and videos are already compressed.

## Security properties

- A queue job is authorized by share access, scope, visitor session and an
  opaque 144-bit identifier.
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
