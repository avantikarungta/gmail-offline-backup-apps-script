# Migration Guide

## From 1.3.0-dev.14 to 1.3.0-dev.15

1. Checkpoint-safely pause an active APPLY, run `make validate`, inspect
   `make files`, and push every numbered module, including the new
   `62_DeadLetterQueue.gs`.
2. Resume the preserved plan. Existing version-2 in-flight checkpoints remain
   valid and are treated as having started one prior attempt.
3. No archive migration or new PLAN is required. After three durable attempts,
   one exact failing queue ID is recorded in the plan's
   `dead-letter-queue.json`, committed as `dead-lettered`, and skipped.
4. A later PLAN deliberately requeues dead-lettered IDs because only an
   `exported` catalog record with a healthy canonical object counts as backed
   up.

## From 1.3.0-dev.13 to 1.3.0-dev.14

1. Run `make configure SCRIPT_ID=YOUR_EXISTING_SCRIPT_ID` so the ignored clasp
   binding includes `85_S3Client.gs`, `86_S3DriveAdapter.gs`, and
   `87_S3Operations.gs`; then run `make validate` and `make push`.
2. Existing archives normalize as Google Drive archives and continue unchanged.
3. Do not switch an initialized Drive archive to S3. Use a fresh Apps Script
   project/state and follow the S3/R2 setup in `README.md`.
4. For S3, stage credentials in Project Settings, run `make s3-configure`, and
   require a successful `make s3-probe` before `make initialize`.

## From 1.3.0-dev.12 to 1.3.0-dev.13

1. Run `make configure SCRIPT_ID=YOUR_EXISTING_SCRIPT_ID` so the ignored clasp
   binding picks up the new `65_PlanEstimate.gs` module order.
2. Run `make remote-preflight`, inspect `make files`, and run `make push`.
3. Start a fresh `make plan-and-wait`. On completion, review the new
   `plan-estimate.json`; no separate quick ESTIMATE is required for the best
   pre-APPLY forecast. Existing archives and completed plans remain readable.

## From 1.3.0-dev.11 to 1.3.0-dev.12

1. Run `make configure SCRIPT_ID=YOUR_EXISTING_SCRIPT_ID`; it is idempotent
   when the ignored `.clasp.json` is already bound to that project.
2. Run `make remote-preflight`, inspect `make files`, and run `make push`.
3. Continue through the named Make targets (`make status`, `make plan-and-wait`,
   `make apply-and-wait`, and `make verify`). Archive and state formats are
   unchanged; no new PLAN is required solely for this tooling release.

## From 1.3.0-dev.10 to 1.3.0-dev.11

1. Push every numbered module and `appsscript.json`.
2. Run `setupBackup()` once. Existing state safely adopts the established
   manifest-less archive root and writes `archive-manifest.json`.
3. Confirm the manifest's account and writer in Drive, then run
   `agentStatus()` and `verifyBackupSample()`.
4. For library callers with an explicit runtime, use manual worker continuation
   or opt a configuration-only native runtime into `AUTO_TRIGGER`.

Do not point a second project at the same archive root. This release rejects
non-empty unclaimed targets and roots leased to another script or mailbox.

## From the single-file 1.3 staging build to 1.3.0-dev.10

1. Push every numbered `.gs` module and `appsscript.json` with `make push`.
2. Remove the old `GmailBackup.gs` project file if it remains in the editor;
   leaving it would define every function twice.
3. Do not clear Script Properties or delete the Drive archive. The persisted
   root ID, catalogs, plans, queues, commits, and `.eml`/`.eml.zip` files are
   compatible.
4. Run `agentStatus()` and confirm `exporterVersion: 1.3.0-dev.10`, then run
   `verifyBackupSample()`.

To select a different Drive destination, use a fresh state/project and set one
of `TARGET_ROOT_FOLDER_ID` or `TARGET_PARENT_FOLDER_ID` before `setupBackup()`.
An existing state intentionally remains pinned to its original root.

## From 1.2.0

1. If PLAN/APPLY is active, run `pauseBackup()` first.
2. Replace `GmailBackup.gs` with the 1.2.1 source and save.
3. The manifest and archive layout are unchanged.
4. Run `setupBackup()` and `doctorBackup()` again.
5. Resume the existing 1.2.x plan with `resumeBackup()` if it was paused; a new plan is not required solely for this bugfix.

Version 1.2.1 fixes RAW byte normalization and makes trigger deletion cleanup non-fatal. Existing `.eml`, catalog, scan journal, queue, and checkpoint files remain compatible.

## From 1.1.0

Version 1.2.1 preserves existing canonical `.eml` files and catalog records but changes the plan format by adding scan journals and an immutable ordered work queue.

### Safe upgrade

1. Run `pauseBackup()` if SCANNING, AUDITING, or APPLYING is active.
2. Replace `GmailBackup.gs` with the 1.2.1 source.
3. Replace `appsscript.json` with the included manifest.
4. Save and confirm Gmail API v1 remains enabled under Services.
5. Run:

```javascript
setupBackup();
doctorBackup();
```

6. Run a new:

```javascript
planBackup();
```

7. Wait for `PLANNED`, review `plan.json` and `queue.json`, then run `applyBackup()`.

### Why old plans are rejected

Pre-1.2 plans stored remaining IDs only in ID-sharded files. They did not contain a durable chronological queue. Version 1.2 refuses to APPLY such a plan rather than silently claiming a requested order it cannot prove.

### What is retained

```text
data/
catalog/
quarantine/
verification/
older plans/
```

The new PLAN audits the existing archive and queues only missing, uncommitted, or unhealthy records.

## Changing APPLY order

Changing `APPLY_ORDER` does not rewrite an existing plan. Start a new PLAN to freeze a different order.

## Changing GMAIL_QUERY

Changing the query is safe between plans. A broader query creates a new exact delta against the same global archive. A narrower query does not delete previously archived messages; they are retained and may be reported as orphans relative to the current query.

## Do not change SHARD_COUNT

`SHARD_COUNT` is an archive-format setting. The persisted configuration guard rejects a mismatch. Restore the original value rather than attempting an in-place change.
