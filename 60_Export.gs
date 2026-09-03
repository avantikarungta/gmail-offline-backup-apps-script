// -----------------------------------------------------------------------------
// Apply / export implementation
// -----------------------------------------------------------------------------

function processApplySlice_(state, executionStartedMs) {
  if (!state.plan.workQueueFolderId || !state.queue || !state.queue.completedAt) {
    throw new Error(
      'This plan predates the ordered work-queue format. Run planBackup() again with v1.2.1 before APPLY.'
    );
  }

  const segmentCount = Number(state.queue.segmentIndex || 0);
  if (Number(state.apply.total || 0) === 0 && Number(state.apply.processed || 0) === 0) {
    state.apply.segmentIndex = segmentCount;
    state.lastSliceMetrics = {};
    finalizeApply_(state);
    return;
  }

  const metrics = newOperationMetrics_();
  const queueFolder = measureOperation_(metrics, 'driveQueueFolder', function () {
    return driveService_().getFolderById(state.plan.workQueueFolderId);
  });
  const commitsRoot = measureOperation_(metrics, 'driveCommitsFolder', function () {
    return driveService_().getFolderById(state.plan.commitsFolderId);
  });
  const queueFiles = measureOperation_(metrics, 'driveQueueList', function () {
    return listFilesByName_(queueFolder);
  });
  const layout = measureOperation_(metrics, 'driveRootLayout', function () {
    return ensureRootLayout_(state.rootFolderId, archiveRootContext_(state));
  });
  const dataFoldersByName = measureOperation_(metrics, 'driveDataFolderList', function () {
    return listFoldersByName_(layout.data);
  });
  const context = {
    canonicalByShard: {},
    catalogByShard: {},
    dataFoldersByName: dataFoldersByName,
    metrics: metrics,
  };
  let lastStatusWriteMs = executionStartedMs;

  while (state.apply.segmentIndex < segmentCount &&
         Date.now() - executionStartedMs < backupConfig_().EXECUTION_BUDGET_MS) {
    const segmentIndex = Number(state.apply.segmentIndex || 0);
    const segmentName = queueSegmentFileName_(segmentIndex);
    const segmentFile = queueFiles[segmentName] || null;
    if (!segmentFile) throw new Error('Missing immutable work-queue segment: ' + segmentName);
    const segment = readJsonFile_(segmentFile, null);
    if (!segment || segment.planId !== state.plan.id ||
        Number(segment.segmentIndex) !== segmentIndex || !Array.isArray(segment.entries)) {
      throw new Error('Invalid immutable work-queue segment: ' + segmentName);
    }
    const entries = segment.entries;

    if (state.apply.offset >= entries.length) {
      if (state.apply.inFlight) {
        throw new Error('Apply checkpoint has an in-flight batch after queue-segment completion: ' +
          JSON.stringify(state.apply.inFlight));
      }
      state.apply.segmentIndex += 1;
      state.apply.offset = 0;
      state.updatedAt = isoNow_();
      measureOperation_(metrics, 'checkpointPersist', function () { saveState_(state); });
      continue;
    }

    const start = state.apply.offset;
    let endExclusive;
    const replayingInFlight = Boolean(state.apply.inFlight);
    if (replayingInFlight) {
      validateInFlight_(state.apply.inFlight, state.plan.id, segmentIndex, start, entries.length);
      endExclusive = Number(state.apply.inFlight.endExclusive);
    } else {
      const batchSize = chooseApplyBatchSize_(state, executionStartedMs, entries.length - start);
      if (batchSize <= 0) break;
      endExclusive = Math.min(entries.length, start + batchSize);
      state.apply.inFlight = {
        schemaVersion: 2,
        planId: state.plan.id,
        segmentIndex: segmentIndex,
        start: start,
        endExclusive: endExclusive,
        createdAt: isoNow_(),
      };
      state.updatedAt = isoNow_();
      measureOperation_(metrics, 'checkpointPersist', function () { saveState_(state); });
    }

    let batchEntries = entries.slice(start, endExclusive);
    const segmentCommitsFolder = getOrCreateChildFolder_(commitsRoot, 'segment-' + padNumber_(segmentIndex, 8));
    let commitName = commitFileName_(start, endExclusive);
    let loadedCommit = loadValidApplyCommit_(
      segmentCommitsFolder, commitName, state, layout, segmentIndex, start, endExclusive, batchEntries
    );
    let commitFile = loadedCommit.file;
    let commit = loadedCommit.commit;

    // If a prior execution died after persisting a large checkpoint but before
    // publishing its commit, reduce that exact frozen range before replay. Any
    // objects written before the crash remain safe: canonical resolution will
    // recover them, and subsequent sub-batches will publish their own commits.
    const replayEndExclusive = applyReplayBatchEnd_(start, endExclusive);
    if (!commitFile && replayingInFlight && replayEndExclusive < endExclusive) {
      const originalEndExclusive = endExclusive;
      endExclusive = replayEndExclusive;
      state.apply.inFlight.endExclusive = endExclusive;
      state.apply.inFlight.replaySplitFromEndExclusive = originalEndExclusive;
      state.apply.inFlight.replaySplitAt = isoNow_();
      state.updatedAt = isoNow_();
      measureOperation_(metrics, 'checkpointPersist', function () { saveState_(state); });
      logProgressEvent_('APPLY_REPLAY_BATCH_SPLIT', state, {
        segmentIndex: segmentIndex,
        start: start,
        originalEndExclusive: originalEndExclusive,
        endExclusive: endExclusive,
      });
      batchEntries = entries.slice(start, endExclusive);
      commitName = commitFileName_(start, endExclusive);
      loadedCommit = loadValidApplyCommit_(
        segmentCommitsFolder, commitName, state, layout, segmentIndex, start, endExclusive, batchEntries
      );
      commitFile = loadedCommit.file;
      commit = loadedCommit.commit;
    }

    if (!commitFile) {
      if (Date.now() - executionStartedMs >=
          backupConfig_().EXECUTION_BUDGET_MS - backupConfig_().CHECKPOINT_SAFETY_MS) {
        break;
      }
      const batchStartedMs = Date.now();
      commit = exportQueueBatch_(
        state,
        layout,
        segmentIndex,
        start,
        endExclusive,
        batchEntries,
        context
      );
      commit.durationMs = Date.now() - batchStartedMs;
      commit.finishedAt = isoNow_();
      commitFile = measureOperation_(metrics, 'driveCommitWrite', function () {
        return segmentCommitsFolder.createFile(commitName, JSON.stringify(commit), 'text/plain');
      });
    }

    measureOperation_(metrics, 'driveCatalogMerge', function () {
      mergeCommitIntoCatalogByShard_(layout.catalog, commit, context);
    });
    advanceApplyStateFromCommit_(state, commit);
    state.apply.offset = endExclusive;
    state.apply.inFlight = null;
    state.updatedAt = isoNow_();
    measureOperation_(metrics, 'checkpointPersist', function () { saveState_(state); });
    if (Date.now() - lastStatusWriteMs >= backupConfig_().STATUS_UPDATE_INTERVAL_MS) {
      safeUpdateStatusFiles_(state);
      lastStatusWriteMs = Date.now();
    }

    if (isPauseRequested_()) break;
    if (Date.now() - executionStartedMs >= backupConfig_().EXECUTION_BUDGET_MS) break;
  }

  state.lastSliceMetrics = summarizeOperationMetrics_(metrics);
  if (state.apply.segmentIndex >= segmentCount) {
    finalizeApply_(state);
  }
}

