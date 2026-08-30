// -----------------------------------------------------------------------------
// Ordered work-queue implementation
// -----------------------------------------------------------------------------

function processQueueSlice_(state, executionStartedMs) {
  const metrics = newOperationMetrics_();
  const queueFolder = measureOperation_(metrics, 'driveQueueFolder', function () {
    return driveService_().getFolderById(state.plan.workQueueFolderId);
  });
  const queueCommitsFolder = measureOperation_(metrics, 'driveQueueCommitsFolder', function () {
    return driveService_().getFolderById(state.plan.queueCommitsFolderId);
  });
  const seenFolder = measureOperation_(metrics, 'driveQueueSeenFolder', function () {
    return driveService_().getFolderById(state.plan.queueSeenFolderId);
  });
  const remainingFolder = measureOperation_(metrics, 'driveRemainingFolder', function () {
    return driveService_().getFolderById(state.plan.remainingFolderId);
  });
  const journalFolder = measureOperation_(metrics, 'driveScanJournalFolder', function () {
    return driveService_().getFolderById(state.plan.scanJournalFolderId);
  });
  const remainingFiles = measureOperation_(metrics, 'driveRemainingList', function () {
    return listFilesByName_(remainingFolder);
  });
  const seenFiles = measureOperation_(metrics, 'driveQueueSeenList', function () {
    return listFilesByName_(seenFolder);
  });
  let lastStatusWriteMs = executionStartedMs;

  if (!state.queue.startedAt) state.queue.startedAt = isoNow_();
  // A fully healthy archive has no queue work. Do not traverse the entire final
  // scan merely to prove that zero IDs should be emitted.
  if (Number(state.queue.total || 0) === 0 && Number(state.queue.queued || 0) === 0 &&
      !state.queue.inFlight) {
    state.queue.stage = 'FINALIZING';
    state.lastSliceMetrics = summarizeOperationMetrics_(metrics);
    finalizeQueue_(state, executionStartedMs);
    return;
  }
  if (state.queue.order === BACKUP_APPLY_ORDER.SHARDED_ID && state.queue.stage === 'ORDERED') {
    state.queue.stage = 'TAIL';
  }

  while (Date.now() - executionStartedMs < backupConfig_().EXECUTION_BUDGET_MS &&
         Date.now() - executionStartedMs < backupConfig_().QUEUE_COLLECTION_BUDGET_MS) {
    if (state.queue.stage === 'ORDERED') {
      const finalChunkCount = Number(state.scan.finalPassChunkCount || 0);
      if (state.queue.sourceIndex >= finalChunkCount) {
        state.queue.stage = 'TAIL';
        state.queue.tailShardIndex = 0;
        state.updatedAt = isoNow_();
        saveState_(state);
        continue;
      }
      measureOperation_(metrics, 'queueOrderedTransaction', function () {
        processOrderedQueueTransaction_(
          state,
          journalFolder,
          remainingFiles,
          seenFolder,
          seenFiles,
          queueFolder,
          queueCommitsFolder
        );
      });
    } else if (state.queue.stage === 'TAIL') {
      if (state.queue.tailShardIndex >= backupConfig_().SHARD_COUNT) {
        state.queue.stage = 'FINALIZING';
        state.updatedAt = isoNow_();
        saveState_(state);
        continue;
      }
      measureOperation_(metrics, 'queueTailTransaction', function () {
        processTailQueueTransaction_(
          state,
          remainingFiles,
          seenFolder,
          seenFiles,
          queueFolder,
          queueCommitsFolder
        );
      });
    } else if (state.queue.stage === 'FINALIZING') {
      finalizeQueue_(state, executionStartedMs);
      return;
    } else {
      throw new Error('Unknown queue stage: ' + state.queue.stage);
    }

    const queued = Number(state.queue.queued || 0);
    const total = Number(state.queue.total || 0);
    if (queued > total) {
      throw new Error('Work queue exceeds the exact audited remaining total: ' + queued + ' > ' + total);
    }
    // The ordered final-pass scan normally emits every exact remaining ID. If
    // its deduplicated count already equals the audit total, equality proves
    // that the 64-shard fallback cannot add anything. Finalize immediately.
    if (queued === total && !state.queue.inFlight) {
      state.queue.stage = 'FINALIZING';
      state.lastSliceMetrics = summarizeOperationMetrics_(metrics);
      finalizeQueue_(state, executionStartedMs);
      return;
    }

    if (Date.now() - lastStatusWriteMs >= backupConfig_().STATUS_UPDATE_INTERVAL_MS) {
      safeUpdateStatusFiles_(state);
      lastStatusWriteMs = Date.now();
    }
    if (isPauseRequested_()) return;
  }
  state.lastSliceMetrics = summarizeOperationMetrics_(metrics);
}

