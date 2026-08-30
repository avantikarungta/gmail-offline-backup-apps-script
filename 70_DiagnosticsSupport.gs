// -----------------------------------------------------------------------------
// Doctor / sampled estimate helpers
// -----------------------------------------------------------------------------

function assertDiagnosticCanRun_(state) {
  if (!state) return;
  const active = [BACKUP_PHASE.SCANNING, BACKUP_PHASE.AUDITING, BACKUP_PHASE.QUEUEING, BACKUP_PHASE.APPLYING];
  if (active.indexOf(state.phase) !== -1) {
    throw new Error(
      'doctorBackup()/estimateBackup() must not compete with active ' + state.phase +
      ' work. Run pauseBackup() first, or wait for the current phase to finish.'
    );
  }
}

function runDiagnosticCheck_(report, name, fn) {
  const startedMs = Date.now();
  try {
    const detail = fn() || {};
    report.checks[name] = Object.assign({ok: true, durationMs: Date.now() - startedMs}, detail);
    return report.checks[name];
  } catch (error) {
    report.checks[name] = {
      ok: false,
      durationMs: Date.now() - startedMs,
      error: truncateString_(errorToString_(error), 1800),
    };
    report.ok = false;
    return report.checks[name];
  }
}

function combineGmailQueries_(baseQuery, extraQuery) {
  const base = String(baseQuery || '').trim();
  const extra = String(extraQuery || '').trim();
  if (!base) return extra;
  if (!extra) return base;
  return '(' + base + ') ' + extra;
}

function gmailListForEstimate_(query, maxResults, operationName) {
  const params = {
    maxResults: clamp_(Math.floor(Number(maxResults || 1)), 1, 500),
    includeSpamTrash: backupConfig_().INCLUDE_SPAM_TRASH,
    fields: 'messages(id,threadId),resultSizeEstimate',
  };
  if (String(query || '').trim()) params.q = String(query).trim();
  return gmailCall_(function () {
    return gmailService_().Users.Messages.list('me', params);
  }, operationName || 'Gmail.Users.Messages.list estimate');
}

function gmailResultCountEstimate_(query) {
  const response = gmailListForEstimate_(query, 1, 'Gmail result-size estimate');
  return Number(response.resultSizeEstimate || 0);
}

function sizeBucketQuery_(bucket) {
  const clauses = [];
  if (Number(bucket.minBytes || 0) > 0) clauses.push('larger:' + (Number(bucket.minBytes) - 1));
  if (bucket.maxBytesExclusive !== null && bucket.maxBytesExclusive !== undefined) {
    clauses.push('smaller:' + Number(bucket.maxBytesExclusive));
  }
  return clauses.join(' ');
}

function dateBucketQuery_(bucket, now) {
  const reference = now instanceof Date ? new Date(now.getTime()) : new Date();
  const clauses = [];
  if (bucket.newerDays !== null && bucket.newerDays !== undefined) {
    const after = new Date(reference.getTime() - Number(bucket.newerDays) * 24 * 60 * 60 * 1000);
    clauses.push('after:' + formatGmailDateUtc_(after));
  }
  if (bucket.olderDays !== null && bucket.olderDays !== undefined) {
    const before = new Date(reference.getTime() - Number(bucket.olderDays) * 24 * 60 * 60 * 1000);
    clauses.push('before:' + formatGmailDateUtc_(before));
  }
  return clauses.join(' ');
}

function formatGmailDateUtc_(date) {
  const value = date instanceof Date ? date : new Date(date);
  return value.getUTCFullYear() + '/' +
    padNumber_(value.getUTCMonth() + 1, 2) + '/' +
    padNumber_(value.getUTCDate(), 2);
}

function selectEstimatorRawCandidates_(dateCandidates, sizeCandidates, limit) {
  const result = [];
  const seen = {};
  const groups = [dateCandidates || [], sizeCandidates || []];
  let index = 0;
  while (result.length < Number(limit || 0)) {
    let added = false;
    for (let g = 0; g < groups.length && result.length < Number(limit || 0); g++) {
      const candidate = groups[g][index];
      if (!candidate || !candidate.id || seen[candidate.id]) continue;
      seen[candidate.id] = true;
      result.push(candidate);
      added = true;
    }
    if (!added && groups.every(function (group) { return index >= group.length; })) break;
    index += 1;
  }

  // Fill any gaps if one dimension is sparse or contains duplicates.
  groups.forEach(function (group) {
    group.forEach(function (candidate) {
      if (result.length >= Number(limit || 0) || !candidate || !candidate.id || seen[candidate.id]) return;
      seen[candidate.id] = true;
      result.push(candidate);
    });
  });
  return result;
}

function syntheticBytes_(size) {
  const requested = Math.max(0, Math.floor(Number(size || 0)));
  if (requested === 0) return [];
  const pattern = 'GMAIL-BACKUP-BENCHMARK-0123456789-abcdefghijklmnopqrstuvwxyz\n';
  const text = pattern.repeat(Math.ceil(requested / pattern.length)).slice(0, requested);
  return utilitiesService_().newBlob(text).getBytes();
}

function diagnosticDriveFolder_() {
  const state = loadState_();
  const config = backupConfig_();
  const drive = driveService_();
  if (state && state.rootFolderId) return drive.getFolderById(state.rootFolderId);
  if (config.TARGET_ROOT_FOLDER_ID) return drive.getFolderById(config.TARGET_ROOT_FOLDER_ID);
  if (config.TARGET_PARENT_FOLDER_ID) return drive.getFolderById(config.TARGET_PARENT_FOLDER_ID);
  return drive.getRootFolder();
}

