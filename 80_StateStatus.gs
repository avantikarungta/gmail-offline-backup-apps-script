// -----------------------------------------------------------------------------
// State, status, and trigger helpers
// -----------------------------------------------------------------------------

function newBaseState_(rootFolderId) {
  const now = isoNow_();
  return {
    schemaVersion: 1,
    exporterVersion: backupConfig_().VERSION,
    phase: BACKUP_PHASE.IDLE,
    previousPhase: null,
    pausedAt: null,
    archiveConfig: {
      shardCount: backupConfig_().SHARD_COUNT,
      preferredEncoding: backupConfig_().ARCHIVE_ENCODING,
      storage: archiveStorageIdentity_(),
    },
    rootFolderId: rootFolderId,
    account: '',
    plan: null,
    scan: null,
    audit: newAuditState_(),
    queue: newQueueState_(),
    apply: newApplyState_(),
    createdAt: now,
    updatedAt: now,
    lastError: null,
    consecutiveErrors: 0,
    retryNotBefore: null,
    lastSliceMetrics: null,
  };
}

function newAuditState_() {
  return {
    shardIndex: 0,
    planned: 0,
    alreadyPresent: 0,
    remaining: 0,
    uncommittedCanonicalFiles: 0,
    catalogMismatches: 0,
    orphanFiles: 0,
    duplicateCanonicalNames: 0,
    invalidFiles: 0,
    startedAt: null,
    completedAt: null,
  };
}

function newQueueState_() {
  return {
    order: backupConfig_().APPLY_ORDER,
    stage: 'ORDERED',
    sourceIndex: 0,
    sourceOffset: 0,
    sourceChunksProcessed: 0,
    tailShardIndex: 0,
    tailOffset: 0,
    segmentIndex: 0,
    inFlight: null,
    total: 0,
    queued: 0,
    orderedQueued: 0,
    tailQueued: 0,
    duplicatesSuppressed: 0,
    nonRemainingRows: 0,
    startedAt: null,
    completedAt: null,
  };
}

function newApplyState_() {
  return {
    segmentIndex: 0,
    shardIndex: 0,
    offset: 0,
    inFlight: null,
    total: 0,
    processed: 0,
    exported: 0,
    gone: 0,
    rawBytes: 0,
    storedBytes: 0,
    batches: 0,
    activeRuntimeMs: 0,
    ewmaMsPerMessage: null,
    ewmaWallMsPerMessage: null,
    ewmaBytesPerMessage: null,
    startedAt: null,
    completedAt: null,
    lastBatchAt: null,
    lastProgressAt: null,
  };
}

function loadState_() {
  const raw = propertiesService_().getScriptProperties().getProperty(backupConfig_().STATE_PROPERTY);
  return raw ? normalizeState_(JSON.parse(raw)) : null;
}

function normalizeState_(state) {
  if (!state) return state;
  state.exporterVersion = backupConfig_().VERSION;
  if (state.pausedAt === undefined) state.pausedAt = null;
  state.archiveConfig = Object.assign({
    shardCount: backupConfig_().SHARD_COUNT,
    preferredEncoding: backupConfig_().ARCHIVE_ENCODING,
    // Archives created before S3 support were necessarily Google Drive.
    storage: {kind: 'GOOGLE_DRIVE', bindingHash: 'GOOGLE_DRIVE'},
  }, state.archiveConfig || {});
  state.audit = Object.assign(newAuditState_(), state.audit || {});
  state.queue = Object.assign(newQueueState_(), state.queue || {});
  const priorApply = state.apply || {};
  state.apply = Object.assign(newApplyState_(), priorApply);
  if (priorApply.storedBytes === undefined) state.apply.storedBytes = Number(state.apply.rawBytes || 0);
  if (state.lastSliceMetrics === undefined) state.lastSliceMetrics = null;
  if (state.scan) {
    state.scan.pageTokenResets = Number(state.scan.pageTokenResets || 0);
    state.scan.generation = Number(state.scan.generation || 0);
    state.scan.chunkIndex = Number(state.scan.chunkIndex || 0);
    state.scan.chunksCommitted = Number(state.scan.chunksCommitted || 0);
  }
  return state;
}

function saveState_(state) {
  const raw = JSON.stringify(state);
  const rawBytes = utilitiesService_().newBlob(raw).getBytes().length;
  if (rawBytes > 8500) {
    throw new Error('Backup state exceeded the safe Apps Script property size: ' + rawBytes + ' bytes.');
  }
  propertiesService_().getScriptProperties().setProperty(backupConfig_().STATE_PROPERTY, raw);
}

