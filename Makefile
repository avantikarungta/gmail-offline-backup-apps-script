SHELL := /bin/sh
.DEFAULT_GOAL := help

CLASP ?= clasp
NODE ?= node
NPM ?= npm
CLASP_PROJECT ?= .clasp.json
CLASP_AUTH ?=
CLASP_USER ?=
SCRIPT_ID ?=
FORCE ?= 0
CONFIRM ?=
FUNCTION ?=
PARAMS ?=
PARAMS_FILE ?=
NONDEV ?= 0
SAMPLE_SIZE ?= 50
PHASE ?=
TIMEOUT_SECONDS ?= 21600
POLL_SECONDS ?= 60
DESCRIPTION ?=
VERSION_NUMBER ?=
DEPLOYMENT_ID ?=
API ?=
EXTERNAL_ENV ?= .env

RELEASE_VERSION := $(shell tr -d '\r\n' < VERSION)
PACKAGE ?= dist/gmail-offline-backup-$(RELEASE_VERSION).zip
CLASP_PROJECT_PATH := $(abspath $(CLASP_PROJECT))

CLASP_ACCOUNT_FLAGS = $(if $(strip $(CLASP_AUTH)),-A "$(CLASP_AUTH)",) $(if $(strip $(CLASP_USER)),-u "$(CLASP_USER)",)
CLASP_PROJECT_FLAGS = $(CLASP_ACCOUNT_FLAGS) -P "$(CLASP_PROJECT_PATH)"

.PHONY: help tools release-tools setup configure config-check auth-check remote-preflight \
	test metadata-validate skill-validate validate checksums checksums-verify package \
	package-verify release-check login login-project logout files pull pull-version \
	push push-force push-watch open-script open-logs logs logs-watch run status \
	status-human initialize doctor estimate plan apply pause resume worker verify \
	diagnose-drive benchmark-compression benchmark-drive wait plan-and-wait \
	s3-status s3-configure s3-probe s3-clear s3-open-settings \
	apply-and-wait versions version deployments deploy redeploy undeploy apis \
	enable-api disable-api open-api-console open-credentials mcp \
	external-config-check external-locate-blocked external-fetch-check external-select-download \
	external-local-check external-r2-probe external-export-one external-upload-local

help: ## Show every supported command and configurable variable.
	@awk 'BEGIN {FS = ":.*## "; printf "Gmail Offline Backup command surface\n\n"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-24s %s\n", $$1, $$2} END {printf "\nCommon variables: SCRIPT_ID, SAMPLE_SIZE, PHASE, TIMEOUT_SECONDS, POLL_SECONDS,\n  FUNCTION, PARAMS, PARAMS_FILE, CLASP_USER, CLASP_AUTH, VERSION_NUMBER,\n  DEPLOYMENT_ID, DESCRIPTION, API, CONFIRM, PACKAGE, EXTERNAL_ENV.\n"}' $(MAKEFILE_LIST)

tools: ## Check the local tools required for development and Apps Script operations.
	@command -v "$(NODE)" >/dev/null || { echo "Missing Node.js (>=18)." >&2; exit 1; }
	@command -v "$(NPM)" >/dev/null || { echo "Missing npm." >&2; exit 1; }
	@command -v "$(CLASP)" >/dev/null || { echo "Missing clasp CLI." >&2; exit 1; }
	@"$(NODE)" scripts/repo-ops.js tools

release-tools: ## Check optional ZIP tools used for release packaging.
	@command -v zip >/dev/null || { echo "Missing zip." >&2; exit 1; }
	@command -v unzip >/dev/null || { echo "Missing unzip." >&2; exit 1; }

setup: tools configure login-project ## Bind, authenticate, and validate a new installation; requires SCRIPT_ID=....
	@$(MAKE) --no-print-directory remote-preflight

configure: ## Create/update ignored .clasp.json; use SCRIPT_ID=... and FORCE=1 to replace a different binding.
	@SCRIPT_ID="$(SCRIPT_ID)" FORCE="$(FORCE)" CLASP_PROJECT="$(CLASP_PROJECT_PATH)" "$(NODE)" scripts/repo-ops.js configure

config-check: ## Validate the local clasp binding and exact module push order.
	@CLASP_PROJECT="$(CLASP_PROJECT_PATH)" "$(NODE)" scripts/repo-ops.js config-check

auth-check: ## Show the clasp authorization currently selected by CLASP_USER/CLASP_AUTH.
	@"$(CLASP)" $(CLASP_ACCOUNT_FLAGS) show-authorized-user

