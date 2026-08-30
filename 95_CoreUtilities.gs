// -----------------------------------------------------------------------------
// Pure utility helpers
// -----------------------------------------------------------------------------

function validateConfiguration_() {
  const config = backupConfig_();
  const backend = storageBackendKind_();
  if (['GOOGLE_DRIVE', 'S3'].indexOf(backend) === -1) {
    throw new Error('STORAGE_BACKEND must be GOOGLE_DRIVE or S3.');
  }
  if (config.TARGET_ROOT_FOLDER_ID && config.TARGET_PARENT_FOLDER_ID) {
    throw new Error('Set only one of TARGET_ROOT_FOLDER_ID or TARGET_PARENT_FOLDER_ID.');
  }
  if (backend === 'S3') {
    validateS3Configuration_();
    assertS3CapabilityProbe_();
  }
  if (backupConfig_().SCAN_PAGE_SIZE < 1 || backupConfig_().SCAN_PAGE_SIZE > 500) {
    throw new Error('SCAN_PAGE_SIZE must be between 1 and 500.');
  }
  if (backupConfig_().SCAN_PASSES < 1 || backupConfig_().SCAN_PASSES > 5) {
    throw new Error('SCAN_PASSES must be between 1 and 5.');
  }
  if (backupConfig_().APPLY_BATCH_SIZE < 1 || backupConfig_().APPLY_BATCH_SIZE > 100) {
    throw new Error('APPLY_BATCH_SIZE must be between 1 and 100.');
  }
  if (backupConfig_().INITIAL_APPLY_BATCH_SIZE < 1 ||
      backupConfig_().INITIAL_APPLY_BATCH_SIZE > backupConfig_().APPLY_BATCH_SIZE) {
    throw new Error('INITIAL_APPLY_BATCH_SIZE must be between 1 and APPLY_BATCH_SIZE.');
  }
  if (backupConfig_().EXECUTION_BUDGET_MS <= backupConfig_().CHECKPOINT_SAFETY_MS + 5000 ||
      backupConfig_().EXECUTION_BUDGET_MS > 5 * 60 * 1000) {
    throw new Error('EXECUTION_BUDGET_MS must leave checkpoint safety and remain at or below five minutes.');
  }
  if (backupConfig_().SCAN_COLLECTION_BUDGET_MS >= backupConfig_().EXECUTION_BUDGET_MS) {
    throw new Error('SCAN_COLLECTION_BUDGET_MS must be less than EXECUTION_BUDGET_MS.');
  }
  if (backupConfig_().QUEUE_COLLECTION_BUDGET_MS >= backupConfig_().EXECUTION_BUDGET_MS) {
    throw new Error('QUEUE_COLLECTION_BUDGET_MS must be less than EXECUTION_BUDGET_MS.');
  }
  if (Object.keys(BACKUP_APPLY_ORDER).map(function (key) { return BACKUP_APPLY_ORDER[key]; })
      .indexOf(backupConfig_().APPLY_ORDER) === -1) {
    throw new Error('APPLY_ORDER must be NEWEST_FIRST, OLDEST_FIRST, or SHARDED_ID.');
  }
  if (backupConfig_().WORK_QUEUE_SEGMENT_SIZE < 1 || backupConfig_().WORK_QUEUE_SEGMENT_SIZE > 5000) {
    throw new Error('WORK_QUEUE_SEGMENT_SIZE must be between 1 and 5000.');
  }
  if (backupConfig_().QUEUE_ROWS_PER_TRANSACTION < 100 ||
      backupConfig_().QUEUE_ROWS_PER_TRANSACTION > 20000) {
    throw new Error('QUEUE_ROWS_PER_TRANSACTION must be between 100 and 20000.');
  }
  if ([1, 5, 10, 15, 30].indexOf(backupConfig_().WORKER_TRIGGER_MINUTES) === -1) {
    throw new Error('WORKER_TRIGGER_MINUTES must be one of 1, 5, 10, 15, 30.');
  }
  const shardCount = Number(backupConfig_().SHARD_COUNT);
  if (!Number.isInteger(shardCount) || shardCount < 16 || shardCount > 256 || (shardCount & (shardCount - 1)) !== 0) {
    throw new Error('SHARD_COUNT must be a power of two between 16 and 256.');
  }
  const auditCheckpointSize = Number(backupConfig_().AUDIT_SHARDS_PER_CHECKPOINT);
  if (!Number.isInteger(auditCheckpointSize) || auditCheckpointSize < 1 || auditCheckpointSize > shardCount) {
    throw new Error('AUDIT_SHARDS_PER_CHECKPOINT must be between 1 and SHARD_COUNT.');
  }
  const benchmarkFiles = Number(backupConfig_().DRIVE_API_BENCHMARK_FILES);
  const benchmarkBytes = Number(backupConfig_().DRIVE_API_BENCHMARK_BYTES_PER_FILE);
  if (!Number.isInteger(benchmarkFiles) || benchmarkFiles < 2 || benchmarkFiles > 20) {
    throw new Error('DRIVE_API_BENCHMARK_FILES must be between 2 and 20.');
  }
  if (!Number.isInteger(benchmarkBytes) || benchmarkBytes < 1024 || benchmarkBytes > 5 * 1024 * 1024) {
    throw new Error('DRIVE_API_BENCHMARK_BYTES_PER_FILE must be between 1 KiB and 5 MiB.');
  }
  if (['DRIVE_APP', 'PARALLEL_API'].indexOf(backupConfig_().DRIVE_WRITE_MODE) === -1) {
    throw new Error('DRIVE_WRITE_MODE must be DRIVE_APP or PARALLEL_API.');
  }
  if (['EML', 'ZIP'].indexOf(backupConfig_().ARCHIVE_ENCODING) === -1) {
    throw new Error('ARCHIVE_ENCODING must be EML or ZIP.');
  }
  const compressionBenchmarkMessages = Number(backupConfig_().ARCHIVE_COMPRESSION_BENCHMARK_MESSAGES);
  if (!Number.isInteger(compressionBenchmarkMessages) || compressionBenchmarkMessages < 1 ||
      compressionBenchmarkMessages > 25) {
    throw new Error('ARCHIVE_COMPRESSION_BENCHMARK_MESSAGES must be between 1 and 25.');
  }
  const parallelFiles = Number(backupConfig_().DRIVE_API_MAX_PARALLEL_FILES);
  const parallelBytes = Number(backupConfig_().DRIVE_API_MAX_PARALLEL_BYTES);
  const multipartBytes = Number(backupConfig_().DRIVE_API_MAX_MULTIPART_FILE_BYTES);
  if (!Number.isInteger(parallelFiles) || parallelFiles < 2 || parallelFiles > 20) {
    throw new Error('DRIVE_API_MAX_PARALLEL_FILES must be between 2 and 20.');
  }
  if (!Number.isInteger(parallelBytes) || parallelBytes < 1024 * 1024 || parallelBytes > 32 * 1024 * 1024) {
    throw new Error('DRIVE_API_MAX_PARALLEL_BYTES must be between 1 MiB and 32 MiB.');
  }
  if (!Number.isInteger(multipartBytes) || multipartBytes < 1024 || multipartBytes > 5 * 1024 * 1024 ||
      multipartBytes > parallelBytes) {
    throw new Error('DRIVE_API_MAX_MULTIPART_FILE_BYTES must be between 1 KiB and 5 MiB and no larger than DRIVE_API_MAX_PARALLEL_BYTES.');
  }
}

