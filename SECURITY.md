# Security and Data Handling

## Authorization model

The script uses official Apps Script/Google APIs and requests:

```text
gmail.readonly
drive
script.scriptapp
script.external_request
```

It does not request Gmail modify/send scopes, extract browser cookies, replay session tokens, scrape private Gmail RPC endpoints, or install a browser extension.

`script.external_request` is used for direct HTTPS calls to Google Drive API
endpoints in Drive mode and to the explicitly configured S3-compatible endpoint
in S3 mode. S3 endpoints must be HTTPS origins without embedded credentials.

S3 access keys are stored only in named Apps Script Script Properties. They are
staged through Project Settings, migrated by `configureS3Credentials()`, and
the staging properties are deleted immediately. Make targets never accept key
material. Authorization headers, session tokens, signed requests, canonical
requests, object keys in provider error XML, and endpoints containing
credentials are not logged. Prefer prefix-scoped, least-privilege credentials
and rotate them according to provider policy.

## Why Drive scope is broad

The Apps Script Drive service does not offer a narrow “only files created by this script” scope for this design. The exporter needs to create files/folders, inspect existing archive files, hash them, update manifests/catalogs, and move conflicts into quarantine.

Keep the Apps Script project private and review the source before authorizing it.

## Corporate policy

Takeout/IMAP restrictions may reflect data-loss-prevention policy. Obtain permission to retain corporate mail, especially messages containing customer data, employee information, privileged material, trade secrets, or regulated records.

## Local/offline storage

The `.eml.zip` files contain complete `.eml` message bodies, headers,
attachments, and inline images. Treat the offline copy as sensitive corporate data:

- use full-disk or encrypted-volume protection;
- restrict local account access;
- avoid consumer sync services unless approved;
- keep backup media physically secure;
- define a retention/deletion date;
- securely erase obsolete copies where required.

## Logs and metadata

Routine structured logs contain counts, IDs only indirectly through errors, phases, rates, and plan identifiers. The archive catalog contains Gmail message IDs, thread IDs, labels, dates, hashes, and Drive file IDs. Diagnostic reports do not persist sampled message bodies.

## Account isolation

The project is anchored to the first authenticated Gmail address. A later execution under another account throws an account-mismatch error before active checkpoint mutation.

The archive destination does not have to be owned by that Gmail account.
`TARGET_ROOT_FOLDER_ID` and `TARGET_PARENT_FOLDER_ID` may reference a folder in
another account's **My Drive**, but Apps Script still performs Drive operations
as the executing identity and therefore requires explicit edit access. This is
folder sharing, not impersonation or cross-account credential reuse. Actual
Google Shared Drive roots are rejected because the implementation still relies
on `DriveApp` operations that do not provide complete Shared Drive support.

Each archive root contains `archive-manifest.json`, which binds it to the
normalized Gmail account, catalog shard count, and Apps Script writer identity.
New explicit roots must be empty. This prevents a second project or mailbox
from silently mixing data into an established archive; it is not a substitute
for restricting Drive sharing to trusted editors.
