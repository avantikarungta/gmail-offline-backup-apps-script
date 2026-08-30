# Gmail Offline Backup for Google Apps Script

**Release:** 1.3.0-dev.14
**Purpose:** Create a resumable, verifiable offline Gmail archive when Google Takeout or IMAP is unavailable, but the user is authorized to access Gmail through Apps Script and the Gmail API.

The exporter reads Gmail through the official Advanced Gmail service, writes complete RFC 2822 messages as one-entry `.eml.zip` files to Google Drive or an S3-compatible bucket, and records Gmail-only metadata in a sharded catalog. Existing plain `.eml` files remain valid in mixed archives. It never sends, labels, deletes, archives, forwards, or otherwise modifies Gmail.

> Use this only for mail the account holder is permitted to retain. A technical ability to export data does not override company retention, confidentiality, or acceptable-use rules.

## What is new in 1.3.0-dev.14

- Added a production S3-compatible archive adapter for AWS S3, Cloudflare R2,
  and compatible endpoints that pass the built-in capability probe.
- Added AWS Signature Version 4, conditional create/update, paginated listing,
  copy/delete, multipart completion, integrity metadata, virtual folders, and
  bounded parallel message uploads without an SDK dependency.
- Added named, secret-safe S3 profile setup through Script Properties plus
  `make s3-configure`, `make s3-probe`, `make s3-status`, and guarded clearing.
- Pinned every initialized archive to its backend binding so an edit cannot
  silently split one backup across Drive, buckets, endpoints, or key prefixes.
- PLAN now automatically writes `plan-estimate.json` after its exact audit and
  immutable queue complete; a separate ESTIMATE run is no longer needed to get
  the best pre-APPLY forecast.
- The PLAN estimate uses the exact remaining message count, a bounded sample
  distributed across the actual work queue, raw-to-ZIP measurements, synthetic
  Drive timings, and prior observed APPLY throughput when available.
- The estimate is durable before final PLAN publication, is reused after a
  crash, appears in `plan.json`, status output, and execution logs, and
  distinguishes raw payload from expected stored ZIP payload.

## What was added in 1.3.0-dev.12

- Added a documented Make command surface for local validation, per-installation
  clasp setup/authentication, every public backup action, bounded phase waiting,
  logs, source synchronization, API/deployment administration, and releases.
- Added an error-aware Apps Script runner: JSON error envelopes now fail the
  command even when `clasp` exits with status zero.
- Added exact release-file inventory checks and isolated ZIP verification,
  including regression tests for the repository tooling.
- Added the repo-local `operate-gmail-backup` agent skill with setup, operation,
  debugging, recovery, development, release, and future storage-adapter guidance.

## What was added in 1.3.0-dev.11

- Added a durable archive-root manifest that binds one Drive root to its Gmail
  account, shard format, and Apps Script writer before layout creation.
- PLAN workers now read the query and spam/trash scope frozen into the plan,
  including after a configuration edit or trigger continuation.
- Injected runtimes default to explicit manual continuation; automatic triggers
  reject service and non-durable configuration overrides they cannot recreate.
- Parallel Drive API requests include Shared Drive flags, while setup rejects
  actual Shared Drive roots because the wider storage layer still uses
  `DriveApp`; folders shared from another account's My Drive remain supported.
- Queue seen-set replay skips shards already made durable after a partial crash.
- Replaced the checked-in live `.clasp.json` with a safe example template.

## What was added in 1.3.0-dev.10

- Split the former monolith into ordered, responsibility-focused Apps Script modules.
- Added the reusable `GmailBackupLibrary` facade and thin `99_Main.gs` commands.
- Added injectable runtime ports for configuration, Gmail, Drive, properties,
  locks, triggers, HTTP, utilities, and logging.
- Added `TARGET_ROOT_FOLDER_ID` / `TARGET_PARENT_FOLDER_ID`, including shared
  folders owned by another Google account.
- Preserved the existing archive, catalog, checkpoint, replay, and public
  command contracts.

## Prior 1.2.1 compatibility work

Version 1.2.1 is a compatibility/hardening release based on a real Google Workspace run:

- Correctly handles the Apps Script Advanced Gmail service returning `Message.raw` as a `Byte[]`.
- Retains compatibility with REST-style base64url `raw` strings.
- Avoids double-decoding raw RFC bytes before writing `.eml` files.
- Treats transient `ScriptApp.deleteTrigger()` cleanup failures as warnings after trigger creation has already succeeded.
- Keeps trigger deletion best-effort so a cleanup glitch cannot poison a durable PLAN/APPLY checkpoint.

