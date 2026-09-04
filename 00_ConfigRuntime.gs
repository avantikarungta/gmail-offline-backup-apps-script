/**
 * Gmail Offline Backup for Google Apps Script
 *
 * Read-only against Gmail; writes RFC 2822 messages as one-entry .eml.zip
 * files (while retaining legacy .eml compatibility) plus integrity metadata
 * in Google Drive. Designed for Google Workspace accounts where Takeout/IMAP
 * may be unavailable but Apps Script + Gmail API access is authorized.
 *
 * Public entry points:
 *   doctorBackup()      - fast prerequisite/health diagnostic
 *   estimateBackup()    - optional quick sampled count/volume/runtime estimate
 *   setupBackup()       - validate access and create the Drive layout
 *   planBackup()        - scan, audit, queue, and estimate the exact remaining delta
 *   applyBackup()       - export the current plan's missing messages
 *   backupStatus()      - log and return progress + ETA
 *   agentStatus()       - return machine-readable status without Drive writes
 *   pauseBackup()       - pause and remove the worker trigger
 *   resumeBackup()      - resume the prior phase
 *   verifyBackupSample()- hash-check a sample of exported files
 *   diagnoseDriveReadAccess()- explain Drive content-read failures
 *   benchmarkArchiveCompression()- measure ZIP savings without writing mail
 *   benchmarkDriveWritePaths()- compare DriveApp with parallel Drive API writes
 *   configureS3Credentials()- migrate staged Script Properties into a profile
 *   probeS3Storage()    - validate the selected S3/R2 binding with real writes
 *   s3StorageStatus()  - return redacted profile/probe status
 *
 * Prerequisite: enable the Advanced Gmail service (Gmail API v1).
 */

