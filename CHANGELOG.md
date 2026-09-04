# Changelog

## 1.3.0-dev.15 — staging

- Persisted each APPLY attempt before Gmail RAW retrieval so hard Apps Script
  termination, including V8 out-of-memory, cannot evade retry accounting.
- Isolated failed replay checkpoints to one message and, after three durable
  attempts, transactionally recorded that exact Gmail ID in the per-plan
  `dead-letter-queue.json` before committing and advancing past it.
- Added dead-letter counters, checkpoint attempt visibility, structured events,
  replay/idempotence validation, and automatic requeueing by the next PLAN.

## 1.3.0-dev.14 — 2026-09-04

- Added a complete S3-compatible backend for AWS S3, Cloudflare R2, and probed
  compatible endpoints, including SigV4, virtual folders, conditionals,
  pagination, copy/delete, multipart, verification reads, and parallel writes.
- Added secret-safe named profiles in Script Properties, a bounded real
  capability probe, redacted status, Make operations, and guarded clearing.
- Pinned archive state/manifests to a non-secret storage binding hash and reject
  in-place Drive/S3 or bucket/endpoint/prefix changes.
- Made an improved estimate an automatic, terminal part of every PLAN rather
  than requiring a separate operator call.
- Based PLAN estimates on exact audited remaining cardinality plus a bounded,
  deterministic sample distributed across the immutable work queue.
- Added raw-message and stored-ZIP payload scenarios, current raw/Drive
  benchmarks, exact-count APPLY/quota projections, and reuse of prior observed
  APPLY throughput.
- Persisted `plan-estimate.json` before final PLAN publication, embedded it in
  `plan.json`, exposed a compact form through status, and made finalization
  replay reuse the artifact without repeating Gmail reads.
- Kept PLAN completion usable when individual sampled messages disappear or a
  benchmark fails by recording degraded sample coverage and fallback rates.

## 1.3.0-dev.12 — staging

- Added a Makefile as the supported command surface for local validation,
  per-installation clasp configuration/authentication, source sync, all public
  backup actions, bounded phase polling, logs, deployments, APIs, and releases.
- Added an error-aware clasp runner that converts Apps Script JSON error
  envelopes into nonzero command failures and unwraps successful results.
- Added exact release-file inventory validation, deterministic source ZIP
  construction, isolated package verification, and tooling regression tests.
- Added the repo-local `operate-gmail-backup` agent skill covering setup,
  operation, observability, debugging, recovery, development, releases, and the
  provider-neutral boundary for future S3-compatible storage.
- Routed operator documentation through the Make targets and kept
  per-installation bindings, generated packages, and credentials out of Git.

## 1.3.0-dev.11 — staging

- Bound every archive root to a durable manifest containing its archive ID,
  Gmail account, catalog shard count, and Apps Script writer identity. Fresh
  explicit roots must be empty; persisted legacy roots are adopted safely.
- Made PLAN's query and spam/trash scope immutable across every scan slice.
- Made explicit runtimes manual by default and rejected trigger modes that
  cannot preserve injected services or execution-only configuration.
- Added Shared Drive flags to direct Drive API writes and an explicit root
  metadata guard that rejects actual Shared Drives until the complete
  `DriveApp`-based storage layer is replaced. Shared My Drive folders remain
  supported.
- Documented the `script.external_request` scope and its Google-only Drive API
  uses.
- Made partial queue seen-shard replay skip writes already made durable.
- Replaced the repository's live Apps Script binding with a safe clasp template
  and explicit per-installation setup instructions.
- Guarded pause and resume with the anchored Gmail identity before any state,
  pause-request, or trigger mutation.
- Clarified that `GmailBackupLibrary` is an in-project facade; native published
  Apps Script Library use requires host-scoped state/lock adapters and a host
  worker wrapper.
- Made PLAN treat catalog filename, archive-encoding extension, and recorded
  MIME drift as repairable catalog mismatches instead of healthy files.

## 1.3.0-dev.10 — staging

- Split the 5,500-line monolith into fifteen ordered Apps Script modules with
  explicit ownership for configuration/runtime, actions, verification, worker,
  scan/audit/queue, export, diagnostics, state/status, platform/storage,
  utilities, and the public main surface.