Version 1.2.0 introduced durable chronological work queues, `NEWEST_FIRST` / `OLDEST_FIRST` / `SHARDED_ID`, scan journals, queue transactions, and date-stratified estimates; all of that remains in 1.2.1.

## Key properties

- **Read-only Gmail scope:** `gmail.readonly` only.
- **Complete canonical message:** `users.messages.get(format=raw)` is normalized from the Advanced Service byte representation (or REST-style base64url when encountered) and stored byte-for-byte as the sole `<gmail-id>.eml` entry inside `<gmail-id>.eml.zip`.
- **Attachments preserved:** attachments and inline images remain inside the MIME/RFC message; no duplicate attachment tree is required.
- **Immutable identity:** Gmail message ID is the canonical filename and catalog key.
- **Pre-apply workflow:** DOCTOR → optional quick ESTIMATE → PLAN with an
  automatic exact-delta estimate → APPLY.
- **PLAN is exact at the ID level:** two scans are set-unioned, the archive is audited, and an immutable ordered queue is generated for only the remaining delta.
- **Idempotent:** rerunning a phase or replaying a crashed transaction does not duplicate messages.
- **Crash-safe:** scan chunks, queue transactions, and apply batches have durable commit boundaries.
- **Integrity:** separate raw-message and stored-archive SHA-256/byte counts, Drive file ID, labels, thread ID, history ID, internal date, and size estimate are cataloged.
- **Progress:** `backupStatus()`, `STATUS.txt`, `status.json`, and structured console events expose progress and ETA.
- **Single-account guard:** a project is anchored to one Gmail address and rejects execution under another account.
- **Destination-independent:** use Google Drive, an editable folder owned by
  another account, AWS S3, Cloudflare R2, or a probed compatible endpoint.
- **Library-first:** a reusable `GmailBackupLibrary` facade owns the actions; `99_Main.gs` is only the Apps Script command/trigger surface.
- **No cookie/token extraction:** this uses authorized APIs, not browser scraping or replayed session credentials.

## Bundle contents

```text
00_ConfigRuntime.gs           defaults and injectable Apps Script runtime ports
10_Diagnostics.gs             DOCTOR and ESTIMATE actions
20_Application.gs             setup/control state transitions
25_Verification.gs            integrity and Drive-read diagnostics
30_Worker.gs                  trigger-safe worker slice
40_Scan.gs                    Gmail ID scanning and journals
45_Audit.gs                   archive/catalog audit
50_Queue.gs                   ordered durable work queue
60_Export.gs                  ZIP export, commits, replay, and catalog merge
65_PlanEstimate.gs            exact-delta PLAN payload/runtime estimation
70_DiagnosticsSupport.gs      benchmarks, estimation, metrics, structured logs
80_StateStatus.gs             state, status/ETA, pause, and triggers
85_S3Client.gs                SigV4 S3 object operations and parallel creates
86_S3DriveAdapter.gs          virtual-folder compatibility over S3 object keys
87_S3Operations.gs            secret-safe profiles, status, and capability probe
90_PlatformStorage.gs         Gmail/Drive storage and integrity adapters
95_CoreUtilities.gs           validation and pure helpers
98_Library.gs                 reusable library facade
99_Main.gs                    thin public editor/trigger entry points
appsscript.json               runtime, Advanced Gmail service, and OAuth scopes
Makefile                      supported setup, operation, debug, and release commands
scripts/clasp-ops.js          error-aware remote function runner and phase waiter
scripts/repo-ops.js           binding, metadata, checksum, and package validation
.agents/skills/               repo-local agent operating playbook
QUICKSTART.md                 concise editor setup and controlled rollout
OPERATIONS.md                 monitoring, pause/resume, recovery, and verification
ARCHITECTURE.md               ordering, storage, checkpoints, and idempotency design
MIGRATION.md                  upgrade guidance from 1.0/1.1
SECURITY.md                   permissions and data-handling considerations
REFERENCES.md                 official API documentation and community references
CHANGELOG.md                  release history
INSTALLATION_CHECKLIST.md     printable setup/run checklist
RELEASE_VALIDATION.md         tests performed and real-account validation boundary
package.json                  local test command; no dependencies
VERSION                       release number
tests/run-tests.js            mocked regression suite
tests/run-tooling-tests.js    Make/clasp wrapper regression suite
SHA256SUMS.txt                per-file integrity hashes
```