function requireState_() {
  const state = loadState_();
  if (!state) throw new Error('Backup is not initialized. Run setupBackup() first.');
  assertArchiveConfiguration_(state);
  return state;
}

function assertArchiveConfiguration_(state) {
  if (!state || !state.archiveConfig) return;
  const established = Number(state.archiveConfig.shardCount || 0);
  if (established && established !== backupConfig_().SHARD_COUNT) {
    throw new Error(
      'SHARD_COUNT is part of the on-Drive archive format. This archive was initialized with ' +
      established + ' shard(s), but the script is configured for ' + backupConfig_().SHARD_COUNT +
      '. Restore the original value before continuing.'
    );
  }
  const establishedStorage = state.archiveConfig.storage || {
    kind: 'GOOGLE_DRIVE', bindingHash: 'GOOGLE_DRIVE',
  };
  const configuredStorage = archiveStorageIdentity_();
  if (String(establishedStorage.kind || 'GOOGLE_DRIVE') !== configuredStorage.kind ||
      String(establishedStorage.bindingHash || 'GOOGLE_DRIVE') !== configuredStorage.bindingHash) {
    throw new Error(
      'This archive is pinned to a different storage backend or S3 bucket/endpoint/prefix binding. ' +
      'Restore the original storage configuration. In-place backend switching is not supported.'
    );
  }
}

function assertCurrentGmailAccount_(state) {
  const profile = gmailCall_(function () {
    return gmailService_().Users.getProfile('me');
  }, 'Gmail.Users.getProfile account guard');
  assertBackupAccount_(state, profile.emailAddress || '');
  return profile;
}

function assertBackupAccount_(state, actualEmail) {
  const expected = String((state && state.account) || '').trim().toLowerCase();
  const actual = String(actualEmail || '').trim().toLowerCase();
  if (expected && actual && expected !== actual) {
    const error = new Error(
      'This Apps Script project is anchored to Gmail account ' + state.account +
      ', but the current execution is authenticated as ' + actualEmail +
      '. Use one private Apps Script project per mailbox; refusing to mix accounts.'
    );
    error.code = 'GMAIL_BACKUP_ACCOUNT_MISMATCH';
    throw error;
  }
}

function statusObject_(state) {
  if (!state || state.phase === BACKUP_PHASE.UNINITIALIZED) {
    return {phase: BACKUP_PHASE.UNINITIALIZED, message: 'Run setupBackup() first.'};
  }

  const progress = progressForState_(state);
  const eta = etaForState_(state);
  let rootUrl = null;
  try { rootUrl = state.rootFolderId ? driveService_().getFolderById(state.rootFolderId).getUrl() : null; } catch (ignored) {}

  const remainingMessages = state.apply ? Math.max(0, Number(state.apply.total || 0) - Number(state.apply.processed || 0)) : null;
  const estimatedApplyBytes = state.apply && Number(state.apply.ewmaBytesPerMessage || 0) > 0
    ? Math.round(Number(state.apply.rawBytes || 0) + remainingMessages * Number(state.apply.ewmaBytesPerMessage))
    : null;
  const activePhase = [BACKUP_PHASE.SCANNING, BACKUP_PHASE.AUDITING, BACKUP_PHASE.QUEUEING, BACKUP_PHASE.APPLYING].indexOf(effectivePhase_(state)) !== -1;
  const estimatedCompletionAt = activePhase && eta.seconds !== null && eta.seconds !== undefined
    ? new Date(Date.now() + eta.seconds * 1000).toISOString()
    : (state.phase === BACKUP_PHASE.COMPLETE && state.apply && state.apply.completedAt ? state.apply.completedAt : null);

  return {
    schemaVersion: 1,
    exporterVersion: backupConfig_().VERSION,
    phase: state.phase,
    effectivePhase: effectivePhase_(state),
    account: state.account || null,
    target: {
      archiveRootFolderId: state.rootFolderId || backupConfig_().TARGET_ROOT_FOLDER_ID || null,
      configuredRootFolderId: backupConfig_().TARGET_ROOT_FOLDER_ID || null,
      configuredParentFolderId: backupConfig_().TARGET_PARENT_FOLDER_ID || null,
    },
    planId: state.plan ? state.plan.id : null,
    planEstimate: state.plan && state.plan.estimate ? state.plan.estimate : null,
    progressPercent: progress.percent,
    progressCurrent: progress.current,
    progressTotal: progress.total,
    progressLabel: progress.label,
    progressBar: progressBar_(progress.percent, 32),
    etaSeconds: eta.seconds,
    eta: eta.text,
    etaConfidence: eta.confidence,
    etaBasis: eta.basis,
    estimatedCompletionAt: estimatedCompletionAt,
    estimatedApplyBytes: estimatedApplyBytes,
    estimatedApplyBytesText: estimatedApplyBytes === null ? null : formatBytes_(estimatedApplyBytes),
    scan: state.scan || null,
    audit: state.audit || null,
    queue: state.queue || null,
    apply: state.apply || null,
    lastError: state.lastError || null,
    retryNotBefore: state.retryNotBefore || null,
    pauseRequestedAt: getPauseRequestedAt_(),
    pausedAt: state.pausedAt || null,
    updatedAt: state.updatedAt || null,
    rootFolderUrl: rootUrl,
    lastSliceMetrics: state.lastSliceMetrics || null,
  };
}

