/**
 * Validates Gmail API access and creates the root Drive layout.
 * Safe to run repeatedly.
 */
function setupBackupAction_() {
  return withScriptLock_(function () {
    validateConfiguration_();
    const profile = gmailCall_(function () {
      return gmailService_().Users.getProfile('me');
    }, 'Gmail.Users.getProfile');
    let state = loadState_();
    assertArchiveConfiguration_(state);
    assertBackupAccount_(state, profile.emailAddress || '');

    const preflightParams = {
      maxResults: 1,
      includeSpamTrash: backupConfig_().INCLUDE_SPAM_TRASH,
      fields: 'messages(id,threadId),resultSizeEstimate',
    };
    if (backupConfig_().GMAIL_QUERY) preflightParams.q = backupConfig_().GMAIL_QUERY;
    const preflightList = gmailCall_(function () {
      return gmailService_().Users.Messages.list('me', preflightParams);
    }, 'Gmail.Users.Messages.list preflight');
    const preflightMessages = preflightList.messages || [];
    let rawMessagePreflightBytes = null;
    if (preflightMessages.length > 0) {
      const preflightMessage = gmailCall_(function () {
        return gmailService_().Users.Messages.get('me', preflightMessages[0].id, {
          format: 'raw',
          fields: 'id,raw',
        });
      }, 'Gmail.Users.Messages.get raw preflight');
      if (!preflightMessage || !preflightMessage.raw) {
        throw new Error('Gmail API preflight returned no raw RFC message content.');
      }
      rawMessagePreflightBytes = gmailRawBytes_(preflightMessage.raw).length;
    }

    const layout = ensureRootLayout_(
      state && state.rootFolderId,
      archiveRootContext_(state, profile.emailAddress || '', true)
    );
    if (!state) {
      state = newBaseState_(layout.root.getId());
    } else {
      state.rootFolderId = layout.root.getId();
      state.updatedAt = isoNow_();
    }
    state.account = profile.emailAddress || state.account || '';
    state.lastError = null;
    saveState_(state);
    safeUpdateStatusFiles_(state);

    const result = {
      ok: true,
      phase: state.phase,
      account: state.account,
      rootFolderUrl: layout.root.getUrl(),
      messageCountReportedByProfile: Number(profile.messagesTotal || 0),
      threadCountReportedByProfile: Number(profile.threadsTotal || 0),
      listPreflightResultEstimate: Number(preflightList.resultSizeEstimate || 0),
      rawMessagePreflightBytes: rawMessagePreflightBytes,
    };
    logger_().log(JSON.stringify(result, null, 2));
    return result;
  });
}

/**
 * PLAN mode.
 *
 * Starts a new immutable plan generation, scans all matching Gmail message IDs,
 * then audits Drive to calculate which IDs in that frozen local plan are not
 * backed by a committed canonical archive file.
 * The work is checkpointed and continued by a time-driven trigger.
 */