## Prerequisites

1. The corporate account can open Apps Script.
2. The account can authorize `gmail.readonly` for the Apps Script project.
3. Google Drive is available and has enough storage for the raw mailbox plus metadata/overhead.
4. Installable time triggers are permitted, or someone can invoke `gmailBackupWorker()` manually.
5. The account holder is authorized to retain the exported mail.

A separate Google Cloud project is normally unnecessary when the script uses Apps Script’s automatically created default Cloud project. Adding the Advanced Gmail service enables its API automatically for that default project. A manually associated standard Cloud project requires the Gmail API to be enabled in Cloud Console.

## Installation in the Apps Script editor

1. Sign into the corporate account in a dedicated browser profile.
2. Open `https://script.new`.
3. Rename the project, for example, **Gmail Offline Backup — sister@company.com**.
4. From this repository, run `make setup SCRIPT_ID=YOUR_SCRIPT_ID`, using the
   project's **Script ID** from Project Settings. This creates the ignored
   per-installation `.clasp.json`, authenticates with project scopes, and checks
   the exact source set and account before any push.
5. Run `make push`, or create matching files in the editor and paste each
   module. The repository does not ship a live `.clasp.json`, so a clone cannot
   overwrite another installation. Use `make help` for every supported local,
   remote, debug, deployment, and release operation.
6. Open **Project Settings**.
7. Enable **Show `appsscript.json` manifest file in editor**.
8. Replace the manifest contents with the included `appsscript.json`.
9. In the left sidebar, open **Services** and confirm **Gmail API v1** is listed. The manifest normally adds it automatically; otherwise click **+**, choose **Gmail API**, and add version `v1`.
10. Save the project.
11. Review `BACKUP_CONFIG` in `00_ConfigRuntime.gs` before the first plan.

Recommended initial values:

```javascript
GMAIL_QUERY: 'newer_than:7d', // controlled test first
INCLUDE_SPAM_TRASH: true,
APPLY_ORDER: 'NEWEST_FIRST',
SCAN_PASSES: 2,
SCAN_PAGE_SIZE: 500,
SHARD_COUNT: 64,
```

### Store the archive in another account's My Drive

Have the destination owner share an empty folder with the Apps Script user and
grant edit access. For a fresh archive, set one of these in
`00_ConfigRuntime.gs`:

```javascript
TARGET_ROOT_FOLDER_ID: 'shared-folder-id',   // use this folder as the archive root
TARGET_PARENT_FOLDER_ID: '',                 // or create ROOT_FOLDER_NAME under this folder
```

Set only one. Once setup persists `state.rootFolderId`, that exact folder stays
authoritative. This is deliberate protection against silently splitting an
archive after a configuration edit.

The Drive API still runs as the Apps Script execution identity; sharing grants
that identity access to another owner's folder. It does not authenticate as the
other account.

The folder must reside in the owner's **My Drive**, not a Google Shared Drive.
Setup checks Drive API metadata and rejects roots with a `driveId` before
claiming them. Full Shared Drive support would require replacing every
`DriveApp` folder, checkpoint, quarantine, and fallback operation with a Drive
API storage adapter.

### Use the in-project library facade

The editor functions in `99_Main.gs` simply call `GmailBackupLibrary`. A host
can instead compose an explicit runtime:

```javascript
const runtime = GmailBackupLibrary.forTargetRoot('shared-folder-id');
GmailBackupLibrary.setup(runtime);
GmailBackupLibrary.plan(runtime);
```

`createRuntime({config, services})` can inject compatible Gmail, Drive,
properties, lock, trigger, HTTP, utilities, and logger ports for tests or a
different host. Explicit runtimes default to `continuationMode: 'MANUAL'`, so
the caller must invoke `GmailBackupLibrary.worker(runtime)` for additional
slices. This prevents an Apps Script trigger from silently falling back to the
native identity or configuration after the runtime stack is gone.

For a configuration-only runtime that uses native Apps Script services, opt in
to automatic trigger continuation explicitly:

```javascript
const runtime = GmailBackupLibrary.forTargetRoot('shared-folder-id', {
  continuationMode: 'AUTO_TRIGGER',
});
GmailBackupLibrary.setup(runtime);
GmailBackupLibrary.plan(runtime);
```

