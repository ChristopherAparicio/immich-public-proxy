# IPP options

Top-level options under `ipp.*`.

## Example

Serve full-resolution images both when zooming in the lightbox and when downloading:

```json
{
  "ipp": {
    "maxDownloadQuality": "fullsize",
    "maxZoomQuality": "fullsize"
  }
}
```

## `responseHeaders`

**Type:** `object`

Change the headers sent with your web responses. By default there is `cache-control` and CORS added.

## `maxDownloadQuality`

**Type:** `string` · **Default:** `"original"`

Highest quality served for a download (the download button and "download all" zip).

- `"original"` - the full-resolution original file (default).
- `"fullsize"` - full resolution but always browser-displayable: the original for JPEG/PNG/WebP, Immich's converted JPEG for RAW/HEIF.
- `"preview"` - only the ~1440px preview JPEG.

## `maxZoomQuality`

**Type:** `string` · **Default:** `"preview"`

Highest quality the lightbox loads when you zoom in past fit-to-screen.

- `"preview"` - keep the preview (default; zoom is capped to the preview's real pixels).
- `"fullsize"` - upgrade to the full-resolution browser-displayable image on zoom, à la the Immich web viewer.

`"original"` is intentionally not an option (it could be an unviewable RAW/DNG or a huge file).

**Independent of [`allowDownload`](#allowdownload)** - your download UI can be off while zoom is on. It only does anything where Immich can serve full resolution: the share's **own** "allow downloads" toggle in Immich must be on (the full-res image comes from the original file, which Immich gates on that toggle), and the format must be **web-displayable** (JPEG/PNG/WebP). Otherwise (RAW/HEIF, or a share with Immich downloads off) the lightbox stays on the preview. To enable zoom-up, leave the Immich share's download permission on and use [`allowDownload`](#allowdownload) to control whether the download buttons appear.

## `downloadedFilename`

**Type:** `int` · **Default:** `0`

The filename of the downloaded image.

- `0` - the original filename if available, falling back to the Immich asset ID.
- `1` - the Immich asset ID number.
- `2` - a shortened version of the asset ID: `img_` plus the first 8 characters of the asset ID.

## `allowDownload`

**Type:** `int` · **Default:** `0`

Show the download UI - the "download all" zip, the multi-select download, and the per-asset download button in the lightbox. Purely a UI switch; it has no effect on image quality (see [`maxZoomQuality`](#maxzoomquality) / [`maxDownloadQuality`](#maxdownloadquality)).

- `0` - downloads off.
- `1` - follow the Immich share's own download setting ([example](https://github.com/user-attachments/assets/79ea8c08-71ce-42ab-b025-10aec384938a)).
- `2` - always on.

The bulk-zip and per-asset buttons can be toggled independently once downloads are allowed - see [`gallery.showDownloadZip`](/config/gallery#showdownloadzip) and [`lightbox.showDownload`](/config/lightbox#showdownload).

> [!NOTE]
> With `2`, IPP shows the download UI even on shares whose **own** download toggle in Immich is off - but Immich still refuses to serve those shares' original files, so IPP works around it where it can:
>
> - **Videos** are downloaded as the transcoded playback file instead of the original (the same stream the visitor can already watch). The filename extension follows the transcoded format, typically `.mp4`.
> - **Photos** download normally as long as [`maxDownloadQuality`](#maxdownloadquality) is below `original`; with `maxDownloadQuality: original` they fail, because the original file is exactly what Immich is refusing to serve.
> - **Gifs** always download as the original file (their preview is a static frame), so they fail on these shares.
>
> To guarantee full-quality downloads of everything, leave the share's download permission on in Immich.

## `downloadFromImmichConcurrencyLimit`

**Type:** `int` · **Default:** `3`

Maximum number of assets IPP will fetch from your Immich server in parallel when building a "download all" zip. Lower this if your Immich server is slow or you see download timeouts on large albums; raise it for faster downloads if your server can handle the load.

## Resumable ZIP downloads

Bulk downloads are prepared as immutable STORE archives before they are sent.
This provides an exact `Content-Length`, supports HTTP byte ranges, and lets a
mobile browser resume while the private cache is valid. Before preparation, IPP
plans the selected download sizes. Small albums continue automatically; large
albums are offered as deterministic independent parts. One archive is prepared
at a time, ready/download transfers are bounded, and additional visitors wait
in a process-local FIFO. Queue state is intentionally lost on restart.

### `maxDownloadZipBytes`

**Type:** `int` · **Default:** `2147483648` (2 GiB)

Maximum aggregate number of source bytes accepted for one archive. A request
that crosses the ceiling fails with HTTP 413 before any ZIP bytes are sent.

### `minDownloadZipFreeBytes`

**Type:** `int` · **Default:** `5368709120` (5 GiB)

Free-space reserve that must remain available on the filesystem backing
`TMPDIR`. Insufficient capacity returns HTTP 507.

### `downloadZipDiskBudgetPercent`

**Type:** `int` · **Default:** `50` · **Environment:** `IPP_ZIP_DISK_BUDGET_PERCENT`

Percentage of free space remaining after `minDownloadZipFreeBytes` that one
preparation may use. The preflight accounts for both staged source files and
the final STORE archive, including a conservative per-entry metadata allowance.
Values are clamped to 10–90.

### `downloadZipSplitThresholdBytes`

**Type:** `int` · **Default:** `1073741824` (1 GiB) · **Environment:** `IPP_ZIP_SPLIT_THRESHOLD_BYTES`

Albums at or below this exact planned source size continue as one ZIP. Larger
albums display a part picker before any file body is staged.

### `downloadZipPartTargetBytes`

**Type:** `int` · **Default:** `536870912` (512 MiB) · **Environment:** `IPP_ZIP_PART_TARGET_BYTES`

Target source size for deterministic parts. An individual asset is never split,
so a part may exceed the target by that asset's size but never the hard
`maxDownloadZipBytes` ceiling.

### `downloadZipPlanConcurrency`

**Type:** `int` · **Default:** `12` · **Environment:** `IPP_ZIP_PLAN_CONCURRENCY`

Maximum concurrent upstream header requests used to determine exact selected
download sizes. Values are clamped to 1–32; response bodies are cancelled.

### `downloadZipPlanTtlSeconds`

**Type:** `int` · **Default:** `3600`

Lifetime of an opaque, visitor-bound multipart plan. A new plan for the same
visitor and share replaces the previous one.

### `downloadZipMaxParts`

**Type:** `int` · **Default:** `64`

Maximum number of deterministic ZIP parts accepted for one album plan.

### `downloadZipPlanMaxAssets`

**Type:** `int` · **Default:** `5000`

Maximum number of unique assets accepted in one album plan. Values are clamped
to 1–20,000; the process also caps the total number of retained plan asset
references so public sessions cannot grow memory without bound.

### `downloadZipMaxParallelDownloads`

**Type:** `int` · **Default:** `2` · **Environment:** `IPP_ZIP_MAX_PARALLEL_DOWNLOADS`

Maximum number of prepared jobs that may be ready or transferring concurrently.
Only one new archive is prepared at a time. Values are clamped to 1–8 and the
reverse proxy should enforce the same or a stricter connection limit.

### `downloadZipCacheTtlSeconds`

**Type:** `int` · **Default:** `1800`

Lifetime of a prepared private ZIP. Cache files are mode `0600`, are removed on
expiry, and are swept after an unclean restart.

### `downloadZipQueueMaxWaiting`

**Type:** `int` · **Default:** `3`

Maximum number of waiting jobs in addition to retained ready/downloading jobs.
Requests beyond this bound receive HTTP 429.

### `downloadZipQueueHeartbeatSeconds`

**Type:** `int` · **Default:** `300`

Maximum time a queued browser may stop polling before its job is discarded.

### `downloadZipQueuedPollSeconds`

**Type:** `int` · **Default:** `30`

Maximum time a job that is still *queued* (not yet preparing) may go without a
status poll before it is dropped as abandoned. The gallery polls every two
seconds, so real visitors are unaffected; a client that creates jobs and never
polls them cannot hold the queue slots for the full heartbeat window. Ready
jobs keep the separate ready lease.

### `downloadZipPlanMaxInFlight`

**Type:** `int` · **Default:** `2`

Process-wide cap on album plans being computed at the same time. Planning
probes Immich once per asset, so this bounds the request amplification a
public visitor can cause upstream regardless of how many sessions they open.
Excess plan requests receive HTTP 429 with `Retry-After`. Identical plans for
the same share are shared across visitors and concurrent misses coalesce.
Environment override: `IPP_ZIP_PLAN_MAX_IN_FLIGHT` (takes precedence over
`config.json`, as reported in the startup `ZIP limits:` log line).

### `downloadZipReadyLeaseSeconds`

**Type:** `int` · **Default:** `120`

Time reserved for the visitor to press the explicit download button after ZIP
preparation completes.

### `downloadZipMaxReadyLeaseSeconds`

**Type:** `int` · **Default:** `300`

Absolute maximum time a prepared job may retain one ready slot. HEAD,
Range and interrupted-transfer retries receive a short retry window but can
never extend this deadline.

### `allowLegacyDirectZipDownload`

**Type:** `bool` · **Default:** `false`

Re-enable the historical direct `GET/POST .../download` endpoints. Leave this
disabled on public deployments: these endpoints bypass the application queue
and exist only as a temporary compatibility escape hatch. The gallery itself
uses the queued endpoints.

## `allowSlugLinks`

**Type:** `bool`

Enable/disable the custom URL links.

## `showHomePage`

**Type:** `bool`

Set to `false` to remove the IPP shield page at `/` and at `/share`.

```json
{
  "ipp": {
    "showHomePage": false
  }
}
```

## `gallery`

**Type:** `object`

Gallery-page options. See [Gallery](/config/gallery).

## `lightbox`

**Type:** `object`

Lightbox options. See [Lightbox](/config/lightbox).

## `showMetadata`

**Type:** `object`

Description / EXIF / location reveal controls. See [Metadata](/config/metadata).

## `customInvalidResponse`

**Type:** various

Send a custom response instead of the default 404. See [Error responses](/config/error-responses).