function effectivePhase_(state) {
  if ((state.phase === BACKUP_PHASE.PAUSED || state.phase === BACKUP_PHASE.ERROR) && state.previousPhase) {
    return state.previousPhase;
  }
  return state.phase;
}

function progressForState_(state) {
  const phase = effectivePhase_(state);

  if (phase === BACKUP_PHASE.SCANNING && state.scan) {
    const estimate = Math.max(Number(state.scan.resultSizeEstimate || 0), Number(state.scan.rowsSeenThisPass || 0), 1);
    const passFraction = (Number(state.scan.pass || 1) - 1) + Math.min(1, Number(state.scan.rowsSeenThisPass || 0) / estimate);
    const totalPasses = Math.max(1, Number(state.scan.passes || 1));
    return {
      current: Number(passFraction.toFixed(4)),
      total: totalPasses,
      percent: clamp_(100 * passFraction / totalPasses, 0, 99.9),
      label: 'scan pass ' + state.scan.pass + '/' + totalPasses,
    };
  }

  if (phase === BACKUP_PHASE.AUDITING && state.audit) {
    return {
      current: Number(state.audit.shardIndex || 0),
      total: backupConfig_().SHARD_COUNT,
      percent: clamp_(100 * Number(state.audit.shardIndex || 0) / backupConfig_().SHARD_COUNT, 0, 99.9),
      label: 'audit archive shards',
    };
  }

  if (phase === BACKUP_PHASE.QUEUEING && state.queue) {
    const orderedUnits = state.queue.order === BACKUP_APPLY_ORDER.SHARDED_ID
      ? 0
      : Number((state.scan || {}).finalPassChunkCount || 0);
    const totalUnits = Math.max(1, orderedUnits + backupConfig_().SHARD_COUNT + 1);
    let current = 0;
    if (state.queue.stage === 'ORDERED') current = Number(state.queue.sourceIndex || 0);
    if (state.queue.stage === 'TAIL') current = orderedUnits + Number(state.queue.tailShardIndex || 0);
    if (state.queue.stage === 'FINALIZING') current = totalUnits - 1;
    return {
      current: current,
      total: totalUnits,
      percent: clamp_(100 * current / totalUnits, 0, 99.9),
      label: 'build ' + state.queue.order + ' immutable work queue',
    };
  }

  if ((phase === BACKUP_PHASE.APPLYING || phase === BACKUP_PHASE.COMPLETE) && state.apply) {
    const total = Math.max(0, Number(state.apply.total || 0));
    const current = Math.min(total, Number(state.apply.processed || 0));
    return {
      current: current,
      total: total,
      percent: total === 0 ? 100 : clamp_(100 * current / total, 0, phase === BACKUP_PHASE.COMPLETE ? 100 : 99.9),
      label: 'messages applied',
    };
  }

  if (phase === BACKUP_PHASE.PLANNED && state.audit) {
    const planned = Math.max(0, Number(state.audit.planned || 0));
    return {
      current: planned,
      total: planned,
      percent: 100,
      label: 'plan complete; ' + Number(state.audit.remaining || 0) + ' message(s) remain',
    };
  }

  return {current: 0, total: 0, percent: phase === BACKUP_PHASE.COMPLETE ? 100 : 0, label: phase};
}

