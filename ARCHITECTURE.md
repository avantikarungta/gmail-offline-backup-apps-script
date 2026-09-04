# Architecture and Correctness Model

## Application and in-project library shape

`99_Main.gs` contains only the Apps Script functions a user or trigger runs.
Those functions delegate to `GmailBackupLibrary` in `98_Library.gs`, which composes the same
actions over an explicit runtime:

```text
Apps Script functions in 99_Main.gs
                 ↓
        GmailBackupLibrary actions
                 ↓
 setup / plan / queue / export / verification orchestration
                 ↓
 runtime ports: Gmail, Drive, properties, locks, triggers, HTTP, utilities, log
                 ↓
 default Apps Script services or injected compatible adapters
```

Apps Script does not support normal ES module imports, so implementation
symbols share the project namespace. Numeric filename prefixes define the
review/test/push order; the runtime boundary supplies the composability that
imports would normally provide.

`GmailBackupLibrary` is an in-project facade, not a promise that the bundle can
be published once as a native Apps Script Library for unrelated consumers.
Google scopes library-owned Script Properties and locks differently from
`ScriptApp`; safe native-library hosting therefore requires injected,
host-namespaced Properties/Lock adapters plus a host-level worker wrapper.
The supported default is one copied Apps Script project per mailbox.

| Module | Responsibility |
|---|---|
| `00_ConfigRuntime.gs` | immutable defaults, phases, runtime creation, service ports |
| `10_Diagnostics.gs` | DOCTOR and ESTIMATE actions |
| `20_Application.gs` | setup, plan/apply transitions, pause/resume/status actions |
| `25_Verification.gs` | sample integrity and Drive-read diagnostics |
| `30_Worker.gs` | one trigger-safe worker slice and error policy |
| `40_Scan.gs` | Gmail ID scan and scan journals |
| `45_Audit.gs` | archive/catalog audit and exact remaining delta |
| `50_Queue.gs` | immutable ordered work queue and queue transactions |
| `60_Export.gs` | RAW export, ZIP encoding, commits, replay, catalog merge |
| `62_DeadLetterQueue.gs` | durable per-message attempts, DLQ evidence, commit validation |
| `65_PlanEstimate.gs` | exact-delta queue sampling, payload/rate modeling, durable PLAN estimate |
| `70_DiagnosticsSupport.gs` | benchmarks, estimators, structured metrics/logs |
| `80_StateStatus.gs` | state schema, status/ETA, pause flags, trigger lifecycle |
| `85_S3Client.gs` | AWS SigV4, S3 object primitives, multipart, parallel create |
| `86_S3DriveAdapter.gs` | virtual folders/files over provider-neutral S3 keys |
| `87_S3Operations.gs` | named credentials, redacted status, capability probe |
| `90_PlatformStorage.gs` | Gmail normalization, layout/repositories, integrity |
| `95_CoreUtilities.gs` | validation and deterministic pure helpers |
| `98_Library.gs` | reusable library facade and deliberately exposed components |
| `99_Main.gs` | thin Apps Script editor/trigger entry points only |

The Node regression suite loads the canonical `.clasp.example.json`
`filePushOrder`, so local tests exercise the same multi-file composition
deployed to Apps Script without committing any installation's live Script ID.

## Runtime and destination injection

`GmailBackupLibrary.createRuntime()` accepts configuration overrides and
compatible service ports. `forTargetRoot(folderId)` and
`forTargetParent(folderId)` are convenience constructors. This makes the
Drive destination independent from the Gmail account selection.

The default Drive adapter still executes as the Apps Script user. A folder in
another account's My Drive therefore works when it is shared with that user
with edit permission. Actual Google Shared Drive roots are detected through
Drive API metadata and rejected: the adapter still relies on `DriveApp` for
folder traversal, checkpoints, quarantine, and large-file fallback. Truly
independent credentials or Shared Drive support require a complete custom Drive
adapter and manual runtime continuation.

Explicit runtimes default to manual continuation. The same runtime must be
passed to `GmailBackupLibrary.worker(runtime)` for every later slice. A
configuration-only runtime can opt into `AUTO_TRIGGER` when all of its
overrides are frozen into Drive/Script-Properties state; injected service ports
are rejected in automatic mode because Apps Script cannot serialize them into
a later trigger invocation.

A persisted logical root key/ID always wins over configuration. State also
stores only the backend kind and a non-secret binding hash. This prevents an
accidental edit from splitting an established archive across two destinations
without leaking a bucket, endpoint, or provider version into core state.

## Data planes

```text
Gmail API
  ├─ ID/list plane: users.messages.list
  └─ raw plane:     users.messages.get(format=raw)

Selected storage backend (Google Drive or S3-compatible object storage)
  ├─ writer/account lease:   archive-manifest.json
  ├─ canonical message data: data/shard-xx/<id>.eml.zip (or legacy .eml)
  ├─ committed metadata:     catalog/shard-xx.json
  ├─ immutable plan evidence
  ├─ immutable ordered queue
  └─ transaction commits/checkpoints

Script Properties
  └─ small atomic current-state checkpoint only
```

Large inventories are never stored in Script Properties; the property value is kept below a conservative 8.5 KiB threshold.

The S3 adapter maps folders to prefixes and files to logical object keys. It
implements exact HEAD/GET, conditional PUT, ETag-guarded replacement,
ListObjectsV2 pagination, copy/delete, and multipart completion. Small message
objects are signed and uploaded in bounded `UrlFetchApp.fetchAll` waves. S3
user metadata carries the same raw-integrity marker used by Drive descriptions.
The provider must pass a destructive-but-bounded probe under a unique temporary
prefix before normal backup actions are enabled.