function planBackupAction_() {
  const result = withScriptLock_(function () {
    validateConfiguration_();
    const previous = loadState_();
    assertArchiveConfiguration_(previous);

    if (previous && [BACKUP_PHASE.SCANNING, BACKUP_PHASE.AUDITING, BACKUP_PHASE.QUEUEING, BACKUP_PHASE.APPLYING].indexOf(previous.phase) !== -1) {
      throw new Error('A backup operation is already active (' + previous.phase + '). Run pauseBackup() first if you intend to replace it.');
    }

    const profile = gmailCall_(function () {
      return gmailService_().Users.getProfile('me');
    }, 'Gmail.Users.getProfile');
    assertBackupAccount_(previous, profile.emailAddress || '');
    const layout = ensureRootLayout_(
      previous && previous.rootFolderId,
      archiveRootContext_(previous, profile.emailAddress || '', true)
    );
    const labelsResponse = gmailCall_(function () {
      return gmailService_().Users.Labels.list('me');
    }, 'Gmail.Users.Labels.list');

    const planId = makePlanId_();
    const planFolder = getOrCreateChildFolder_(layout.plans, planId);
    const planShardsFolder = getOrCreateChildFolder_(planFolder, 'mailbox-shards');
    const remainingFolder = getOrCreateChildFolder_(planFolder, 'remaining-shards');
    const auditFolder = getOrCreateChildFolder_(planFolder, 'audit');
    const commitsFolder = getOrCreateChildFolder_(planFolder, 'commits');
    const scanJournalFolder = getOrCreateChildFolder_(planFolder, 'scan-journal');
    const workQueueFolder = getOrCreateChildFolder_(planFolder, 'work-queue');
    const queueCommitsFolder = getOrCreateChildFolder_(planFolder, 'queue-commits');
    const queueSeenFolder = getOrCreateChildFolder_(planFolder, 'queue-seen');

    // Plan IDs are unique; if a collision somehow occurs, refuse to reuse a
    // non-empty generation rather than mixing snapshots.
    if (folderHasAnyFiles_(planShardsFolder) || folderHasAnyFiles_(remainingFolder) ||
        folderHasAnyFiles_(auditFolder) || folderHasAnyFiles_(scanJournalFolder) ||
        folderHasAnyFiles_(workQueueFolder) || folderHasAnyFiles_(queueCommitsFolder) ||
        folderHasAnyFiles_(queueSeenFolder)) {
      throw new Error('Plan folder collision: ' + planId);
    }

    const now = isoNow_();
    const state = newBaseState_(layout.root.getId());
    state.phase = BACKUP_PHASE.SCANNING;
    state.account = profile.emailAddress || '';
    state.plan = {
      id: planId,
      folderId: planFolder.getId(),
      shardsFolderId: planShardsFolder.getId(),
      remainingFolderId: remainingFolder.getId(),
      auditFolderId: auditFolder.getId(),
      commitsFolderId: commitsFolder.getId(),
      scanJournalFolderId: scanJournalFolder.getId(),
      workQueueFolderId: workQueueFolder.getId(),
      queueCommitsFolderId: queueCommitsFolder.getId(),
      queueSeenFolderId: queueSeenFolder.getId(),
      query: backupConfig_().GMAIL_QUERY,
      includeSpamTrash: backupConfig_().INCLUDE_SPAM_TRASH,
      shardCount: backupConfig_().SHARD_COUNT,
      applyOrder: backupConfig_().APPLY_ORDER,
      createdAt: now,
      completedAt: null,
      labelsFileId: null,
      summaryFileId: null,
      queueSummaryFileId: null,
      estimateFileId: null,
      estimate: null,
      priorApplyPerformance: priorApplyPerformance_(previous),
    };
    state.scan = {
      pass: 1,
      passes: backupConfig_().SCAN_PASSES,
      nextPageToken: '',
      pagesCommitted: 0,
      rowsSeen: 0,
      rowsSeenThisPass: 0,
      pageTokenResets: 0,
      generation: 0,
      chunkIndex: 0,
      chunksCommitted: 0,
      finalPassGeneration: null,
      finalPassChunkCount: null,
      finalPassRows: null,
      resultSizeEstimate: backupConfig_().GMAIL_QUERY ? 0 : Number(profile.messagesTotal || 0),
      historyIdStart: String(profile.historyId || ''),
      historyIdEnd: '',
      profileMessagesAtStart: Number(profile.messagesTotal || 0),
      profileThreadsAtStart: Number(profile.threadsTotal || 0),
      profileMessagesAtEnd: null,
      profileThreadsAtEnd: null,
      startedAt: now,
      completedAt: null,
    };
    state.audit = newAuditState_();
    state.queue = newQueueState_();
    state.apply = newApplyState_();
    state.previousPhase = null;
    state.pausedAt = null;
    state.lastError = null;

    const labelSnapshot = {
      schemaVersion: 1,
      planId: planId,
      capturedAt: now,
      account: state.account,
      labels: (labelsResponse.labels || []).map(function (label) {
        return {
          id: label.id,
          name: label.name,
          type: label.type,
          messageListVisibility: label.messageListVisibility || null,
          labelListVisibility: label.labelListVisibility || null,
        };
      }),
    };
    const labelsFile = upsertJsonFile_(planFolder, 'labels.json', labelSnapshot);
    state.plan.labelsFileId = labelsFile.getId();

    clearPauseRequest_();
    saveState_(state);
    ensureWorkerTrigger_();
    safeUpdateStatusFiles_(state);
    logProgressEvent_('PLAN_STARTED', state);
    return statusObject_(state);
  });

  // Do useful work immediately; the recurring trigger handles continuation.
  gmailBackupWorker();
  return result;
}