Automatic mode accepts only plan-persisted destination/query/order overrides.
Injected services and execution-only overrides must use manual continuation.

Here “library” means the facade is copied into each installation's own Apps
Script project or used by another host with explicit adapters. This release is
not safe to publish once as a native Apps Script Library shared by unrelated
consumer scripts: Google scopes library-owned Script Properties and locks
differently from `ScriptApp`, so consumers could collide unless the host
injects its own namespaced Properties/Lock services and provides its own worker
entry point. Use one copied project per mailbox unless you deliberately build
that host wrapper.

`APPLY_ORDER` is frozen into each plan when `planBackup()` starts. Changing it afterward affects only a future plan. `SHARD_COUNT` is part of the archive format and must not change after setup.

## Controlled rollout

Use a small query first so authorization, queueing, raw export, offline opening, and verification can all be proven end-to-end.

### 1. Initialize and anchor the archive

Run:

```sh
make initialize
```

Authorize the requested scopes. A successful result includes:

- the authenticated Gmail account;
- the Drive root URL;
- a successful ID-list preflight;
- a nonzero raw-message preflight byte count for a nonempty query.

`setupBackup()` creates a new, ID-anchored Drive folder named:

```text
Gmail Offline Backup/
```

It never discovers an archive by folder name because Drive permits duplicate names. The exact folder ID is stored in Script Properties.

### 2. Run the health check

```sh
make doctor
```

DOCTOR checks configuration, account identity, label access, one raw message read/normalize/hash, large-message search support, Drive capacity, a synthetic Drive write/read/hash round trip, and trigger creation plus best-effort cleanup. A cleanup-only failure is reported as a caution, not as a false prerequisite failure. It does not modify Gmail.

### 3. Optionally get a quick preview

```sh
make estimate
```

ESTIMATE performs cheap sampled work before PLAN:

- one realistic ID page;
- mutually exclusive size-band searches;
- date-stratified searches and metadata samples;
- a few in-memory raw fetch/decode/hash samples;
- two synthetic Drive-write benchmarks;
- optional sampled coverage against an existing committed catalog.

It estimates message count, payload range, PLAN duration, APPLY duration, and
quota-day floors. This preview is optional. Completed PLAN automatically makes
a materially better forecast from the exact audited delta and its immutable
queue.

### 4. Build an exact plan

```sh
make plan-and-wait
```

This immediately performs useful work and installs a recurring one-minute continuation trigger. PLAN proceeds through:

```text
SCANNING → AUDITING → QUEUEING → PLANNED
```

Monitor it with:

```sh
make status
```

Wait for `phase: PLANNED`, then inspect the latest plan folder’s:

```text
plan.json
queue.json
plan-estimate.json
work-queue/
```

`plan-estimate.json` has an authoritative remaining-message count for that
PLAN, plus sampled raw/stored payload bounds, APPLY duration, and quota-day
floors. The same compact summary appears in `make status`.

### 5. Apply the frozen delta

```sh
make apply-and-wait
```

Wait for `phase: COMPLETE`. Calling `applyBackup()` again is safe.

### 6. Verify the staged archive

```sh
make verify SAMPLE_SIZE=50
make benchmark-compression
```

Download several `.eml.zip` files, extract their single `.eml` entry, and open it offline in Thunderbird, Apple Mail, Outlook, or another RFC-message-capable tool. Include examples with attachments, inline images, Unicode text, Sent mail, long threads, and older mail. ZIP compression does not bypass Workspace content or download restrictions.

### 7. Expand to the complete mailbox

After the controlled test succeeds, change:

```javascript
GMAIL_QUERY: '',
```

Keep `INCLUDE_SPAM_TRASH: true` for the broadest mailbox enumeration, then run:

```sh
make estimate # optional quick preview
make plan-and-wait
```

Review the new plan and queue, then run:

```sh
make apply-and-wait
```

Existing committed messages are detected and skipped; the new plan contains only the missing delta.

### 8. Re-plan after completion

A live mailbox is not an atomic snapshot. Run one more plan after APPLY completes:

```sh
make plan-and-wait
```

A zero-remaining result is the strongest available confirmation that the archive matches the latest observed mailbox set. Repeat APPLY if the post-run plan finds mail that arrived or changed visibility during the previous run.

### 9. Make the archive genuinely offline

Google Drive is staging, not the final backup. Download or sync the entire `Gmail Offline Backup` folder to an encrypted local/external drive, verify the copied files, and retain another independent copy where appropriate.

