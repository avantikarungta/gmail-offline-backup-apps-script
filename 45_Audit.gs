// -----------------------------------------------------------------------------
// Audit / PLAN delta implementation
// -----------------------------------------------------------------------------

function processAuditSlice_(state, executionStartedMs) {
  const metrics = newOperationMetrics_();
  const planShardsFolder = measureOperation_(metrics, 'drivePlanShardsFolder', function () {
    return driveService_().getFolderById(state.plan.shardsFolderId);
  });
  const remainingFolder = measureOperation_(metrics, 'driveRemainingFolder', function () {
    return driveService_().getFolderById(state.plan.remainingFolderId);
  });
  const auditFolder = measureOperation_(metrics, 'driveAuditFolder', function () {
    return driveService_().getFolderById(state.plan.auditFolderId);
  });
  const layout = measureOperation_(metrics, 'driveRootLayout', function () {
    return ensureRootLayout_(state.rootFolderId, archiveRootContext_(state));
  });

  const planFiles = measureOperation_(metrics, 'drivePlanShardList', function () {
    return listFilesByName_(planShardsFolder);
  });
  const auditFiles = measureOperation_(metrics, 'driveAuditList', function () {
    return listFilesByName_(auditFolder);
  });
  const remainingFiles = measureOperation_(metrics, 'driveRemainingList', function () {
    return listFilesByName_(remainingFolder);
  });
  const catalogFiles = measureOperation_(metrics, 'driveCatalogList', function () {
    return listFilesByName_(layout.catalog);
  });
  // DriveApp.getFoldersByName() is a remote lookup. Inventory the data root
  // once instead of issuing up to 64 separate lookups during every audit.
  const dataFolders = measureOperation_(metrics, 'driveDataFolderList', function () {
    return listFoldersByName_(layout.data);
  });
  let lastStatusWriteMs = executionStartedMs;

  while (state.audit.shardIndex < backupConfig_().SHARD_COUNT &&
         Date.now() - executionStartedMs < backupConfig_().EXECUTION_BUDGET_MS) {
    const shard = shardName_(state.audit.shardIndex);
    const summaryName = 'shard-' + shard + '.json';
    let summary;

    if (auditFiles[summaryName]) {
      summary = readJsonFile_(auditFiles[summaryName], null);
      if (!summary || summary.planId !== state.plan.id) {
        throw new Error('Invalid audit checkpoint for shard ' + shard);
      }
    } else {
      const planFile = planFiles[summaryName] || null;
      const planned = planFile ? measureOperation_(metrics, 'drivePlanShardRead', function () {
        return readJsonFile_(planFile, []);
      }) : [];
      const planIdSet = {};
      planned.forEach(function (entry) { planIdSet[entry.id] = true; });

      const dataFolder = dataFolders['shard-' + shard] || null;
      const existing = dataFolder ? measureOperation_(metrics, 'driveDataShardList', function () {
        return listCanonicalArchiveFiles_(dataFolder);
      }) : {
        byId: {}, allById: {}, duplicates: 0, invalidFiles: 0,
      };
      const catalogFile = catalogFiles[summaryName] || null;
      const catalogRecords = catalogFile ? measureOperation_(metrics, 'driveCatalogShardRead', function () {
        return readJsonFile_(catalogFile, []);
      }) : [];
      const catalogById = {};
      catalogRecords.forEach(function (record) {
        if (record && record.id) catalogById[record.id] = record;
      });

      let uncommittedCanonicalFiles = 0;
      let catalogMismatches = 0;
      const missing = [];
      planned.forEach(function (entry) {
        const record = catalogById[entry.id] || null;
        const file = chooseCanonicalFile_(existing, entry.id, record);
        const health = canonicalArchiveHealth_(file, record);
        if (health.ok) return;
        if (health.category === 'uncommitted') uncommittedCanonicalFiles++;
        if (health.category === 'catalog-mismatch') catalogMismatches++;
        missing.push({
          id: entry.id,
          threadId: entry.threadId || '',
          auditReason: health.reason,
        });
      });

      const existingIds = Object.keys(existing.byId);
      const orphanCount = existingIds.reduce(function (count, id) {
        return count + (planIdSet[id] ? 0 : 1);
      }, 0);

      // An absent remaining-shard file means an empty set. Avoid creating 64
      // files per plan when only a handful of shards contain missing IDs. If a
      // partial prior attempt left a file, still overwrite it to prevent stale
      // entries from surviving a recomputation.
      if (missing.length > 0 || remainingFiles[summaryName]) {
        remainingFiles[summaryName] = measureOperation_(metrics, 'driveRemainingWrite', function () {
          return upsertJsonFile_(remainingFolder, summaryName, missing);
        });
      }
      summary = {
        schemaVersion: 1,
        planId: state.plan.id,
        shard: shard,
        planned: planned.length,
        alreadyPresent: planned.length - missing.length,
        remaining: missing.length,
        uncommittedCanonicalFiles: uncommittedCanonicalFiles,
        catalogMismatches: catalogMismatches,
        orphanFiles: orphanCount,
        duplicateCanonicalNames: existing.duplicates,
        invalidFiles: existing.invalidFiles,
        auditedAt: isoNow_(),
      };
      // Aggregate healthy counts are checkpointed in Script Properties and in
      // final plan.json. Per-shard files are reserved for missing/unhealthy or
      // otherwise anomalous shards, where offline diagnostic detail matters.
      if (auditSummaryNeedsFile_(summary)) {
        auditFiles[summaryName] = measureOperation_(metrics, 'driveAuditWrite', function () {
          return upsertJsonFile_(auditFolder, summaryName, summary);
        });
      }
    }

    // Any required remaining/anomaly files exist before state advances. State
    // is persisted in small groups; a crash between grouped checkpoints only
    // replays read-only healthy audits or their deterministic sparse evidence.
    state.audit.planned += Number(summary.planned || 0);
    state.audit.alreadyPresent += Number(summary.alreadyPresent || 0);
    state.audit.remaining += Number(summary.remaining || 0);
    state.audit.uncommittedCanonicalFiles = Number(state.audit.uncommittedCanonicalFiles || 0) + Number(summary.uncommittedCanonicalFiles || 0);
    state.audit.catalogMismatches = Number(state.audit.catalogMismatches || 0) + Number(summary.catalogMismatches || 0);
    state.audit.orphanFiles += Number(summary.orphanFiles || 0);
    state.audit.duplicateCanonicalNames += Number(summary.duplicateCanonicalNames || 0);
    state.audit.invalidFiles += Number(summary.invalidFiles || 0);
    state.audit.shardIndex += 1;
    state.updatedAt = isoNow_();
    const statusDue = Date.now() - lastStatusWriteMs >= backupConfig_().STATUS_UPDATE_INTERVAL_MS;
    const pauseRequested = isPauseRequested_();
    const checkpointDue = state.audit.shardIndex >= backupConfig_().SHARD_COUNT ||
      state.audit.shardIndex % backupConfig_().AUDIT_SHARDS_PER_CHECKPOINT === 0 ||
      statusDue || pauseRequested;
    if (checkpointDue) {
      measureOperation_(metrics, 'checkpointPersist', function () { saveState_(state); });
    }
    if (statusDue) {
      safeUpdateStatusFiles_(state);
      lastStatusWriteMs = Date.now();
    }
    if (pauseRequested) break;
  }

  if (state.audit.shardIndex >= backupConfig_().SHARD_COUNT) {
    // PLAN is not terminal yet: first turn the exact remaining set into an
    // immutable work queue. The queue preserves the final users.messages.list
    // scan order (newest first) or its reverse, while canonical storage remains
    // ID-sharded. This makes a partial backup useful without weakening archive
    // lookup/idempotency guarantees.
    state.audit.completedAt = state.audit.completedAt || isoNow_();
    state.apply = newApplyState_();
    state.apply.total = state.audit.remaining;
    state.queue = newQueueState_();
    state.queue.order = state.plan.applyOrder || backupConfig_().APPLY_ORDER;
    state.queue.total = state.audit.remaining;
    state.queue.startedAt = isoNow_();
    state.phase = BACKUP_PHASE.QUEUEING;
    state.updatedAt = isoNow_();
    measureOperation_(metrics, 'checkpointPersist', function () { saveState_(state); });
  }
  state.lastSliceMetrics = summarizeOperationMetrics_(metrics);
}

function auditSummaryNeedsFile_(summary) {
  if (!summary) return false;
  return Number(summary.remaining || 0) > 0 ||
    Number(summary.uncommittedCanonicalFiles || 0) > 0 ||
    Number(summary.catalogMismatches || 0) > 0 ||
    Number(summary.orphanFiles || 0) > 0 ||
    Number(summary.duplicateCanonicalNames || 0) > 0 ||
    Number(summary.invalidFiles || 0) > 0;
}