function etaForState_(state) {
  if (state.phase === BACKUP_PHASE.PAUSED) {
    return {seconds: null, text: 'paused', confidence: 'n/a', basis: 'paused'};
  }
  if (state.phase === BACKUP_PHASE.ERROR) {
    return {seconds: null, text: 'stopped on error', confidence: 'n/a', basis: 'error'};
  }

  const phase = effectivePhase_(state);
  const progress = progressForState_(state);
  if (phase === BACKUP_PHASE.COMPLETE) return {seconds: 0, text: 'complete', confidence: 'high', basis: 'complete'};
  if (phase === BACKUP_PHASE.PLANNED) return {seconds: 0, text: 'ready to apply', confidence: 'high', basis: 'plan complete'};

  if (phase === BACKUP_PHASE.APPLYING && state.apply) {
    const remaining = Math.max(0, Number(state.apply.total || 0) - Number(state.apply.processed || 0));
    if (remaining === 0) return {seconds: 0, text: 'finishing checkpoints', confidence: 'high', basis: 'no messages remaining'};

    const activeMs = Number(state.apply.ewmaMsPerMessage || 0);
    const wallMs = Number(state.apply.ewmaWallMsPerMessage || 0);
    if (activeMs > 0 || wallMs > 0) {
      // The wall-clock EWMA learns trigger gaps; before it stabilizes, add a
      // modest checkpoint/scheduler overhead to the active processing EWMA.
      const estimatedMsPerMessage = wallMs > 0 ? Math.max(activeMs, wallMs) : activeMs * 1.15;
      let seconds = Math.round(remaining * estimatedMsPerMessage / 1000);
      if (state.retryNotBefore) {
        seconds += Math.max(0, Math.round((Date.parse(state.retryNotBefore) - Date.now()) / 1000));
      }
      const processed = Number(state.apply.processed || 0);
      const batches = Number(state.apply.batches || 0);
      return {
        seconds: seconds,
        text: formatDuration_(seconds),
        confidence: processed >= 500 && batches >= 20 ? 'high' : processed >= 50 && batches >= 5 ? 'medium' : 'low',
        basis: wallMs > 0 ? 'observed wall-clock EWMA' : 'active batch EWMA plus scheduler allowance',
      };
    }
  }

  let startedAt = null;
  if (phase === BACKUP_PHASE.SCANNING && state.scan) startedAt = state.scan.startedAt;
  if (phase === BACKUP_PHASE.AUDITING && state.audit) startedAt = state.audit.startedAt;
  if (phase === BACKUP_PHASE.QUEUEING && state.queue) startedAt = state.queue.startedAt;
  if (startedAt && progress.current > 0 && progress.total > progress.current) {
    const elapsedSeconds = Math.max(1, (Date.now() - Date.parse(startedAt)) / 1000);
    let seconds = Math.round(elapsedSeconds * (progress.total - progress.current) / progress.current);
    if (state.retryNotBefore) {
      seconds += Math.max(0, Math.round((Date.parse(state.retryNotBefore) - Date.now()) / 1000));
    }
    return {
      seconds: seconds,
      text: formatDuration_(seconds),
      confidence: progress.current / progress.total > 0.2 ? 'medium' : 'low',
      basis: 'elapsed wall time and current phase fraction',
    };
  }

  return {seconds: null, text: 'estimating…', confidence: 'low', basis: 'insufficient samples'};
}