/**
 * APPLY mode.
 *
 * Exports only the message IDs identified as missing by the latest completed
 * plan. Existing canonical files are never duplicated.
 */
function applyBackupAction_() {
  const result = withScriptLock_(function () {
    const state = requireState_();
    assertCurrentGmailAccount_(state);
    if (state.phase === BACKUP_PHASE.APPLYING) {
      ensureWorkerTrigger_();
      logProgressEvent_('APPLY_ALREADY_RUNNING', state);
      return statusObject_(state);
    }
    if (state.phase !== BACKUP_PHASE.PLANNED && state.phase !== BACKUP_PHASE.COMPLETE) {
      throw new Error('applyBackup() requires a completed plan. Current phase: ' + state.phase);
    }
    if (!state.plan || !state.plan.id) {
      throw new Error('No plan is available. Run planBackup() first.');
    }
    if (!state.plan.workQueueFolderId || !state.queue || !state.queue.completedAt) {
      throw new Error('The current plan has no completed v1.2 ordered work queue. Run planBackup() again.');
    }

    // COMPLETE means this specific plan already finished. It is safe and useful
    // to make apply idempotent rather than resetting counters.
    if (state.phase === BACKUP_PHASE.COMPLETE && state.apply.processed >= state.apply.total) {
      safeUpdateStatusFiles_(state);
      logProgressEvent_('APPLY_ALREADY_COMPLETE', state);
      return statusObject_(state);
    }

    state.phase = BACKUP_PHASE.APPLYING;
    state.previousPhase = null;
    state.pausedAt = null;
    state.apply.startedAt = state.apply.startedAt || isoNow_();
    state.apply.lastBatchAt = null;
    state.apply.lastProgressAt = null;
    state.lastError = null;
    state.updatedAt = isoNow_();
    clearPauseRequest_();
    saveState_(state);
    ensureWorkerTrigger_();
    safeUpdateStatusFiles_(state);
    logProgressEvent_('APPLY_STARTED', state);
    return statusObject_(state);
  });

  gmailBackupWorker();
  return result;
}

/** Logs and returns a structured status object with progress and ETA. */
function backupStatusAction_() {
  let state = loadState_() || {phase: BACKUP_PHASE.UNINITIALIZED};

  // State properties are replaced as a single value, so a status read never
  // observes a partially written checkpoint. If the worker finishes while we
  // are waiting for the short lock, reload before updating Drive; otherwise a
  // stale status read could overwrite a newer STATUS.txt/status.json.
  if (state.rootFolderId) {
    const lock = lockService_().getScriptLock();
    if (lock.tryLock(1000)) {
      try {
        state = loadState_() || state;
        safeUpdateStatusFiles_(state);
      } finally {
        lock.releaseLock();
      }
    }
  }

  const status = statusObject_(state);
  logger_().log(formatStatusText_(state));
  return status;
}

/** Returns machine-oriented status without refreshing Drive status files. */
function agentStatusAction_() {
  const state = loadState_() || {phase: BACKUP_PHASE.UNINITIALIZED};
  return statusObject_(state);
}

