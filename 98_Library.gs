/**
 * Public library facade over the internal application modules.
 */
function runBackupLibraryAction_(runtime, action, args) {
  return withBackupRuntime_(runtime, function () {
    return action.apply(null, args || []);
  });
}

var GmailBackupLibrary = Object.freeze({
  version: function () { return backupConfig_().VERSION; },
  createRuntime: createBackupRuntime_,
  forTargetRoot: function (folderId, options) {
    return createBackupRuntime_(Object.assign({}, options || {}, {targetRootFolderId: folderId}));
  },
  forTargetParent: function (folderId, options) {
    return createBackupRuntime_(Object.assign({}, options || {}, {targetParentFolderId: folderId}));
  },
  withRuntime: withBackupRuntime_,
  doctor: function (runtime) {
    return runBackupLibraryAction_(runtime, doctorBackupAction_);
  },
  estimate: function (runtime) {
    return runBackupLibraryAction_(runtime, estimateBackupAction_);
  },
  setup: function (runtime) {
    return runBackupLibraryAction_(runtime, setupBackupAction_);
  },
  plan: function (runtime) {
    return runBackupLibraryAction_(runtime, planBackupAction_);
  },
  apply: function (runtime) {
    return runBackupLibraryAction_(runtime, applyBackupAction_);
  },
  status: function (runtime) {
    return runBackupLibraryAction_(runtime, backupStatusAction_);
  },
  agentStatus: function (runtime) {
    return runBackupLibraryAction_(runtime, agentStatusAction_);
  },
  pause: function (runtime) {
    return runBackupLibraryAction_(runtime, pauseBackupAction_);
  },
  resume: function (runtime) {
    return runBackupLibraryAction_(runtime, resumeBackupAction_);
  },
  verifySample: function (sampleSize, runtime) {
    return runBackupLibraryAction_(runtime, verifyBackupSampleAction_, [sampleSize]);
  },
  diagnoseDriveReadAccess: function (runtime) {
    return runBackupLibraryAction_(runtime, diagnoseDriveReadAccessAction_);
  },
  worker: function (runtime) {
    return runBackupLibraryAction_(runtime, gmailBackupWorkerAction_);
  },
  benchmarkArchiveCompression: function (runtime) {
    return runBackupLibraryAction_(runtime, benchmarkArchiveCompressionAction_);
  },
  benchmarkDriveWritePaths: function (runtime) {
    return runBackupLibraryAction_(runtime, benchmarkDriveWritePathsAction_);
  },
  configureS3Credentials: function (runtime) {
    return runBackupLibraryAction_(runtime, configureS3CredentialsAction_);
  },
  clearS3Credentials: function (confirmation, runtime) {
    return runBackupLibraryAction_(runtime, clearS3CredentialsAction_, [confirmation]);
  },
  probeS3Storage: function (runtime) {
    return runBackupLibraryAction_(runtime, probeS3StorageAction_);
  },
  s3StorageStatus: function (runtime) {
    return runBackupLibraryAction_(runtime, s3StorageStatusAction_);
  },
  archive: Object.freeze({
    buildPayload: buildArchivePayload_,
    inspectBlob: inspectArchiveBlob_,
    readFileIntegrity: readArchiveFileIntegrity_,
  }),
  storage: Object.freeze({
    ensureLayout: ensureRootLayout_,
    listCanonical: listCanonicalArchiveFiles_,
  }),
  state: Object.freeze({
    load: loadState_,
    status: statusObject_,
  }),
});
