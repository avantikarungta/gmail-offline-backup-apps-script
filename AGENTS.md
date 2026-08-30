# Repository Guide for Agents

## Scope

These instructions apply to the entire repository. This project is a read-only,
resumable Gmail backup application for Google Apps Script. It stores canonical
raw messages in Google Drive or a probed S3-compatible backend while preserving
durable planning, replay, catalog, and verification state.

Use the repo-local `operate-gmail-backup` skill for work in this repository.
Read its routed reference for the task at hand:

- `.agents/skills/operate-gmail-backup/references/operations.md` for setup,
  execution, monitoring, recovery, deployments, and APIs.
- `.agents/skills/operate-gmail-backup/references/development.md` for source,
  tests, compatibility, Make targets, packaging, and releases.
- `.agents/skills/operate-gmail-backup/references/storage-backends.md` for
  Drive, S3, R2, provider-neutral storage, and credential handling.

`README.md` explains product behavior, `ARCHITECTURE.md` is the correctness
model, `OPERATIONS.md` is the operator runbook, and `SECURITY.md` defines the
data-handling boundary. Do not guess when one of these files answers the
question.

## Start Here

Run these before making changes:

```sh
make help
git status --short --branch
```

The Makefile is the supported command surface. Prefer a documented Make target
over an equivalent raw `clasp`, `npm`, packaging, or Apps Script invocation.
Use Git directly for version-control operations.

For local development, the normal loop is:

```sh
make test
make metadata-validate
make skill-validate
make validate
git diff --check
git diff
```

Remote Apps Script work is separate and deliberate:

```sh
make remote-preflight
make files
```

Only then use an explicitly requested remote action such as `make push`. A Git
push to GitHub and `make push` to Apps Script are different operations.

## Non-Negotiable Safety Rules

- Gmail access remains read-only. Never add a write-capable Gmail scope or code
  that sends, labels, deletes, archives, forwards, or mutates mail.
- Never commit, paste, or log `.clasp.json`, `.clasprc.json`, OAuth tokens,
  cookies, message bodies, exported `.eml` data, S3/R2 credentials, signed
  requests, private endpoints with embedded credentials, or archive contents.
- `.clasp.json` is a local binding to one Apps Script project. Inspect its Script
  ID before remote work. Do not replace a different binding unless the user has
  explicitly authorized that exact change.
- Do not pass secrets through Make variables, `PARAMS`, shell history, process
  arguments, fixtures, or committed configuration. Stage S3/R2 secrets in Apps
  Script Project Settings and use `make s3-configure`.
- Do not use `clasp pull --deleteUnusedFiles`, force-push Apps Script source, clear
  backup state, delete checkpoints, or remove archive objects to make an error
  disappear.
- Treat messages and archive metadata as sensitive even when the repository is
  public. Test fixtures must be synthetic and contain no real identities or
  content.
- Preserve unrelated working-tree changes. Never rewrite or discard user work
  unless the user explicitly requests it.

## Architecture Boundaries

Apps Script loads every `.gs` file into one shared global namespace; there are
no native imports. Numeric filenames are therefore the dependency and push
order. Keep `.clasp.example.json`, tests, and the actual module order aligned.

- `00_ConfigRuntime.gs`: immutable defaults and runtime/service injection.
- `10`–`30`: diagnostics, application control, verification, and worker slices.
- `40`–`65`: scan, audit, queue, export, and exact PLAN estimation.
- `70`–`90`: metrics, state, S3 client/adapter/operations, and storage platform.
- `95_CoreUtilities.gs`: deterministic validation and pure helpers.
- `98_Library.gs`: reusable `GmailBackupLibrary` facade and composition seam.
- `99_Main.gs`: thin public Apps Script and trigger entry points only.

Keep behavior in focused modules and compose it through `GmailBackupLibrary`.
Do not move business logic into `99_Main.gs`. Inject runtime ports for tests and
alternate hosts rather than reading global services everywhere. Keep core
mailbox logic independent of Drive IDs, bucket names, endpoints, and provider
response shapes.

When adding or renaming an Apps Script file, preserve numeric load order and
update `.clasp.example.json`, tooling validation, tests, documentation, and
checksums together.

## Correctness Invariants