function loadValidApplyCommit_(
  segmentCommitsFolder,
  commitName,
  state,
  layout,
  segmentIndex,
  start,
  endExclusive,
  batchEntries
) {
  let commitFile = firstFileByName_(segmentCommitsFolder, commitName);
  if (!commitFile) return {file: null, commit: null};

  try {
    const commit = readJsonFile_(commitFile, null);
    validateCommit_(commit, state.plan.id, segmentIndex, start, endExclusive, batchEntries);
    if (backupConfig_().VERIFY_REPLAYED_COMMITS) {
      const validation = validateCommittedFiles_(commit, layout);
      if (!validation.ok) {
        logger_().warn('Discarding an invalid replay checkpoint ' + commitName + ': ' +
          JSON.stringify(validation.failures));
        quarantineCheckpointFile_(
          layout.root,
          commitFile,
          state.plan.id,
          'segment-' + padNumber_(segmentIndex, 8),
          commitName
        );
        return {file: null, commit: null};
      }
    }
    return {file: commitFile, commit: commit};
  } catch (error) {
    logger_().warn('Discarding an unreadable replay checkpoint ' + commitName + ': ' + errorToString_(error));
    quarantineCheckpointFile_(
      layout.root,
      commitFile,
      state.plan.id,
      'segment-' + padNumber_(segmentIndex, 8),
      commitName
    );
    return {file: null, commit: null};
  }
}