function benchmarkSyntheticDriveWrite_(size, verifyRead, label) {
  const bytes = syntheticBytes_(size);
  const expectedHash = verifyRead ? sha256Hex_(bytes) : null;
  const name = '.gmail-backup-' + String(label || 'benchmark') + '-' + compactTimestamp_() + '-' + utilitiesService_().getUuid().slice(0, 8) + '.bin';
  let file = null;
  let result = null;
  try {
    const createStartedMs = Date.now();
    file = diagnosticDriveFolder_().createFile(
      utilitiesService_().newBlob(bytes, 'application/octet-stream', name)
    );
    const createMs = Math.max(1, Date.now() - createStartedMs);
    result = {
      bytes: bytes.length,
      createMs: createMs,
      createMiBPerSecond: bytes.length > 0 ? (bytes.length / (1024 * 1024)) / (createMs / 1000) : null,
      sizeVerified: Number(file.getSize()) === bytes.length,
      readMs: null,
      hashVerified: null,
      temporaryFileTrashed: false,
    };
    if (!result.sizeVerified) throw new Error('Drive benchmark file size did not match the source blob.');
    if (verifyRead) {
      const readStartedMs = Date.now();
      const storedBytes = file.getBlob().getBytes();
      result.readMs = Math.max(1, Date.now() - readStartedMs);
      result.hashVerified = sha256Hex_(storedBytes) === expectedHash;
      if (!result.hashVerified) throw new Error('Drive benchmark read-back SHA-256 did not match.');
    }
  } finally {
    if (file) {
      file.setTrashed(true);
      if (result) result.temporaryFileTrashed = true;
    }
  }
  return result;
}

/**
 * Measures the configured archive encoding against a bounded Gmail sample.
 * Message bytes stay in memory; no email content is written to Drive.
 */
function benchmarkArchiveCompressionAction_() {
  return withScriptLock_(function () {
    const state = loadState_();
    assertDiagnosticCanRun_(state);
    validateConfiguration_();
    const limit = Number(backupConfig_().ARCHIVE_COMPRESSION_BENCHMARK_MESSAGES);
    const listed = gmailCall_(function () {
      return gmailService_().Users.Messages.list('me', {
        q: backupConfig_().GMAIL_QUERY,
        includeSpamTrash: backupConfig_().INCLUDE_SPAM_TRASH,
        maxResults: limit,
        fields: 'messages(id,threadId)',
      });
    }, 'Gmail.Users.Messages.list compression benchmark');
    const rows = [];
    (listed.messages || []).slice(0, limit).forEach(function (entry) {
      const message = gmailCall_(function () {
        return gmailService_().Users.Messages.get('me', entry.id, {
          format: 'raw',
          fields: 'id,sizeEstimate,raw',
        });
      }, 'Gmail.Users.Messages.get compression benchmark (' + entry.id + ')');
      const rawBytes = gmailRawBytes_(message.raw);
      const startedMs = Date.now();
      const archive = buildArchivePayload_(entry.id, rawBytes);
      const encodeMs = Math.max(1, Date.now() - startedMs);
      const roundTrip = inspectArchiveBlob_(
        utilitiesService_().newBlob(archive.storedBytes, archive.mimeType, archive.fileName),
        entry.id,
        archive.archiveEncoding,
        archive.innerFileName
      );
      const roundTripVerified = roundTrip.rawByteLength === archive.rawByteLength &&
        roundTrip.rawSha256 === archive.rawSha256 &&
        roundTrip.storedSha256 === archive.storedSha256;
      if (!roundTripVerified) {
        throw new Error('ZIP compression round-trip failed for Gmail ID ' + entry.id + '.');
      }
      rows.push({
        id: entry.id,
        rawBytes: archive.rawByteLength,
        storedBytes: archive.storedByteLength,
        bytesSaved: archive.rawByteLength - archive.storedByteLength,
        storedPercentOfRaw: archive.rawByteLength > 0
          ? Number((100 * archive.storedByteLength / archive.rawByteLength).toFixed(1))
          : 0,
        encodeMs: encodeMs,
        roundTripVerified: roundTripVerified,
      });
    });
    const totalRawBytes = rows.reduce(function (sum, row) { return sum + row.rawBytes; }, 0);
    const totalStoredBytes = rows.reduce(function (sum, row) { return sum + row.storedBytes; }, 0);
    const report = {
      schemaVersion: 1,
      exporterVersion: backupConfig_().VERSION,
      checkedAt: isoNow_(),
      query: backupConfig_().GMAIL_QUERY,
      archiveEncoding: backupConfig_().ARCHIVE_ENCODING,
      sampledMessages: rows.length,
      totalRawBytes: totalRawBytes,
      totalStoredBytes: totalStoredBytes,
      bytesSaved: totalRawBytes - totalStoredBytes,
      storedPercentOfRaw: totalRawBytes > 0
        ? Number((100 * totalStoredBytes / totalRawBytes).toFixed(1))
        : 0,
      totalEncodeMs: rows.reduce(function (sum, row) { return sum + row.encodeMs; }, 0),
      roundTripVerified: rows.every(function (row) { return row.roundTripVerified; }),
      rows: rows,
      note: 'ZIP compression does not bypass Google Workspace content or download restrictions.',
    };
    logger_().log(JSON.stringify(report, null, 2));
    return report;
  });
}

