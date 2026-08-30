# Installation and Run Checklist

## Authorization and policy

- [ ] Confirm the account holder is permitted to retain the mail.
- [ ] Confirm Drive download/sync is allowed, not merely Drive write access.
- [ ] Use a dedicated browser profile signed into the target corporate account.

## Install

- [ ] Open `script.new`.
- [ ] Run `make setup SCRIPT_ID=YOUR_SCRIPT_ID` with the project's verified
      Script ID; review the bound project, authenticated account, and file list.
- [ ] Run `make push`, or create/paste every numbered `.gs` module.
- [ ] Show and replace `appsscript.json`.
- [ ] Confirm Gmail API v1 under Services.
- [ ] Set `GMAIL_QUERY: 'newer_than:7d'` for the first test.
- [ ] Set `APPLY_ORDER: 'NEWEST_FIRST'` unless a different order is intentional.
- [ ] If using a shared destination, set exactly one of `TARGET_ROOT_FOLDER_ID`
      or `TARGET_PARENT_FOLDER_ID`, confirm edit access, and use an empty target
      root from My Drive—not a Google Shared Drive—unless it already has this
      project's valid archive manifest.
- [ ] If using S3/R2, use a fresh project/state; configure only non-secret S3
      values in source, stage credentials in Script Properties, run
      `make s3-configure`, then require a successful `make s3-probe`.
- [ ] Save the project.

## Diagnose and estimate

- [ ] Run `make initialize` and approve scopes.
- [ ] Confirm the reported Gmail account is correct.
- [ ] Confirm `rawMessagePreflightBytes` is nonzero for a nonempty query.
- [ ] Run `make doctor` and review any failed checks/cautions.
- [ ] Optionally run `make estimate` for a quick preview; PLAN will create the
      more authoritative exact-delta estimate automatically.

## Controlled PLAN/APPLY

- [ ] Run `make plan-and-wait`.
- [ ] Monitor with `make status`, `make logs`, and Apps Script Executions.
- [ ] Wait for `PLANNED`.
- [ ] Review `plan.json`.
- [ ] Review `queue.json` and confirm apply order.
- [ ] Review `plan-estimate.json` for the exact remaining count, sampled
      raw/stored payload, APPLY duration, and quota-day floor.
- [ ] Run `make apply-and-wait`.
- [ ] Wait for `COMPLETE`.
- [ ] Run `make verify SAMPLE_SIZE=50`.
- [ ] Download/open representative `.eml` files offline.

## Full mailbox

- [ ] Set `GMAIL_QUERY: ''`.
- [ ] Decide whether `INCLUDE_SPAM_TRASH` should remain true.
- [ ] Optionally run `make estimate` for a quick preview.
- [ ] Run `make plan-and-wait` and confirm `PLANNED`.
- [ ] Review exact remaining count and anomalies.
- [ ] Run `make apply-and-wait` and confirm COMPLETE.
- [ ] Run `make verify`.
- [ ] Run a post-APPLY `make plan-and-wait`.
- [ ] Apply any post-run delta.

## Offline completion

- [ ] Download/sync the entire backup root.
- [ ] Verify sample hashes/files in the offline copy.
- [ ] Store the copy on encrypted media.
- [ ] Keep an approved independent second copy.
- [ ] Document retention and secure-deletion requirements.