const BACKUP_CONFIG = Object.freeze({
  VERSION: '1.3.0-dev.16',

  // Archive storage. GOOGLE_DRIVE preserves the existing behavior. S3 uses
  // the S3-compatible API and works with AWS S3, Cloudflare R2, and compatible
  // endpoints after the configured profile passes probeS3Storage().
  STORAGE_BACKEND: 'GOOGLE_DRIVE',

  // Non-secret S3 profile configuration. Credentials are never stored in
  // source: configureS3Credentials() moves staging Script Properties into the
  // named profile and removes the staging values. For R2 use its account
  // endpoint and region "auto". PATH is the most portable addressing style;
  // VIRTUAL is also supported for endpoints with compatible TLS/DNS.
  S3_PROFILE: 'default',
  S3_BUCKET: '',
  S3_ENDPOINT: '',
  S3_REGION: '',
  S3_KEY_PREFIX: '',
  S3_ADDRESSING_STYLE: 'PATH',
  S3_LIST_PAGE_SIZE: 500,
  S3_MAX_PARALLEL_REQUESTS: 8,
  // Keep a wave below Apps Script's practical V8 heap ceiling. Each upload is
  // also referenced by the Gmail response, archive record, and UrlFetch call.
  S3_MAX_PARALLEL_BYTES: 8 * 1024 * 1024,
  // Amortize commit, catalog, and checkpoint writes across one bounded R2/S3
  // request wave. Upload payload memory remains capped independently above;
  // a failed multi-message checkpoint is replay-safely split to one message.
  S3_APPLY_BATCH_SIZE: 8,
  // Full replay hashing above this size can exceed the Apps Script V8 heap.
  // Such a message must carry a deterministic external full-hash attestation;
  // Apps Script still validates its object metadata before advancing state.
  S3_REPLAY_FULL_HASH_MAX_BYTES: 8 * 1024 * 1024,
  S3_MULTIPART_THRESHOLD_BYTES: 32 * 1024 * 1024,
  S3_MULTIPART_PART_BYTES: 8 * 1024 * 1024,
  S3_PROBE_MULTIPART: false,
  S3_CREDENTIAL_PROPERTY_PREFIX: 'GMAIL_BACKUP_S3_PROFILE_V1_',
  S3_STAGING_ACCESS_KEY_PROPERTY: 'GMAIL_BACKUP_S3_STAGING_ACCESS_KEY_ID',
  S3_STAGING_SECRET_KEY_PROPERTY: 'GMAIL_BACKUP_S3_STAGING_SECRET_ACCESS_KEY',
  S3_STAGING_SESSION_TOKEN_PROPERTY: 'GMAIL_BACKUP_S3_STAGING_SESSION_TOKEN',

  // Drive output. By default the folder is created in My Drive; the optional
  // target IDs below can select an editable shared folder instead.
  ROOT_FOLDER_NAME: 'Gmail Offline Backup',

  // Optional destination overrides for a fresh archive. TARGET_ROOT_FOLDER_ID
  // uses an existing folder as the archive root. TARGET_PARENT_FOLDER_ID
  // creates ROOT_FOLDER_NAME inside an existing folder. The folder may be
  // owned by another Google account as long as the executing identity can
  // edit it. A persisted state.rootFolderId always remains authoritative.
  TARGET_ROOT_FOLDER_ID: '',
  TARGET_PARENT_FOLDER_ID: '',

  // Empty query = entire mailbox. To export only Inbox, use 'in:inbox'.
  GMAIL_QUERY: '',
  INCLUDE_SPAM_TRASH: true,

  // Gmail API list() maximum is 500.
  SCAN_PAGE_SIZE: 500,

  // A second ID-only pass reduces the chance that mailbox movement during a
  // long scan causes an ID to be missed. A later plan will still catch deltas.
  SCAN_PASSES: 2,
  MAX_SCAN_PAGES_PER_EXECUTION: 20,

  // users.messages.list is documented as reverse chronological (newest first).
  // PLAN journals the final scan pass and turns it into an immutable queue.
  // Valid values: NEWEST_FIRST, OLDEST_FIRST, SHARDED_ID.
  APPLY_ORDER: 'NEWEST_FIRST',

  // Work-queue segments are intentionally smaller than scan journal chunks so
  // APPLY does not repeatedly parse very large JSON files across trigger runs.
  WORK_QUEUE_SEGMENT_SIZE: 500,
  QUEUE_ROWS_PER_TRANSACTION: 5000,
  QUEUE_COLLECTION_BUDGET_MS: 2 * 60 * 1000,

  // Maximum commit size. The actual batch is reduced dynamically when the
  // remaining execution budget is small or observed messages are slow.
  APPLY_BATCH_SIZE: 20,
  INITIAL_APPLY_BATCH_SIZE: 5,
  // A failed multi-message checkpoint is replayed one message at a time so a
  // single poison/oversized message can never dead-letter healthy neighbors.
  APPLY_REPLAY_BATCH_SIZE: 1,
  // Attempts are persisted before Gmail RAW retrieval. This catches hard V8
  // termination (including out-of-memory), which bypasses JavaScript catch.
  APPLY_MAX_MESSAGE_ATTEMPTS: 3,
  DEAD_LETTER_FILE: 'dead-letter-queue.json',
  DEFAULT_ESTIMATED_MS_PER_MESSAGE: 1500,
  CHECKPOINT_SAFETY_MS: 45 * 1000,

  // Parallel Drive API writes are materially faster for small messages and
  // catalog updates. Multipart upload is intentionally limited to 5 MiB per
  // file; larger messages retain the proven DriveApp path.
  DRIVE_WRITE_MODE: 'PARALLEL_API',
  DRIVE_API_MAX_PARALLEL_FILES: 8,
  DRIVE_API_MAX_PARALLEL_BYTES: 8 * 1024 * 1024,
  DRIVE_API_MAX_MULTIPART_FILE_BYTES: 5 * 1024 * 1024,

  // ZIP stores each raw RFC message as one <gmail-id>.eml entry inside
  // <gmail-id>.eml.zip. Existing plain EML files remain canonical and valid.
  // ZIP is compression, not a way around Workspace download restrictions.
  ARCHIVE_ENCODING: 'ZIP',
  ARCHIVE_COMPRESSION_BENCHMARK_MESSAGES: 5,

  // Apps Script is limited to 6 minutes/execution. Stop well before that so
  // checkpoint/status writes have time to finish.
  EXECUTION_BUDGET_MS: 4 * 60 * 1000,
  SCAN_COLLECTION_BUDGET_MS: 2 * 60 * 1000,

  // Recurring trigger is deliberate: it recovers if one execution crashes
  // before it can schedule a one-shot continuation. ScriptLock prevents overlap.
  WORKER_TRIGGER_MINUTES: 1,
  WORKER_FUNCTION: 'gmailBackupWorker',

  // Retry transient Gmail/Drive failures inside an execution.
  MAX_RETRIES: 5,
  INITIAL_RETRY_DELAY_MS: 750,

  // Idempotency/data layout: use the low bits of Gmail's hexadecimal ID.
  // 64 shards keeps scan checkpoint writes bounded while still distributing a
  // large mailbox across manageable Drive folders/catalog files. Do not change
  // this after setup; the value is persisted and enforced.
  SHARD_COUNT: 64,
  // Audit summaries/remaining sets are durable before their grouped state
  // checkpoint. A crash can therefore replay at most this many read-only
  // shard audits without losing or double-counting committed progress.
  AUDIT_SHARDS_PER_CHECKPOINT: 8,

  STATUS_UPDATE_INTERVAL_MS: 60 * 1000,
  STATUS_TEXT_FILE: 'STATUS.txt',
  STATUS_JSON_FILE: 'status.json',
  ARCHIVE_MANIFEST_FILE: 'archive-manifest.json',
  STATE_PROPERTY: 'GMAIL_BACKUP_STATE_V1',
  PAUSE_REQUEST_PROPERTY: 'GMAIL_BACKUP_PAUSE_REQUEST_V1',
  WRITER_INSTANCE_PROPERTY: 'GMAIL_BACKUP_WRITER_INSTANCE_V1',

  // When a partial retry finds an existing .eml or .eml.zip, hash the raw
  // message inside it against Gmail before treating it as complete. This is
  // expensive only on abnormal/retry paths.
  VERIFY_RECOVERED_FILES: true,
  VERIFY_REPLAYED_COMMITS: true,

  // Number of files checked by verifyBackupSample() when no argument is supplied.
  DEFAULT_VERIFY_SAMPLE_SIZE: 25,

  // Operational visibility and cheap preflight/estimation stages.
  LOG_PROGRESS_TO_CONSOLE: true,
  METRIC_SAMPLE_LIMIT: 256,
  DOCTOR_DRIVE_TEST_BYTES: 64 * 1024,
  ESTIMATE_METADATA_SAMPLES_PER_BUCKET: 2,
  ESTIMATE_METADATA_SAMPLES_PER_DATE_BUCKET: 1,
  ESTIMATE_RAW_SAMPLES: 4,
  ESTIMATE_COVERAGE_SAMPLE_IDS: 32,
  PLAN_ESTIMATE_SAMPLE_MESSAGES: 64,
  ESTIMATE_MAX_RAW_SAMPLE_BYTES: 10 * 1024 * 1024,
  ESTIMATE_DRIVE_TEST_SMALL_BYTES: 64 * 1024,
  ESTIMATE_DRIVE_TEST_LARGE_BYTES: 1024 * 1024,

  // Synthetic, disposable benchmark for evaluating parallel Drive API writes.
  DRIVE_API_BENCHMARK_FILES: 8,
  DRIVE_API_BENCHMARK_BYTES_PER_FILE: 128 * 1024,

  // Published Workspace quota assumptions used only for planning estimates.
  // Runtime enforcement remains Google's responsibility and may change.
  ESTIMATE_TRIGGER_RUNTIME_SECONDS_PER_DAY: 6 * 60 * 60,
  ESTIMATE_GMAIL_READS_PER_DAY: 50000,
});