## Apply ordering

### `NEWEST_FIRST` — default

The final completed Gmail scan is consumed in the API’s documented newest-first order. Messages already committed are filtered out without changing the relative order of the remaining messages.

Use this when a partially completed backup should contain the newest and usually most valuable mail first.

### `OLDEST_FIRST`

The exporter reverses both the final scan-journal chunk order and the row order inside each chunk, yielding a global oldest-to-newest queue for the final pass.

Use this for chronological migration/archive reconstruction from the beginning of the mailbox.

### `SHARDED_ID`

The queue is generated directly from deterministic ID shards. It does not preserve chronology and may be slightly cheaper to construct.

Use this only when order is irrelevant.

### Fallback IDs

Because Gmail remains live, an ID can appear in the multi-pass set union but not in the final completed pass. Such IDs are not dropped. They are appended after the ordered portion in deterministic shard/ID order and counted as `fallbackMessages` in `queue.json` and status output.

## How PLAN is made durable

### Scan transaction

```text
fetch one bounded set of list pages
        ↓
write immutable scan-journal chunk
        ↓
merge chunk into ID-sharded plan inventory
        ↓
advance page-token/state checkpoint
```

If the process crashes after journal creation, the exact chunk is replayed without asking Gmail for a shifted page sequence again.

If Gmail invalidates a page token, the current uncommitted slice is discarded and the entire pass restarts under a new generation. Set-union shards retain safety; ordering later uses only the final completed generation of the final pass.

### Queue transaction

```text
persist exact in-flight source range
        ↓
select missing, not-yet-queued IDs
        ↓
write deterministic queue commit
        ↓
create/validate immutable queue segments
        ↓
merge IDs into sharded queue-seen sets
        ↓
advance queue checkpoint
```

### Apply transaction

```text
persist exact queue segment/range
        ↓
fetch raw Gmail messages
        ↓
hash/reuse or create canonical .eml/.eml.zip files
        ↓
write deterministic apply commit
        ↓
merge records into ID-sharded catalog
        ↓
advance APPLY checkpoint
```

This order makes partial failure replayable and idempotent.

## Progress and console logging

Run:

```sh
make status-human
```

It prints a human-readable snapshot to the current execution log and returns a structured object. The latest cross-execution state is also written to:

```text
Gmail Offline Backup/STATUS.txt
Gmail Offline Backup/status.json
```

Every worker execution emits structured lines prefixed with:

```text
[GMAIL-BACKUP]
```

Typical events include:

```text
PLAN_STARTED
APPLY_STARTED
WORKER_SLICE_STARTED
WORKER_SLICE_COMPLETED
WORKER_BACKOFF
WORKER_SLICE_ERROR
```

Each trigger invocation has its own entry in **Apps Script → Executions**; there is no single continuously scrolling console across all invocations.

Status includes:

- current and effective phase;
- text progress bar and percentage;
- scan pass, pages, rows, and page-token restarts;
- archive audit totals/anomalies;
- queue order, stage, queued count, segment count, and fallback count;
- APPLY processed/exported/gone counts and bytes;
- active and wall-clock throughput;
- ETA, confidence, basis, and estimated completion time;
- retry backoff and last error;
- exact in-flight checkpoint.

Set `LOG_PROGRESS_TO_CONSOLE: false` to suppress routine structured console events while retaining persisted status files and errors.

## Pause, resume, and manual operation

```sh
make pause
make resume
make worker
```

- `pauseBackup()` stops after the next durable checkpoint and removes the continuation trigger.
- `resumeBackup()` resumes the preserved SCANNING, AUDITING, QUEUEING, or APPLYING phase without resetting progress or contaminating ETA with paused time.
- `gmailBackupWorker()` is safe to invoke manually. Use it repeatedly if installable triggers are blocked.
- After repeated errors, the exporter moves to `ERROR`, removes the worker trigger, and preserves the prior phase. Correct the cause, then run `resumeBackup()`.

Do not manually delete active plan journal, queue, commit, catalog, or Script Property data. See `OPERATIONS.md` for recovery guidance.

## Output layout