function formatStatusText_(state) {
  if (!state || state.phase === BACKUP_PHASE.UNINITIALIZED) return 'Gmail backup is not initialized. Run setupBackup().';
  const status = statusObject_(state);
  const lines = [];
  lines.push('GMAIL OFFLINE BACKUP');
  lines.push('Phase: ' + status.phase + (status.effectivePhase !== status.phase ? ' (' + status.effectivePhase + ' checkpoint preserved)' : ''));
  if (status.account) lines.push('Account: ' + status.account);
  if (status.target && status.target.archiveRootFolderId) {
    lines.push('Archive root folder ID: ' + status.target.archiveRootFolderId);
  }
  if (status.planId) lines.push('Plan: ' + status.planId);
  lines.push(status.progressBar + ' ' + status.progressPercent.toFixed(1) + '%');
  lines.push('Progress: ' + status.progressCurrent + ' / ' + status.progressTotal + ' (' + status.progressLabel + ')');
  lines.push('ETA: ' + status.eta + ' [' + status.etaConfidence + ' confidence; ' + status.etaBasis + ']');
  if (status.estimatedCompletionAt) lines.push('Estimated completion: ' + status.estimatedCompletionAt);

  if (state.scan) {
    lines.push('Scan: pass ' + state.scan.pass + '/' + state.scan.passes +
      ', pages committed ' + state.scan.pagesCommitted +
      ', list rows seen ' + state.scan.rowsSeen +
      ', current estimate ' + state.scan.resultSizeEstimate +
      ', page-token restarts ' + Number(state.scan.pageTokenResets || 0));
  }
  if (state.audit) {
    lines.push('Plan totals: planned ' + state.audit.planned +
      ', committed/present ' + state.audit.alreadyPresent +
      ', remaining ' + state.audit.remaining +
      ', uncommitted files ' + Number(state.audit.uncommittedCanonicalFiles || 0) +
      ', catalog mismatches ' + Number(state.audit.catalogMismatches || 0) +
      ', orphans retained ' + state.audit.orphanFiles);
    if (Number(state.audit.duplicateCanonicalNames || 0) || Number(state.audit.invalidFiles || 0)) {
      lines.push('Archive anomalies: duplicate canonical names ' + Number(state.audit.duplicateCanonicalNames || 0) +
        ', non-canonical files in data shards ' + Number(state.audit.invalidFiles || 0));
    }
  }
  if (state.queue) {
    lines.push('Queue: order ' + state.queue.order +
      ', stage ' + state.queue.stage +
      ', queued ' + Number(state.queue.queued || 0) + '/' + Number(state.queue.total || 0) +
      ', segments ' + Number(state.queue.segmentIndex || 0) +
      ', final-scan fallback ' + Number(state.queue.tailQueued || 0));
    if (state.queue.inFlight) {
      lines.push('Queue in-flight checkpoint: ' + state.queue.inFlight.kind + ' ' + state.queue.inFlight.key);
    }
  }
  if (state.phase === BACKUP_PHASE.PLANNED && state.plan && state.plan.estimate) {
    const estimate = state.plan.estimate;
    lines.push('PLAN estimate: exact remaining ' + Number(estimate.exactRemainingMessages || 0).toLocaleString() +
      ', raw payload ' + String(estimate.rawPayload && estimate.rawPayload.typical || 'unknown') +
      ', stored payload ' + String(estimate.storedPayload && estimate.storedPayload.typical || 'unknown'));
    if (estimate.apply) {
      lines.push('Estimated APPLY: ' + estimate.apply.low + ' low / ' + estimate.apply.typical +
        ' typical / ' + estimate.apply.high + ' high [' + estimate.apply.confidence + ' confidence]');
      lines.push('Estimated APPLY quota-day floor: ' + estimate.apply.lowQuotaDays + ' low / ' +
        estimate.apply.typicalQuotaDays + ' typical / ' + estimate.apply.highQuotaDays + ' high');
    }
  }
  if (state.apply) {
    const storedBytes = Number(state.apply.storedBytes || state.apply.rawBytes || 0);
    lines.push('Apply: processed ' + state.apply.processed + '/' + state.apply.total +
      ', exported ' + state.apply.exported +
      ', vanished ' + state.apply.gone +
      ', raw ' + formatBytes_(state.apply.rawBytes) +
      ', stored ' + formatBytes_(storedBytes));
    if (status.estimatedApplyBytesText) lines.push('Estimated payload for this APPLY plan: ' + status.estimatedApplyBytesText);
    if (state.apply.ewmaMsPerMessage) {
      lines.push('Observed active rate: ' + (1000 / state.apply.ewmaMsPerMessage).toFixed(2) + ' messages/sec' +
        (state.apply.ewmaBytesPerMessage ? ', average ' + formatBytes_(state.apply.ewmaBytesPerMessage) + '/message' : ''));
    }
    if (state.apply.ewmaWallMsPerMessage) {
      lines.push('Observed wall-clock rate: ' + (1000 / state.apply.ewmaWallMsPerMessage).toFixed(2) + ' messages/sec');
    }
    if (state.apply.inFlight) {
      lines.push('In-flight checkpoint: queue segment ' + state.apply.inFlight.segmentIndex +
        ', offsets [' + state.apply.inFlight.start + ', ' + state.apply.inFlight.endExclusive + ')');
    }
  }
  if (state.phase === BACKUP_PHASE.PLANNED) lines.push('Next action: review plan.json, then run applyBackup().');
  if (state.phase === BACKUP_PHASE.COMPLETE) lines.push('Next action: run planBackup() again to calculate the post-run delta, then download/sync the archive offline.');
  if (status.pauseRequestedAt) lines.push('Pause requested at: ' + status.pauseRequestedAt + ' (waiting for safe checkpoint)');
  if (status.pausedAt) lines.push('Paused/stopped at: ' + status.pausedAt);
  if (state.retryNotBefore) lines.push('Retry not before: ' + state.retryNotBefore);
  if (state.lastError) lines.push('Last error: ' + state.lastError.message);
  if (status.rootFolderUrl) lines.push('Drive: ' + status.rootFolderUrl);
  lines.push('Updated: ' + (state.updatedAt || isoNow_()));
  return lines.join('\n');
}