const BACKUP_PHASE = Object.freeze({
  UNINITIALIZED: 'UNINITIALIZED',
  IDLE: 'IDLE',
  SCANNING: 'SCANNING',
  AUDITING: 'AUDITING',
  QUEUEING: 'QUEUEING',
  PLANNED: 'PLANNED',
  APPLYING: 'APPLYING',
  COMPLETE: 'COMPLETE',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR',
});

const BACKUP_APPLY_ORDER = Object.freeze({
  NEWEST_FIRST: 'NEWEST_FIRST',
  OLDEST_FIRST: 'OLDEST_FIRST',
  SHARDED_ID: 'SHARDED_ID',
});

// Mutually exclusive message-size bands used by estimateBackup(). Gmail's
// larger:/smaller: search operators accept byte counts. The final band's
// high scenario is deliberately not called an upper bound.
const BACKUP_ESTIMATE_SIZE_BUCKETS = Object.freeze([
  {name: '<10 KiB', minBytes: 0, maxBytesExclusive: 10 * 1024},
  {name: '10-50 KiB', minBytes: 10 * 1024, maxBytesExclusive: 50 * 1024},
  {name: '50-250 KiB', minBytes: 50 * 1024, maxBytesExclusive: 250 * 1024},
  {name: '250 KiB-1 MiB', minBytes: 250 * 1024, maxBytesExclusive: 1024 * 1024},
  {name: '1-5 MiB', minBytes: 1024 * 1024, maxBytesExclusive: 5 * 1024 * 1024},
  {name: '5-10 MiB', minBytes: 5 * 1024 * 1024, maxBytesExclusive: 10 * 1024 * 1024},
  {name: '10-25 MiB', minBytes: 10 * 1024 * 1024, maxBytesExclusive: 25 * 1024 * 1024},
  {name: '25-50 MiB', minBytes: 25 * 1024 * 1024, maxBytesExclusive: 50 * 1024 * 1024},
  {name: '>=50 MiB', minBytes: 50 * 1024 * 1024, maxBytesExclusive: null},
]);

