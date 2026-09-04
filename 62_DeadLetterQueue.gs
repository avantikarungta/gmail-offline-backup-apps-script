// -----------------------------------------------------------------------------
// Durable APPLY attempt tracking and per-plan dead-letter evidence
// -----------------------------------------------------------------------------

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
    if (record.status !== 'exported' && record.status !== 'gone' && record.status !== 'dead-lettered') {
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

function applyAttemptCount_(inFlight) {
  if (!inFlight) return 0;
  const explicit = Number(inFlight.attemptCount);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  // A legacy in-flight checkpoint proves that one export attempt started. It
  // predates durable counting, so preserve compatibility without granting an
  // unbounded set of fresh retries after upgrade.
  return Number(inFlight.schemaVersion || 0) < 3 ? 1 : 0;
}

function beginApplyAttempt_(state) {
  const inFlight = state && state.apply && state.apply.inFlight;
  if (!inFlight) throw new Error('Cannot begin APPLY attempt without an in-flight checkpoint.');
  const attempts = applyAttemptCount_(inFlight);
  if (attempts >= Number(backupConfig_().APPLY_MAX_MESSAGE_ATTEMPTS)) {
    throw new Error('Cannot begin APPLY attempt after its durable retry limit.');
  }
  inFlight.schemaVersion = 3;
  inFlight.attemptCount = attempts + 1;
  inFlight.lastAttemptAt = isoNow_();
  state.updatedAt = inFlight.lastAttemptAt;
  saveState_(state);
  logProgressEvent_('APPLY_ATTEMPT_STARTED', state, {
    segmentIndex: Number(inFlight.segmentIndex),
    start: Number(inFlight.start),
    endExclusive: Number(inFlight.endExclusive),
    attempt: Number(inFlight.attemptCount),
    maxAttempts: Number(backupConfig_().APPLY_MAX_MESSAGE_ATTEMPTS),
  });
}

function shouldDeadLetterInFlight_(inFlight) {
  return applyAttemptCount_(inFlight) >= Number(backupConfig_().APPLY_MAX_MESSAGE_ATTEMPTS);
}

function buildDeadLetterCommit_(state, segmentIndex, start, endExclusive, entries) {
  if (Number(endExclusive) !== Number(start) + 1 || !entries || entries.length !== 1) {
    throw new Error('Refusing to dead-letter anything other than one exact queue entry.');
  }
  const entry = entries[0];
  const inFlight = state.apply.inFlight;
  const recordedAt = isoNow_();
  const record = {
    id: entry.id,
    threadId: entry.threadId || '',
    archiveShard: shardForId_(entry.id),
    queueSegment: Number(segmentIndex),
    queueOffset: Number(start),
    status: 'dead-lettered',
    reasonCode: 'APPLY_ATTEMPTS_EXHAUSTED',
    reason: 'No valid APPLY commit was published after the durable per-message attempt limit.',
    attemptCount: applyAttemptCount_(inFlight),
    checkpointCreatedAt: inFlight.createdAt || null,
    lastAttemptAt: inFlight.lastAttemptAt || null,
    recordedAt: recordedAt,
  };
  persistDeadLetterRecord_(state, record);
  logProgressEvent_('APPLY_MESSAGE_DEAD_LETTERED', state, {
    segmentIndex: Number(segmentIndex),
    offset: Number(start),
    attempts: Number(record.attemptCount),
    deadLetterFile: backupConfig_().DEAD_LETTER_FILE,
  });
  return {
    schemaVersion: 3,
    planId: state.plan.id,
    queueSegment: Number(segmentIndex),
    start: Number(start),
    endExclusive: Number(endExclusive),
    createdAt: recordedAt,
    durationMs: 1,
    finishedAt: recordedAt,
    summary: {
      processed: 1,
      exported: 0,
      gone: 0,
      deadLettered: 1,
      rawBytes: 0,
      storedBytes: 0,
    },
    records: [record],
  };
}

function persistDeadLetterRecord_(state, record) {
  const planFolder = driveService_().getFolderById(state.plan.folderId);
  const name = backupConfig_().DEAD_LETTER_FILE;
  const file = firstFileByName_(planFolder, name);
  const queue = file ? readJsonFile_(file, null) : {
    schemaVersion: 1,
    exporterVersion: backupConfig_().VERSION,
    planId: state.plan.id,
    createdAt: isoNow_(),
    updatedAt: null,
    count: 0,
    entries: [],
  };
  validateDeadLetterQueue_(queue, state.plan.id);
  const byId = {};
  (queue.entries || []).forEach(function (existing) {
    if (existing && existing.id) byId[existing.id] = existing;
  });
  const prior = byId[record.id] || null;
  byId[record.id] = Object.assign({}, prior || {}, record, {
    firstRecordedAt: prior && prior.firstRecordedAt || prior && prior.recordedAt || record.recordedAt,
  });
  queue.exporterVersion = backupConfig_().VERSION;
  queue.updatedAt = isoNow_();
  queue.entries = Object.keys(byId).map(function (id) { return byId[id]; }).sort(function (a, b) {
    return Number(a.queueSegment) - Number(b.queueSegment) ||
      Number(a.queueOffset) - Number(b.queueOffset) || String(a.id).localeCompare(String(b.id));
  });
  queue.count = queue.entries.length;
  return upsertJsonFile_(planFolder, name, queue);
}

function validateDeadLetterQueue_(queue, planId) {
  if (!queue || Number(queue.schemaVersion) !== 1 || queue.planId !== planId || !Array.isArray(queue.entries)) {
    throw new Error('Invalid or mismatched per-plan dead-letter queue.');
  }
  const seen = {};
  queue.entries.forEach(function (entry) {
    if (!entry || !entry.id || seen[entry.id] || entry.status !== 'dead-lettered') {
      throw new Error('Dead-letter queue contains a missing, duplicate, or invalid Gmail ID record.');
    }
    seen[entry.id] = true;
  });
}

function validateDeadLetterCommitEvidence_(state, commit) {
  const records = (commit.records || []).filter(function (record) {
    return record && record.status === 'dead-lettered';
  });
  if (!records.length) return;
  const planFolder = driveService_().getFolderById(state.plan.folderId);
  const file = firstFileByName_(planFolder, backupConfig_().DEAD_LETTER_FILE);
  const queue = file ? readJsonFile_(file, null) : null;
  validateDeadLetterQueue_(queue, state.plan.id);
  const byId = {};
  queue.entries.forEach(function (entry) { byId[entry.id] = entry; });
  records.forEach(function (record) {
    const evidence = byId[record.id];
    if (!evidence || Number(evidence.queueSegment) !== Number(commit.queueSegment) ||
        Number(evidence.queueOffset) < Number(commit.start) ||
        Number(evidence.queueOffset) >= Number(commit.endExclusive)) {
      throw new Error('Dead-letter APPLY commit is missing its durable queue evidence.');
    }
  });
}
