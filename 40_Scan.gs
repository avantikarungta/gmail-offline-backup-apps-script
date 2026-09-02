// -----------------------------------------------------------------------------
// Scan / plan implementation
// -----------------------------------------------------------------------------

function processScanSlice_(state, executionStartedMs) {
  const planShardsFolder = driveService_().getFolderById(state.plan.shardsFolderId);
  const journalFolder = driveService_().getFolderById(state.plan.scanJournalFolderId);
  const pass = Number(state.scan.pass || 1);
  const generation = Number(state.scan.generation || 0);
  const chunkIndex = Number(state.scan.chunkIndex || 0);
  const checkpointName = scanJournalFileName_(pass, generation, chunkIndex);
  let checkpointFile = firstFileByName_(journalFolder, checkpointName);
  let checkpoint = null;

  // A scan journal chunk is a durable transaction boundary. If an execution
  // wrote the chunk but crashed before advancing Script Properties, the next
  // execution validates and replays that exact chunk without asking Gmail for
  // a potentially shifted page sequence again.
  if (checkpointFile) {
    checkpoint = readJsonFile_(checkpointFile, null);
    validateScanJournalChunk_(checkpoint, state, pass, generation, chunkIndex);
  } else {
    const startToken = state.scan.nextPageToken || '';
    let token = startToken;
    let pages = 0;
    let rows = 0;
    let passCompleted = false;
    let resultSizeEstimate = Number(state.scan.resultSizeEstimate || 0);
    const orderedMessages = [];
    const collectionStartedMs = Date.now();

    while (pages < backupConfig_().MAX_SCAN_PAGES_PER_EXECUTION &&
           Date.now() - collectionStartedMs < backupConfig_().SCAN_COLLECTION_BUDGET_MS &&
           Date.now() - executionStartedMs < backupConfig_().EXECUTION_BUDGET_MS) {
      const params = {
        maxResults: backupConfig_().SCAN_PAGE_SIZE,
        includeSpamTrash: Boolean(state.plan.includeSpamTrash),
        fields: 'messages(id,threadId),nextPageToken,resultSizeEstimate',
      };
      if (state.plan.query) params.q = state.plan.query;
      if (token) params.pageToken = token;

      let response;
      try {
        response = gmailCall_(function () {
          return gmailService_().Users.Messages.list('me', params);
        }, 'Gmail.Users.Messages.list');
      } catch (error) {
        // Page tokens can become invalid on a live mailbox. Discard any pages
        // collected in this not-yet-committed slice and restart the whole pass
        // under a new generation. Set-union shards remain safe; queue ordering
        // later uses only the final completed generation of the final pass.
        if (token && isInvalidPageTokenError_(error)) {
          state.scan.pageTokenResets = Number(state.scan.pageTokenResets || 0) + 1;
          state.scan.nextPageToken = '';
          state.scan.rowsSeenThisPass = 0;
          state.scan.generation = generation + 1;
          state.scan.chunkIndex = 0;
          state.updatedAt = isoNow_();
          saveState_(state);
          logger_().warn(
            'Gmail invalidated a list page token; restarting scan pass ' + pass +
            ' as generation ' + state.scan.generation + '.'
          );
          return;
        }
        throw error;
      }

      const messages = (response.messages || []).map(function (message) {
        return {id: message.id, threadId: message.threadId || ''};
      });
      Array.prototype.push.apply(orderedMessages, messages);
      pages += 1;
      rows += messages.length;
      resultSizeEstimate = Math.max(
        resultSizeEstimate,
        Number(response.resultSizeEstimate || 0),
        Number(state.scan.rowsSeenThisPass || 0) + rows
      );

      token = response.nextPageToken || '';
      if (!token) {
        passCompleted = true;
        break;
      }
    }

    if (pages === 0) return;

    checkpoint = {
      schemaVersion: 1,
      planId: state.plan.id,
      pass: pass,
      generation: generation,
      chunkIndex: chunkIndex,
      startPageToken: startToken,
      endPageToken: token,
      pages: pages,
      rows: rows,
      passCompleted: passCompleted,
      resultSizeEstimate: resultSizeEstimate,
      ordering: 'GMAIL_MESSAGES_LIST_NEWEST_FIRST',
      messages: orderedMessages,
      createdAt: isoNow_(),
    };
    checkpointFile = journalFolder.createFile(
      checkpointName,
      JSON.stringify(checkpoint),
      'text/plain'
    );
  }

  // Merge the durable journal into the exact set inventory. Replaying this
  // after a crash is harmless because the shard merge is ID-keyed.
  const bufferByShard = {};
  (checkpoint.messages || []).forEach(function (message) {
    const shard = shardForId_(message.id);
    if (!bufferByShard[shard]) bufferByShard[shard] = [];
    bufferByShard[shard].push({id: message.id, threadId: message.threadId || ''});
  });
  flushPlanShardBuffer_(planShardsFolder, bufferByShard);

  state.scan.pagesCommitted = Number(state.scan.pagesCommitted || 0) + Number(checkpoint.pages || 0);
  state.scan.rowsSeen = Number(state.scan.rowsSeen || 0) + Number(checkpoint.rows || 0);
  state.scan.rowsSeenThisPass = Number(state.scan.rowsSeenThisPass || 0) + Number(checkpoint.rows || 0);
  state.scan.nextPageToken = checkpoint.endPageToken || '';
  state.scan.resultSizeEstimate = Math.max(
    Number(state.scan.resultSizeEstimate || 0),
    Number(checkpoint.resultSizeEstimate || 0),
    Number(state.scan.rowsSeenThisPass || 0)
  );
  state.scan.chunkIndex = chunkIndex + 1;
  state.scan.chunksCommitted = Number(state.scan.chunksCommitted || 0) + 1;

  if (checkpoint.passCompleted) {
    if (pass < Number(state.scan.passes || 1)) {
      state.scan.pass = pass + 1;
      state.scan.nextPageToken = '';
      state.scan.rowsSeenThisPass = 0;
      state.scan.generation = 0;
      state.scan.chunkIndex = 0;
    } else {
      const endProfile = gmailCall_(function () {
        return gmailService_().Users.getProfile('me');
      }, 'Gmail.Users.getProfile');
      state.scan.finalPassGeneration = generation;
      state.scan.finalPassChunkCount = state.scan.chunkIndex;
      state.scan.finalPassRows = state.scan.rowsSeenThisPass;
      state.scan.historyIdEnd = String(endProfile.historyId || '');
      state.scan.profileMessagesAtEnd = Number(endProfile.messagesTotal || 0);
      state.scan.profileThreadsAtEnd = Number(endProfile.threadsTotal || 0);
      state.scan.completedAt = isoNow_();
      state.phase = BACKUP_PHASE.AUDITING;
      state.audit = newAuditState_();
      state.audit.startedAt = isoNow_();
    }
  }
}