// Date strata are calculated at estimate time so raw samples are not drawn
// only from Gmail's newest-first first page. Boundaries are approximate UTC
// calendar dates and are used only for planning, never for authoritative PLAN.
const BACKUP_ESTIMATE_DATE_BUCKETS = Object.freeze([
  {name: 'last 30 days', newerDays: 30, olderDays: null},
  {name: '30-180 days', newerDays: 180, olderDays: 30},
  {name: '6-12 months', newerDays: 365, olderDays: 180},
  {name: '1-3 years', newerDays: 3 * 365, olderDays: 365},
  {name: '3-7 years', newerDays: 7 * 365, olderDays: 3 * 365},
  {name: 'older than 7 years', newerDays: null, olderDays: 7 * 365},
]);

// Runtime service boundary. Apps Script does not support ES modules, so the
// library uses an explicit runtime object instead of hidden global coupling.
// Tests and alternative hosts can inject compatible ports; normal editor
// entry points use the native services below.
const GMAIL_BACKUP_RUNTIME_STACK = [];

function createBackupRuntime_(overrides) {
  const options = overrides || {};
  const configOverrides = Object.assign({}, options.config || {});
  if (options.targetRootFolderId !== undefined) {
    configOverrides.TARGET_ROOT_FOLDER_ID = String(options.targetRootFolderId || '');
  }
  if (options.targetParentFolderId !== undefined) {
    configOverrides.TARGET_PARENT_FOLDER_ID = String(options.targetParentFolderId || '');
  }
  const services = options.services || {};
  const continuationMode = String(options.continuationMode || 'MANUAL').toUpperCase();
  if (['MANUAL', 'AUTO_TRIGGER'].indexOf(continuationMode) === -1) {
    throw new Error('continuationMode must be MANUAL or AUTO_TRIGGER.');
  }
  if (continuationMode === 'AUTO_TRIGGER' && Object.keys(services).length > 0) {
    throw new Error(
      'AUTO_TRIGGER cannot preserve injected services across Apps Script executions. ' +
      'Use MANUAL and invoke GmailBackupLibrary.worker(runtime) until the phase is no longer active.'
    );
  }
  if (continuationMode === 'AUTO_TRIGGER') {
    const durableOverrideKeys = [
      'TARGET_ROOT_FOLDER_ID',
      'TARGET_PARENT_FOLDER_ID',
      'GMAIL_QUERY',
      'INCLUDE_SPAM_TRASH',
      'APPLY_ORDER',
      'SCAN_PASSES',
    ];
    const unsafeKeys = Object.keys(configOverrides).filter(function (key) {
      return durableOverrideKeys.indexOf(key) === -1 && configOverrides[key] !== BACKUP_CONFIG[key];
    });
    if (unsafeKeys.length) {
      throw new Error(
        'AUTO_TRIGGER cannot preserve these runtime-only configuration overrides: ' +
        unsafeKeys.sort().join(', ') + '. Use MANUAL continuation or edit BACKUP_CONFIG.'
      );
    }
  }
  return Object.freeze({
    config: Object.freeze(Object.assign({}, BACKUP_CONFIG, configOverrides)),
    continuationMode: continuationMode,
    hasServiceOverrides: Object.keys(services).length > 0,
    serviceOverrideNames: Object.freeze(Object.keys(services).sort()),
    services: Object.freeze({
      gmail: services.gmail || (typeof Gmail !== 'undefined' ? Gmail : null),
      drive: services.drive || (typeof DriveApp !== 'undefined' ? DriveApp : null),
      script: services.script || (typeof ScriptApp !== 'undefined' ? ScriptApp : null),
      properties: services.properties || (typeof PropertiesService !== 'undefined' ? PropertiesService : null),
      lock: services.lock || (typeof LockService !== 'undefined' ? LockService : null),
      urlFetch: services.urlFetch || (typeof UrlFetchApp !== 'undefined' ? UrlFetchApp : null),
      utilities: services.utilities || (typeof Utilities !== 'undefined' ? Utilities : null),
      logger: services.logger || (typeof console !== 'undefined' ? console : null),
    }),
  });
}

