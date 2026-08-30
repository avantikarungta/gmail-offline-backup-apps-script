# Operations

## First-Time Setup

Run from the repository root:

```sh
make setup SCRIPT_ID=YOUR_SCRIPT_ID
```

The composite setup runs `tools`, `configure`, `login-project`, and
`remote-preflight`. Run those targets individually when diagnosing a partial
setup.

Inspect `.clasp.json` and `make files` before the first push. Then:

```sh
make push
make initialize
make doctor
make estimate # optional quick preview
```

`make configure` is idempotent for the same Script ID. It refuses to replace a different local binding unless `FORCE=1` is explicit. A forced replacement is an exceptional operation; compare both IDs and confirm the target first.

`make login-project` requests the manifest scopes needed for execution. `make auth-check` reports which clasp account/config is active but does not prove that the Google account owns the target project; `make files` and a read-only `make status` provide the practical project check.

## Controlled Backup Run

Use this sequence for a normal run:

```sh
make plan-and-wait
make status
make apply-and-wait
make verify SAMPLE_SIZE=50
make plan-and-wait
```

The final PLAN should converge to no remaining messages. Review status and logs before beginning another APPLY if it does not.

Completed PLAN automatically creates `plan-estimate.json`. Use its exact
remaining count and sampled raw/stored payload, duration, and quota-day ranges
for the pre-APPLY decision; `estimateBackup()` remains an optional quick preview
before PLAN.

`make wait` polls `agentStatus` without refreshing Drive status files. Configure it with comma-separated `PHASE`, `TIMEOUT_SECONDS`, and `POLL_SECONDS`. It fails on `ERROR`, `PAUSED`, permanent API errors, and timeout; transient rate or server failures are retried.

Examples:

```sh
make wait PHASE=PLANNED TIMEOUT_SECONDS=14400 POLL_SECONDS=30
make wait PHASE=COMPLETE,IDLE TIMEOUT_SECONDS=86400
```

## Public Operations

| Make target | Apps Script entry point | Effect |
| --- | --- | --- |
| `status` | `agentStatus` | Read machine-oriented status; no Drive status refresh |
| `status-human` | `backupStatus` | Read/log human status and refresh status files |
| `initialize` | `setupBackup` | Create or adopt the archive layout |
| `doctor` | `doctorBackup` | Run bounded Gmail/Drive diagnostics, including a temporary write/delete |
| `estimate` | `estimateBackup` | Sample the mailbox for volume and runtime estimates |
| `plan` | `planBackup` | Start exact PLAN, queue, automatic estimate, and continuation work |
| `apply` | `applyBackup` | Start APPLY for the completed plan |
| `pause` / `resume` | `pauseBackup` / `resumeBackup` | Safely checkpoint/continue a run |
| `worker` | `gmailBackupWorker` | Run one worker slice manually |
| `verify` | `verifyBackupSample` | Verify a random archive sample |
| `diagnose-drive` | `diagnoseDriveReadAccess` | Diagnose Drive read/download restrictions |
| `benchmark-compression` | `benchmarkArchiveCompression` | Measure ZIP savings without writing mail |
| `benchmark-drive` | `benchmarkDriveWritePaths` | Compare Drive write paths |
| `s3-status` | `s3StorageStatus` | Read redacted S3 binding/profile/probe status |
| `s3-configure` | `configureS3Credentials` | Migrate staged Script Properties into the named profile |
| `s3-probe` | `probeS3Storage` | Perform real bounded conditional/read/list/copy/delete checks |
| `s3-clear` | `clearS3Credentials` | Clear the selected profile with exact confirmation |

## S3 / R2 operations

Never pass access keys through Make variables or `PARAMS`. Set the documented
staging properties in Apps Script Project Settings, then run:

```sh
make s3-configure
make s3-probe
make s3-status
```

Normal backup actions enforce a successful probe whose binding hash matches the
current profile, bucket, endpoint, region, prefix, and addressing style. After
a same-profile credential rotation, rerun the probe. Use
`S3_PROBE_MULTIPART: true` only when intentionally validating a real multipart
transfer. An initialized archive must never be switched in place.

For an exceptional public function:

```sh
make run FUNCTION=functionName PARAMS='["value",123]'
make run FUNCTION=functionName PARAMS_FILE=/absolute/path/to/params.json
```

Prefer `PARAMS_FILE` for complex JSON, but never use it for S3 secret material;
the wrapper ultimately forwards parameters to clasp. Add a named target when a
function becomes a stable operation.

For a one-message oversized Gmail RAW proof outside Apps Script, use ignored
`.env` through `make external-config-check`, `make external-locate-blocked`,
`make external-fetch-check`,
`make external-r2-probe CONFIRM=external-r2-probe`, and
`make external-export-one CONFIRM=external-export-one`. This bridge reuses
the clasp OAuth grant without copying tokens, writes an uncompressed `.eml`
under an isolated R2 prefix, and does not advance Apps Script state or its
catalog. It is not a full migration or a replacement for PLAN/APPLY.

If direct Gmail REST access reports `accessNotConfigured`, use the signed-in
Gmail **Download message** action for the selected checkpoint entry, then run
`make external-select-download`, `make external-local-check`, and
`make external-upload-local CONFIRM=external-upload-local`. Selection requires
exactly one recent `.eml`; command output never includes its name, path, or
content.

## Monitoring And Logs

```sh
make status
make logs
make logs-watch
make open-script
make open-logs
```

Use `make status-human` only when refreshing the Drive status artifacts is desired. Capture timestamps, phase, counters, last error, and the nearest log entries when reporting a failure. Do not paste message bodies or credentials into issues or commits.

## Debugging And Recovery

1. Run `make config-check`, `make auth-check`, and `make files`.
2. Run `make status`; if it fails, run `make logs` and inspect the Apps Script execution page with `make open-script`.
3. Run `make doctor` for bounded prerequisite and Drive write/read/delete checks.
4. If work is active but unhealthy, use `make pause`, inspect the checkpoint and logs, then `make resume` after the cause is fixed.
5. If a trigger is blocked or delayed, use `make worker` for one observable slice. Do not loop it blindly.
6. Use `make verify` after recovery and PLAN again to establish exact remaining work.

Do not delete state, manifests, staging objects, or committed catalog records during recovery. Those records make retries idempotent and crash-safe.

## Source, Deployments, And APIs

```sh
make pull
make push
make versions
make version DESCRIPTION='release description'
make deployments
make deploy VERSION_NUMBER=12 DESCRIPTION='production'
make redeploy DEPLOYMENT_ID=... VERSION_NUMBER=13
make apis
make enable-api API=drive
```

Destructive or forceful operations require exact confirmations:

```sh
make push-force CONFIRM=push-force
make undeploy DEPLOYMENT_ID=... CONFIRM=...
make disable-api API=drive CONFIRM=disable-drive
```

Use `make pull-version VERSION_NUMBER=...` to inspect a historical source version. Never add `--deleteUnusedFiles`; the repository intentionally contains files that are not Apps Script source.