function exportQueueBatch_(state, layout, segmentIndex, start, endExclusive, entries, context) {
  const records = [];
  const pendingUploads = [];
  let pendingUploadBytes = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const id = entry.id;
    const archiveShard = shardForId_(id);
    const canonicalContext = getCanonicalShardContext_(layout, archiveShard, context);
    const dataFolder = canonicalContext.folder;
    const canonical = canonicalContext.canonical;
    let message;

    try {
      message = measureOperation_(context.metrics, 'gmailGetRaw', function () {
        return gmailCall_(function () {
          return gmailService_().Users.Messages.get('me', id, {
            format: 'raw',
            fields: 'id,threadId,labelIds,historyId,internalDate,sizeEstimate,raw',
          });
        }, 'Gmail.Users.Messages.get(' + id + ')');
      });
    } catch (error) {
      if (isNotFoundError_(error)) {
        records.push({
          id: id,
          threadId: entry.threadId || '',
          archiveShard: archiveShard,
          status: 'gone',
          reason: 'Message no longer exists or is no longer accessible at apply time.',
          recordedAt: isoNow_(),
        });
        continue;
      }
      throw error;
    }

    if (!message || !message.raw) {
      throw new Error('Gmail API returned no raw content for message ' + id);
    }

    const bytes = measureOperation_(context.metrics, 'rawConversion', function () {
      return gmailRawBytes_(message.raw);
    });
    // The remaining commit metadata does not need Gmail's raw field. Drop that
    // reference before buffering uploads so the V8 heap retains only the
    // canonical byte array, not both the API response and archive payload.
    message.raw = null;
    recordOperationBytes_(context.metrics, 'gmailGetRaw', bytes.length);
    const sha256 = measureOperation_(context.metrics, 'sha256', function () {
      return sha256Hex_(bytes);
    }, bytes.length);
    const archive = measureOperation_(context.metrics, 'archiveEncode', function () {
      return buildArchivePayload_(id, bytes, sha256);
    }, bytes.length);
    const resolution = measureOperation_(context.metrics, 'driveCanonicalResolve', function () {
      return resolveCanonicalForExport_(canonical, id, archive, layout.root);
    });
    let file = resolution.file;

    if (!file && shouldUseParallelDriveUpload_(archive.storedByteLength)) {
      if (pendingUploads.length > 0 &&
          (pendingUploads.length >= parallelArchiveUploadFileLimit_() ||
           pendingUploadBytes + archive.storedByteLength > parallelArchiveUploadByteLimit_())) {
        flushParallelDriveUploads_(pendingUploads, records, context);
        pendingUploadBytes = 0;
      }
      const recordIndex = records.length;
      records.push(null);
      pendingUploads.push({
        recordIndex: recordIndex,
        id: id,
        entry: entry,
        message: message,
        archiveShard: archiveShard,
        queueSegment: segmentIndex,
        archive: archive,
        folderId: dataFolder.getId(),
        resolution: resolution,
      });
      pendingUploadBytes += archive.storedByteLength;
      if (pendingUploads.length >= parallelArchiveUploadFileLimit_() ||
          pendingUploadBytes >= parallelArchiveUploadByteLimit_()) {
        flushParallelDriveUploads_(pendingUploads, records, context);
        pendingUploadBytes = 0;
      }
      continue;
    }

    if (!file) {
      const blob = utilitiesService_().newBlob(archive.storedBytes, archive.mimeType, archive.fileName);
      file = measureOperation_(context.metrics, 'driveArchiveCreate', function () {
        return createArchiveFileWithIntegrity_(dataFolder, blob, archive);
      }, archive.storedByteLength);
      canonical.byId[id] = file;
      canonical.allById[id] = [file];
    }

    records.push(buildExportedRecord_({
      id: id,
      entry: entry,
      message: message,
      archiveShard: archiveShard,
      queueSegment: segmentIndex,
      archive: resolution.storage || archive,
      driveFileId: file.getId(),
      resolution: resolution,
    }));
  }

  flushParallelDriveUploads_(pendingUploads, records, context);
  if (records.some(function (record) { return !record; })) {
    throw new Error('Parallel Drive upload left an unresolved commit record.');
  }

  const exportedRecords = records.filter(function (record) { return record.status === 'exported'; });
  const goneRecords = records.filter(function (record) { return record.status === 'gone'; });
  return {
    schemaVersion: 2,
    planId: state.plan.id,
    queueSegment: segmentIndex,
    start: start,
    endExclusive: endExclusive,
    createdAt: isoNow_(),
    durationMs: 0,
    summary: {
      processed: records.length,
      exported: exportedRecords.length,
      gone: goneRecords.length,
      rawBytes: exportedRecords.reduce(function (sum, record) {
        return sum + Number(record.rawBytes || 0);
      }, 0),
      storedBytes: exportedRecords.reduce(function (sum, record) {
        return sum + Number(record.storedBytes || record.rawBytes || 0);
      }, 0),
    },
    records: records,
  };
}

function parallelDriveApiEnabled_() {
  return !isS3StorageBackend_() &&
    backupConfig_().DRIVE_WRITE_MODE === 'PARALLEL_API' &&
    hasRuntimeService_('urlFetch', typeof UrlFetchApp !== 'undefined' ? UrlFetchApp : null) &&
    hasRuntimeService_('script', typeof ScriptApp !== 'undefined' ? ScriptApp : null) &&
    typeof scriptService_().getOAuthToken === 'function';
}

function shouldUseParallelDriveUpload_(byteLength) {
  if (isS3StorageBackend_()) {
    return hasRuntimeService_('urlFetch', typeof UrlFetchApp !== 'undefined' ? UrlFetchApp : null) &&
      Number(byteLength || 0) <= parallelArchiveUploadByteLimit_();
  }
  return parallelDriveApiEnabled_() &&
    Number(byteLength || 0) <= Number(backupConfig_().DRIVE_API_MAX_MULTIPART_FILE_BYTES);
}

function parallelArchiveUploadFileLimit_() {
  return Number(isS3StorageBackend_()
    ? backupConfig_().S3_MAX_PARALLEL_REQUESTS
    : backupConfig_().DRIVE_API_MAX_PARALLEL_FILES);
}

function parallelArchiveUploadByteLimit_() {
  return Number(isS3StorageBackend_()
    ? backupConfig_().S3_MAX_PARALLEL_BYTES
    : backupConfig_().DRIVE_API_MAX_PARALLEL_BYTES);
}

function flushParallelDriveUploads_(pendingUploads, records, context) {
  if (!(pendingUploads || []).length) return;
  const uploads = pendingUploads.slice();
  pendingUploads.length = 0;
  const totalBytes = uploads.reduce(function (sum, upload) {
    return sum + upload.archive.storedByteLength;
  }, 0);
  const specs = uploads.map(function (upload) {
    return {
      name: upload.archive.fileName,
      mimeType: upload.archive.mimeType,
      parentId: upload.folderId,
      bytes: upload.archive.storedBytes,
      payloadSha256: upload.archive.storedSha256,
      appProperties: archiveIntegrityProperties_(upload.archive),
    };
  });
  const created = measureOperation_(context.metrics, 'driveArchiveCreateParallel', function () {
    return driveApiCreateFiles_(
      specs,
      isS3StorageBackend_() ? null : scriptService_().getOAuthToken()
    );
  }, totalBytes);
  if (created.length !== uploads.length) {
    throw new Error('Parallel Drive upload response count did not match the request count.');
  }
  uploads.forEach(function (upload, index) {
    const file = created[index];
    const parents = file.parents || [];
    if (!file.id || file.name !== upload.archive.fileName ||
        Number(file.size) !== Number(upload.archive.storedByteLength) ||
        file.mimeType !== upload.archive.mimeType || parents.indexOf(upload.folderId) === -1) {
      throw new Error('Parallel Drive upload returned mismatched metadata for Gmail ID ' + upload.id + '.');
    }
    records[upload.recordIndex] = buildExportedRecord_({
      id: upload.id,
      entry: upload.entry,
      message: upload.message,
      archiveShard: upload.archiveShard,
      queueSegment: upload.queueSegment,
      archive: upload.archive,
      driveFileId: file.id,
      resolution: upload.resolution,
    });
  });
}