function processOrderedQueueTransaction_(state, journalFolder, remainingFiles, seenFolder, seenFiles, queueFolder, queueCommitsFolder) {
  const finalChunkCount = Number(state.scan.finalPassChunkCount || 0);
  const logicalIndex = Number(state.queue.sourceIndex || 0);
  const actual = state.queue.order === BACKUP_APPLY_ORDER.OLDEST_FIRST
    ? finalChunkCount - 1 - logicalIndex
    : logicalIndex;
  const name = scanJournalFileName_(
    Number(state.scan.passes || 1),
    Number(state.scan.finalPassGeneration || 0),
    actual
  );
  const file = firstFileByName_(journalFolder, name);
  if (!file) throw new Error('Missing final-pass scan journal chunk: ' + name);
  const chunk = readJsonFile_(file, null);
  if (!chunk || chunk.planId !== state.plan.id || Number(chunk.chunkIndex) !== actual) {
    throw new Error('Invalid final-pass scan journal chunk: ' + name);
  }

  const rows = (chunk.messages || []).slice();
  if (state.queue.order === BACKUP_APPLY_ORDER.OLDEST_FIRST) rows.reverse();
  const startOffset = Number(state.queue.sourceOffset || 0);
  if (startOffset >= rows.length) {
    state.queue.sourceIndex = logicalIndex + 1;
    state.queue.sourceOffset = 0;
    state.queue.sourceChunksProcessed = Number(state.queue.sourceChunksProcessed || 0) + 1;
    state.updatedAt = isoNow_();
    saveState_(state);
    return;
  }
  const endOffset = Math.min(rows.length, startOffset + backupConfig_().QUEUE_ROWS_PER_TRANSACTION);
  const key = 'ordered-' + padNumber_(logicalIndex, 8) +
    '-' + padNumber_(startOffset, 8) + '-' + padNumber_(endOffset, 8);
  const inFlight = ensureQueueInFlight_(state, {
    kind: 'ORDERED',
    key: key,
    sourceIndex: logicalIndex,
    actualChunkIndex: actual,
    sourceOffset: startOffset,
    sourceEndOffset: endOffset,
    sourceRowsInUnit: rows.length,
    segmentStart: Number(state.queue.segmentIndex || 0),
  });

  const commitName = key + '.json';
  let commitFile = firstFileByName_(queueCommitsFolder, commitName);
  let commit;
  if (commitFile) {
    commit = readJsonFile_(commitFile, null);
    validateQueueCommit_(commit, state, inFlight);
  } else {
    const sourceRows = rows.slice(startOffset, endOffset);
    const allPlannedAreRemaining = Number(state.audit.remaining || 0) === Number(state.audit.planned || 0);
    const selection = selectMissingUnseenQueueEntries_(
      sourceRows,
      remainingFiles,
      seenFiles,
      allPlannedAreRemaining
    );
    commit = buildQueueCommit_(state, inFlight, selection.entries, {
      sourceChunkIndices: [actual],
      sourceRows: sourceRows.length,
      sourceRowsInUnit: rows.length,
      sourceOffset: startOffset,
      sourceEndOffset: endOffset,
      duplicatesSuppressed: selection.duplicatesSuppressed,
      nonRemainingRows: selection.nonRemainingRows,
    });
    commitFile = queueCommitsFolder.createFile(commitName, JSON.stringify(commit), 'text/plain');
  }

  ensureQueueSegments_(state, queueFolder, commit);
  mergeQueueCommitIntoSeen_(seenFolder, seenFiles, commit);
  advanceQueueStateFromCommit_(state, commit);
}