function withScriptLock_(fn) {
  const lock = lockService_().getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function makePlanId_() {
  return compactTimestamp_() + '-' + utilitiesService_().getUuid().slice(0, 8);
}

function padNumber_(value, width) {
  return String(Math.max(0, Number(value || 0))).padStart(width, '0');
}

function compactTimestamp_() {
  return utilitiesService_().formatDate(new Date(), 'Etc/UTC', "yyyyMMdd'T'HHmmss'Z'");
}

function isoNow_() {
  return new Date().toISOString();
}

function shiftIsoTimestamp_(timestamp, deltaMs) {
  const parsed = Date.parse(timestamp || '');
  if (!Number.isFinite(parsed)) return timestamp || null;
  return new Date(parsed + Math.max(0, Number(deltaMs || 0))).toISOString();
}

function shardForId_(id) {
  const normalized = String(id || '').toLowerCase();
  if (!normalized) throw new Error('Cannot shard an empty Gmail message ID.');
  const tail = normalized.slice(-2).padStart(2, '0');
  let value;
  // Gmail IDs are normally hexadecimal. Hash any unexpected suffix so the
  // archive remains usable rather than rejecting a future ID format.
  if (/^[0-9a-f]{2}$/.test(tail)) {
    value = parseInt(tail, 16);
  } else {
    value = 0;
    for (let i = 0; i < normalized.length; i++) value = ((value * 31) + normalized.charCodeAt(i)) & 0xff;
  }
  return ('0' + (value % backupConfig_().SHARD_COUNT).toString(16)).slice(-2);
}

function shardName_(index) {
  return ('0' + Number(index).toString(16)).slice(-2);
}

function commitFileName_(start, endExclusive) {
  return String(start).padStart(8, '0') + '-' + String(endExclusive).padStart(8, '0') + '.json';
}

function ewma_(previous, sample, alpha) {
  if (previous === null || previous === undefined || !isFinite(previous)) return sample;
  return alpha * sample + (1 - alpha) * previous;
}

function clamp_(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function progressBar_(percent, width) {
  const bounded = clamp_(Number(percent || 0), 0, 100);
  const filled = Math.round(width * bounded / 100);
  return '[' + '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled)) + ']';
}

function formatDuration_(seconds) {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) return 'estimating…';
  seconds = Math.max(0, Math.round(seconds));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const parts = [];
  if (days) parts.push(days + 'd');
  if (hours || days) parts.push(hours + 'h');
  if (minutes || hours || days) parts.push(minutes + 'm');
  if (!days && !hours) parts.push(secs + 's');
  return parts.join(' ');
}