function updateStatusFiles_(state) {
  if (!state || !state.rootFolderId) return;
  const root = driveService_().getFolderById(state.rootFolderId);
  upsertTextFile_(root, backupConfig_().STATUS_TEXT_FILE, formatStatusText_(state));
  upsertTextFile_(root, backupConfig_().STATUS_JSON_FILE, JSON.stringify(statusObject_(state), null, 2));
}

function safeUpdateStatusFiles_(state) {
  try {
    updateStatusFiles_(state);
  } catch (error) {
    logger_().warn('Unable to refresh progress files; backup checkpoints remain valid: ' + errorToString_(error));
  }
}

function getPauseRequestedAt_() {
  return propertiesService_().getScriptProperties().getProperty(backupConfig_().PAUSE_REQUEST_PROPERTY) || null;
}

function isPauseRequested_() {
  return Boolean(getPauseRequestedAt_());
}

function clearPauseRequest_() {
  propertiesService_().getScriptProperties().deleteProperty(backupConfig_().PAUSE_REQUEST_PROPERTY);
}

function applyPauseRequest_(state) {
  const requestedAt = getPauseRequestedAt_();
  if (!requestedAt) return false;
  clearPauseRequest_();
  if ([BACKUP_PHASE.SCANNING, BACKUP_PHASE.AUDITING, BACKUP_PHASE.QUEUEING, BACKUP_PHASE.APPLYING].indexOf(state.phase) === -1) {
    return false;
  }
  state.previousPhase = state.phase;
  state.phase = BACKUP_PHASE.PAUSED;
  state.pausedAt = isoNow_();
  state.updatedAt = state.pausedAt;
  saveState_(state);
  removeWorkerTriggers_();
  safeUpdateStatusFiles_(state);
  logger_().log('Backup paused after a safe checkpoint. Pause requested at ' + requestedAt + '.');
  return true;
}

function ensureWorkerTrigger_() {
  const runtime = currentBackupRuntime_();
  if (runtime && runtime.continuationMode !== 'AUTO_TRIGGER') {
    logger_().log(
      'Injected runtime is in MANUAL continuation mode; invoke ' +
      'GmailBackupLibrary.worker(runtime) until the active phase completes.'
    );
    return false;
  }
  const handler = backupConfig_().WORKER_FUNCTION;
  const existing = scriptService_().getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === handler;
  });
  if (existing.length === 0) {
    scriptService_().newTrigger(handler).timeBased().everyMinutes(backupConfig_().WORKER_TRIGGER_MINUTES).create();
  } else if (existing.length > 1) {
    existing.slice(1).forEach(function (trigger) {
      safeDeleteTrigger_(trigger, 'duplicate worker trigger');
    });
  }
  return true;
}

function removeWorkerTriggers_() {
  const handler = backupConfig_().WORKER_FUNCTION;
  scriptService_().getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handler) {
      safeDeleteTrigger_(trigger, 'worker trigger cleanup');
    }
  });
}

/**
 * Best-effort trigger deletion. A transient ScriptApp.deleteTrigger backend
 * failure must never corrupt or fail an otherwise durable Gmail checkpoint.
 * The worker is phase-gated and lock-protected, so an undeleted trigger may
 * cause harmless future invocations but cannot re-apply completed work.
 */
function safeDeleteTrigger_(trigger, context) {
  if (!trigger) return true;
  try {
    scriptService_().deleteTrigger(trigger);
    return true;
  } catch (error) {
    logger_().warn('[GMAIL-BACKUP] Could not delete ' + (context || 'trigger') + ': ' + errorToString_(error));
    return false;
  }
}