remote-preflight: tools config-check auth-check files ## Check tools, binding, auth, and files before remote work.

test: ## Run the dependency-free mocked regression suite.
	@"$(NPM)" test

metadata-validate: ## Validate JSON, versions, module order, and release-file invariants.
	@"$(NODE)" scripts/repo-ops.js validate

skill-validate: ## Validate the repo-local agent skill and its routed references.
	@"$(NODE)" scripts/repo-ops.js validate-skill

validate: test metadata-validate skill-validate ## Run all local checks that do not require Google access.

checksums: ## Regenerate SHA256SUMS.txt for the complete release file set.
	@"$(NODE)" scripts/repo-ops.js checksums-write

checksums-verify: ## Verify SHA256SUMS.txt and reject missing/unlisted release files.
	@"$(NODE)" scripts/repo-ops.js checksums-verify

package: validate checksums-verify release-tools ## Build a deterministic source ZIP at PACKAGE=....
	@PACKAGE="$(PACKAGE)" "$(NODE)" scripts/repo-ops.js package

package-verify: release-tools ## Extract PACKAGE, verify checksums, and rerun all tests in isolation.
	@PACKAGE="$(PACKAGE)" "$(NODE)" scripts/repo-ops.js package-verify

release-check: package ## Run full local validation and verify the packaged artifact.
	@$(MAKE) --no-print-directory package-verify PACKAGE="$(PACKAGE)"

login: tools ## Authenticate clasp with its normal scopes.
	@"$(CLASP)" $(CLASP_ACCOUNT_FLAGS) login

login-project: tools config-check ## Authenticate clasp with manifest scopes needed by `clasp run`.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) login --use-project-scopes --include-clasp-scopes

logout: ## Remove the selected clasp authorization.
	@"$(CLASP)" $(CLASP_ACCOUNT_FLAGS) logout

files: config-check ## Show exactly which files clasp will and will not push.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) status

pull: config-check ## Pull remote source without deleting repo-only files.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) pull

pull-version: config-check ## Pull VERSION_NUMBER without deleting repo-only files.
	@test -n "$(VERSION_NUMBER)" || { echo "Usage: make pull-version VERSION_NUMBER=123" >&2; exit 2; }
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) pull --versionNumber "$(VERSION_NUMBER)"

push: validate config-check ## Push validated Apps Script source and manifest.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) push

push-force: validate config-check ## Force-push only with CONFIRM=push-force.
	@test "$(CONFIRM)" = "push-force" || { echo "Refusing. Re-run with CONFIRM=push-force after reviewing make files." >&2; exit 2; }
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) push --force

push-watch: config-check ## Watch local Apps Script files and push changes until interrupted.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) push --watch

open-script: config-check ## Open the bound Apps Script editor.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) open-script

open-logs: config-check ## Open Cloud Logging for the bound project.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) open-logs

logs: config-check ## Print recent Apps Script logs.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) logs

logs-watch: config-check ## Stream Apps Script logs until interrupted.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) logs --watch

run: config-check ## Run FUNCTION with optional PARAMS='[...]', PARAMS_FILE=..., and NONDEV=1.
	@test -n "$(FUNCTION)" || { echo "Usage: make run FUNCTION=agentStatus [PARAMS='[...]']" >&2; exit 2; }
	@CLASP_BIN="$(CLASP)" CLASP_PROJECT="$(CLASP_PROJECT_PATH)" CLASP_AUTH="$(CLASP_AUTH)" CLASP_USER="$(CLASP_USER)" FUNCTION="$(FUNCTION)" PARAMS='$(PARAMS)' PARAMS_FILE="$(PARAMS_FILE)" NONDEV="$(NONDEV)" "$(NODE)" scripts/clasp-ops.js run

status: ## Return machine-readable status without writing Drive status files.
	@$(MAKE) --no-print-directory run FUNCTION=agentStatus

status-human: ## Log/return the human status and refresh Drive status files.
	@$(MAKE) --no-print-directory run FUNCTION=backupStatus

initialize: ## Validate Gmail and create/adopt the configured archive layout.
	@$(MAKE) --no-print-directory run FUNCTION=setupBackup

doctor: ## Run the bounded prerequisite and read/write/delete diagnostic.
	@$(MAKE) --no-print-directory run FUNCTION=doctorBackup

estimate: ## Run the sampled mailbox volume/runtime estimate.
	@$(MAKE) --no-print-directory run FUNCTION=estimateBackup