function processTailQueueTransaction_(state, remainingFiles, seenFolder, seenFiles, queueFolder, queueCommitsFolder) {
  const shardIndex = Number(state.queue.tailShardIndex || 0);
  const shard = shardName_(shardIndex);
  const name = 'shard-' + shard + '.json';
  const remaining = remainingFiles[name] ? readJsonFile_(remainingFiles[name], []) : [];
  const startOffset = Number(state.queue.tailOffset || 0);
  if (startOffset >= remaining.length) {
    state.queue.tailShardIndex = shardIndex + 1;
    state.queue.tailOffset = 0;
    state.updatedAt = isoNow_();
    saveState_(state);
    return;
  }
  const endOffset = Math.min(remaining.length, startOffset + backupConfig_().QUEUE_ROWS_PER_TRANSACTION);
  const key = 'tail-' + shard + '-' + padNumber_(startOffset, 8) + '-' + padNumber_(endOffset, 8);
  const inFlight = ensureQueueInFlight_(state, {
    kind: 'TAIL',
    key: key,
    shard: shard,
    sourceOffset: startOffset,
    sourceEndOffset: endOffset,
    sourceRowsInUnit: remaining.length,
    segmentStart: Number(state.queue.segmentIndex || 0),
  });
  const commitName = key + '.json';
  let commitFile = firstFileByName_(queueCommitsFolder, commitName);
  let commit;

  if (commitFile) {
    commit = readJsonFile_(commitFile, null);
    validateQueueCommit_(commit, state, inFlight);
  } else {
    const seen = readQueueSeenSet_(seenFiles[name] || null);
    const sourceRows = remaining.slice(startOffset, endOffset);
    const entries = [];
    sourceRows.forEach(function (entry) {
      if (!entry || !entry.id || seen[entry.id]) return;
      seen[entry.id] = true;
      entries.push({
        id: entry.id,
        threadId: entry.threadId || '',
        auditReason: entry.auditReason || '',
        orderSource: state.queue.order === BACKUP_APPLY_ORDER.SHARDED_ID
          ? 'SHARDED_ID'
          : 'FINAL_SCAN_FALLBACK',
      });
    });
    commit = buildQueueCommit_(state, inFlight, entries, {
      shard: shard,
      sourceRows: sourceRows.length,
      sourceRowsInUnit: remaining.length,
      sourceOffset: startOffset,
      sourceEndOffset: endOffset,
      // Rows already emitted by the chronological stage are expected here;
      // they are not duplicate observations in Gmail's ordered scan.
      duplicatesSuppressed: 0,
      nonRemainingRows: 0,
    });
    commitFile = queueCommitsFolder.createFile(commitName, JSON.stringify(commit), 'text/plain');
  }

  ensureQueueSegments_(state, queueFolder, commit);
  mergeQueueCommitIntoSeen_(seenFolder, seenFiles, commit);
  advanceQueueStateFromCommit_(state, commit);
}

function ensureQueueInFlight_(state, intended) {
  if (state.queue.inFlight) {
    const existing = state.queue.inFlight;
    if (existing.planId !== state.plan.id || existing.kind !== intended.kind ||
        existing.key !== intended.key || Number(existing.segmentStart) !== Number(intended.segmentStart)) {
      throw new Error('Queue in-flight checkpoint does not match current state: ' + JSON.stringify(existing));
    }
    return existing;
  }
  state.queue.inFlight = Object.assign({
    schemaVersion: 1,
    planId: state.plan.id,
    createdAt: isoNow_(),
  }, intended);
  state.updatedAt = isoNow_();
  saveState_(state);
  return state.queue.inFlight;
}

function selectMissingUnseenQueueEntries_(orderedEntries, remainingFiles, seenFiles, allPlannedAreRemaining) {
  const positionsByShard = {};
  orderedEntries.forEach(function (entry, index) {
    if (!entry || !entry.id) return;
    const shard = shardForId_(entry.id);
    if (!positionsByShard[shard]) positionsByShard[shard] = [];
    positionsByShard[shard].push({index: index, entry: entry});
  });

  const selectedAt = {};
  let duplicatesSuppressed = 0;
  let nonRemainingRows = 0;
  Object.keys(positionsByShard).forEach(function (shard) {
    const name = 'shard-' + shard + '.json';
    const remainingById = {};
    if (!allPlannedAreRemaining) {
      const remainingRows = remainingFiles[name] ? readJsonFile_(remainingFiles[name], []) : [];
      remainingRows.forEach(function (entry) {
        if (entry && entry.id) remainingById[entry.id] = entry;
      });
    }
    const seen = readQueueSeenSet_(seenFiles[name] || null);

    positionsByShard[shard].forEach(function (position) {
      const id = position.entry.id;
      const remaining = allPlannedAreRemaining
        ? {id: id, threadId: position.entry.threadId || '', auditReason: 'all-planned-messages-remaining'}
        : remainingById[id];
      if (!remaining) {
        nonRemainingRows += 1;
        return;
      }
      if (seen[id]) {
        duplicatesSuppressed += 1;
        return;
      }
      // Mark locally so duplicates within this same source transaction are
      // suppressed before the durable seen shard is updated.
      seen[id] = true;
      selectedAt[position.index] = {
        id: id,
        threadId: position.entry.threadId || remaining.threadId || '',
        auditReason: remaining.auditReason || '',
        orderSource: 'FINAL_SCAN_PASS',
      };
    });
  });

  return {
    entries: Object.keys(selectedAt).map(Number).sort(function (a, b) { return a - b; }).map(function (index) {
      return selectedAt[index];
    }),
    duplicatesSuppressed: duplicatesSuppressed,
    nonRemainingRows: nonRemainingRows,
  };
}