function formatBytes_(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return value.toFixed(0) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = -1;
  do {
    amount /= 1024;
    unit++;
  } while (amount >= 1024 && unit < units.length - 1);
  return amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2) + ' ' + units[unit];
}

function newOperationMetrics_() {
  return {operations: {}};
}

function operationMetricRow_(metrics, name) {
  if (!metrics) return null;
  metrics.operations = metrics.operations || {};
  if (!metrics.operations[name]) {
    metrics.operations[name] = {
      count: 0,
      bytes: 0,
      totalMs: 0,
      maxMs: 0,
      samples: [],
    };
  }
  return metrics.operations[name];
}

function recordOperationMetric_(metrics, name, durationMs, bytes) {
  const row = operationMetricRow_(metrics, name);
  if (!row) return;
  const duration = Math.max(0, Number(durationMs || 0));
  row.count += 1;
  row.bytes += Math.max(0, Number(bytes || 0));
  row.totalMs += duration;
  row.maxMs = Math.max(row.maxMs, duration);
  const limit = Math.max(1, Number(backupConfig_().METRIC_SAMPLE_LIMIT || 256));
  if (row.samples.length < limit) row.samples.push(duration);
  else row.samples[(row.count - 1) % limit] = duration;
}

function recordOperationBytes_(metrics, name, bytes) {
  const row = operationMetricRow_(metrics, name);
  if (row) row.bytes += Math.max(0, Number(bytes || 0));
}

function measureOperation_(metrics, name, fn, bytes) {
  if (!metrics) return fn();
  const startedMs = Date.now();
  try {
    return fn();
  } finally {
    recordOperationMetric_(metrics, name, Date.now() - startedMs, bytes);
  }
}

function percentile_(values, percentile) {
  if (!values || !values.length) return null;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1));
  return sorted[index];
}

function summarizeOperationMetrics_(metrics) {
  const summary = {};
  Object.keys((metrics && metrics.operations) || {}).sort().forEach(function (name) {
    const row = metrics.operations[name];
    if (!row || !row.count) return;
    summary[name] = {
      count: row.count,
      bytes: row.bytes,
      totalMs: row.totalMs,
      meanMs: Number((row.totalMs / row.count).toFixed(1)),
      p50Ms: percentile_(row.samples, 0.50),
      p95Ms: percentile_(row.samples, 0.95),
      maxMs: row.maxMs,
    };
  });
  return summary;
}

function errorToString_(error) {
  if (!error) return 'Unknown error';
  return String(error.message || error);
}

function truncateString_(value, maxLength) {
  const text = String(value || '');
  const limit = Math.max(0, Number(maxLength || 0));
  if (!limit || text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)) + '…';
}

function keepDeterministicSampleCandidate_(selected, record, limit) {
  if (limit <= 0) return;
  const candidate = {score: stableHash32_(String(record.id)), record: record};
  const compare = function (a, b) {
    return a.score - b.score || String(a.record.id).localeCompare(String(b.record.id));
  };

  if (selected.length < limit) {
    selected.push(candidate);
    selected.sort(compare);
    return;
  }

  if (compare(candidate, selected[selected.length - 1]) < 0) {
    selected[selected.length - 1] = candidate;
    selected.sort(compare);
  }
}

function stableHash32_(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