function buildExportedRecord_(input) {
  const archive = input.archive;
  const record = {
    id: input.id,
    threadId: input.message.threadId || input.entry.threadId || '',
    archiveShard: input.archiveShard,
    queueSegment: input.queueSegment,
    status: 'exported',
    labelIds: input.message.labelIds || [],
    historyId: input.message.historyId || '',
    internalDate: input.message.internalDate || '',
    sizeEstimate: Number(input.message.sizeEstimate || 0),
    archiveEncoding: archive.archiveEncoding,
    rawBytes: Number(archive.rawByteLength || 0),
    sha256: archive.rawSha256,
    storedBytes: Number(archive.storedByteLength || 0),
    storedSha256: archive.storedSha256,
    fileName: archive.fileName,
    innerFileName: archive.innerFileName || null,
    mimeType: archive.mimeType,
    storageFileId: input.driveFileId,
    foundExisting: input.resolution.foundExisting,
    recoveredExisting: Boolean(input.resolution.file),
    replacedConflict: input.resolution.replacedConflict,
    quarantinedExistingFiles: input.resolution.quarantinedCount,
    exportedAt: isoNow_(),
  };
  // Preserve the established Drive catalog field for backward compatibility;
  // S3 records use only the provider-neutral logical storage ID.
  if (!isS3StorageBackend_()) record.driveFileId = input.driveFileId;
  return record;
}

function finalizeApply_(state) {
  // As with PLAN finalization, remain APPLYING until the durable summary exists.
  // This ensures a transient Drive failure is retried instead of silently
  // completing without its final report.
  if (Number(state.apply.processed || 0) !== Number(state.apply.total || 0)) {
    throw new Error(
      'Refusing to finalize APPLY: processed ' + Number(state.apply.processed || 0) +
      ' of ' + Number(state.apply.total || 0) + ' queued messages.'
    );
  }
  state.apply.completedAt = state.apply.completedAt || isoNow_();
  state.plan.appliedAt = state.plan.appliedAt || isoNow_();

  const planFolder = driveService_().getFolderById(state.plan.folderId);
  upsertJsonFile_(planFolder, 'apply-summary.json', {
    schemaVersion: 1,
    exporterVersion: backupConfig_().VERSION,
    planId: state.plan.id,
    account: state.account,
    shardCount: backupConfig_().SHARD_COUNT,
    applyOrder: state.queue ? state.queue.order : null,
    completedAt: state.apply.completedAt,
    audit: state.audit,
    queue: state.queue,
    apply: state.apply,
    rootFolderUrl: driveService_().getFolderById(state.rootFolderId).getUrl(),
  });

  state.phase = BACKUP_PHASE.COMPLETE;
  state.updatedAt = isoNow_();
  saveState_(state);
}

function exportBatch_(state, layout, shard, start, endExclusive, entries, context) {
  const canonicalContext = getCanonicalShardContext_(layout, shard, context);
  const dataFolder = canonicalContext.folder;
  const canonical = canonicalContext.canonical;
  const records = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const id = entry.id;
    let message;

    try {
      message = gmailCall_(function () {
        return gmailService_().Users.Messages.get('me', id, {
          format: 'raw',
          fields: 'id,threadId,labelIds,historyId,internalDate,sizeEstimate,raw',
        });
      }, 'Gmail.Users.Messages.get(' + id + ')');
    } catch (error) {
      if (isNotFoundError_(error)) {
        records.push({
          id: id,
          threadId: entry.threadId || '',
          archiveShard: shard,
          status: 'gone',
          reason: 'Message no longer exists or is no longer accessible at apply time.',
          recordedAt: isoNow_(),
        });
        continue;
      }
      throw error;
    }

    if (!message || !message.raw) {
      throw new Error('Gmail API returned no raw content for message ' + id);
    }

    const bytes = gmailRawBytes_(message.raw);
    const sha256 = sha256Hex_(bytes);
    const archive = buildArchivePayload_(id, bytes, sha256);
    const resolution = resolveCanonicalForExport_(canonical, id, archive, layout.root);
    let file = resolution.file;

    if (!file) {
      const blob = utilitiesService_().newBlob(archive.storedBytes, archive.mimeType, archive.fileName);
      file = createArchiveFileWithIntegrity_(dataFolder, blob, archive);
      canonical.byId[id] = file;
      canonical.allById[id] = [file];
    }

    records.push(buildExportedRecord_({
      id: id,
      entry: entry,
      message: message,
      archiveShard: shard,
      queueSegment: null,
      archive: resolution.storage || archive,
      driveFileId: file.getId(),
      resolution: resolution,
    }));
  }

  const exportedRecords = records.filter(function (record) { return record.status === 'exported'; });
  const goneRecords = records.filter(function (record) { return record.status === 'gone'; });
  return {
    schemaVersion: 1,
    planId: state.plan.id,
    shard: shard,
    start: start,
    endExclusive: endExclusive,
    createdAt: isoNow_(),
    durationMs: 0,
    summary: {
      processed: records.length,
      exported: exportedRecords.length,
      gone: goneRecords.length,
      rawBytes: exportedRecords.reduce(function (sum, record) { return sum + Number(record.rawBytes || 0); }, 0),
      storedBytes: exportedRecords.reduce(function (sum, record) {
        return sum + Number(record.storedBytes || record.rawBytes || 0);
      }, 0),
    },
    records: records,
  };
}