plan: ## Start exact PLAN, queue, and automatic exact-delta estimate generation.
	@$(MAKE) --no-print-directory run FUNCTION=planBackup

apply: ## Start APPLY for the current completed plan.
	@$(MAKE) --no-print-directory run FUNCTION=applyBackup

pause: ## Request a checkpoint-safe pause and remove the worker trigger.
	@$(MAKE) --no-print-directory run FUNCTION=pauseBackup

resume: ## Resume the preserved phase and reinstall its worker trigger.
	@$(MAKE) --no-print-directory run FUNCTION=resumeBackup

worker: ## Run one worker slice manually.
	@$(MAKE) --no-print-directory run FUNCTION=gmailBackupWorker

verify: ## Verify a random archive sample; override SAMPLE_SIZE=50.
	@$(MAKE) --no-print-directory run FUNCTION=verifyBackupSample PARAMS='[$(SAMPLE_SIZE)]'

diagnose-drive: ## Diagnose Drive download/read restrictions without acknowledging content.
	@$(MAKE) --no-print-directory run FUNCTION=diagnoseDriveReadAccess

benchmark-compression: ## Benchmark ZIP savings without writing mail.
	@$(MAKE) --no-print-directory run FUNCTION=benchmarkArchiveCompression

benchmark-drive: ## Compare DriveApp and parallel Drive API write paths.
	@$(MAKE) --no-print-directory run FUNCTION=benchmarkDriveWritePaths

s3-status: ## Show redacted S3/R2 binding, credential presence, and last probe.
	@$(MAKE) --no-print-directory run FUNCTION=s3StorageStatus

s3-configure: ## Move staged Script Properties into the selected S3 profile (no secrets in CLI args).
	@$(MAKE) --no-print-directory run FUNCTION=configureS3Credentials

s3-probe: ## Run real conditional/read/list/copy/delete checks against the selected S3/R2 bucket.
	@$(MAKE) --no-print-directory run FUNCTION=probeS3Storage

s3-clear: ## Clear selected S3 profile only with CONFIRM=clear-PROFILE.
	@test -n "$(CONFIRM)" || { echo "Usage: make s3-clear CONFIRM=clear-PROFILE" >&2; exit 2; }
	@$(MAKE) --no-print-directory run FUNCTION=clearS3Credentials PARAMS='["$(CONFIRM)"]'

s3-open-settings: config-check ## Open Apps Script so S3 credentials can be staged in Project Settings.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) open-script

wait: config-check ## Poll agentStatus until PHASE (comma-separated allowed) or timeout.
	@test -n "$(PHASE)" || { echo "Usage: make wait PHASE=PLANNED [TIMEOUT_SECONDS=21600 POLL_SECONDS=60]" >&2; exit 2; }
	@CLASP_BIN="$(CLASP)" CLASP_PROJECT="$(CLASP_PROJECT_PATH)" CLASP_AUTH="$(CLASP_AUTH)" CLASP_USER="$(CLASP_USER)" PHASE="$(PHASE)" TIMEOUT_SECONDS="$(TIMEOUT_SECONDS)" POLL_SECONDS="$(POLL_SECONDS)" "$(NODE)" scripts/clasp-ops.js wait

plan-and-wait: plan ## Start PLAN and wait for its queue and exact-delta estimate.
	@$(MAKE) --no-print-directory wait PHASE=PLANNED TIMEOUT_SECONDS="$(TIMEOUT_SECONDS)" POLL_SECONDS="$(POLL_SECONDS)"

apply-and-wait: apply ## Start APPLY and wait for COMPLETE.
	@$(MAKE) --no-print-directory wait PHASE=COMPLETE TIMEOUT_SECONDS="$(TIMEOUT_SECONDS)" POLL_SECONDS="$(POLL_SECONDS)"

versions: config-check ## List immutable Apps Script versions.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) versions

version: validate config-check ## Create an immutable version; optional DESCRIPTION=....
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) version "$(DESCRIPTION)"

deployments: config-check ## List deployments for the bound Apps Script project.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) deployments

deploy: config-check ## Create a deployment; optional VERSION_NUMBER=... DESCRIPTION=....
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) deploy $(if $(strip $(VERSION_NUMBER)),--versionNumber "$(VERSION_NUMBER)",) $(if $(strip $(DESCRIPTION)),--description "$(DESCRIPTION)",)