/** Pauses active work and removes the recurring worker trigger. */
function pauseBackupAction_() {
  // Identity must be checked before even the lock-contended pause-request
  // property is written. Otherwise another editor executing as a different
  // Gmail user could stop the legitimate account's worker.
  const preflightState = requireState_();
  assertCurrentGmailAccount_(preflightState);
  const lock = lockService_().getScriptLock();
  if (!lock.tryLock(1000)) {
    const requestedAt = isoNow_();
    propertiesService_().getScriptProperties().setProperty(backupConfig_().PAUSE_REQUEST_PROPERTY, requestedAt);
    const status = statusObject_(preflightState);
    status.pauseRequested = true;
    status.pauseRequestedAt = requestedAt;
    logger_().log('Pause requested. The active worker will stop after its current safe checkpoint.');
    return status;
  }

  try {
    const state = requireState_();
    assertBackupAccount_(state, preflightState.account || '');
    clearPauseRequest_();
    const active = [BACKUP_PHASE.SCANNING, BACKUP_PHASE.AUDITING, BACKUP_PHASE.QUEUEING, BACKUP_PHASE.APPLYING];
    if (state.phase === BACKUP_PHASE.PAUSED || state.phase === BACKUP_PHASE.ERROR) {
      removeWorkerTriggers_();
      safeUpdateStatusFiles_(state);
      return statusObject_(state);
    }
    if (active.indexOf(state.phase) === -1) {
      removeWorkerTriggers_();
      safeUpdateStatusFiles_(state);
      return statusObject_(state);
    }

    state.previousPhase = state.phase;
    state.phase = BACKUP_PHASE.PAUSED;
    state.pausedAt = isoNow_();
    state.updatedAt = state.pausedAt;
    saveState_(state);
    removeWorkerTriggers_();
    safeUpdateStatusFiles_(state);
    logger_().log(formatStatusText_(state));
    return statusObject_(state);
  } finally {
    lock.releaseLock();
  }
}

/** Resumes the phase that was active before pauseBackup(). */
function resumeBackupAction_() {
  const result = withScriptLock_(function () {
    const state = requireState_();
    assertCurrentGmailAccount_(state);
    if (state.phase !== BACKUP_PHASE.PAUSED && state.phase !== BACKUP_PHASE.ERROR) {
      return statusObject_(state);
    }
    const resumable = state.previousPhase;
    if ([BACKUP_PHASE.SCANNING, BACKUP_PHASE.AUDITING, BACKUP_PHASE.QUEUEING, BACKUP_PHASE.APPLYING].indexOf(resumable) === -1) {
      throw new Error('There is no resumable active phase. Current previousPhase: ' + resumable);
    }

    // Exclude user-controlled PAUSED/ERROR downtime from elapsed-time ETAs.
    // Persisted retry backoff while still active remains included intentionally.
    const resumeMs = Date.now();
    const pausedMs = state.pausedAt ? Math.max(0, resumeMs - Date.parse(state.pausedAt)) : 0;
    if (pausedMs > 0) {
      if (resumable === BACKUP_PHASE.SCANNING && state.scan) {
        state.scan.startedAt = shiftIsoTimestamp_(state.scan.startedAt, pausedMs);
      } else if (resumable === BACKUP_PHASE.AUDITING && state.audit) {
        state.audit.startedAt = shiftIsoTimestamp_(state.audit.startedAt, pausedMs);
      } else if (resumable === BACKUP_PHASE.QUEUEING && state.queue) {
        state.queue.startedAt = shiftIsoTimestamp_(state.queue.startedAt, pausedMs);
      } else if (resumable === BACKUP_PHASE.APPLYING && state.apply) {
        state.apply.startedAt = shiftIsoTimestamp_(state.apply.startedAt, pausedMs);
      }
    }

    state.phase = resumable;
    state.previousPhase = null;
    state.pausedAt = null;
    state.lastError = null;
    state.retryNotBefore = null;
    state.consecutiveErrors = 0;
    if (resumable === BACKUP_PHASE.APPLYING && state.apply) state.apply.lastProgressAt = null;
    state.updatedAt = isoNow_();
    clearPauseRequest_();
    saveState_(state);
    ensureWorkerTrigger_();
    safeUpdateStatusFiles_(state);
    return statusObject_(state);
  });

  gmailBackupWorker();
  return result;
}