function withBackupRuntime_(runtime, fn) {
  if (!runtime) return fn();
  GMAIL_BACKUP_RUNTIME_STACK.push(runtime);
  try {
    return fn();
  } finally {
    GMAIL_BACKUP_RUNTIME_STACK.pop();
  }
}

function currentBackupRuntime_() {
  return GMAIL_BACKUP_RUNTIME_STACK.length
    ? GMAIL_BACKUP_RUNTIME_STACK[GMAIL_BACKUP_RUNTIME_STACK.length - 1]
    : null;
}

function backupConfig_() {
  const runtime = currentBackupRuntime_();
  return runtime ? runtime.config : BACKUP_CONFIG;
}

function runtimeService_(name, nativeService) {
  const runtime = currentBackupRuntime_();
  const service = runtime && runtime.services ? runtime.services[name] : nativeService;
  if (!service) throw new Error('Required runtime service is unavailable: ' + name);
  return service;
}

function hasRuntimeService_(name, nativeService) {
  const runtime = currentBackupRuntime_();
  return Boolean(runtime && runtime.services ? runtime.services[name] : nativeService);
}

function gmailService_() {
  return runtimeService_('gmail', typeof Gmail !== 'undefined' ? Gmail : null);
}

function driveService_() {
  const runtime = currentBackupRuntime_();
  if (runtime && runtime.serviceOverrideNames && runtime.serviceOverrideNames.indexOf('drive') !== -1) {
    return runtimeService_('drive', typeof DriveApp !== 'undefined' ? DriveApp : null);
  }
  if (isS3StorageBackend_()) return s3DriveService_();
  return runtimeService_('drive', typeof DriveApp !== 'undefined' ? DriveApp : null);
}

function scriptService_() {
  return runtimeService_('script', typeof ScriptApp !== 'undefined' ? ScriptApp : null);
}

function propertiesService_() {
  return runtimeService_('properties', typeof PropertiesService !== 'undefined' ? PropertiesService : null);
}

function lockService_() {
  return runtimeService_('lock', typeof LockService !== 'undefined' ? LockService : null);
}

function urlFetchService_() {
  return runtimeService_('urlFetch', typeof UrlFetchApp !== 'undefined' ? UrlFetchApp : null);
}

function utilitiesService_() {
  return runtimeService_('utilities', typeof Utilities !== 'undefined' ? Utilities : null);
}

function logger_() {
  return runtimeService_('logger', typeof console !== 'undefined' ? console : null);
}
