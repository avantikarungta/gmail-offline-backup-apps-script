# Quick Start — Gmail Offline Backup 1.3.0-dev.14

## Install

1. Sign into the target corporate Gmail account.
2. Open `script.new`.
3. Run `make setup SCRIPT_ID=YOUR_SCRIPT_ID` with the Script ID shown in
   Project Settings. Review the reported account, binding, and `make files`.
4. Run `make push`, or create/paste every numbered `.gs` module in the Apps
   Script editor.
5. Enable the manifest in **Project Settings** and paste `appsscript.json`.
6. Confirm **Services → Gmail API v1** is present.
7. Save.
8. In `00_ConfigRuntime.gs`, start with:

```javascript
GMAIL_QUERY: 'newer_than:7d',
APPLY_ORDER: 'NEWEST_FIRST',
```

## Run in this order

```sh
make initialize
make doctor
make estimate # optional quick preview; PLAN creates the better exact-delta estimate
make plan-and-wait
```

Run periodically to inspect progress:

```sh
make status
```

When phase is `PLANNED`, inspect `plan.json`, `queue.json`, and the automatically
generated `plan-estimate.json` in Drive, then run:

```sh
make apply-and-wait
```

When phase is `COMPLETE`:

```sh
make verify SAMPLE_SIZE=50
```

Download sample `.eml.zip` files, extract their single `.eml` entry, and open it offline.

## Full mailbox

Change:

```javascript
GMAIL_QUERY: '',
```

Then run:

```sh
make estimate # optional quick preview
make plan-and-wait
```

When `PLANNED`:

```sh
make apply-and-wait
```

After completion, run one final `make plan-and-wait` to catch mail that arrived
or changed visibility during the run. Apply again if the new plan reports
remaining messages.

## Controls

```sh
make pause
make resume
make status
make worker # one manual continuation slice if triggers are blocked
```

## Apply order

```javascript
APPLY_ORDER: 'NEWEST_FIRST' // recommended
APPLY_ORDER: 'OLDEST_FIRST'
APPLY_ORDER: 'SHARDED_ID'
```

The selected order is frozen when PLAN starts.

## Optional S3 / Cloudflare R2 destination

For a fresh archive, set `STORAGE_BACKEND: 'S3'` plus the bucket, HTTPS
endpoint, region (`auto` for R2), key prefix, and addressing style in
`00_ConfigRuntime.gs`. Do not put access keys in source.

After pushing, add the staging access-key and secret-key Script Properties in
Apps Script Project Settings, then run:

```sh
make s3-configure
make s3-probe
make s3-status
make initialize
```

See `README.md` for the exact property names and configuration example. Use a
fresh Apps Script state/project; an existing Drive archive cannot be switched
to S3 in place.

## Optional shared My Drive destination

For a fresh archive, share a destination folder with the Apps Script user and
set exactly one value in `00_ConfigRuntime.gs`:

```javascript
TARGET_ROOT_FOLDER_ID: 'shared-folder-id',
TARGET_PARENT_FOLDER_ID: '',
```

The Drive owner may be another account, but the executing account must have
edit access. Existing initialized archives remain pinned to their persisted
root folder ID. Use a folder from the owner's My Drive; actual Google Shared
Drive roots are detected and rejected during setup.