redeploy: config-check ## Update DEPLOYMENT_ID; optional VERSION_NUMBER and DESCRIPTION.
	@test -n "$(DEPLOYMENT_ID)" || { echo "Usage: make redeploy DEPLOYMENT_ID=... [VERSION_NUMBER=...]" >&2; exit 2; }
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) redeploy "$(DEPLOYMENT_ID)" $(if $(strip $(VERSION_NUMBER)),--versionNumber "$(VERSION_NUMBER)",) $(if $(strip $(DESCRIPTION)),--description "$(DESCRIPTION)",)

undeploy: config-check ## Delete exact DEPLOYMENT_ID only with matching CONFIRM value.
	@test -n "$(DEPLOYMENT_ID)" || { echo "Usage: make undeploy DEPLOYMENT_ID=... CONFIRM=..." >&2; exit 2; }
	@test "$(CONFIRM)" = "$(DEPLOYMENT_ID)" || { echo "Refusing. Set CONFIRM to the exact deployment ID." >&2; exit 2; }
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) undeploy "$(DEPLOYMENT_ID)"

apis: config-check ## List APIs enabled for the Apps Script Cloud project.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) apis

enable-api: config-check ## Enable API=... for the bound project.
	@test -n "$(API)" || { echo "Usage: make enable-api API=gmail" >&2; exit 2; }
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) enable-api "$(API)"

disable-api: config-check ## Disable API=... only with CONFIRM=disable-API.
	@test -n "$(API)" || { echo "Usage: make disable-api API=... CONFIRM=disable-..." >&2; exit 2; }
	@test "$(CONFIRM)" = "disable-$(API)" || { echo "Refusing. Set CONFIRM=disable-$(API)." >&2; exit 2; }
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) disable-api "$(API)"

open-api-console: config-check ## Open the API console for the bound project.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) open-api-console

open-credentials: config-check ## Open credential setup for the bound project's Cloud project.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) open-credentials-setup

mcp: config-check ## Start clasp's Apps Script MCP server until interrupted.
	@"$(CLASP)" $(CLASP_PROJECT_FLAGS) mcp

external-config-check: ## Validate ignored EXTERNAL_ENV without printing secret values.
	@EXTERNAL_ENV="$(EXTERNAL_ENV)" "$(NODE)" scripts/external-r2.js config-check

external-locate-blocked: ## Read the Drive checkpoint and select the blocked Gmail message in ignored EXTERNAL_ENV.
	@EXTERNAL_ENV="$(EXTERNAL_ENV)" "$(NODE)" scripts/external-r2.js locate-blocked

external-fetch-check: ## Fetch selected Gmail RAW outside Apps Script and print only integrity metadata.
	@EXTERNAL_ENV="$(EXTERNAL_ENV)" "$(NODE)" scripts/external-r2.js fetch-check

external-select-download: ## Select exactly one recent browser-downloaded EML in ignored EXTERNAL_ENV.
	@EXTERNAL_ENV="$(EXTERNAL_ENV)" "$(NODE)" scripts/external-r2.js select-download

external-local-check: ## Validate and hash the selected local EML without printing its path or content.
	@EXTERNAL_ENV="$(EXTERNAL_ENV)" "$(NODE)" scripts/external-r2.js local-check

external-r2-probe: ## Write/read/delete an isolated R2 probe; requires CONFIRM=external-r2-probe.
	@test "$(CONFIRM)" = "external-r2-probe" || { echo "Refusing. Re-run with CONFIRM=external-r2-probe." >&2; exit 2; }
	@EXTERNAL_ENV="$(EXTERNAL_ENV)" CONFIRM="$(CONFIRM)" "$(NODE)" scripts/external-r2.js probe-r2

external-export-one: ## Fetch selected Gmail RAW outside Apps Script and conditionally write one R2 .eml; requires confirmation.
	@test "$(CONFIRM)" = "external-export-one" || { echo "Refusing. Re-run with CONFIRM=external-export-one." >&2; exit 2; }
	@EXTERNAL_ENV="$(EXTERNAL_ENV)" CONFIRM="$(CONFIRM)" "$(NODE)" scripts/external-r2.js export-one

external-upload-local: ## Conditionally write the selected local EML to R2; requires CONFIRM=external-upload-local.
	@test "$(CONFIRM)" = "external-upload-local" || { echo "Refusing. Re-run with CONFIRM=external-upload-local." >&2; exit 2; }
	@EXTERNAL_ENV="$(EXTERNAL_ENV)" CONFIRM="$(CONFIRM)" "$(NODE)" scripts/external-r2.js upload-local
