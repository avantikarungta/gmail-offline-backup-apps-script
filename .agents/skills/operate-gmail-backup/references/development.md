# Development

## Architecture And Compatibility

Apps Script loads `.gs` files into one shared namespace. Numeric filenames encode the exact push order; preserve it. Keep `99_Main.gs` a thin public facade and put behavior in focused modules with runtime dependencies injected through the existing runtime seam.

Preserve public entry-point names and the archive transaction sequence:

1. Persist the in-flight checkpoint.
2. Write canonical message objects.
3. Publish the commit record.
4. Update catalog/index material.
5. Advance the durable cursor and counters.

Changes must remain replay-safe when execution stops after any step. Add compatibility tests for old state shapes and replay tests around each new persistence boundary.

For per-message failure handling, persist attempt state before Gmail access,
isolate replay to one immutable queue entry, write DLQ evidence before its
commit, and advance only after the normal catalog/commit transaction. Never
mark a dead-lettered record as exported; the next PLAN must requeue it.

## Edit And Test Loop

Run:

```sh
make test
make metadata-validate
make skill-validate
make validate
git diff --check
git diff
```

Remote validation is a separate, deliberate step:

```sh
make remote-preflight
make push
make status
```

Do not treat a local test pass as authorization to push. Do not treat a successful push as an end-to-end backup test.

## Versioned Changes And Releases

For release-bearing work, update these together:

- `VERSION`
- `package.json`
- `BACKUP_CONFIG.VERSION` in `00_ConfigRuntime.gs`
- the current `CHANGELOG.md` heading
- README release notes
- `RELEASE_VALIDATION.md`
- any test that asserts the release version

Then run:

```sh
make validate
make checksums
make checksums-verify
make release-check
```

`make release-check` builds the source archive, extracts it into an isolated temporary directory, verifies the exact checksum inventory, and reruns tests there. Inspect `git status --short` after generation. Commit only intentional source, documentation, skill, and checksum changes; `dist/` is ignored.

## Extending The Make Surface

The Makefile is the repository's public operational API. When adding a stable public Apps Script function or maintenance workflow:

1. Add a named, documented Make target.
2. Mark whether it is observational or mutating.
3. Require exact confirmation for destructive or forceful actions.
4. Route Apps Script calls through `scripts/clasp-ops.js` so JSON error envelopes become nonzero failures.
5. Add local tests where behavior can be simulated.
6. Update `make help`, this skill, and the operator documentation.

Keep secrets out of Make variables when they would appear in process lists, shell history, or logs. Accept a file path or a preconfigured secret profile instead.
