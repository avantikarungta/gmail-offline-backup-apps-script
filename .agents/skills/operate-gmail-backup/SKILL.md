---
name: operate-gmail-backup
description: Operate and maintain this Gmail Offline Backup Apps Script repository through its Makefile, including clasp setup and authentication, deployment, PLAN/APPLY control, monitoring, logs, recovery, verification, tests, releases, and storage-backend development. Use for work in this repository; do not use for unrelated Gmail or generic Apps Script projects.
---

# Operate Gmail Backup

Treat the repository `Makefile` as the supported command surface. Start with `make help`, and prefer its targets over equivalent raw `clasp`, `npm`, packaging, or public Apps Script function commands. Use Git directly for version-control operations.

## Guardrails

- Before remote work, run `make remote-preflight`. Before pushing, run `make validate` and inspect `make files`.
- Treat `.clasp.json` as a per-installation project binding. Create it with `make configure SCRIPT_ID=...`; never replace a different binding until its Script ID has been verified.
- Distinguish observation (`status`, `logs`, `files`, `versions`, `deployments`) from mutation (`initialize`, `doctor`, `plan`, `apply`, `pause`, `resume`, `worker`, `push`, API changes, and deployment changes).
- Gmail access is read-only. Do not widen Gmail scopes.
- Do not bypass the repository's `make run` wrapper: `clasp` can emit an Apps Script JSON error while itself exiting successfully. The wrapper converts that envelope into a real command failure.
- Do not use destructive pull flags such as `clasp pull --deleteUnusedFiles`; repo-only files must survive pulls.
- Keep one Apps Script project bound to one mailbox and one archive root. Treat persistent state and committed manifests as authoritative.
- Use bounded tests, PLAN before APPLY, sample verification after APPLY, and a fresh PLAN to confirm remaining work.
- Never clear active state merely to make a failure disappear. Preserve checkpoints and crash replay.
- Never commit or print OAuth tokens, `.clasp.json`, messages, S3/R2 credentials, or signed request material.

## Route The Task

- For setup, normal runs, monitoring, debugging, recovery, deployments, and API administration, read [references/operations.md](references/operations.md).
- For code changes, tests, module boundaries, compatibility, releases, and new Make targets, read [references/development.md](references/development.md).
- For provider-neutral archive work and the implemented S3/R2 backend, read [references/storage-backends.md](references/storage-backends.md).

Read only the references needed for the task. Preserve the transactional order and public entry-point compatibility described there.