/**
 * Compares sequential DriveApp writes with parallel Drive API requests using
 * synthetic data only. All benchmark files live in one temporary folder that
 * is moved to Trash before this function returns.
 */
function benchmarkDriveWritePathsAction_() {
  if (isS3StorageBackend_()) {
    throw new Error('benchmarkDriveWritePaths() applies only to the Google Drive backend. Use probeS3Storage() for S3/R2.');
  }
  return withScriptLock_(function () {
    const state = loadState_();
    assertDiagnosticCanRun_(state);
    validateConfiguration_();
    const count = Number(backupConfig_().DRIVE_API_BENCHMARK_FILES);
    const bytesPerFile = Number(backupConfig_().DRIVE_API_BENCHMARK_BYTES_PER_FILE);
    const root = state && state.rootFolderId
      ? driveService_().getFolderById(state.rootFolderId)
      : driveService_().getRootFolder();
    const folder = root.createFolder(
      '.drive-api-benchmark-' + compactTimestamp_() + '-' + utilitiesService_().getUuid().slice(0, 8)
    );
    const bytes = syntheticBytes_(bytesPerFile);
    const expectedHash = sha256Hex_(bytes);
    const token = scriptService_().getOAuthToken();
    let report = null;

    try {
      const sequentialCreateStartedMs = Date.now();
      const sequentialFiles = [];
      for (let i = 0; i < count; i++) {
        sequentialFiles.push(folder.createFile(utilitiesService_().newBlob(
          bytes,
          'application/octet-stream',
          'driveapp-' + padNumber_(i, 3) + '.bin'
        )));
      }
      const sequentialCreateMs = Math.max(1, Date.now() - sequentialCreateStartedMs);

      const parallelSpecs = [];
      for (let j = 0; j < count; j++) {
        parallelSpecs.push({
          name: 'drive-api-' + padNumber_(j, 3) + '.bin',
          mimeType: 'application/octet-stream',
          parentId: folder.getId(),
          bytes: bytes,
        });
      }
      const parallelCreateStartedMs = Date.now();
      const parallelFiles = driveApiCreateFiles_(parallelSpecs, token);
      const parallelCreateMs = Math.max(1, Date.now() - parallelCreateStartedMs);
      const parallelReadbackStartedMs = Date.now();
      const parallelReadback = waitForDiagnosticDriveReadback_(function () {
        return parallelFiles.every(function (metadata) {
          const file = driveService_().getFileById(metadata.id);
          return file.getName() === metadata.name &&
            Number(file.getSize()) === bytes.length &&
            fileIsInFolder_(file, folder.getId()) &&
            sha256Hex_(file.getBlob().getBytes()) === expectedHash;
        });
      });
      const parallelReadbackMs = Math.max(1, Date.now() - parallelReadbackStartedMs);

      const catalogContent = JSON.stringify({
        kind: 'synthetic-catalog-benchmark',
        payload: 'x'.repeat(16 * 1024),
      });
      const sequentialCatalogFiles = [];
      const parallelCatalogFiles = [];
      for (let k = 0; k < count; k++) {
        sequentialCatalogFiles.push(folder.createFile(
          'driveapp-catalog-' + padNumber_(k, 3) + '.json',
          '{}',
          'text/plain'
        ));
        parallelCatalogFiles.push(folder.createFile(
          'drive-api-catalog-' + padNumber_(k, 3) + '.json',
          '{}',
          'text/plain'
        ));
      }

      const sequentialUpdateStartedMs = Date.now();
      sequentialCatalogFiles.forEach(function (file) { file.setContent(catalogContent); });
      const sequentialUpdateMs = Math.max(1, Date.now() - sequentialUpdateStartedMs);

      const updates = parallelCatalogFiles.map(function (file) {
        return {fileId: file.getId(), content: catalogContent, mimeType: 'application/json'};
      });
      const parallelUpdateStartedMs = Date.now();
      const parallelUpdates = driveApiUpdateMedia_(updates, token);
      const parallelUpdateMs = Math.max(1, Date.now() - parallelUpdateStartedMs);
      const parallelCatalogReadbackStartedMs = Date.now();
      const parallelCatalogReadback = waitForDiagnosticDriveReadback_(function () {
        return parallelCatalogFiles.every(function (file) {
          return driveService_().getFileById(file.getId()).getBlob().getDataAsString() === catalogContent;
        });
      });
      const parallelCatalogReadbackMs = Math.max(1, Date.now() - parallelCatalogReadbackStartedMs);

      const expectedTotalBytes = count * bytes.length;
      const parallelTotalBytes = parallelFiles.reduce(function (sum, file) {
        return sum + Number(file.size || 0);
      }, 0);
      report = {
        schemaVersion: 1,
        exporterVersion: backupConfig_().VERSION,
        kind: 'drive-write-path-benchmark',
        createdAt: isoNow_(),
        filesPerPath: count,
        bytesPerFile: bytes.length,
        expectedBytesPerPath: expectedTotalBytes,
        sequentialCreateMs: sequentialCreateMs,
        parallelCreateMs: parallelCreateMs,
        createSpeedup: sequentialCreateMs / parallelCreateMs,
        parallelReadbackMs: parallelReadbackMs,
        parallelReadbackVerified: parallelReadback.ok,
        parallelReadbackAttempts: parallelReadback.attempts,
        sequentialCatalogUpdateMs: sequentialUpdateMs,
        parallelCatalogUpdateMs: parallelUpdateMs,
        catalogUpdateSpeedup: sequentialUpdateMs / parallelUpdateMs,
        parallelCatalogReadbackMs: parallelCatalogReadbackMs,
        parallelCatalogReadbackVerified: parallelCatalogReadback.ok,
        parallelCatalogReadbackAttempts: parallelCatalogReadback.attempts,
        sequentialFileCount: sequentialFiles.length,
        parallelFileCount: parallelFiles.length,
        parallelBytesVerified: parallelTotalBytes === expectedTotalBytes,
        parallelCatalogResponses: parallelUpdates.length,
        temporaryFolderTrashed: false,
      };
      if (parallelFiles.length !== count || !report.parallelBytesVerified) {
        throw new Error('Parallel Drive API create benchmark returned unexpected file metadata.');
      }
      if (!parallelReadback.ok) {
        throw new Error('DriveApp could not verify API-created file bytes after bounded propagation checks: ' +
          String(parallelReadback.lastError || 'content did not match'));
      }
      if (parallelUpdates.length !== count) {
        throw new Error('Parallel Drive API catalog benchmark returned an unexpected response count.');
      }
      if (!parallelCatalogReadback.ok) {
        throw new Error('DriveApp could not verify API-updated catalog content after bounded propagation checks: ' +
          String(parallelCatalogReadback.lastError || 'content did not match'));
      }
    } finally {
      folder.setTrashed(true);
      if (report) report.temporaryFolderTrashed = true;
    }

    report.persisted = persistDiagnosticReport_(state, 'drive-write-path-benchmark', report);
    logger_().log(JSON.stringify(report, null, 2));
    return report;
  });
}

