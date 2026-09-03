# Operations Guide

## State machine

```text
IDLE
  ↓ planBackup()
SCANNING
  ↓
AUDITING
  ↓
QUEUEING
  ↓
PLANNED
  ↓ applyBackup()
APPLYING
  ↓
COMPLETE
```

Any active phase may become `PAUSED` or `ERROR` while preserving `previousPhase` and durable checkpoints.

## Monitoring

Use three views together:

1. `make status` for a machine-readable snapshot, or `make status-human` when
   the Drive status files should also be refreshed.
2. Drive `STATUS.txt` / `status.json` for the latest cross-execution state.
3. Apps Script **Executions** for each trigger invocation and structured `[GMAIL-BACKUP]` logs.

The authoritative completion artifacts are:

```text
plan.json
queue.json
plan-estimate.json
apply-summary.json
catalog/shard-*.json
```

`plan-estimate.json` is generated automatically at the end of PLAN. Its
remaining count is exact for that PLAN; payload and timing ranges use a bounded
sample of the immutable queue and prior APPLY measurements when available.

## Normal commands

```sh
make initialize
make doctor
make estimate
make plan-and-wait
make status
make apply-and-wait
make verify SAMPLE_SIZE=50
make diagnose-drive
make benchmark-compression
make s3-status
make s3-probe
make pause
make resume
make worker
```

## Safe restart behavior

Running `planBackup()` after a prior COMPLETE creates a new plan generation while retaining the global archive. The new audit computes only the current missing/unhealthy delta.

Running `applyBackup()` repeatedly against the same completed plan is idempotent.

Running `gmailBackupWorker()` manually is safe. `ScriptLock` prevents overlapping worker executions from changing checkpoints simultaneously.

The archive is pinned to the persisted `state.rootFolderId`. Changing
`TARGET_ROOT_FOLDER_ID` or `TARGET_PARENT_FOLDER_ID` after initialization does
not redirect an established archive. Use a fresh Apps Script state/project for
a genuinely different destination.

The same guard pins S3 archives to a hash of the profile, bucket, endpoint,
region, key prefix, and addressing style. Restore the original binding if an
operation reports a storage mismatch; migration/dual-write is intentionally
not inferred from a configuration edit.

The root-level `archive-manifest.json` is a writer lease and mailbox guard. Do
not copy or edit it to make a second project reuse the same root. Give each
mailbox/project its own empty target folder. On upgrade, `setupBackup()` adopts
an established manifest-less root only when existing Script Properties already
point to its complete legacy layout.

## Pause and resume

`pauseBackup()` is cooperative. If the worker currently owns the lock, a pause request is persisted and honored after the next safe checkpoint.

`resumeBackup()`:

- restores the exact previous phase;
- preserves scan/queue/apply checkpoints;
- clears retry backoff/error counters;
- excludes paused time from phase ETA calculations;
- reinstalls the worker trigger.

## Error recovery

### `ERROR` after repeated transient failures

1. Open `STATUS.txt` and the latest failed execution.
2. Correct the source problem: quota, authorization, Drive capacity, moved/deleted folder, or transient Google service error.
3. Run:

```sh
make resume
```

### Worker triggers are blocked

Run this manually whenever convenient:

```sh
make worker
```

Each invocation continues from the last durable checkpoint.

### Gmail page token invalidated

No manual action is normally needed. The exporter restarts that scan pass under a new generation. The final completed generation supplies chronological queue order; prior observations remain in the set union.

### Existing `.eml` or `.eml.zip` conflicts with Gmail

On a retry, the exporter hashes the raw message (extracting the sole ZIP entry when necessary). A conflicting or duplicate canonical file is moved to `quarantine/`, and the canonical file is recreated/reused safely. Healthy legacy `.eml` files are retained; newly missing messages use `.eml.zip`.

### Commit file exists but state did not advance

This is an expected crash window. The next worker validates/replays the deterministic commit, merges it idempotently, and then advances state.

### Old v1.0/v1.1 plan cannot APPLY

Run a new `planBackup()` under 1.2.1. Existing canonical data/catalog records are retained and audited.

### Backup root is unavailable

Restore access to the exact Drive folder identified by the persisted root folder ID. Do not create a same-named replacement; name matching is intentionally not used.

If the root is owned by another account, confirm it is still shared with the
Apps Script execution identity with edit access and still resides in that
account's My Drive. Actual Google Shared Drive roots are unsupported and
rejected during setup/plan root verification.

For S3/R2, run `make s3-status` and `make s3-probe`. A changed endpoint,
bucket, or prefix requires a fresh archive. Rotate credentials by staging the
new values in Project Settings and rerunning `make s3-configure`; the binding
does not change, but the real probe should be rerun before resuming.

### External oversized-message R2 proof

An R2 destination inside Apps Script does not fix a Gmail RAW response that is
itself too large for Apps Script. Use the local proof bridge only for the
checkpointed oversized message:

1. Copy `.env.example` to ignored `.env` and set its mode to `0600`.
2. Keep `CLASP_AUTH_FILE` pointed at the authorization created by
   `make login-project`; never copy OAuth tokens into `.env`.
3. Set an isolated R2 prefix and a credential with read, create, HEAD, and
   delete permissions for that prefix.
4. Run `make external-locate-blocked` to read `status.json` and the immutable
   queue segment, then store only the selected Gmail ID in `.env`.
   If the clasp OAuth client lacks Drive file authorization, use the signed-in
   Drive UI to select that exact checkpointed entry instead.
5. Run `make external-fetch-check` to fetch and hash the selected RAW response
   in memory without writing it anywhere. If the clasp OAuth client reports
   `accessNotConfigured`, use Gmail's signed-in **Download message** action,
   then run `make external-select-download` and `make external-local-check`.
6. Run the confirmed R2 probe, then either the direct `external-export-one`
   target or `make external-upload-local CONFIRM=external-upload-local` for the
   selected browser download.

The export uses create-only semantics and verifies the stored byte length and
raw SHA-256. A matching existing object is treated as a replay; a mismatch is
never overwritten. This proof does not advance Apps Script state or publish a
catalog record. Preserve the partial Drive archive until a full migration or
new-archive design has been validated.

If a production S3/R2 APPLY dies after its canonical message object is
durably written but before its commit record is published, keep the backup
paused and use the bounded recovery operation:

```sh
make external-inspect-s3-blocked
make external-repair-s3-blocked CONFIRM=external-repair-s3-blocked
```

Set `R2_KEY_PREFIX` to the already-bound production prefix and
`R2_ARCHIVE_ROOT_NAME` to the configured `ROOT_FOLDER_NAME`. Inspection is
read-only. Repair accepts only a `PAUSED`/`APPLYING`, exact one-message
checkpoint; it checks the immutable queue entry, content type, Apps Script
integrity marker, byte count, and full SHA-256 before conditionally creating
the deterministic commit. It never fetches Gmail, overwrites an object, edits
Script Properties, or advances the cursor. On resume, ordinary replay
validation merges the commit into the catalog and advances state.

If inspection reports that the canonical object is absent, run
`make external-select-s3-blocked`, open and download that exact Gmail message
as `.eml`, and run `make external-select-download` plus
`make external-local-check`. Then use:

```sh
make external-import-s3-blocked CONFIRM=external-import-s3-blocked
```

The importer re-reads the paused checkpoint and requires its selected Gmail ID
to match, conditionally creates the canonical `.eml` with the native Apps
Script marker, re-downloads and hashes it, and only then publishes the commit.
It is replay-safe if interrupted on either side of the object/commit boundary.

### S3 precondition or conflict failure

Do not manually overwrite the named object. The in-flight checkpoint remains
durable. Inspect the execution, run `make s3-probe`, then `make resume` or one
`make worker`. A replay lists and hashes the canonical object before deciding
whether to reuse or quarantine it.

## Files not to delete during an active run

Do not manually delete or edit:

```text
mailbox-shards/
remaining-shards/
audit/
scan-journal/
work-queue/
queue-commits/
queue-seen/
commits/
catalog/
Script Properties
```

`STATUS.txt` and `status.json` are recreatable, but deleting them provides no benefit.

## Verification practice

If Drive metadata is readable but `DriveApp.getBlob()` is denied, verification
uses Drive's server-side SHA-256 checksum for the stored `.eml` or `.eml.zip`
blob. Catalog records keep both the raw-message hash and the stored-file hash.
When a ZIP is downloadable, verification extracts its sole `.eml` entry and
checks both. Run
`diagnoseDriveReadAccess()` to additionally record Drive's ownership,
application-authorization, download-capability, restriction, and direct media
error metadata without acknowledging or downloading flagged content. Treat a
non-zero `downloadRestricted` count or `portable: false` as an offline-export
blocker even when every integrity checksum passes.

After each major run:

1. `make verify SAMPLE_SIZE=50` or a larger sample.
2. Extract and open `.eml` examples from downloaded `.eml.zip` files offline.
3. Re-run PLAN after APPLY.
4. Copy the complete Drive folder offline.
5. Hash/check the offline copy.
6. Retain at least one independent second copy where policy permits.

## Interpreting `gone`

A message is recorded as `gone` when it was in the frozen work queue but `messages.get` returns not found at APPLY time. This may mean the message was deleted or became inaccessible. It counts as processed so one vanished ID cannot block the entire plan. A later PLAN recalculates the mailbox set.

## Quota behavior

The worker deliberately stops at approximately four minutes, leaving a checkpoint safety margin below Apps Script’s execution ceiling. Trigger and Gmail daily quotas can pause effective progress until their rolling windows reset. The exporter persists checkpoints rather than trying to defeat those limits.