function createArchiveFileWithIntegrity_(folder, blob, archive) {
  const description = archiveIntegrityDescription_(archive);
  if (folder && typeof folder.createFileWithDescription === 'function') {
    return folder.createFileWithDescription(blob, description);
  }
  const file = folder.createFile(blob);
  // Drive needs a second metadata call. S3 folds this into the conditional
  // create so large message objects are not uploaded twice.
  file.setDescription(description);
  return file;
}

function validateCommit_(commit, planId, location, start, endExclusive, expectedEntries) {
  const isQueueCommit = commit && commit.queueSegment !== undefined && commit.queueSegment !== null;
  const locationMatches = isQueueCommit
    ? Number(commit.queueSegment) === Number(location)
    : commit && String(commit.shard) === String(location);
  if (!commit || commit.planId !== planId || !locationMatches ||
      Number(commit.start) !== Number(start) || Number(commit.endExclusive) !== Number(endExclusive)) {
    throw new Error('Commit checkpoint does not match the requested batch: location=' + location + ', start=' + start);
  }
  const records = commit.records || [];
  const expected = Number(endExclusive) - Number(start);
  if (records.length !== expected || Number((commit.summary || {}).processed) !== expected) {
    throw new Error('Commit checkpoint has an invalid record count for location=' + location + ', start=' + start);
  }
  const seen = {};
  records.forEach(function (record, index) {
    if (!record || !record.id || seen[record.id]) {
      throw new Error('Commit checkpoint contains a missing or duplicate Gmail ID.');
    }
    if (record.status !== 'exported' && record.status !== 'gone') {
      throw new Error('Commit checkpoint contains an invalid status for Gmail ID ' + record.id);
    }
    if (expectedEntries && (!expectedEntries[index] || expectedEntries[index].id !== record.id)) {
      throw new Error('Commit checkpoint Gmail IDs do not match the frozen plan range.');
    }
    seen[record.id] = true;
  });
}

function validateInFlight_(inFlight, planId, location, start, entryCount) {
  const locationMatches = inFlight && inFlight.segmentIndex !== undefined
    ? Number(inFlight.segmentIndex) === Number(location)
    : inFlight && String(inFlight.shard) === String(location);
  if (!inFlight || inFlight.planId !== planId || !locationMatches ||
      Number(inFlight.start) !== Number(start)) {
    throw new Error('In-flight apply checkpoint does not match current state: ' + JSON.stringify(inFlight));
  }
  const end = Number(inFlight.endExclusive);
  if (!Number.isFinite(end) || end <= Number(start) || end > Number(entryCount)) {
    throw new Error('In-flight apply checkpoint has an invalid end offset: ' + JSON.stringify(inFlight));
  }
}

function chooseApplyBatchSize_(state, executionStartedMs, remainingInShard) {
  const elapsed = Date.now() - executionStartedMs;
  const usableMs = backupConfig_().EXECUTION_BUDGET_MS - elapsed - backupConfig_().CHECKPOINT_SAFETY_MS;
  if (usableMs < 5000) return 0;

  const learnedMs = Number(state.apply.ewmaMsPerMessage || 0);
  const estimatedMs = Math.max(250, learnedMs || backupConfig_().DEFAULT_ESTIMATED_MS_PER_MESSAGE);
  let size = Math.max(1, Math.floor(usableMs / estimatedMs));
  if (!learnedMs) size = Math.min(size, backupConfig_().INITIAL_APPLY_BATCH_SIZE);
  return Math.min(applyBatchSizeLimit_(), Number(remainingInShard || 0), size);
}

function applyBatchSizeLimit_() {
  return Number(isS3StorageBackend_()
    ? backupConfig_().S3_APPLY_BATCH_SIZE
    : backupConfig_().APPLY_BATCH_SIZE);
}

function applyReplayBatchEnd_(start, endExclusive) {
  return Math.min(Number(endExclusive), Number(start) + applyBatchSizeLimit_());
}

function validateCommittedFiles_(commit, layout) {
  const failures = [];
  (commit.records || []).forEach(function (record) {
    if (record.status !== 'exported') return;
    try {
      const archiveShard = record.archiveShard || commit.shard || shardForId_(record.id);
      const expectedFolder = findChildFolder_(layout.data, 'shard-' + archiveShard);
      const file = driveService_().getFileById(storageFileIdForRecord_(record));
      if (typeof file.isTrashed === 'function' && file.isTrashed()) {
        failures.push({id: record.id, reason: 'file-is-trashed'});
        return;
      }
      if (!expectedFolder || !fileIsInFolder_(file, expectedFolder.getId())) {
        failures.push({id: record.id, reason: 'file-not-in-expected-data-shard'});
        return;
      }
      if (file.getName() !== record.fileName) {
        failures.push({id: record.id, reason: 'file-name-mismatch', actual: file.getName(), expected: record.fileName});
        return;
      }
      const expectedStoredBytes = expectedStoredBytesForRecord_(record);
      if (Number(file.getSize()) !== expectedStoredBytes) {
        failures.push({id: record.id, reason: 'file-size-mismatch', actual: Number(file.getSize()), expected: expectedStoredBytes});
        return;
      }
      if (String(file.getMimeType() || '') !== archiveMimeTypeForEncoding_(archiveEncodingForRecord_(record))) {
        failures.push({id: record.id, reason: 'file-mime-type-mismatch'});
        return;
      }
      if (backupConfig_().VERIFY_RECOVERED_FILES) {
        if (shouldUseExternalS3ReplayAttestation_(record)) {
          const attested = validateExternalS3ReplayAttestation_(commit, record, file, layout);
          if (!attested.ok) {
            failures.push({id: record.id, reason: attested.reason, error: attested.error || null});
            return;
          }
          record.integrityVerification = {
            schemaVersion: 1,
            kind: 'EXTERNAL_S3_FULL_SHA256_V1',
            verifiedAt: attested.attestation.verifiedAt,
            attestationFileId: attested.file.getId(),
          };
          return;
        }
        const integrity = readArchiveFileIntegrity_(file, record, false);
        const expectedStoredSha256 = expectedStoredSha256ForRecord_(record);
        const storedMatches = integrity.ok && expectedStoredSha256 &&
          integrity.storedSha256 === expectedStoredSha256;
        const rawMatches = integrity.ok && integrity.rawSha256
          ? integrity.rawSha256 === record.sha256 &&
            Number(integrity.rawByteLength) === Number(record.rawBytes)
          : archiveEncodingForRecord_(record) === 'ZIP' && storedMatches;
        if (!storedMatches || !rawMatches) {
          failures.push({
            id: record.id,
            reason: integrity.ok ? 'file-hash-mismatch' : 'file-integrity-unavailable',
            actualStoredSha256: integrity.storedSha256 || null,
            expectedStoredSha256: expectedStoredSha256,
            actualRawSha256: integrity.rawSha256 || null,
            expectedRawSha256: record.sha256,
            error: integrity.error || null,
          });
        }
      }
    } catch (error) {
      failures.push({id: record.id, reason: 'file-unavailable', error: errorToString_(error)});
    }
  });
  return {ok: failures.length === 0, failures: failures};
}