```text
Gmail Offline Backup/
  STATUS.txt
  status.json

  data/
    shard-00/
      <gmail-id>.eml.zip
    ...
    shard-3f/

  catalog/
    shard-00.json
    ...
    shard-3f.json

  plans/
    <plan-id>/
      labels.json
      plan.json
      queue.json
      plan-estimate.json
      apply-summary.json

      mailbox-shards/
        shard-00.json ... shard-3f.json

      remaining-shards/
        shard-xx.json  # sparse; only shards with missing/unhealthy IDs

      audit/
        shard-xx.json  # sparse; only shards with actionable anomalies

      scan-journal/
        pass-02-gen-000-chunk-00000000.json
        ...

      work-queue/
        segment-00000000.json
        ...

      queue-commits/
        ordered-....json
        tail-....json

      queue-seen/
        shard-00.json ... shard-3f.json

      commits/
        segment-00000000/
          00000000-00000005.json
        ...

  diagnostics/
    doctor-latest.json
    estimate-latest.json
    doctor-<timestamp>.json
    estimate-<timestamp>.json

  verification/
    sample-<timestamp>-<id>.json

  quarantine/
    checkpoints/
    <gmail-id>.eml.zip.conflict-...
    <gmail-id>.eml.zip.duplicate-...
```

Gmail labels are not part of the RFC email bytes. They are preserved in `labels.json` and in each exported catalog record.

## Configuration reference

Important settings in `00_ConfigRuntime.gs`:

```javascript
ROOT_FOLDER_NAME: 'Gmail Offline Backup',
STORAGE_BACKEND: 'GOOGLE_DRIVE', // or 'S3'
TARGET_ROOT_FOLDER_ID: '',
TARGET_PARENT_FOLDER_ID: '',
GMAIL_QUERY: '',
INCLUDE_SPAM_TRASH: true,
SCAN_PAGE_SIZE: 500,
SCAN_PASSES: 2,
MAX_SCAN_PAGES_PER_EXECUTION: 20,
APPLY_ORDER: 'NEWEST_FIRST',
WORK_QUEUE_SEGMENT_SIZE: 500,
QUEUE_ROWS_PER_TRANSACTION: 5000,
APPLY_BATCH_SIZE: 20,
INITIAL_APPLY_BATCH_SIZE: 5,
ARCHIVE_ENCODING: 'ZIP',
DRIVE_WRITE_MODE: 'PARALLEL_API',
EXECUTION_BUDGET_MS: 4 * 60 * 1000,
CHECKPOINT_SAFETY_MS: 45 * 1000,
WORKER_TRIGGER_MINUTES: 1,
SHARD_COUNT: 64,
LOG_PROGRESS_TO_CONSOLE: true,
```

Avoid raising `EXECUTION_BUDGET_MS` close to the six-minute Apps Script limit. The checkpoint margin is a correctness feature, not unused capacity.

## S3 / Cloudflare R2 setup

Use a fresh Apps Script project/state for a new S3 archive. An initialized
archive cannot be switched in place between Drive and S3, or between S3
buckets/endpoints/prefixes.

1. Create a bucket and a least-privilege S3 API credential that can list the
   bucket and get, put, copy, and delete objects under the selected prefix;
   multipart uploads also need create/upload/complete/abort permissions.
2. Set only non-secret values in `00_ConfigRuntime.gs`. For R2:

```javascript
STORAGE_BACKEND: 'S3',
S3_PROFILE: 'default',
S3_BUCKET: 'gmail-backup',
S3_ENDPOINT: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
S3_REGION: 'auto',
S3_KEY_PREFIX: 'mailbox-name',
S3_ADDRESSING_STYLE: 'PATH',
```

   For AWS, use the bucket's regional HTTPS endpoint and actual AWS region.
   Generic endpoints may use `PATH` or `VIRTUAL`, but must pass the probe.
3. Push the configuration. In Apps Script **Project Settings → Script
   Properties**, stage `GMAIL_BACKUP_S3_STAGING_ACCESS_KEY_ID` and
   `GMAIL_BACKUP_S3_STAGING_SECRET_ACCESS_KEY`. For temporary credentials also
   stage `GMAIL_BACKUP_S3_STAGING_SESSION_TOKEN`.
4. Run:

```sh
make s3-configure  # migrates and immediately removes staging properties
make s3-probe      # performs real conditional/read/list/copy/delete operations
make s3-status     # redacted binding and probe result
make initialize
make doctor
```

Never put S3 secrets in source, `.clasp.json`, Make variables, shell history,
or command parameters. Set `S3_PROBE_MULTIPART: true` temporarily when a real
multipart compatibility check (at least 5 MiB) is required.