function buildQueueCommit_(state, inFlight, entries, details) {
  const segmentStart = Number(inFlight.segmentStart || 0);
  const segments = [];
  for (let offset = 0; offset < entries.length; offset += backupConfig_().WORK_QUEUE_SEGMENT_SIZE) {
    const index = segmentStart + segments.length;
    segments.push({
      index: index,
      name: queueSegmentFileName_(index),
      entries: entries.slice(offset, offset + backupConfig_().WORK_QUEUE_SEGMENT_SIZE),
    });
  }
  return {
    schemaVersion: 1,
    planId: state.plan.id,
    applyOrder: state.queue.order,
    kind: inFlight.kind,
    key: inFlight.key,
    sourceIndex: inFlight.sourceIndex === undefined ? null : Number(inFlight.sourceIndex),
    actualChunkIndex: inFlight.actualChunkIndex === undefined ? null : Number(inFlight.actualChunkIndex),
    sourceOffset: Number((details || {}).sourceOffset || inFlight.sourceOffset || 0),
    sourceEndOffset: Number((details || {}).sourceEndOffset || inFlight.sourceEndOffset || 0),
    sourceRowsInUnit: Number((details || {}).sourceRowsInUnit || inFlight.sourceRowsInUnit || 0),
    shard: inFlight.shard || null,
    segmentStart: segmentStart,
    segmentEnd: segmentStart + segments.length,
    selected: entries.length,
    sourceRows: Number((details || {}).sourceRows || 0),
    duplicatesSuppressed: Number((details || {}).duplicatesSuppressed || 0),
    nonRemainingRows: Number((details || {}).nonRemainingRows || 0),
    sourceChunkIndices: (details || {}).sourceChunkIndices || [],
    segments: segments,
    createdAt: isoNow_(),
  };
}

function validateQueueCommit_(commit, state, inFlight) {
  if (!commit || commit.planId !== state.plan.id || commit.applyOrder !== state.queue.order ||
      commit.kind !== inFlight.kind || commit.key !== inFlight.key ||
      Number(commit.segmentStart) !== Number(inFlight.segmentStart)) {
    throw new Error('Queue commit does not match current checkpoint: ' + inFlight.key);
  }
  if (Number(commit.sourceOffset) !== Number(inFlight.sourceOffset) ||
      Number(commit.sourceEndOffset) !== Number(inFlight.sourceEndOffset) ||
      Number(commit.sourceRowsInUnit) !== Number(inFlight.sourceRowsInUnit)) {
    throw new Error('Queue commit source range mismatch: ' + inFlight.key);
  }
  if (inFlight.kind === 'ORDERED' &&
      (Number(commit.sourceIndex) !== Number(inFlight.sourceIndex) ||
       Number(commit.actualChunkIndex) !== Number(inFlight.actualChunkIndex))) {
    throw new Error('Ordered queue commit range mismatch: ' + inFlight.key);
  }
  if (inFlight.kind === 'TAIL' && commit.shard !== inFlight.shard) {
    throw new Error('Tail queue commit shard mismatch: ' + inFlight.key);
  }
  let count = 0;
  const seen = {};
  (commit.segments || []).forEach(function (segment, relativeIndex) {
    if (Number(segment.index) !== Number(commit.segmentStart) + relativeIndex ||
        segment.name !== queueSegmentFileName_(segment.index) || !Array.isArray(segment.entries)) {
      throw new Error('Queue commit has an invalid segment descriptor: ' + inFlight.key);
    }
    segment.entries.forEach(function (entry) {
      if (!entry || !entry.id || seen[entry.id]) {
        throw new Error('Queue commit contains a missing or duplicate Gmail ID: ' + inFlight.key);
      }
      seen[entry.id] = true;
      count += 1;
    });
  });
  if (count !== Number(commit.selected || 0) ||
      Number(commit.segmentEnd) !== Number(commit.segmentStart) + (commit.segments || []).length) {
    throw new Error('Queue commit count/segment range mismatch: ' + inFlight.key);
  }
}