function shouldUseExternalS3ReplayAttestation_(record) {
  return isS3StorageBackend_() && archiveEncodingForRecord_(record) === 'EML' &&
    expectedStoredBytesForRecord_(record) > Number(backupConfig_().S3_REPLAY_FULL_HASH_MAX_BYTES);
}

function validateExternalS3ReplayAttestation_(commit, record, file, layout) {
  try {
    if (!commit || !record || !layout || !layout.plans ||
        !Array.isArray(commit.records) || commit.records.length !== 1 ||
        commit.queueSegment === undefined || commit.queueSegment === null ||
        Number(commit.endExclusive) !== Number(commit.start) + 1) {
      return {ok: false, reason: 'oversized-replay-attestation-range-invalid'};
    }
    const planFolder = findChildFolder_(layout.plans, String(commit.planId || ''));
    const attestations = planFolder ? findChildFolder_(planFolder, 'integrity-attestations') : null;
    const segmentName = 'segment-' + padNumber_(Number(commit.queueSegment), 8);
    const segmentFolder = attestations ? findChildFolder_(attestations, segmentName) : null;
    const name = commitFileName_(Number(commit.start), Number(commit.endExclusive));
    const attestationFile = segmentFolder ? firstFileByName_(segmentFolder, name) : null;
    if (!attestationFile) {
      return {ok: false, reason: 'oversized-replay-attestation-missing'};
    }
    const attestation = readJsonFile_(attestationFile, null);
    const rawBytes = Number(record.rawBytes);
    const storedBytes = expectedStoredBytesForRecord_(record);
    const rawSha256 = String(record.sha256 || '').toLowerCase();
    const storedSha256 = String(expectedStoredSha256ForRecord_(record) || '').toLowerCase();
    const marker = archiveIntegrityMarkerForFile_(file, null);
    const matches = attestation && Number(attestation.schemaVersion) === 1 &&
      attestation.kind === 'EXTERNAL_S3_FULL_SHA256_V1' &&
      attestation.planId === commit.planId &&
      Number(attestation.queueSegment) === Number(commit.queueSegment) &&
      Number(attestation.start) === Number(commit.start) &&
      Number(attestation.endExclusive) === Number(commit.endExclusive) &&
      attestation.messageId === record.id &&
      attestation.storageFileId === storageFileIdForRecord_(record) &&
      attestation.archiveEncoding === 'EML' &&
      Number(attestation.rawBytes) === rawBytes &&
      Number(attestation.storedBytes) === storedBytes &&
      String(attestation.rawSha256 || '').toLowerCase() === rawSha256 &&
      String(attestation.storedSha256 || '').toLowerCase() === storedSha256 &&
      Number.isFinite(Date.parse(attestation.verifiedAt || '')) &&
      marker && marker.archiveEncoding === 'EML' &&
      Number(marker.rawByteLength) === rawBytes && marker.rawSha256 === rawSha256 &&
      storedBytes === rawBytes && storedSha256 === rawSha256;
    if (!matches) return {ok: false, reason: 'oversized-replay-attestation-mismatch'};
    return {ok: true, attestation: attestation, file: attestationFile};
  } catch (error) {
    return {
      ok: false,
      reason: 'oversized-replay-attestation-unavailable',
      error: errorToString_(error),
    };
  }
}

