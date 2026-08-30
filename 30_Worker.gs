/**
 * Trigger target. Do not rename without updating BACKUP_CONFIG.WORKER_FUNCTION.
 * It is safe to invoke manually.
 */
function gmailBackupWorkerAction_() {
  const lock = lockService_().getScriptLock();
  if (!lock.tryLock(1000)) {
    logger_().log('Another Gmail backup execution is active; this invocation is exiting.');
    return;
  }

  let state = null;
  let phaseBefore = null;
  const startedMs = Date.now();
  try {
    state = loadState_();
    if (!state) return;
    phaseBefore = state.phase;
    assertArchiveConfiguration_(state);
    logProgressEvent_('WORKER_SLICE_STARTED', state);
    const activePhase = [BACKUP_PHASE.SCANNING, BACKUP_PHASE.AUDITING, BACKUP_PHASE.QUEUEING, BACKUP_PHASE.APPLYING].indexOf(state.phase) !== -1;

    // A pending pause is allowed to bypass retry backoff, but still verify the
    // effective Gmail account before mutating an active project checkpoint.
    if (isPauseRequested_() && activePhase) assertCurrentGmailAccount_(state);
    if (applyPauseRequest_(state)) return;

    if (state.retryNotBefore && Date.now() < Date.parse(state.retryNotBefore)) {
      logProgressEvent_('WORKER_BACKOFF', state, {retryNotBefore: state.retryNotBefore});
      return;
    }

    if (activePhase) assertCurrentGmailAccount_(state);

    if (state.phase === BACKUP_PHASE.SCANNING) {
      processScanSlice_(state, startedMs);
    } else if (state.phase === BACKUP_PHASE.AUDITING) {
      processAuditSlice_(state, startedMs);
    } else if (state.phase === BACKUP_PHASE.QUEUEING) {
      processQueueSlice_(state, startedMs);
    } else if (state.phase === BACKUP_PHASE.APPLYING) {
      processApplySlice_(state, startedMs);
    } else {
      if ([BACKUP_PHASE.PLANNED, BACKUP_PHASE.COMPLETE, BACKUP_PHASE.PAUSED, BACKUP_PHASE.ERROR].indexOf(state.phase) !== -1) {
        removeWorkerTriggers_();
      }
    }

    if (applyPauseRequest_(state)) return;

    state.consecutiveErrors = 0;
    state.retryNotBefore = null;
    state.lastError = null;
    state.updatedAt = isoNow_();
    saveState_(state);
    safeUpdateStatusFiles_(state);
    logProgressEvent_('WORKER_SLICE_COMPLETED', state, {
      phaseBefore: phaseBefore,
      durationMs: Date.now() - startedMs,
    });

    if ([BACKUP_PHASE.SCANNING, BACKUP_PHASE.AUDITING, BACKUP_PHASE.QUEUEING, BACKUP_PHASE.APPLYING].indexOf(state.phase) !== -1) {
      ensureWorkerTrigger_();
    } else {
      removeWorkerTriggers_();
    }
  } catch (error) {
    // A manual execution by the wrong user must not poison the shared project
    // checkpoint or back off the legitimate trigger owner.
    if (error && error.code === 'GMAIL_BACKUP_ACCOUNT_MISMATCH') {
      logger_().error(error && error.stack ? error.stack : error);
      throw error;
    }
    if (state) {
      state.lastError = {
        at: isoNow_(),
        phase: state.phase,
        message: truncateString_(errorToString_(error), 1800),
      };
      state.consecutiveErrors = Number(state.consecutiveErrors || 0) + 1;
      const backoffMinutes = Math.min(60, Math.pow(2, Math.min(6, state.consecutiveErrors - 1)));
      state.retryNotBefore = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();

      // Repeated failures should become visible and stop burning trigger quota.
      if (state.consecutiveErrors >= 8) {
        state.previousPhase = state.phase;
        state.phase = BACKUP_PHASE.ERROR;
        state.pausedAt = state.pausedAt || isoNow_();
        removeWorkerTriggers_();
      }
      state.updatedAt = isoNow_();
      saveState_(state);
      try { safeUpdateStatusFiles_(state); } catch (ignored) {}
    }
    if (state) {
      logProgressEvent_('WORKER_SLICE_ERROR', state, {
        phaseBefore: phaseBefore,
        durationMs: Date.now() - startedMs,
        error: truncateString_(errorToString_(error), 1000),
      });
    }
    logger_().error(error && error.stack ? error.stack : error);
    throw error;
  } finally {
    lock.releaseLock();
  }
}