- Added `GmailBackupLibrary` in `98_Library.gs`; `99_Main.gs` now contains only
  thin editor/trigger entry points.
- Added an injectable runtime boundary for configuration, Gmail, Drive,
  Properties, locks, triggers, HTTP, Utilities, and logging. The regression
  suite loads the exact same module order used by `clasp push`.
- Added `TARGET_ROOT_FOLDER_ID` and `TARGET_PARENT_FOLDER_ID`, plus
  `forTargetRoot()` / `forTargetParent()` helpers, so an editable Drive folder
  owned by another account can be selected without changing exporter logic.
- Kept persisted root-folder identity authoritative and preserved all existing
  archive, catalog, checkpoint, public-command, and crash-replay contracts.

## 1.3.0-dev.9 — staging

- New exports are stored as one-entry `<gmail-id>.eml.zip` archives to reduce
  Drive storage and upload bytes while preserving the exact raw RFC message.
- Catalog records now keep separate raw-message and stored-archive byte counts
  and SHA-256 hashes; verification checks both whenever ZIP contents are
  downloadable.
- Existing plain `.eml` files remain canonical, so an established archive can
  contain both formats without rewriting healthy data.
- Replay, audit, quarantine, parallel-upload sizing, and commit validation are
  ZIP-aware. A bounded in-memory benchmark measures actual compression savings
  with `benchmarkArchiveCompression()`.
- New files carry a raw SHA-256/length integrity marker in Drive metadata so a
  policy-blocked ZIP remains safely recognizable during crash replay even if
  recompressing the same message produces different ZIP-container bytes.
- ZIP is explicitly treated as compression only; Workspace content and
  download restrictions may still apply to the resulting files.

## 1.3.0-dev.8 — staging

- Added an Apps Script-native Drive read-access diagnostic that uses the same
  OAuth client and manifest scopes as the backup runtime.
- Verification now falls back to Drive's server-computed SHA-256 for stored
  `.eml` blobs when `DriveApp` permits metadata access but denies `getBlob()`.
- The diagnostic records ownership, app authorization, download capability,
  content/download restrictions, and the exact unacknowledged media-read error;
  it never persists OAuth tokens or email contents.
- Verification reports integrity and download portability separately so a
  checksum-valid but policy-restricted file is never presented as portable.

## 1.3.0-dev.7 — staging

- Enabled the measured parallel Drive API path for APPLY `.eml` creation and
  sharded catalog updates.
- Limited multipart uploads to 5 MiB per file, eight concurrent requests, and
  8 MiB per wave; larger messages automatically retain the proven `DriveApp`
  path.
- Preserved durable commit-before-catalog ordering so partial API success is
  recovered idempotently by the existing in-flight replay logic.
- The synthetic benchmark now proves API-created files and API-updated catalog
  content can be reopened through `DriveApp` with exact SHA-256/content matches.

## 1.3.0-dev.6 — staging

- Added a disposable synthetic benchmark that compares sequential `DriveApp`
  file creates and catalog updates with parallel Drive API requests.
- Added the explicit `script.external_request` scope required by
  `UrlFetchApp.fetchAll()`; Gmail remains read-only.
- Added reusable multipart-create and media-update request helpers with strict
  response validation. The production archive path is unchanged until the
  benchmark demonstrates a worthwhile improvement.

## 1.3.0-dev.5 — staging

- Replaced ineffective retries for persistent `DriveApp` access denials with
  stage-specific verification diagnostics (`openFile`, `readMetadata`,
  `checkParent`, or `readContent`).
- Failed verification records now retain the metadata that was readable before
  the denied operation, without weakening filename, parent, size, or SHA-256
  checks for successfully read files.

## 1.3.0-dev.4 — staging

- Added bounded exponential retry for transient Drive verification failures,
  including Apps Script's generic `Access denied: DriveApp` backend response.
- Verification now retries the complete per-file read/hash check atomically so
  a partial transient read cannot be misreported as archive corruption.

## 1.3.0-dev.3 — staging

