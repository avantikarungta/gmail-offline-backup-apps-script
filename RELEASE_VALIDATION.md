# Release Validation — 1.3.0-dev.15

## Automated checks performed

- JavaScript syntax validation with Node.
- `appsscript.json` and `package.json` JSON parsing.
- Mocked regression suite with no external dependencies.
- Repository-tooling regression coverage for successful calls, Apps Script
  JSON error envelopes, argument forwarding, and phase waiting.
- Makefile metadata and repo-local skill structure validation.
- Loading modules in the exact `.clasp.example.json` deployment order.
- ZIP extraction and rerun of both test suites from the packaged artifact.
- SHA-256 generation and exact-inventory verification for every bundled source
  file before and after ZIP extraction.

## Regression coverage

- raw RFC message byte preservation, including UTF-8 and arbitrary byte values;
- deterministic ID sharding and verification sampling;
- account-isolation guard;
- Gmail query composition, size bands, date strata, volume/timing helpers, and quota-day estimates;
- DOCTOR and ESTIMATE end-to-end mock paths;
- setup preflight, exact Drive-root anchoring, and idempotent setup rerun;
- two-pass plan set union;
- crash after scan-journal creation and replay without re-listing Gmail;
- newest-first work-queue generation;
- global oldest-first ordering across multiple final-pass chunks;
- duplicate suppression and fallback queueing;
- crash after queue segment creation and exact replay;
- deterministic sampling across the immutable work queue;
- exact-delta raw/stored payload and prior-throughput APPLY estimates;
- durable PLAN-estimate reuse after final-summary failure;
- PLAN final-summary failure and retry;
- zero-delta APPLY finalization failure and retry;
- raw-message idempotency, corruption quarantine, and replacement;
- mixed-shard APPLY commit/catalog merge;
- crash after APPLY commit creation and replay without duplicate canonical files.
- legacy in-flight checkpoint compatibility and durable pre-Gmail attempt counts;
- one-message replay isolation, bounded retry exhaustion, and DLQ publication;
- crash after DLQ evidence but before commit, followed by idempotent replay;
- dead-letter catalog markers remaining unhealthy for a future PLAN.
- ZIP compression and exact ZIP→EML SHA-256 round trips;
- mixed legacy `.eml` and new `.eml.zip` archives;
- runtime configuration isolation and injected logging;
- exact-root and parent-folder destination injection, including shared-folder semantics.
- SigV4 canonical request construction and credential-free URLs;
- S3 ListObjectsV2 XML decoding, virtual folders, conditional create/update,
  integrity metadata, object reads, rename/move, and backend binding rejection;
- immutable query/spam scope across scan slices with different global defaults;
- manual continuation for injected runtimes and rejection of unsafe automatic overrides;
- archive-root mailbox/writer leases and rejection of non-empty unclaimed roots;
- Shared Drive flags on parallel create/update requests and pre-write rejection
  of actual Shared Drive roots;
- forward-progress replay after a partial queue seen-shard merge.
- wrong-account pause/resume rejection before properties, state, or triggers
  can change;
- explicit in-project facade boundary for Apps Script resource scoping.
- PLAN health rejection for renamed, extension-incompatible, or MIME-drifted
  canonical archive files.

## Still requires real-account validation

The mocked suite cannot reproduce every Google Workspace policy, Gmail mutation pattern, Drive/S3 latency condition, Apps Script memory ceiling, provider implementation, or quota behavior. Before a full mailbox run:

1. use a small query such as `newer_than:7d`;
2. run DOCTOR, ESTIMATE, PLAN, APPLY, and verification;
3. inspect the Apps Script Executions panel;
4. extract and open representative `.eml` files from `.eml.zip` archives offline;
5. prove the entire Drive folder can be downloaded or synced;
6. expand the query only after the controlled run succeeds.

For S3/R2, also run the real `make s3-probe` against the exact target binding.
Enable `S3_PROBE_MULTIPART` for a provider-specific multipart check. This source
release has local contract tests; AWS S3 and R2 acceptance still requires the
operator's credentials/bucket and is deliberately not simulated as proof.

## 1.2.1 compatibility regressions

- Advanced-Service `Message.raw` represented as signed Apps Script `Byte[]` is preserved byte-for-byte.
- REST-style unpadded base64url `Message.raw` is decoded to the same byte sequence.
- A simulated `ScriptApp.deleteTrigger()` backend exception after successful trigger creation leaves DOCTOR in PASS state with a cleanup caution.
- Existing worker trigger cleanup paths use best-effort deletion so cleanup failure cannot corrupt phase/checkpoint state.
