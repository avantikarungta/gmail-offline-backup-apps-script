# Design References

Reviewed on 2026-08-28.

## Official Google documentation

- Gmail API list guide; documents reverse chronological/newest-first order, ID/thread-only list resources, pagination, max 500, and `resultSizeEstimate`:  
  https://developers.google.com/workspace/gmail/api/guides/list-messages
- `users.messages.list` REST reference:  
  https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
- Gmail Message resource; immutable ID, labels, `internalDate`, `sizeEstimate`, and complete RFC 2822 base64url `raw`:  
  https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
- `users.messages.get` REST reference:  
  https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
- Gmail API usage limits and per-method quota units:  
  https://developers.google.com/workspace/gmail/api/reference/quota
- Gmail search operators including `after:`, `before:`, `older_than:`, `newer_than:`, `larger:`, `smaller:`, and `in:anywhere`:  
  https://support.google.com/mail/answer/7190
- Apps Script quotas and limitations:  
  https://developers.google.com/apps-script/guides/services/quotas
- Apps Script Advanced Google services and default-versus-standard Cloud projects:  
  https://developers.google.com/apps-script/guides/services/advanced
- Official Google Workspace Apps Script Advanced Gmail sample; its RAW example passes `message.raw` directly as byte data to `Utilities.base64Encode()`:  
  https://github.com/googleworkspace/apps-script-samples/blob/main/advanced/gmail.gs
- Apps Script Lock service:  
  https://developers.google.com/apps-script/reference/lock/lock-service
- Apps Script ClockTriggerBuilder:  
  https://developers.google.com/apps-script/reference/script/clock-trigger-builder
- Apps Script `ScriptApp` trigger management (`getProjectTriggers`, `deleteTrigger`, `newTrigger`):  
  https://developers.google.com/apps-script/reference/script/script-app
- Apps Script DriveApp:  
  https://developers.google.com/apps-script/reference/drive/drive-app
- Apps Script Folder:  
  https://developers.google.com/apps-script/reference/drive/folder
- Apps Script File:  
  https://developers.google.com/apps-script/reference/drive/file
- Apps Script Utilities:  
  https://developers.google.com/apps-script/reference/utilities/utilities

## Official S3-compatible storage documentation

- AWS S3 Signature Version 4 canonical request and authorization-header signing:
  https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
- AWS S3 conditional writes, including `If-None-Match`, `If-Match`, copy, and
  conditional multipart completion:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
- AWS S3 `ListObjectsV2`:
  https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
- AWS S3 `CopyObject`:
  https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
- AWS S3 `CompleteMultipartUpload`:
  https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html
- Cloudflare R2 S3 API compatibility matrix, account endpoint, conditional
  operations, and `auto` region:
  https://developers.cloudflare.com/r2/api/s3/api/
- Cloudflare R2 upload and multipart limits:
  https://developers.cloudflare.com/r2/objects/upload-objects/

## Community implementations reviewed

- `gablilli/googlescripts` Gmail `.eml` proof of concept:  
  https://github.com/gablilli/googlescripts/tree/main/gmail
- Tanaike’s `GmailToList` pagination/batch patterns:  
  https://github.com/tanaikech/GmailToList
- Apps Script `.eml` export discussion using raw message content:  
  https://stackoverflow.com/questions/56852267/how-i-can-download-my-email-per-gogglescript/56946271

## Design choices

- Official Gmail API rather than browser scraping/session-token replay.
- Message-level list/get rather than thread-only enumeration.
- Complete raw RFC message bytes rather than parsed body/spreadsheet output.
- Immutable Gmail IDs as canonical identity.
- Ordered journal/queue separated from ID-sharded canonical storage.
- Durable in-flight ranges and deterministic commits before state advancement.
- No Gmail labels or “processed” markers are added to the source mailbox.
