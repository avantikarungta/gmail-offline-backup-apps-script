# Storage Backends

Google Drive and S3-compatible object storage are implemented production targets. AWS S3, Cloudflare R2, and generic compatible endpoints use the same SigV4 adapter, but a specific binding is supported only after `make s3-probe` succeeds against it. Do not treat local mocks as provider acceptance.

## Provider-Neutral Contract

Keep mailbox discovery, MIME acquisition, ZIP packaging, planning, verification, and status logic independent of storage. A backend adapter should expose equivalents of:

- `head(key)` and `get(key)`
- `put(key, body, metadata)`
- `putIfAbsent(key, body, metadata)`
- `replaceIfMatch(key, body, etag, metadata)`
- paginated `list(prefix, cursor)`
- `copy(source, destination)` and `delete(key)` where supported
- `multipartPut(key, source, options)` for large objects
- `describe()` and a bounded `probe()`

Use provider-neutral logical keys for canonical messages, commits, catalog pages, status, quarantine, and temporary staging. Do not leak Drive IDs, S3 URLs, bucket names, or provider-specific version identifiers into core state.

## Correctness Requirements

- Make manifest, commit, and catalog publication conditional or create-only where possible.
- Treat exact `HEAD` results, content lengths, hashes, and entity versions as the basis for idempotency.
- Preserve in-flight checkpoints before external writes and replay the same logical key after a crash.
- Store the per-plan dead-letter queue through the same provider-neutral folder
  adapter, before publishing its `dead-lettered` commit; never treat that
  marker as a healthy canonical object.
- Quarantine mismatched existing objects rather than silently overwriting them.
- Keep payload hashes independent of transport encoding and validate after upload.
- Redact authorization headers, signed URLs, security tokens, access keys, message data, and endpoints containing credentials from logs.
- Run a bounded capability probe because S3-compatible products differ in conditional requests, multipart behavior, checksums, listing consistency, and metadata handling.
- Account for Apps Script `UrlFetchApp` request and runtime limits; multipart/resumable paths must be sliceable across executions.
- Do not full-read an oversized S3 object during Apps Script replay. Require a
  create-only external full-hash attestation produced only after a complete GET
  matches the canonical marker, byte count, and SHA-256; then recheck that
  attestation and bounded object metadata before catalog/cursor advancement.

## Configuration And Credentials

Never pass secret keys through Make command-line variables, check them into JSON, or place them in Script source. Use a named profile stored in Apps Script Properties (or an external short-lived credential mechanism) with non-secret configuration separated from secrets.

The profile covers backend kind, bucket, endpoint, region, key prefix, credential reference, addressing style, and probe results. R2 uses its account endpoint and `auto`; AWS S3 uses an actual region. Generic endpoints must be probed rather than inferred from the product name.

Use `make s3-configure` only after secrets are staged in Apps Script Project Settings; it migrates and deletes staging properties without CLI secret arguments. Use `make s3-probe` for real operations and `make s3-status` for redacted state. Never bypass the successful-probe guard for normal backup work.

## Validation Matrix

Test at least:

- AWS S3, R2, and one strict local emulator or compatible service
- new object, existing identical object, existing mismatched object
- conditional request success and precondition failure
- single-part and multipart boundaries
- pagination and empty prefixes
- throttling, transient 5xx, timeouts, and retry-after behavior
- crash after each transaction step followed by replay
- credential expiry/rotation without exposing secrets
- verification of sampled archives through the provider-neutral interface

Do not switch an active archive backend in place. Migration or dual-write needs an explicit design with independent cursors, manifests, verification, and cutover state.