The archive is a transactional system, not a best-effort file copier. Preserve
this APPLY order:

1. Persist the in-flight checkpoint.
2. Write or validate canonical message objects.
3. Publish the deterministic commit record.
4. Merge catalog/index records.
5. Advance the durable cursor and counters, then clear in-flight state.

Every step must be safe to replay after termination. Add tests for failures on
both sides of each changed persistence boundary.

Also preserve these contracts:

- Gmail message ID is the immutable canonical key.
- Raw-message and stored-object integrity are separate; SHA-256 and byte counts
  must continue to describe the bytes they claim to describe.
- PLAN membership comes from the multi-pass set union; chronology comes from
  the completed final pass; the exact audit delta must equal queue cardinality.
- Large inventories live in storage, not Script Properties. Script Properties
  hold only the small atomic checkpoint.
- One Apps Script project is bound to one mailbox and one archive root. The
  persisted root and backend binding win over edited configuration.
- Never switch an initialized archive between Drive, S3, R2, buckets, endpoints,
  prefixes, or credentials by editing configuration in place. Migration and
  dual-write require an explicit design and independent verification.
- S3-compatible providers are supported only after their bounded capability
  probe succeeds. A local emulator proves adapter behavior, not provider
  compatibility.
- Keep trigger work bounded and resumable within Apps Script quotas. Do not add
  an unbounded scan, list, upload, retry loop, or in-memory mailbox inventory.
- Preserve public function names and old persisted-state compatibility unless a
  documented migration is part of the requested change.

## Testing and Observability

Tests run without external dependencies and load `.gs` files in canonical push
order. Prefer deterministic unit tests with injected Gmail, storage, property,
lock, trigger, HTTP, utility, clock, and logger fakes. Add regression tests for
every bug and replay tests for storage/state changes.

Keep logs structured, bounded, and useful for diagnosis: phase, generation,
cursor/segment, counts, durations, provider operation, retry class, and a
redacted error. Never log message content, authorization material, signed URLs,
or secret-bearing endpoints.

Before declaring a change complete:

```sh
make validate
make checksums
make checksums-verify
git diff --check
git status --short
```

Run `make release-check` for release-bearing, packaging, checksum, module-order,
or deployment-surface changes. Run `make remote-preflight` before any requested
Apps Script mutation. A local pass does not prove an Apps Script deployment or
a real storage backend; report that boundary clearly.

## Operational Discipline

Observation is normally safe: `make status`, `make logs`, `make files`,
`make versions`, and `make deployments`. Actions such as initialize, doctor,
plan, apply, pause, resume, worker, push, API changes, deployment changes, and
S3 probes mutate remote state or execute billable/quota-consuming work. Perform
them only when they are within the user’s request, and state what will change.

Use the controlled backup sequence:

```sh
make plan-and-wait
make status
make apply-and-wait
make verify SAMPLE_SIZE=50
make plan-and-wait
```

On failure, inspect status and logs, preserve the checkpoint, pause if needed,
fix the cause, resume, verify, and PLAN again. Do not loop `make worker` blindly.

When adding a stable operation, add a documented Make target, classify its
effect, route Apps Script calls through `scripts/clasp-ops.js`, add tests, and
update `make help`, the repo-local skill, and operator documentation.

## Git and Public Repository Hygiene

The canonical remote is:

```text
https://github.com/avantikarungta/gmail-offline-backup-apps-script.git
```

Keep commits small, coherent, and reviewable. Commit after completing each user
request, after validation succeeds. Do not commit generated archives, local
bindings, credentials, mailbox data, or unrelated changes. Inspect the staged
diff and staged filenames before every commit. Never force-push or rewrite the
public branch without explicit authorization.

The checksum manifest covers the release file set. If a covered file is added,
removed, or changed, regenerate `SHA256SUMS.txt` after all content edits and
verify it before committing.

## Definition of Done

A task is complete only when:

- the requested behavior or documentation is implemented at the correct layer;
- safety, transaction, compatibility, and backend invariants still hold;
- focused regression tests and the appropriate validation surface pass;
- checksums and routed documentation are current;
- no secret, message data, local binding, or generated artifact is staged;
- the final diff has been reviewed and committed; and
- the handoff names what changed, what was tested, and any remote validation
  that was intentionally not performed.