function ensureQueueSegments_(state, queueFolder, commit) {
  const existingFiles = listFilesByName_(queueFolder);
  (commit.segments || []).forEach(function (segment) {
    const payload = {
      schemaVersion: 1,
      planId: state.plan.id,
      applyOrder: state.queue.order,
      segmentIndex: segment.index,
      entries: segment.entries,
    };
    const existing = existingFiles[segment.name] || null;
    if (existing) {
      const actual = readJsonFile_(existing, null);
      if (!queueSegmentMatches_(actual, payload)) {
        throw new Error('Existing work-queue segment conflicts with its durable commit: ' + segment.name);
      }
    } else {
      existingFiles[segment.name] = queueFolder.createFile(
        segment.name,
        JSON.stringify(payload),
        'text/plain'
      );
    }
  });
}

function queueSegmentMatches_(actual, expected) {
  if (!actual || actual.planId !== expected.planId || actual.applyOrder !== expected.applyOrder ||
      Number(actual.segmentIndex) !== Number(expected.segmentIndex)) return false;
  const a = actual.entries || [];
  const b = expected.entries || [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!a[i] || !b[i] || a[i].id !== b[i].id) return false;
  }
  return true;
}

function mergeQueueCommitIntoSeen_(seenFolder, seenFiles, commit) {
  const additions = {};
  (commit.segments || []).forEach(function (segment) {
    (segment.entries || []).forEach(function (entry) {
      const shard = shardForId_(entry.id);
      if (!additions[shard]) additions[shard] = [];
      additions[shard].push(entry.id);
    });
  });

  Object.keys(additions).sort().forEach(function (shard) {
    const name = 'shard-' + shard + '.json';
    const file = seenFiles[name] || null;
    const seen = readQueueSeenSet_(file);
    const missing = additions[shard].filter(function (id) { return !seen[id]; });
    // A crash may occur after some seen shards are durable but before the
    // queue-state checkpoint advances. On replay, do not spend another remote
    // write on shards that already contain this commit's complete addition.
    // This makes each retry advance past the last successfully written shard.
    if (!missing.length) return;
    missing.forEach(function (id) { seen[id] = true; });
    const sorted = Object.keys(seen).sort();
    if (file) {
      file.setContent(JSON.stringify(sorted));
    } else {
      seenFiles[name] = seenFolder.createFile(name, JSON.stringify(sorted), 'text/plain');
    }
  });
}

function readQueueSeenSet_(file) {
  const set = {};
  if (!file) return set;
  const rows = readJsonFile_(file, []);
  rows.forEach(function (value) {
    const id = typeof value === 'string' ? value : value && value.id;
    if (id) set[id] = true;
  });
  return set;
}

function advanceQueueStateFromCommit_(state, commit) {
  state.queue.segmentIndex = Number(commit.segmentEnd || state.queue.segmentIndex || 0);
  state.queue.queued = Number(state.queue.queued || 0) + Number(commit.selected || 0);
  state.queue.duplicatesSuppressed = Number(state.queue.duplicatesSuppressed || 0) + Number(commit.duplicatesSuppressed || 0);
  state.queue.nonRemainingRows = Number(state.queue.nonRemainingRows || 0) + Number(commit.nonRemainingRows || 0);
  if (commit.kind === 'ORDERED') {
    if (Number(commit.sourceEndOffset) >= Number(commit.sourceRowsInUnit)) {
      state.queue.sourceIndex = Number(commit.sourceIndex || 0) + 1;
      state.queue.sourceOffset = 0;
      state.queue.sourceChunksProcessed = Number(state.queue.sourceChunksProcessed || 0) + 1;
    } else {
      state.queue.sourceIndex = Number(commit.sourceIndex || 0);
      state.queue.sourceOffset = Number(commit.sourceEndOffset || 0);
    }
    state.queue.orderedQueued = Number(state.queue.orderedQueued || 0) + Number(commit.selected || 0);
  } else {
    if (Number(commit.sourceEndOffset) >= Number(commit.sourceRowsInUnit)) {
      state.queue.tailShardIndex = Number(state.queue.tailShardIndex || 0) + 1;
      state.queue.tailOffset = 0;
    } else {
      state.queue.tailOffset = Number(commit.sourceEndOffset || 0);
    }
    state.queue.tailQueued = Number(state.queue.tailQueued || 0) + Number(commit.selected || 0);
  }
  state.queue.inFlight = null;
  state.updatedAt = isoNow_();
  saveState_(state);
}