function waitForDiagnosticDriveReadback_(check) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      if (check()) return {ok: true, attempts: attempt, lastError: null};
      lastError = 'DriveApp returned stale or mismatched content';
    } catch (error) {
      lastError = errorToString_(error);
    }
    if (attempt < 4) utilitiesService_().sleep(attempt * 750);
  }
  return {ok: false, attempts: 4, lastError: lastError};
}

function persistDiagnosticReport_(state, kind, report) {
  if (!state || !state.rootFolderId) {
    return {persisted: false, reason: 'Run setupBackup() first to persist reports under the archive root.'};
  }
  try {
    const root = driveService_().getFolderById(state.rootFolderId);
    const folder = getOrCreateChildFolder_(root, 'diagnostics');
    const uniqueName = kind + '-' + compactTimestamp_() + '-' + utilitiesService_().getUuid().slice(0, 8) + '.json';
    const uniqueFile = upsertJsonFile_(folder, uniqueName, report);
    const latestFile = upsertJsonFile_(folder, kind + '-latest.json', report);
    return {
      persisted: true,
      uniqueFileId: uniqueFile.getId(),
      uniqueFileUrl: uniqueFile.getUrl ? uniqueFile.getUrl() : null,
      latestFileId: latestFile.getId(),
    };
  } catch (error) {
    return {persisted: false, error: truncateString_(errorToString_(error), 1000)};
  }
}

function safeNumberCall_(fn) {
  try {
    const value = Number(fn());
    return Number.isFinite(value) ? value : null;
  } catch (ignored) {
    return null;
  }
}