- Made `remaining-shards/` and `audit/` sparse: files are written only for
  missing, unhealthy, orphaned, duplicate, or invalid shards. Empty remaining
  files previously consumed most of AUDIT time on small deltas.
- Batched Script Property audit checkpoints every eight shards. Durable sparse
  evidence remains ahead of the grouped checkpoint, so crash replay stays safe.

## 1.3.0-dev.2 — staging

- Short-circuited ordered queue construction when its deduplicated count
  already equals the exact audited remaining total, eliminating a redundant
  64-shard fallback pass on stable mailboxes.
- Inventory Drive data-shard folders once per AUDIT/APPLY slice instead of
  issuing repeated `getFoldersByName()` lookups.
- Added AUDIT and QUEUE operation timing metrics alongside APPLY metrics.

## 1.3.0-dev.1 — staging

- Kept the live test query bounded to `newer_than:7d`.
- Added a non-mutating `agentStatus()` control surface.
- Added persisted per-slice APPLY latency distributions for Gmail raw fetch,
  raw conversion, SHA-256, Drive shard lookup/list, EML creation, commit write,
  catalog merge, and checkpoint persistence.
- Removed the redundant per-EML Drive description mutation; the same metadata
  remains durable in transaction commits and the global catalog.
- Avoided rewriting PLAN membership shards when a later scan pass contributes
  no new ID or thread mapping.

## 1.2.1 — 2026-08-26

- Fixed RAW-message handling for the Apps Script Advanced Gmail service. In current Apps Script, discovery `format=byte` fields such as `Message.raw` may arrive as a `Byte[]` rather than the public REST API's base64url string. The exporter now accepts either representation without double-decoding.
- Added regression coverage for exact binary preservation from both Advanced-Service byte arrays and REST-style base64url strings.
- Made temporary/worker trigger deletion best-effort. A transient `ScriptApp.deleteTrigger()` backend error no longer turns an otherwise healthy DOCTOR or completed checkpoint into a failed backup operation.
- DOCTOR now reports trigger cleanup failures as cautions after successful trigger creation.

## 1.2.0 — 2026-08-26

- Added durable scan-journal chunks that are written before plan-shard/state advancement and replayed after crashes.
- Added explicit `APPLY_ORDER`: `NEWEST_FIRST`, `OLDEST_FIRST`, or `SHARDED_ID`.
- Added immutable ordered work-queue segments, transactional queue commits, sharded queue-seen sets, and queue cardinality verification.
- Preserved Gmail’s documented newest-first list sequence; `OLDEST_FIRST` globally reverses chunk and row order.
- Added deterministic fallback queueing for IDs present in the multi-pass union but absent from the final completed scan pass.
- Reworked APPLY to consume ordered queue segments while retaining canonical ID-sharded data/catalog storage.
- Added mixed-shard apply commits and idempotent per-shard catalog merge.
- Added QUEUEING progress, ETA, status, and structured console fields.
- Added date-stratified estimation to reduce newest-only sampling bias.
- Added v1.1-plan migration guard; existing archive data remains reusable through a new plan.
- Expanded regression tests for scan-journal replay, multi-chunk oldest-first order, duplicate suppression, queue crash/replay, and mixed-shard apply replay.
- Added complete setup, operations, architecture, migration, security, and checklist documentation.

## 1.1.0 — 2026-08-26

- Added `doctorBackup()` for Gmail/Drive/trigger prerequisite validation.
- Added `estimateBackup()` for sampled message-count, payload, PLAN-time, APPLY-time, and quota-day estimates.
- Added structured `[GMAIL-BACKUP]` console progress events for PLAN/APPLY lifecycle and worker slices.
- Added message-size histogram, raw read/decode/hash sampling, synthetic Drive write benchmarking, and rough committed-catalog coverage sampling with a Wilson interval.
- Added tests for query composition, volume/timing estimators, public doctor/estimate paths, and cleanup behavior.
- Expanded operational timing, logging, and diagnostic documentation.

## 1.0.0 — 2026-08-26

- Initial production-oriented read-only Gmail raw-message exporter.
- Added sharded canonical storage/catalogs, PLAN/APPLY separation, idempotent apply commits, checkpointing, verification, progress, and ETA.