## Timing expectations

PLAN is mostly count-driven and includes two ID scans, a 64-shard archive audit, and ordered queue construction. With default settings, broad initial ranges are:

| Matching messages | PLAN rough range |
|---:|---:|
| 10,000 | 3–12 minutes |
| 50,000 | 10–40 minutes |
| 100,000 | 25–90 minutes |
| 250,000 | 1–4 hours |
| 500,000 | 2–8 hours |

APPLY performs one raw Gmail read and normally one Drive file creation per missing message. Before mailbox-specific measurements exist, use roughly **1.5–6 seconds/message**, with approximately **3 seconds/message** as a central starting assumption.

| Missing messages | 1.5 s/message | 3 s/message | 6 s/message |
|---:|---:|---:|---:|
| 10,000 | 4.2 h | 8.3 h | 16.7 h |
| 50,000 | 20.8 h | 41.7 h | 83.3 h |
| 100,000 | 41.7 h | 83.3 h | 166.7 h |
| 250,000 | 104.2 h | 208.3 h | 416.7 h |

These are active processing hours. Trigger runtime quotas can spread them across calendar days. Message count matters heavily because each message is an independent Gmail read, hash, file, and catalog record; the same 50 GB spread over 200,000 small messages can take much longer than 50 GB across 40,000 large messages.

PLAN automatically samples its exact remaining queue and uses observed
throughput from a prior APPLY when one exists. After 50–200 messages in the
current APPLY, `backupStatus()` uses current active and wall-clock EWMAs and
becomes the most useful forecast.

## Permissions

The included manifest requests:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/script.scriptapp
https://www.googleapis.com/auth/script.external_request
```

- `gmail.readonly`: enumerate and retrieve Gmail messages/labels without modifying them.
- `drive`: create, inspect, hash, update, move, and quarantine archive files.
- `script.scriptapp`: create and remove the continuation trigger.
- `script.external_request`: call Google Drive API endpoints for Drive mode and
  the explicitly configured HTTPS S3-compatible endpoint for S3 mode.

## Upgrading from 1.0 or 1.1

1. Pause any active v1.0/v1.1 worker.
2. Replace the source and manifest with this release.
3. Run `setupBackup()` and `doctorBackup()`.
4. Run a new `planBackup()`.
5. Do not APPLY an old pre-1.2 plan; version 1.2 intentionally rejects plans without a completed ordered work queue.

The existing `data/` and `catalog/` archive remains reusable. The new plan audits it and queues only missing/unhealthy records. See `MIGRATION.md`.

## Tests

No npm dependencies are required.

```sh
make validate
```

Expected output:

```text
All Gmail backup tests passed.
All repository tooling tests passed.
```

The suite covers raw-byte preservation, deterministic sharding, size/date estimation helpers, account isolation, two-pass scan union, durable scan-journal replay, newest-first queueing, global oldest-first ordering across multiple chunks, duplicate suppression, queue crash/replay, terminal summary retries, zero-delta APPLY, mixed-shard apply commits, corruption quarantine/replacement, catalog idempotence, and crash replay after commit creation.

## Residual limitations

- Gmail remains live; this is not a server-side atomic snapshot. Multi-pass union, journal generations, history IDs, fallback IDs, and a post-APPLY plan mitigate—but cannot erase—concurrent change.
- `resultSizeEstimate`, ESTIMATE samples, and ETA ranges are approximate.
- PLAN's remaining count is exact for its completed scan/audit generation, but
  its payload and time ranges remain sampled forecasts and the live mailbox can
  change afterward.
- S3 compatibility varies. Setup refuses backup operations until the exact
  bucket/endpoint/prefix binding passes the real capability probe; validate
  AWS S3/R2 credentials and provider policy in the target account.
- Apps Script, Gmail, Drive/S3, and organizational quotas/policies can interrupt or throttle work.
- Exceptionally large raw messages may exceed Apps Script memory/response limits. Such a failure remains visible and resumable; the message is not silently marked complete.
- PLAN validates committed identity, file location, and byte size, not a full SHA-256 pass over every existing file. Use `verifyBackupSample()` and perform an offline full-file hash verification after downloading.
- Drive administrators may restrict download/sync even when Drive writes are allowed. Prove the offline-copy step early.
- The exporter preserves message bytes and Gmail metadata but is not a turnkey mailbox viewer. Use an RFC-message-capable client or indexing tool for browsing the offline archive.