function median_(values) {
  const sorted = (values || []).filter(function (value) {
    return Number.isFinite(Number(value));
  }).map(Number).sort(function (a, b) { return a - b; });
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function estimateMailboxVolume_(messageEstimate, bucketReports) {
  const rawBucketCount = (bucketReports || []).reduce(function (sum, bucket) {
    return sum + Math.max(0, Number(bucket.resultSizeEstimate || 0));
  }, 0);
  const targetCount = Math.max(0, Number(messageEstimate || rawBucketCount || 0));
  const normalization = rawBucketCount > 0 && targetCount > 0 ? targetCount / rawBucketCount : 1;
  let lowBytes = 0;
  let typicalBytes = 0;
  let highScenarioBytes = 0;
  let sampledBuckets = 0;

  const buckets = (bucketReports || []).map(function (bucket) {
    const rawCount = Math.max(0, Number(bucket.resultSizeEstimate || 0));
    const normalizedCount = rawCount * normalization;
    const sizes = (bucket.samples || []).map(function (sample) {
      return Number(sample.sizeEstimate || 0);
    }).filter(function (size) { return size > 0; });
    if (sizes.length) sampledBuckets++;

    const minBytes = Math.max(0, Number(bucket.minBytes || 0));
    const maxBytes = bucket.maxBytesExclusive === null || bucket.maxBytesExclusive === undefined
      ? null
      : Math.max(minBytes + 1, Number(bucket.maxBytesExclusive));
    let representative = median_(sizes);
    if (representative === null) {
      representative = maxBytes === null
        ? Math.max(1, minBytes * 1.5)
        : (minBytes === 0 ? maxBytes / 3 : Math.sqrt(minBytes * maxBytes));
    }
    if (maxBytes !== null) representative = clamp_(representative, Math.max(1, minBytes), maxBytes - 1);
    else representative = Math.max(representative, Math.max(1, minBytes));

    const lowRepresentative = minBytes > 0 ? minBytes : 1;
    const highRepresentative = maxBytes !== null
      ? maxBytes - 1
      : Math.max(representative * 2, Math.max(1, minBytes) * 3);
    lowBytes += normalizedCount * lowRepresentative;
    typicalBytes += normalizedCount * representative;
    highScenarioBytes += normalizedCount * highRepresentative;

    return Object.assign({}, bucket, {
      normalizedCount: Math.round(normalizedCount),
      representativeBytes: Math.round(representative),
      representativeSource: sizes.length ? 'metadata sample median' : 'bucket heuristic',
      lowRepresentativeBytes: Math.round(lowRepresentative),
      highScenarioRepresentativeBytes: Math.round(highRepresentative),
    });
  });

  return {
    estimatedMessages: targetCount,
    rawBucketEstimateSum: rawBucketCount,
    normalizationFactor: Number(normalization.toFixed(6)),
    lowBytes: Math.round(lowBytes),
    typicalBytes: Math.round(typicalBytes),
    highScenarioBytes: Math.round(highScenarioBytes),
    averageTypicalBytesPerMessage: targetCount > 0 ? Math.round(typicalBytes / targetCount) : 0,
    sampledBuckets: sampledBuckets,
    totalBuckets: buckets.length,
    confidence: sampledBuckets >= Math.ceil(buckets.length * 0.6) ? 'medium' : 'low',
    buckets: buckets,
  };
}

function selectEvenlySpaced_(items, limit) {
  const source = items || [];
  const count = Math.max(0, Math.min(source.length, Math.floor(Number(limit || 0))));
  if (count === 0) return [];
  if (count === source.length) return source.slice();
  const selected = [];
  for (let i = 0; i < count; i++) {
    const index = count === 1 ? 0 : Math.round(i * (source.length - 1) / (count - 1));
    selected.push(source[index]);
  }
  return selected;
}

function wilsonInterval_(successes, trials) {
  const n = Math.max(0, Number(trials || 0));
  const k = clamp_(Number(successes || 0), 0, n);
  if (n === 0) return {low: 0, high: 1};
  const z = 1.96;
  const p = k / n;
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denominator;
  return {low: clamp_(center - margin, 0, 1), high: clamp_(center + margin, 0, 1)};
}

function estimateArchiveCoverageSample_(state, candidateIds, mailboxCount) {
  if (!state || !state.rootFolderId) {
    return {available: false, reason: 'No initialized archive root; run setupBackup() first.'};
  }
  const unique = {};
  (candidateIds || []).forEach(function (id) {
    if (id && Object.keys(unique).length < backupConfig_().ESTIMATE_COVERAGE_SAMPLE_IDS) unique[String(id)] = true;
  });
  const ids = Object.keys(unique);
  if (!ids.length) return {available: false, reason: 'No matching message IDs were available to sample.'};

  try {
    const layout = ensureRootLayout_(state.rootFolderId, archiveRootContext_(state));
    const catalogFiles = listFilesByName_(layout.catalog);
    const idsByShard = {};
    ids.forEach(function (id) {
      const shard = shardForId_(id);
      if (!idsByShard[shard]) idsByShard[shard] = [];
      idsByShard[shard].push(id);
    });

    let covered = 0;
    Object.keys(idsByShard).forEach(function (shard) {
      const file = catalogFiles['shard-' + shard + '.json'];
      const records = file ? readJsonFile_(file, []) : [];
      const exported = {};
      records.forEach(function (record) {
        if (record && record.id && record.status === 'exported' && storageFileIdForRecord_(record)) exported[record.id] = true;
      });
      idsByShard[shard].forEach(function (id) {
        if (exported[id]) covered++;
      });
    });

    const sampleSize = ids.length;
    const coverageRate = covered / sampleSize;
    const interval = wilsonInterval_(covered, sampleSize);
    const total = Math.max(0, Number(mailboxCount || 0));
    return {
      available: true,
      sampleSize: sampleSize,
      committedCatalogHits: covered,
      committedCoverageRate: coverageRate,
      committedCoveragePercent: Number((coverageRate * 100).toFixed(1)),
      coverage95PercentLow: Number((interval.low * 100).toFixed(1)),
      coverage95PercentHigh: Number((interval.high * 100).toFixed(1)),
      estimatedRemainingMessages: Math.round(total * (1 - coverageRate)),
      lowRemainingMessages: Math.round(total * (1 - interval.high)),
      highRemainingMessages: Math.round(total * (1 - interval.low)),
      basis: 'committed catalog membership for a deterministic sample of matching Gmail IDs',
      authoritative: false,
    };
  } catch (error) {
    return {available: false, reason: truncateString_(errorToString_(error), 1000)};
  }
}

function exactRemainingFromCurrentState_(state) {
  if (!state || !state.plan) return null;
  if (String(state.plan.query || '') !== String(backupConfig_().GMAIL_QUERY || '')) return null;
  if (Boolean(state.plan.includeSpamTrash) !== Boolean(backupConfig_().INCLUDE_SPAM_TRASH)) return null;
  const phase = effectivePhase_(state);
  if (phase === BACKUP_PHASE.PLANNED && state.audit) return Math.max(0, Number(state.audit.remaining || 0));
  if ((phase === BACKUP_PHASE.APPLYING || phase === BACKUP_PHASE.COMPLETE) && state.apply) {
    return Math.max(0, Number(state.apply.total || 0) - Number(state.apply.processed || 0));
  }
  return null;
}

function driveWriteModel_(benchmarks) {
  const rows = (benchmarks || []).filter(function (row) {
    return Number(row.bytes || 0) > 0 && Number(row.createMs || 0) > 0;
  }).sort(function (a, b) { return Number(a.bytes) - Number(b.bytes); });
  if (!rows.length) return {fixedMs: 750, msPerByte: 0, source: 'fallback'};
  if (rows.length === 1 || Number(rows[rows.length - 1].bytes) === Number(rows[0].bytes)) {
    return {fixedMs: Number(rows[0].createMs), msPerByte: 0, source: 'single synthetic write'};
  }
  const small = rows[0];
  const large = rows[rows.length - 1];
  const slope = Math.max(0, (Number(large.createMs) - Number(small.createMs)) / (Number(large.bytes) - Number(small.bytes)));
  const intercept = Math.max(0, Number(small.createMs) - slope * Number(small.bytes));
  return {fixedMs: intercept, msPerByte: slope, source: 'two-point synthetic write'};
}

function buildBackupTimingEstimate_(messageEstimate, volume, listPageMs, rawBenchmarks, driveBenchmarks, remainingContext) {
  const plan = estimatePlanTiming_(messageEstimate, listPageMs, driveBenchmarks);
  let applyCount = Math.max(0, Number(messageEstimate || 0));
  let countBasis = 'sampled whole-mailbox count estimate';
  let countRange = null;
  let exactRemaining = null;
  if (typeof remainingContext === 'number') {
    applyCount = Math.max(0, Number(remainingContext));
    countBasis = 'exact remaining count from the current frozen plan';
    exactRemaining = applyCount;
  } else if (remainingContext && remainingContext.messages !== null && remainingContext.messages !== undefined) {
    applyCount = Math.max(0, Number(remainingContext.messages || 0));
    countBasis = remainingContext.basis || 'provided remaining-count estimate';
    if (remainingContext.exact) exactRemaining = applyCount;
    if (remainingContext.lowMessages !== undefined || remainingContext.highMessages !== undefined) {
      countRange = {
        lowMessages: Math.max(0, Number(remainingContext.lowMessages || 0)),
        highMessages: Math.max(0, Number(remainingContext.highMessages || 0)),
      };
    }
  }
  const apply = estimateApplyTiming_(applyCount, volume, rawBenchmarks, driveBenchmarks);
  apply.countBasis = countBasis;
  apply.countRange = countRange;
  if (countRange) {
    const lowCount = Math.min(applyCount, countRange.lowMessages);
    const highCount = Math.max(applyCount, countRange.highMessages);
    apply.lowSeconds = Math.max(0, Math.round(lowCount * apply.lowMsPerMessage / 1000));
    apply.highSeconds = Math.max(apply.typicalSeconds, Math.round(highCount * apply.highMsPerMessage / 1000));
    apply.low = formatDuration_(apply.lowSeconds);
    apply.high = formatDuration_(apply.highSeconds);
    apply.lowQuotaDays = quotaDaysForEstimate_(lowCount, apply.lowSeconds);
    apply.highQuotaDays = quotaDaysForEstimate_(highCount, apply.highSeconds);
  }
  return {
    plan: plan,
    apply: apply,
    exactRemainingFromCurrentPlan: exactRemaining,
    quotaAssumptions: {
      triggerRuntimeSecondsPerDay: backupConfig_().ESTIMATE_TRIGGER_RUNTIME_SECONDS_PER_DAY,
      GmailReadWriteOperationsPerDay: backupConfig_().ESTIMATE_GMAIL_READS_PER_DAY,
      note: 'Published Workspace quotas used as planning floors; actual remaining daily quota is not observable here.',
    },
  };
}

function estimatePlanTiming_(messageCount, listPageMs, driveBenchmarks) {
  const count = Math.max(0, Number(messageCount || 0));
  const pagesPerPass = Math.ceil(count / backupConfig_().SCAN_PAGE_SIZE);
  const totalPages = pagesPerPass * backupConfig_().SCAN_PASSES;
  const observedPageMs = Math.max(25, Number(listPageMs || 250));
  const timeLimitedPages = Math.max(1, Math.floor(backupConfig_().SCAN_COLLECTION_BUDGET_MS / observedPageMs));
  const pagesPerSlice = Math.max(1, Math.min(backupConfig_().MAX_SCAN_PAGES_PER_EXECUTION, timeLimitedPages));
  // A worker slice stops when a pass reaches its terminal page; it does not
  // continue into the next pass in the same invocation. Preserve pass
  // boundaries when estimating slice count.
  const slicesPerPass = Math.max(1, Math.ceil(pagesPerPass / pagesPerSlice));
  const scanSlices = backupConfig_().SCAN_PASSES * slicesPerPass;
  const driveModel = driveWriteModel_(driveBenchmarks);
  const shardsTouched = count === 0 ? 0 : Math.min(backupConfig_().SHARD_COUNT, Math.max(1, count));
  const estimatedShardOperationMs = Math.max(75, driveModel.fixedMs * 0.45);
  const flushTypicalMs = shardsTouched === 0 ? 0 : clamp_(shardsTouched * estimatedShardOperationMs, 5000, 120000);
  const listActiveMs = totalPages * observedPageMs;
  const auditTypicalMs = count === 0 ? 5000 : Math.max(10000, shardsTouched * Math.max(100, driveModel.fixedMs) * 2);
  const queueSourceTransactions = count === 0
    ? 0
    : Math.ceil(count / backupConfig_().QUEUE_ROWS_PER_TRANSACTION);
  const queueTransactionMs = count === 0
    ? 0
    : clamp_(shardsTouched * Math.max(75, driveModel.fixedMs * 0.35), 3000, 90000);
  const queueTypicalMs = queueSourceTransactions * queueTransactionMs +
    backupConfig_().SHARD_COUNT * Math.max(25, driveModel.fixedMs * 0.10);

  const lowMs = Math.max(
    listActiveMs * 1.1 + scanSlices * 2000 + auditTypicalMs * 0.5 + queueTypicalMs * 0.35,
    Math.max(0, scanSlices - 1) * 30000
  );
  const typicalMs = Math.max(
    listActiveMs + scanSlices * flushTypicalMs + auditTypicalMs + queueTypicalMs,
    Math.max(0, scanSlices - 1) * 60000 + scanSlices * 10000
  );
  const highMs = Math.max(
    typicalMs * 3,
    Math.max(0, scanSlices - 1) * 180000 + scanSlices * 60000
  );

  return durationScenario_(lowMs, typicalMs, highMs, {
    pagesPerPass: pagesPerPass,
    totalListPages: totalPages,
    estimatedPagesPerWorkerSlice: pagesPerSlice,
    estimatedSlicesPerPass: slicesPerPass,
    estimatedWorkerSlices: scanSlices,
    estimatedQueueSourceTransactions: queueSourceTransactions,
    queueRowsPerTransaction: backupConfig_().QUEUE_ROWS_PER_TRANSACTION,
    applyOrder: backupConfig_().APPLY_ORDER,
    observedFirstPageMs: observedPageMs,
    note: 'PLAN includes two ID scans, archive audit, and ordered queue construction; Drive shard rewrites and trigger scheduling make this a broad range.',
  });
}

function estimateApplyTiming_(messageCount, volume, rawBenchmarks, driveBenchmarks) {
  const count = Math.max(0, Number(messageCount || 0));
  const averageBytes = count > 0
    ? Math.max(0, Number(volume.typicalBytes || 0) / Math.max(1, Number(volume.estimatedMessages || count)))
    : 0;
  const rawTotalMedian = median_((rawBenchmarks || []).map(function (row) { return Number(row.totalMs || 0); }));
  const rawBytesMedian = median_((rawBenchmarks || []).map(function (row) { return Number(row.bytes || 0); }));
  let estimatedRawMs = rawTotalMedian === null ? 600 : rawTotalMedian;
  if (rawTotalMedian !== null && rawBytesMedian && averageBytes > 0) {
    estimatedRawMs *= clamp_(Math.sqrt(averageBytes / rawBytesMedian), 0.5, 3.0);
  }
  const driveModel = driveWriteModel_(driveBenchmarks);
  const estimatedDriveMs = driveModel.fixedMs + driveModel.msPerByte * averageBytes;
  const typicalMsPerMessage = Math.max(
    backupConfig_().DEFAULT_ESTIMATED_MS_PER_MESSAGE,
    estimatedRawMs + estimatedDriveMs + 250
  );
  const lowMsPerMessage = Math.max(750, typicalMsPerMessage * 0.55);
  const highMsPerMessage = Math.max(6000, typicalMsPerMessage * 2.5);
  const lowSeconds = count * lowMsPerMessage / 1000;
  const typicalSeconds = count * typicalMsPerMessage / 1000;
  const highSeconds = count * highMsPerMessage / 1000;

  return durationScenario_(lowSeconds * 1000, typicalSeconds * 1000, highSeconds * 1000, {
    messages: count,
    averageEstimatedBytesPerMessage: Math.round(averageBytes),
    rawSampleMedianMs: rawTotalMedian,
    rawSampleMedianBytes: rawBytesMedian,
    modeledDriveFixedMs: Number(driveModel.fixedMs.toFixed(2)),
    modeledDriveMsPerMiB: Number((driveModel.msPerByte * 1024 * 1024).toFixed(2)),
    lowMsPerMessage: Number(lowMsPerMessage.toFixed(1)),
    typicalMsPerMessage: Number(typicalMsPerMessage.toFixed(1)),
    highMsPerMessage: Number(highMsPerMessage.toFixed(1)),
    lowQuotaDays: quotaDaysForEstimate_(count, lowSeconds),
    typicalQuotaDays: quotaDaysForEstimate_(count, typicalSeconds),
    highQuotaDays: quotaDaysForEstimate_(count, highSeconds),
    note: 'APPLY is both message-count and byte-volume dominated; one raw read and one Drive file create occur per exported message.',
  });
}

function quotaDaysForEstimate_(messageCount, activeSeconds) {
  const count = Math.max(0, Number(messageCount || 0));
  if (count === 0) return 0;
  const runtimeDays = Math.ceil(Math.max(0, Number(activeSeconds || 0)) / backupConfig_().ESTIMATE_TRIGGER_RUNTIME_SECONDS_PER_DAY);
  const readDays = Math.ceil(count / backupConfig_().ESTIMATE_GMAIL_READS_PER_DAY);
  return Math.max(1, runtimeDays, readDays);
}

function durationScenario_(lowMs, typicalMs, highMs, extra) {
  const lowSeconds = Math.max(0, Math.round(Number(lowMs || 0) / 1000));
  const typicalSeconds = Math.max(lowSeconds, Math.round(Number(typicalMs || 0) / 1000));
  const highSeconds = Math.max(typicalSeconds, Math.round(Number(highMs || 0) / 1000));
  return Object.assign({
    lowSeconds: lowSeconds,
    low: formatDuration_(lowSeconds),
    typicalSeconds: typicalSeconds,
    typical: formatDuration_(typicalSeconds),
    highSeconds: highSeconds,
    high: formatDuration_(highSeconds),
  }, extra || {});
}

function formatDoctorText_(report) {
  const lines = ['GMAIL BACKUP DOCTOR: ' + (report.ok ? 'PASS' : 'FAIL')];
  Object.keys(report.checks || {}).forEach(function (name) {
    const check = report.checks[name];
    lines.push((check.ok ? 'PASS' : check.skipped ? 'SKIP' : 'FAIL') + '  ' + name + '  (' + Number(check.durationMs || 0) + ' ms)' +
      (check.error ? ' — ' + check.error : ''));
  });
  (report.cautions || []).forEach(function (caution) { lines.push('CAUTION: ' + caution); });
  lines.push('Duration: ' + formatDuration_(Number(report.durationMs || 0) / 1000));
  lines.push('Next: ' + report.recommendedNextAction);
  return lines.join('\n');
}

function formatEstimateText_(report) {
  const volume = report.volumeEstimate;
  const timing = report.timingEstimate;
  const lines = ['GMAIL BACKUP QUICK ESTIMATE'];
  lines.push('Messages: approximately ' + Number(report.estimatedMessages || 0).toLocaleString());
  lines.push('Payload: ' + formatBytes_(volume.lowBytes) + ' low / ' + formatBytes_(volume.typicalBytes) +
    ' typical / ' + formatBytes_(volume.highScenarioBytes) + ' high scenario');
  lines.push('PLAN: ' + timing.plan.low + ' low / ' + timing.plan.typical + ' typical / ' + timing.plan.high + ' high');
  lines.push('APPLY (' + timing.apply.countBasis + '): ' + timing.apply.low + ' low / ' + timing.apply.typical +
    ' typical / ' + timing.apply.high + ' high');
  lines.push('APPLY quota-day floor: ' + timing.apply.lowQuotaDays + ' low / ' + timing.apply.typicalQuotaDays +
    ' typical / ' + timing.apply.highQuotaDays + ' high');
  if (report.archiveCoverageEstimate && report.archiveCoverageEstimate.available) {
    lines.push('Rough existing coverage: ' + report.archiveCoverageEstimate.committedCoveragePercent.toFixed(1) +
      '% of ' + report.archiveCoverageEstimate.sampleSize + ' sampled IDs; estimated remaining ' +
      Number(report.archiveCoverageEstimate.estimatedRemainingMessages || 0).toLocaleString() +
      ' (wide 95% range ' + Number(report.archiveCoverageEstimate.lowRemainingMessages || 0).toLocaleString() +
      '-' + Number(report.archiveCoverageEstimate.highRemainingMessages || 0).toLocaleString() + ')');
  }
  if (report.driveStorage.availableBytes !== null) {
    lines.push('Drive available: ' + formatBytes_(report.driveStorage.availableBytes));
  }
  lines.push('This is sampled. PLAN remains authoritative for the exact remaining ID set.');
  return lines.join('\n');
}

function logProgressEvent_(event, state, extra) {
  if (!backupConfig_().LOG_PROGRESS_TO_CONSOLE || !state) return;
  const progress = progressForState_(state);
  const eta = etaForState_(state);
  const payload = {
    event: event,
    at: isoNow_(),
    phase: state.phase,
    effectivePhase: effectivePhase_(state),
    planId: state.plan ? state.plan.id : null,
    archiveRootFolderId: state.rootFolderId || null,
    archiveEncoding: backupConfig_().ARCHIVE_ENCODING,
    driveWriteMode: backupConfig_().DRIVE_WRITE_MODE,
    progressPercent: Number(Number(progress.percent || 0).toFixed(2)),
    progressCurrent: progress.current,
    progressTotal: progress.total,
    progressLabel: progress.label,
    etaSeconds: eta.seconds,
    eta: eta.text,
    etaConfidence: eta.confidence,
  };
  if (state.scan) {
    payload.scan = {
      pass: state.scan.pass,
      passes: state.scan.passes,
      pagesCommitted: state.scan.pagesCommitted,
      rowsSeen: state.scan.rowsSeen,
      resultSizeEstimate: state.scan.resultSizeEstimate,
      pageTokenResets: Number(state.scan.pageTokenResets || 0),
    };
  }
  if (state.lastSliceMetrics) payload.metrics = state.lastSliceMetrics;
  if (state.audit) {
    payload.audit = {
      shardIndex: state.audit.shardIndex,
      planned: state.audit.planned,
      alreadyPresent: state.audit.alreadyPresent,
      remaining: state.audit.remaining,
    };
  }
  if (state.queue) {
    payload.queue = {
      order: state.queue.order,
      stage: state.queue.stage,
      queued: state.queue.queued,
      total: state.queue.total,
      segmentCount: state.queue.segmentIndex,
      sourceChunksProcessed: state.queue.sourceChunksProcessed,
      tailShardIndex: state.queue.tailShardIndex,
    };
  }
  if (state.apply) {
    payload.apply = {
      processed: state.apply.processed,
      total: state.apply.total,
      exported: state.apply.exported,
      gone: state.apply.gone,
      rawBytes: state.apply.rawBytes,
      storedBytes: state.apply.storedBytes,
      batches: state.apply.batches,
    };
  }
  Object.keys(extra || {}).forEach(function (key) { payload[key] = extra[key]; });
  logger_().log('[GMAIL-BACKUP] ' + JSON.stringify(payload));
}