## Identity and sharding

The immutable Gmail message ID is the canonical key.

```text
shard = low byte of hexadecimal Gmail ID mod SHARD_COUNT
```

Unexpected future ID formats fall back to a deterministic string hash. Canonical storage and catalog lookup remain ID-sharded regardless of APPLY order.

## Ordering model

Google’s message-list guide documents reverse chronological output, newest first. PLAN journals every bounded list slice in observed order.

For `NEWEST_FIRST`:

```text
final-pass chunk 0 rows forward
final-pass chunk 1 rows forward
...
```

For `OLDEST_FIRST`:

```text
last final-pass chunk rows reversed
previous chunk rows reversed
...
first chunk rows reversed
```

The queue filters IDs that are already committed while preserving relative order among remaining IDs.

The multi-pass set union is authoritative for membership. The completed final pass is authoritative for primary chronology. Union-only IDs are appended deterministically as fallback entries so chronology never causes loss.

## PLAN phases

### SCANNING

- Lists message IDs/thread IDs only.
- Uses pages up to 500.
- Runs two passes by default.
- Journals bounded page groups before advancing page-token state.
- Set-unions IDs into 64 mailbox shards.
- Records start/end profile counts and history IDs.

### AUDITING

For each ID shard, compares planned IDs with:

- canonical `.eml.zip` and legacy `.eml` files;
- committed catalog records;
- Drive file IDs;
- byte lengths.

Outputs the exact current remaining delta and anomaly counts.

### QUEUEING

- Walks final-pass journals in selected order.
- Selects only remaining and not-yet-queued IDs.
- Suppresses duplicates caused by a changing mailbox/list pagination.
- Creates immutable queue segments.
- Appends union-only fallback IDs.
- Refuses to finalize unless queue cardinality equals the exact audit delta.
- Samples the immutable queue and durably writes `plan-estimate.json` before
  publishing the final PLAN summary.
- Reuses a matching estimate after a crash, so summary replay does not repeat
  Gmail sampling or synthetic Drive benchmarks.

## APPLY transaction protocol

For each bounded queue range:

1. Persist `inFlight` to Script Properties.
2. Persist the next attempt number immediately before Gmail access.
3. Fetch each Gmail message in RAW format.
4. Decode raw bytes and calculate the raw-message SHA-256.
5. ZIP the raw message, calculate the stored-file SHA-256, then reuse a
   matching canonical `.eml`/`.eml.zip` file or create the ZIP.
6. Write a deterministic batch commit.
7. Merge records into each affected catalog shard.
8. Advance queue segment/offset and clear `inFlight`.

For S3-compatible storage, a new range contains at most eight messages. That
range shares one commit, catalog merge, and final state checkpoint, while
parallel upload payloads remain independently capped at 8 MiB. A range that
fails before commit is reduced to one message on replay; batching therefore
amortizes the healthy path without widening dead-letter scope.

If an exact one-message checkpoint starts three attempts without publishing a
valid commit, the alternate transaction writes/upserts that Gmail ID in the
plan's `dead-letter-queue.json`, writes a deterministic `dead-lettered` commit,
merges its marker into the catalog, then advances. Only the DLQ file is written
before the commit; the cursor cannot advance from DLQ evidence alone.

### Crash windows

- **Before file creation:** retry the same range with a pre-persisted attempt
  count; hard VM termination cannot evade the limit.
- **Repeated failure:** split replay to one exact queue entry, durably write its
  DLQ evidence, then commit and advance. A subsequent PLAN treats the
  `dead-lettered` catalog marker as missing and requeues it.
- **After some files, before commit:** re-fetch and SHA-256-check existing files.
- **After commit, before catalog:** validate files and replay commit.
- **Oversized S3 replay:** a local recovery may publish a create-only,
  full-object SHA-256 attestation before its commit. Above the V8 replay-hash
  limit, Apps Script validates that immutable attestation plus the canonical
  object's marker, type, and size instead of loading the full object into heap.
- **During multi-shard catalog merge:** repeat ID-keyed merges safely.
- **After catalog, before state advancement:** repeat merge, then advance once.

## Canonical versus derived data

Canonical archive data:

```text
.eml.zip containing one exact raw .eml entry (or a retained legacy .eml)
catalog exported records
```

Derived/rebuildable planning data:

```text
mailbox-shards
remaining-shards
audit summaries
scan journals
work queues
queue-seen sets
transaction commits
dead-letter queue evidence
status files
```

Do not delete derived data during an active plan because it is the evidence/checkpoint chain for that generation.

## Concurrency

A script-scoped lock surrounds public state transitions and worker execution.
Recurring triggers provide crash recovery; the lock prevents overlap.
Duplicate worker triggers are removed automatically. Because locks do not span
different Apps Script projects, `archive-manifest.json` also binds the Drive
root to one Gmail account and one script/writer identity. Fresh explicit roots
must be empty; existing manifest-less roots are adopted only through the
already-persisted legacy state and complete legacy layout.

## Non-atomic mailbox caveat

No user-level list pagination over a live mailbox is a perfect snapshot. New mail, deletion, and label/query changes can shift positions. The design mitigates this with:

- multi-pass set union;
- immutable scan journals;
- page-token generation restarts;
- duplicate suppression;
- union-only fallback IDs;
- start/end history IDs;
- post-APPLY re-planning.