function finalizeQueue_(state, executionStartedMs) {
  if (Number(state.queue.queued || 0) !== Number(state.audit.remaining || 0)) {
    throw new Error(
      'Work-queue cardinality mismatch: queued ' + Number(state.queue.queued || 0) +
      ', expected ' + Number(state.audit.remaining || 0) + '. Refusing to finalize PLAN.'
    );
  }

  state.queue.completedAt = state.queue.completedAt || isoNow_();
  const planFolder = driveService_().getFolderById(state.plan.folderId);
  const estimateResult = ensurePlanEstimate_(state, planFolder, executionStartedMs);
  state.plan.estimateFileId = estimateResult.file.getId();
  state.plan.estimate = compactPlanEstimate_(estimateResult.report, state.plan.estimateFileId);
  state.plan.completedAt = state.plan.completedAt || estimateResult.report.createdAt || isoNow_();
  logger_().log(formatPlanEstimateText_(estimateResult.report));
  const queueSummary = {
    schemaVersion: 1,
    exporterVersion: backupConfig_().VERSION,
    planId: state.plan.id,
    applyOrder: state.queue.order,
    canonicalScanOrder: 'NEWEST_FIRST',
    sourcePass: Number(state.scan.passes || 1),
    sourceGeneration: Number(state.scan.finalPassGeneration || 0),
    sourceChunks: Number(state.scan.finalPassChunkCount || 0),
    sourceRows: Number(state.scan.finalPassRows || 0),
    queueSegments: Number(state.queue.segmentIndex || 0),
    queuedMessages: Number(state.queue.queued || 0),
    orderedMessages: Number(state.queue.orderedQueued || 0),
    fallbackMessages: Number(state.queue.tailQueued || 0),
    duplicatesSuppressed: Number(state.queue.duplicatesSuppressed || 0),
    rowsNotInRemainingDelta: Number(state.queue.nonRemainingRows || 0),
    completedAt: state.queue.completedAt,
    notes: [
      'Gmail users.messages.list is consumed in its documented newest-first order.',
      'OLDEST_FIRST reverses final-pass chunks and each chunk before queue creation.',
      'IDs observed by the set-union plan but absent from the completed final pass are appended in deterministic shard/ID order.',
      'Canonical .eml and .eml.zip storage plus catalog lookup remain sharded by immutable Gmail message ID.',
    ],
  };
  const queueSummaryFile = upsertJsonFile_(planFolder, 'queue.json', queueSummary);
  state.plan.queueSummaryFileId = queueSummaryFile.getId();

  const planSummary = {
    schemaVersion: 1,
    exporterVersion: backupConfig_().VERSION,
    planId: state.plan.id,
    account: state.account,
    query: state.plan.query,
    includeSpamTrash: state.plan.includeSpamTrash,
    shardCount: backupConfig_().SHARD_COUNT,
    applyOrder: state.queue.order,
    createdAt: state.plan.createdAt,
    completedAt: state.plan.completedAt,
    scan: state.scan,
    audit: state.audit,
    queue: queueSummary,
    estimate: estimateResult.report,
    mailboxChangedDuringScan: Boolean(
      state.scan.historyIdStart && state.scan.historyIdEnd &&
      state.scan.historyIdStart !== state.scan.historyIdEnd
    ),
    notes: [
      'The exact plan set is a deduplicated union of Gmail message IDs collected across ' + state.scan.passes + ' scan pass(es).',
      'The work queue preserves the completed final pass order, then appends any union-only fallback IDs deterministically.',
      'The Gmail mailbox is not atomically snapshotted; start/end history IDs expose concurrent change.',
      'A later plan safely computes newly observed mail and any prior gaps as a delta.',
      'Only files with matching exported catalog records are counted as already present.',
      'Existing archive files are never deleted by plan mode.',
    ],
  };
  const summaryFile = upsertJsonFile_(planFolder, 'plan.json', planSummary);
  state.plan.summaryFileId = summaryFile.getId();
  state.phase = BACKUP_PHASE.PLANNED;
  state.updatedAt = isoNow_();
  saveState_(state);
}

function queueSegmentFileName_(index) {
  return 'segment-' + padNumber_(index, 8) + '.json';
}