function scanJournalFileName_(pass, generation, chunkIndex) {
  return 'pass-' + padNumber_(pass, 2) +
    '-gen-' + padNumber_(generation, 3) +
    '-chunk-' + padNumber_(chunkIndex, 8) + '.json';
}

function validateScanJournalChunk_(checkpoint, state, pass, generation, chunkIndex) {
  if (!checkpoint || checkpoint.planId !== state.plan.id ||
      Number(checkpoint.pass) !== Number(pass) ||
      Number(checkpoint.generation) !== Number(generation) ||
      Number(checkpoint.chunkIndex) !== Number(chunkIndex) ||
      String(checkpoint.startPageToken || '') !== String(state.scan.nextPageToken || '')) {
    throw new Error('Scan journal checkpoint does not match current state: ' +
      scanJournalFileName_(pass, generation, chunkIndex));
  }
  if (!Array.isArray(checkpoint.messages) ||
      Number(checkpoint.rows || 0) !== checkpoint.messages.length ||
      Number(checkpoint.pages || 0) < 1) {
    throw new Error('Scan journal checkpoint is malformed: ' +
      scanJournalFileName_(pass, generation, chunkIndex));
  }
  const seen = {};
  checkpoint.messages.forEach(function (entry) {
    if (!entry || !entry.id) throw new Error('Scan journal contains a missing Gmail ID.');
    // Duplicates can legitimately occur across pages on a changing mailbox;
    // they are retained in the journal and suppressed when the queue is built.
    seen[entry.id] = true;
  });
}

function flushPlanShardBuffer_(folder, bufferByShard) {
  const existingFiles = listFilesByName_(folder);
  Object.keys(bufferByShard).sort().forEach(function (shard) {
    const name = 'shard-' + shard + '.json';
    let conflictRetries = 0;
    while (true) {
      const file = conflictRetries === 0 ? (existingFiles[name] || null) : firstFileByName_(folder, name);
      const existing = file ? readJsonFile_(file, []) : [];
      const byId = {};
      let changed = !file;

      existing.forEach(function (entry) {
        if (entry && entry.id) byId[entry.id] = {id: entry.id, threadId: entry.threadId || ''};
      });
      bufferByShard[shard].forEach(function (entry) {
        if (!entry || !entry.id) return;
        const next = {id: entry.id, threadId: entry.threadId || ''};
        const prior = byId[entry.id];
        if (!prior || prior.threadId !== next.threadId) changed = true;
        byId[entry.id] = next;
      });

      // The second scan pass is normally almost identical to the first. Avoid a
      // storage mutation for every touched shard when the set union and thread
      // mappings did not change.
      if (!changed) return;
      const merged = Object.keys(byId).sort().map(function (id) { return byId[id]; });
      try {
        if (file) {
          file.setContent(JSON.stringify(merged));
        } else {
          existingFiles[name] = folder.createFile(name, JSON.stringify(merged), 'text/plain');
        }
        return;
      } catch (error) {
        if (!error || error.code !== 'S3_PRECONDITION_FAILED' || conflictRetries >= 2) throw error;
        conflictRetries++;
        logger_().warn(JSON.stringify({
          event: 'SCAN_SHARD_CONFLICT_RELOAD', shard: shard, attempt: conflictRetries,
        }));
      }
    }
  });
}