function quarantineCheckpointFile_(rootFolder, file, planId, location, originalName) {
  const quarantine = getOrCreateChildFolder_(getOrCreateChildFolder_(rootFolder, 'quarantine'), 'checkpoints');
  const safePlan = String(planId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  const safeName = String(originalName || 'checkpoint.json').replace(/[^A-Za-z0-9_.-]/g, '_');
  const safeLocation = String(location || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  file.setName(safePlan + '-' + safeLocation + '-' + safeName + '.invalid-' + compactTimestamp_() + '-' + utilitiesService_().getUuid().slice(0, 8));
  file.moveTo(quarantine);
}

function resolveCanonicalForExport_(canonical, id, archive, rootFolder) {
  const candidates = ((canonical.allById && canonical.allById[id]) || []).slice();
  if (candidates.length === 0 && canonical.byId[id]) candidates.push(canonical.byId[id]);
  if (candidates.length === 0) {
    return {file: null, storage: null, foundExisting: false, replacedConflict: false, quarantinedCount: 0};
  }

  if (!backupConfig_().VERIFY_RECOVERED_FILES) {
    const candidate = candidates[0];
    const encoding = archiveEncodingForFileName_(candidate.getName()) || archive.archiveEncoding;
    return {
      file: candidate,
      storage: {
        archiveEncoding: encoding,
        fileName: candidate.getName(),
        innerFileName: encoding === 'ZIP' ? id + '.eml' : null,
        mimeType: candidate.getMimeType(),
        rawByteLength: archive.rawByteLength,
        rawSha256: archive.rawSha256,
        storedByteLength: Number(candidate.getSize()),
        storedSha256: encoding === 'EML' ? archive.rawSha256 : archive.storedSha256,
      },
      foundExisting: true,
      replacedConflict: false,
      quarantinedCount: 0,
    };
  }

  let valid = null;
  let validStorage = null;
  const checked = [];
  candidates.forEach(function (candidate) {
    const encoding = archiveEncodingForFileName_(candidate.getName());
    let integrity = null;
    let matches = Boolean(encoding) &&
      String(candidate.getMimeType() || '') === archiveMimeTypeForEncoding_(encoding);
    if (matches) {
      integrity = readArchiveFileIntegrity_(candidate, {
        id: id,
        fileName: candidate.getName(),
        innerFileName: encoding === 'ZIP' ? id + '.eml' : null,
        archiveEncoding: encoding,
      }, false);
      matches = Boolean(integrity.ok) &&
        Number(integrity.rawByteLength) === Number(archive.rawByteLength) &&
        integrity.rawSha256 === archive.rawSha256;
      // If a Workspace policy blocks ZIP content reads, Drive's server-side
      // stored hash can still prove that this is the exact ZIP just created.
      if (!matches && integrity.ok && encoding === archive.archiveEncoding &&
          !integrity.contentDecoded &&
          Number(candidate.getSize()) === Number(archive.storedByteLength) &&
          integrity.storedSha256 === archive.storedSha256) {
        matches = true;
      }
    }
    const storage = matches ? {
      archiveEncoding: encoding,
      fileName: candidate.getName(),
      innerFileName: encoding === 'ZIP' ? id + '.eml' : null,
      mimeType: candidate.getMimeType(),
      rawByteLength: archive.rawByteLength,
      rawSha256: archive.rawSha256,
      storedByteLength: Number(candidate.getSize()),
      storedSha256: integrity.storedSha256,
    } : null;
    if (matches && !valid) {
      valid = candidate;
      validStorage = storage;
    }
    checked.push({file: candidate, matches: matches});
  });

  const quarantine = checked.length > 1 || !valid
    ? getOrCreateChildFolder_(rootFolder, 'quarantine')
    : null;
  let quarantinedCount = 0;
  checked.forEach(function (item) {
    if (item.file === valid) return;
    const reason = item.matches ? 'duplicate' : 'conflict';
    item.file
      .setName(item.file.getName() + '.' + reason + '-' + compactTimestamp_() + '-' + utilitiesService_().getUuid().slice(0, 8))
      .moveTo(quarantine);
    quarantinedCount++;
  });

  if (valid) {
    canonical.byId[id] = valid;
    canonical.allById[id] = [valid];
    return {
      file: valid,
      storage: validStorage,
      foundExisting: true,
      replacedConflict: false,
      quarantinedCount: quarantinedCount,
    };
  }

  delete canonical.byId[id];
  canonical.allById[id] = [];
  return {
    file: null,
    storage: null,
    foundExisting: true,
    replacedConflict: true,
    quarantinedCount: quarantinedCount,
  };
}

function getCanonicalShardContext_(layout, shard, context) {
  context.canonicalByShard = context.canonicalByShard || {};
  if (!context.canonicalByShard[shard]) {
    const name = 'shard-' + shard;
    context.dataFoldersByName = context.dataFoldersByName || listFoldersByName_(layout.data);
    let folder = context.dataFoldersByName[name] || null;
    if (!folder) {
      folder = measureOperation_(context.metrics, 'driveShardCreate', function () {
        return layout.data.createFolder(name);
      });
      context.dataFoldersByName[name] = folder;
    }
    context.canonicalByShard[shard] = {
      folder: folder,
      canonical: measureOperation_(context.metrics, 'driveShardList', function () {
        return listCanonicalArchiveFiles_(folder);
      }),
    };
  }
  return context.canonicalByShard[shard];
}

function getCatalogShardContext_(catalogFolder, shard, context) {
  context.catalogByShard = context.catalogByShard || {};
  if (!context.catalogByShard[shard]) {
    const name = 'shard-' + shard + '.json';
    const file = firstFileByName_(catalogFolder, name);
    const records = file ? readJsonFile_(file, []) : [];
    const byId = {};
    records.forEach(function (record) {
      if (record && record.id) byId[record.id] = record;
    });
    context.catalogByShard[shard] = {
      name: name,
      file: file,
      fileId: file ? file.getId() : null,
      version: file && typeof file.getVersion === 'function' ? file.getVersion() : null,
      byId: byId,
    };
  }
  return context.catalogByShard[shard];
}

function mergeCommitIntoCatalog_(catalogFolder, shard, commit, context) {
  const cache = getCatalogShardContext_(catalogFolder, shard, context);
  (commit.records || []).forEach(function (record) {
    if (record && record.id) cache.byId[record.id] = record;
  });

  const merged = Object.keys(cache.byId).sort().map(function (id) { return cache.byId[id]; });
  if (cache.file) {
    cache.file.setContent(JSON.stringify(merged));
  } else {
    cache.file = catalogFolder.createFile(cache.name, JSON.stringify(merged), 'text/plain');
  }
}

function mergeCommitIntoCatalogByShard_(catalogFolder, commit, context) {
  if (parallelCatalogApiEnabled_()) {
    mergeCommitIntoCatalogByShardParallel_(catalogFolder, commit, context);
    return;
  }
  const recordsByShard = {};
  (commit.records || []).forEach(function (record) {
    if (!record || !record.id) return;
    const shard = record.archiveShard || shardForId_(record.id);
    if (!recordsByShard[shard]) recordsByShard[shard] = [];
    recordsByShard[shard].push(record);
  });
  Object.keys(recordsByShard).sort().forEach(function (shard) {
    mergeCommitIntoCatalog_(catalogFolder, shard, {
      records: recordsByShard[shard],
    }, context);
  });
}

function parallelCatalogApiEnabled_() {
  return isS3StorageBackend_()
    ? hasRuntimeService_('urlFetch', typeof UrlFetchApp !== 'undefined' ? UrlFetchApp : null)
    : parallelDriveApiEnabled_();
}

function mergeCommitIntoCatalogByShardParallel_(catalogFolder, commit, context) {
  const recordsByShard = {};
  (commit.records || []).forEach(function (record) {
    if (!record || !record.id) return;
    const shard = record.archiveShard || shardForId_(record.id);
    if (!recordsByShard[shard]) recordsByShard[shard] = [];
    recordsByShard[shard].push(record);
  });

  const updates = [];
  const creates = [];
  Object.keys(recordsByShard).sort().forEach(function (shard) {
    const cache = getCatalogShardContext_(catalogFolder, shard, context);
    recordsByShard[shard].forEach(function (record) { cache.byId[record.id] = record; });
    const content = JSON.stringify(
      Object.keys(cache.byId).sort().map(function (id) { return cache.byId[id]; })
    );
    const byteLength = utilitiesService_().newBlob(content).getBytes().length;
    const prepared = {shard: shard, cache: cache, content: content, byteLength: byteLength};
    if (cache.fileId) updates.push(prepared); else creates.push(prepared);
  });

  const token = isS3StorageBackend_() ? null : scriptService_().getOAuthToken();
  if (updates.length) {
    const updateResults = driveApiUpdateMedia_(updates.map(function (item) {
      return {
        fileId: item.cache.fileId,
        content: item.content,
        mimeType: 'application/json',
        etag: item.cache.version,
      };
    }), token);
    updateResults.forEach(function (result, index) {
      const item = updates[index];
      if (result.id !== item.cache.fileId || Number(result.size) !== item.byteLength) {
        throw new Error('Parallel catalog update returned mismatched metadata for shard ' + item.shard + '.');
      }
      if (result.etag) item.cache.version = result.etag;
    });
  }

  if (creates.length) {
    const createResults = driveApiCreateFiles_(creates.map(function (item) {
      return {
        name: item.cache.name,
        mimeType: 'application/json',
        parentId: catalogFolder.getId(),
        bytes: utilitiesService_().newBlob(item.content).getBytes(),
      };
    }), token);
    createResults.forEach(function (result, index) {
      const item = creates[index];
      const parents = result.parents || [];
      if (!result.id || result.name !== item.cache.name ||
          Number(result.size) !== item.byteLength ||
          result.mimeType !== 'application/json' || parents.indexOf(catalogFolder.getId()) === -1) {
        throw new Error('Parallel catalog create returned mismatched metadata for shard ' + item.shard + '.');
      }
      item.cache.fileId = result.id;
      if (result.etag) item.cache.version = result.etag;
    });
  }
}

function advanceApplyStateFromCommit_(state, commit) {
  const summary = commit.summary || {};
  const processed = Number(summary.processed || 0);
  const durationMs = Math.max(1, Number(commit.durationMs || 1));
  const exported = Number(summary.exported || 0);
  const gone = Number(summary.gone || 0);
  const bytes = Number(summary.rawBytes || 0);
  const storedBytes = Number(summary.storedBytes || summary.rawBytes || 0);
  const now = isoNow_();
  const priorProgressAt = state.apply.lastProgressAt;

  state.apply.processed = Number(state.apply.processed || 0) + processed;
  state.apply.exported = Number(state.apply.exported || 0) + exported;
  state.apply.gone = Number(state.apply.gone || 0) + gone;
  state.apply.rawBytes = Number(state.apply.rawBytes || 0) + bytes;
  state.apply.storedBytes = Number(state.apply.storedBytes || 0) + storedBytes;
  state.apply.batches = Number(state.apply.batches || 0) + 1;
  state.apply.activeRuntimeMs = Number(state.apply.activeRuntimeMs || 0) + durationMs;

  if (processed > 0) {
    const sampleMsPerMessage = durationMs / processed;
    state.apply.ewmaMsPerMessage = ewma_(state.apply.ewmaMsPerMessage, sampleMsPerMessage, 0.25);

    if (priorProgressAt) {
      const priorMs = Date.parse(priorProgressAt);
      if (Number.isFinite(priorMs)) {
        const wallDeltaMs = Math.max(1, Date.now() - priorMs);
        const wallSampleMsPerMessage = wallDeltaMs / processed;
        state.apply.ewmaWallMsPerMessage = ewma_(state.apply.ewmaWallMsPerMessage, wallSampleMsPerMessage, 0.15);
      }
    }
  }
  if (exported > 0) {
    const sampleBytesPerMessage = bytes / exported;
    state.apply.ewmaBytesPerMessage = ewma_(state.apply.ewmaBytesPerMessage, sampleBytesPerMessage, 0.20);
  }

  state.apply.lastBatchAt = now;
  state.apply.lastProgressAt = now;
}
