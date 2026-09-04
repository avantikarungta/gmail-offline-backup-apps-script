// -----------------------------------------------------------------------------
// Exact-delta PLAN estimate
// -----------------------------------------------------------------------------

function priorApplyPerformance_(state) {
  const apply = state && state.apply;
  const deadLettered = Math.max(0, Number(apply && apply.deadLettered || 0));
  const processed = Math.max(0, Number(apply && apply.processed || 0) - deadLettered);
  if (!processed) return null;
  return {
    sourcePlanId: state.plan ? state.plan.id : null,
    processedMessages: processed,
    exportedMessages: Math.max(0, Number(apply.exported || 0)),
    goneMessages: Math.max(0, Number(apply.gone || 0)),
    deadLetteredMessages: deadLettered,
    batches: Math.max(0, Number(apply.batches || 0)),
    activeRuntimeMs: Math.max(0, Number(apply.activeRuntimeMs || 0)),
    ewmaMsPerMessage: positiveNumberOrNull_(apply.ewmaMsPerMessage),
    ewmaWallMsPerMessage: positiveNumberOrNull_(apply.ewmaWallMsPerMessage),
    ewmaBytesPerMessage: positiveNumberOrNull_(apply.ewmaBytesPerMessage),
    completedAt: apply.completedAt || null,
  };
}

function ensurePlanEstimate_(state, planFolder, executionStartedMs) {
  const exactRemaining = Math.max(0, Number(state.audit && state.audit.remaining || 0));
  const existingFile = firstFileByName_(planFolder, 'plan-estimate.json');
  if (existingFile) {
    try {
      const existing = readJsonFile_(existingFile, null);
      if (planEstimateMatches_(existing, state, exactRemaining)) {
        return {report: existing, file: existingFile, reused: true};
      }
      logger_().warn('Existing plan-estimate.json did not match the current PLAN; rebuilding it.');
    } catch (error) {
      logger_().warn('Existing plan-estimate.json was unreadable; rebuilding it: ' + errorToString_(error));
    }
  }

  const report = buildPlanEstimateReport_(state, executionStartedMs);
  const file = upsertJsonFile_(planFolder, 'plan-estimate.json', report);
  return {report: report, file: file, reused: false};
}

function planEstimateMatches_(report, state, exactRemaining) {
  return Boolean(
    report &&
    Number(report.schemaVersion) === 1 &&
    report.kind === 'plan-estimate' &&
    report.planId === state.plan.id &&
    Number(report.exact && report.exact.remainingMessages) === Number(exactRemaining)
  );
}

function buildPlanEstimateReport_(state, executionStartedMs) {
  const exactRemaining = Math.max(0, Number(state.audit && state.audit.remaining || 0));
  const startedMs = Number(executionStartedMs || Date.now());
  const deadlineMs = startedMs + backupConfig_().EXECUTION_BUDGET_MS - backupConfig_().CHECKPOINT_SAFETY_MS;
  const selectedEntries = selectPlanEstimateQueueEntries_(state, backupConfig_().PLAN_ESTIMATE_SAMPLE_MESSAGES);
  const metadataSamples = [];

  selectedEntries.forEach(function (entry) {
    if (Date.now() >= deadlineMs) return;
    const startedMs = Date.now();
    try {
      const metadata = gmailCall_(function () {
        return gmailService_().Users.Messages.get('me', entry.id, {
          format: 'metadata',
          fields: 'id,threadId,internalDate,sizeEstimate',
        });
      }, 'PLAN estimate metadata sample');
      metadataSamples.push({
        id: entry.id,
        status: 'available',
        internalDate: String(metadata.internalDate || ''),
        sizeEstimate: Math.max(0, Number(metadata.sizeEstimate || 0)),
        getMs: Math.max(1, Date.now() - startedMs),
      });
    } catch (error) {
      metadataSamples.push({
        id: entry.id,
        status: isNotFoundError_(error) ? 'gone' : 'error',
        error: truncateString_(errorToString_(error), 500),
        getMs: Math.max(1, Date.now() - startedMs),
      });
    }
  });

  const rawCandidates = selectEvenlySpaced_(metadataSamples.filter(function (sample) {
    return sample.status === 'available' && sample.sizeEstimate > 0 &&
      sample.sizeEstimate <= backupConfig_().ESTIMATE_MAX_RAW_SAMPLE_BYTES;
  }), backupConfig_().ESTIMATE_RAW_SAMPLES);
  const rawBenchmarks = [];
  rawCandidates.forEach(function (candidate) {
    if (Date.now() >= deadlineMs) return;
    const getStartedMs = Date.now();
    try {
      const message = gmailCall_(function () {
        return gmailService_().Users.Messages.get('me', candidate.id, {
          format: 'raw',
          fields: 'id,sizeEstimate,raw',
        });
      }, 'PLAN estimate raw sample');
      const getMs = Math.max(1, Date.now() - getStartedMs);
      const cpuStartedMs = Date.now();
      const rawBytes = gmailRawBytes_(message.raw);
      const archive = buildArchivePayload_(candidate.id, rawBytes);
      const processingMs = Math.max(1, Date.now() - cpuStartedMs);
      rawBenchmarks.push({
        id: candidate.id,
        sizeEstimate: Math.max(0, Number(message.sizeEstimate || candidate.sizeEstimate || 0)),
        bytes: rawBytes.length,
        rawBytes: rawBytes.length,
        storedBytes: archive.storedByteLength,
        gmailGetMs: getMs,
        processingMs: processingMs,
        totalMs: getMs + processingMs,
      });
    } catch (error) {
      rawBenchmarks.push({
        id: candidate.id,
        error: truncateString_(errorToString_(error), 500),
      });
    }
  });

  const driveBenchmarks = [];
  if (exactRemaining > 0) {
    [
      {bytes: backupConfig_().ESTIMATE_DRIVE_TEST_SMALL_BYTES, label: 'plan-estimate-small'},
      {bytes: backupConfig_().ESTIMATE_DRIVE_TEST_LARGE_BYTES, label: 'plan-estimate-large'},
    ].forEach(function (spec) {
      if (Date.now() >= deadlineMs) return;
      try {
        driveBenchmarks.push(benchmarkSyntheticDriveWrite_(spec.bytes, false, spec.label));
      } catch (error) {
        driveBenchmarks.push({bytes: spec.bytes, error: truncateString_(errorToString_(error), 500)});
      }
    });
  }

  const payload = estimateExactPlanPayload_(
    exactRemaining,
    metadataSamples.length,
    metadataSamples,
    rawBenchmarks,
    state.plan.priorApplyPerformance || null
  );
  const timing = estimateExactPlanApplyTiming_(
    exactRemaining,
    payload,
    rawBenchmarks,
    driveBenchmarks,
    state.plan.priorApplyPerformance || null
  );
  const createdAt = isoNow_();
  return {
    schemaVersion: 1,
    exporterVersion: backupConfig_().VERSION,
    kind: 'plan-estimate',
    planId: state.plan.id,
    createdAt: createdAt,
    account: state.account,
    query: state.plan.query,
    includeSpamTrash: state.plan.includeSpamTrash,
    exact: {
      plannedMessages: Math.max(0, Number(state.audit && state.audit.planned || 0)),
      alreadyPresentMessages: Math.max(0, Number(state.audit && state.audit.alreadyPresent || 0)),
      remainingMessages: exactRemaining,
      countAuthoritative: true,
      basis: 'completed PLAN set union, archive audit, and immutable work-queue cardinality',
    },
    sample: {
      method: 'deterministic evenly distributed sample of the immutable PLAN work queue',
      requestedMessages: Math.max(0, Number(backupConfig_().PLAN_ESTIMATE_SAMPLE_MESSAGES || 0)),
      candidateMessages: selectedEntries.length,
      selectedMessages: metadataSamples.length,
      metadataAvailable: metadataSamples.filter(function (row) { return row.status === 'available'; }).length,
      goneSincePlan: metadataSamples.filter(function (row) { return row.status === 'gone'; }).length,
      metadataErrors: metadataSamples.filter(function (row) { return row.status === 'error'; }).length,
      rawAvailable: rawBenchmarks.filter(function (row) { return !row.error; }).length,
      rawErrors: rawBenchmarks.filter(function (row) { return row.error; }).length,
      metadata: metadataSamples,
      raw: rawBenchmarks,
    },
    payloadEstimate: payload,
    applyTimingEstimate: timing,
    driveBenchmarks: driveBenchmarks,
    priorApplyPerformance: state.plan.priorApplyPerformance || null,
    actualPlanTiming: actualPlanTiming_(state, createdAt),
    caveats: [
      'The remaining message count is exact for this completed PLAN; mailbox changes after PLAN are handled by a later PLAN.',
      'Payload bounds come from a deterministic queue-stratified sample, not a statistically random sample.',
      'Messages that disappear before APPLY still consume a Gmail lookup but write no archive payload.',
      'Quota-day values are floors based on configured published quotas; already-consumed quota and administrator throttling are not observable.',
    ],
    recommendedNextAction: exactRemaining > 0
      ? 'Review this estimate and plan.json, then run applyBackup().'
      : 'No APPLY work remains for this PLAN; run PLAN again after later mailbox changes.',
  };
}

function selectPlanEstimateQueueEntries_(state, limit) {
  const total = Math.max(0, Number(state.audit && state.audit.remaining || 0));
  const requested = Math.max(0, Math.min(total, Math.floor(Number(limit || 0))));
  const segmentCount = Math.max(0, Number(state.queue && state.queue.segmentIndex || 0));
  if (!requested || !segmentCount) return [];

  const queueFolder = driveService_().getFolderById(state.plan.workQueueFolderId);
  const queueFiles = listFilesByName_(queueFolder);
  const segmentIndices = [];
  for (let i = 0; i < segmentCount; i++) segmentIndices.push(i);
  const selectedSegments = selectEvenlySpaced_(segmentIndices, Math.min(segmentCount, requested));
  const candidates = [];
  const perSegment = Math.max(1, Math.ceil(requested / selectedSegments.length));

  selectedSegments.forEach(function (segmentIndex, selectedIndex) {
    const name = queueSegmentFileName_(segmentIndex);
    const file = queueFiles[name] || null;
    if (!file) throw new Error('Missing immutable work-queue segment while estimating PLAN: ' + name);
    const segment = readJsonFile_(file, null);
    if (!segment || segment.planId !== state.plan.id || Number(segment.segmentIndex) !== Number(segmentIndex) ||
        !Array.isArray(segment.entries)) {
      throw new Error('Invalid immutable work-queue segment while estimating PLAN: ' + name);
    }
    if (perSegment === 1) {
      const offset = selectedSegments.length === 1
        ? Math.floor(segment.entries.length / 2)
        : Math.round(selectedIndex * Math.max(0, segment.entries.length - 1) / (selectedSegments.length - 1));
      if (segment.entries[offset]) candidates.push(segment.entries[offset]);
    } else {
      Array.prototype.push.apply(candidates, selectEvenlySpaced_(segment.entries, perSegment));
    }
  });

  const unique = [];
  const seen = {};
  selectEvenlySpaced_(candidates, Math.min(requested, candidates.length)).forEach(function (entry) {
    if (!entry || !entry.id || seen[entry.id]) return;
    seen[entry.id] = true;
    unique.push({id: entry.id, threadId: entry.threadId || ''});
  });
  return unique;
}

function estimateExactPlanPayload_(population, selectedCount, metadataSamples, rawBenchmarks, priorPerformance) {
  const total = Math.max(0, Number(population || 0));
  if (total === 0) return emptyPlanPayloadEstimate_();
  const usableMetadata = (metadataSamples || []).filter(function (row) {
    return row.status === 'available' || row.status === 'gone';
  });
  const metadataValues = usableMetadata.map(function (row) {
    return row.status === 'gone' ? 0 : Math.max(0, Number(row.sizeEstimate || 0));
  });
  if (!metadataValues.length) {
    const observedBytes = positiveNumberOrNull_(priorPerformance && priorPerformance.ewmaBytesPerMessage);
    const typicalPerMessage = observedBytes || 1024 * 1024;
    const lowPerMessage = observedBytes ? typicalPerMessage * 0.5 : 10 * 1024;
    const highPerMessage = observedBytes ? typicalPerMessage * 2 : 50 * 1024 * 1024;
    const fallback = byteScenario_(
      total * lowPerMessage,
      total * typicalPerMessage,
      total * highPerMessage,
      false
    );
    return {
      exactRemainingMessages: total,
      confidence: 'low',
      metadataSizeEstimate: fallback,
      rawPayload: fallback,
      storedPayload: fallback,
      averageTypicalRawBytesPerMessage: Math.round(typicalPerMessage),
      averageTypicalStoredBytesPerMessage: Math.round(typicalPerMessage),
      rawCalibrationSamples: 0,
      compressionCalibrationSamples: 0,
      note: observedBytes
        ? 'Metadata sampling failed; payload falls back to prior observed bytes per message.'
        : 'Metadata sampling failed; payload uses a deliberately broad generic fallback range.',
    };
  }
  const metadataScenario = estimatePopulationTotal_(total, metadataValues);
  const availableMetadataCount = usableMetadata.filter(function (row) { return row.status === 'available'; }).length;
  const usableRaw = (rawBenchmarks || []).filter(function (row) {
    return !row.error && Number(row.rawBytes || 0) >= 0;
  });
  const rawRatios = usableRaw.filter(function (row) {
    return Number(row.sizeEstimate || 0) > 0;
  }).map(function (row) {
    return Number(row.rawBytes || 0) / Number(row.sizeEstimate);
  });
  const storedRatios = usableRaw.filter(function (row) {
    return Number(row.rawBytes || 0) > 0;
  }).map(function (row) {
    return Number(row.storedBytes || 0) / Number(row.rawBytes);
  });
  const completeMetadata = Number(selectedCount) === total && usableMetadata.length === total;
  const completeRaw = completeMetadata && usableRaw.length === availableMetadataCount;

  let rawScenario;
  let storedScenario;
  if (completeRaw) {
    const exactRaw = usableRaw.reduce(function (sum, row) { return sum + Number(row.rawBytes || 0); }, 0);
    const exactStored = usableRaw.reduce(function (sum, row) { return sum + Number(row.storedBytes || 0); }, 0);
    rawScenario = byteScenario_(exactRaw, exactRaw, exactRaw, true);
    storedScenario = byteScenario_(exactStored, exactStored, exactStored, true);
  } else {
    const rawLowRatio = rawRatios.length ? Math.min.apply(null, rawRatios) : 1;
    const rawTypicalRatio = rawRatios.length ? median_(rawRatios) : 1;
    const rawHighRatio = rawRatios.length ? Math.max.apply(null, rawRatios) : 1;
    rawScenario = byteScenario_(
      metadataScenario.lowBytes * rawLowRatio,
      metadataScenario.typicalBytes * rawTypicalRatio,
      metadataScenario.highBytes * rawHighRatio,
      false
    );
    const storedLowRatio = storedRatios.length ? Math.min.apply(null, storedRatios) : 1;
    const storedTypicalRatio = storedRatios.length ? median_(storedRatios) : 1;
    const storedHighRatio = storedRatios.length ? Math.max.apply(null, storedRatios) : 1;
    storedScenario = byteScenario_(
      rawScenario.lowBytes * storedLowRatio,
      rawScenario.typicalBytes * storedTypicalRatio,
      rawScenario.highBytes * storedHighRatio,
      false
    );
  }

  const confidence = completeRaw ? 'high' :
    metadataValues.length >= Math.min(total, backupConfig_().PLAN_ESTIMATE_SAMPLE_MESSAGES) && usableRaw.length >= Math.min(4, availableMetadataCount)
      ? 'medium'
      : 'low';
  return {
    exactRemainingMessages: total,
    confidence: confidence,
    metadataSizeEstimate: metadataScenario,
    rawPayload: rawScenario,
    storedPayload: storedScenario,
    averageTypicalRawBytesPerMessage: total ? Math.round(rawScenario.typicalBytes / total) : 0,
    averageTypicalStoredBytesPerMessage: total ? Math.round(storedScenario.typicalBytes / total) : 0,
    rawCalibrationSamples: rawRatios.length,
    compressionCalibrationSamples: storedRatios.length,
    note: 'Count is exact; payload bounds model the exact delta from its bounded deterministic sample.',
  };
}

function emptyPlanPayloadEstimate_() {
  const empty = byteScenario_(0, 0, 0, true);
  return {
    exactRemainingMessages: 0,
    confidence: 'high',
    metadataSizeEstimate: empty,
    rawPayload: empty,
    storedPayload: empty,
    averageTypicalRawBytesPerMessage: 0,
    averageTypicalStoredBytesPerMessage: 0,
    rawCalibrationSamples: 0,
    compressionCalibrationSamples: 0,
    note: 'The completed PLAN has no remaining messages.',
  };
}

function estimatePopulationTotal_(population, values) {
  const total = Math.max(0, Number(population || 0));
  const sample = (values || []).map(function (value) { return Math.max(0, Number(value || 0)); });
  if (!total || !sample.length) return byteScenario_(0, 0, 0, total === 0);
  const mean = sample.reduce(function (sum, value) { return sum + value; }, 0) / sample.length;
  if (sample.length >= total) {
    const exact = sample.reduce(function (sum, value) { return sum + value; }, 0);
    return byteScenario_(exact, exact, exact, true);
  }
  let lowMean;
  let highMean;
  if (sample.length === 1) {
    lowMean = mean * 0.5;
    highMean = mean * 2;
  } else {
    const variance = sample.reduce(function (sum, value) {
      return sum + Math.pow(value - mean, 2);
    }, 0) / (sample.length - 1);
    const finiteCorrection = total > 1 ? Math.sqrt(Math.max(0, (total - sample.length) / (total - 1))) : 0;
    const margin = 1.96 * Math.sqrt(variance / sample.length) * finiteCorrection;
    lowMean = Math.max(0, mean - margin);
    highMean = mean + margin;
  }
  return byteScenario_(total * lowMean, total * mean, total * highMean, false);
}

function byteScenario_(lowBytes, typicalBytes, highBytes, exact) {
  const typical = Math.max(0, Math.round(Number(typicalBytes || 0)));
  const low = Math.min(typical, Math.max(0, Math.round(Number(lowBytes || 0))));
  const high = Math.max(typical, Math.max(0, Math.round(Number(highBytes || 0))));
  return {
    lowBytes: low,
    typicalBytes: typical,
    highBytes: high,
    low: formatBytes_(low),
    typical: formatBytes_(typical),
    high: formatBytes_(high),
    exact: Boolean(exact),
  };
}

function estimateExactPlanApplyTiming_(count, payload, rawBenchmarks, driveBenchmarks, priorPerformance) {
  let timing;
  if (priorPerformance && positiveNumberOrNull_(priorPerformance.ewmaMsPerMessage ||
      (priorPerformance.activeRuntimeMs / Math.max(1, priorPerformance.processedMessages)))) {
    timing = estimateApplyTimingFromPrior_(count, payload, priorPerformance);
  } else {
    timing = estimateApplyTiming_(count, {
      estimatedMessages: count,
      typicalBytes: Number(payload.rawPayload && payload.rawPayload.typicalBytes || 0),
    }, rawBenchmarks, driveBenchmarks);
    timing.rateBasis = rawBenchmarks.filter(function (row) { return !row.error; }).length ||
      driveBenchmarks.filter(function (row) { return !row.error; }).length
      ? 'current PLAN raw/ZIP and synthetic Drive samples'
      : 'conservative built-in fallback';
    timing.confidence = rawBenchmarks.filter(function (row) { return !row.error; }).length >= 2 ? 'medium' : 'low';
  }
  timing.countBasis = 'exact remaining count from completed PLAN';
  timing.countExact = true;
  return timing;
}

function estimateApplyTimingFromPrior_(count, payload, prior) {
  const messages = Math.max(0, Number(count || 0));
  const active = positiveNumberOrNull_(prior.ewmaMsPerMessage) ||
    positiveNumberOrNull_(Number(prior.activeRuntimeMs || 0) / Math.max(1, Number(prior.processedMessages || 0))) ||
    backupConfig_().DEFAULT_ESTIMATED_MS_PER_MESSAGE;
  const wall = positiveNumberOrNull_(prior.ewmaWallMsPerMessage);
  const currentAverageBytes = messages > 0
    ? Number(payload.rawPayload && payload.rawPayload.typicalBytes || 0) / messages
    : 0;
  const priorAverageBytes = positiveNumberOrNull_(prior.ewmaBytesPerMessage);
  const sizeFactor = currentAverageBytes > 0 && priorAverageBytes
    ? clamp_(Math.sqrt(currentAverageBytes / priorAverageBytes), 0.67, 1.5)
    : 1;
  const typicalMs = Math.max(active, wall || active * 1.15) * sizeFactor;
  const observed = Math.max(0, Number(prior.processedMessages || 0));
  const lowFactor = observed >= 500 ? 0.85 : observed >= 50 ? 0.70 : 0.55;
  const highFactor = observed >= 500 ? 1.25 : observed >= 50 ? 1.60 : 2.50;
  const lowSeconds = messages * typicalMs * lowFactor / 1000;
  const typicalSeconds = messages * typicalMs / 1000;
  const highSeconds = messages * typicalMs * highFactor / 1000;
  return durationScenario_(lowSeconds * 1000, typicalSeconds * 1000, highSeconds * 1000, {
    messages: messages,
    averageEstimatedBytesPerMessage: Math.round(currentAverageBytes),
    typicalMsPerMessage: Number(typicalMs.toFixed(1)),
    sizeAdjustmentFactor: Number(sizeFactor.toFixed(3)),
    lowQuotaDays: quotaDaysForEstimate_(messages, lowSeconds),
    typicalQuotaDays: quotaDaysForEstimate_(messages, typicalSeconds),
    highQuotaDays: quotaDaysForEstimate_(messages, highSeconds),
    rateBasis: 'observed APPLY throughput from plan ' + String(prior.sourcePlanId || 'previous'),
    confidence: observed >= 500 ? 'high' : observed >= 50 ? 'medium' : 'low',
    priorObservedMessages: observed,
    note: 'Prior observed throughput is adjusted modestly for this PLAN sample\'s average message size.',
  });
}

function actualPlanTiming_(state, completedAt) {
  function secondsBetween(start, end) {
    const startMs = Date.parse(start || '');
    const endMs = Date.parse(end || '');
    return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null;
  }
  const totalSeconds = secondsBetween(state.plan.createdAt, completedAt);
  return {
    totalSeconds: totalSeconds,
    total: totalSeconds === null ? null : formatDuration_(totalSeconds),
    scanSeconds: secondsBetween(state.scan && state.scan.startedAt, state.scan && state.scan.completedAt),
    auditSeconds: secondsBetween(state.audit && state.audit.startedAt, state.audit && state.audit.completedAt),
    queueSeconds: secondsBetween(state.queue && state.queue.startedAt, state.queue && state.queue.completedAt),
    listPagesCommitted: Math.max(0, Number(state.scan && state.scan.pagesCommitted || 0)),
    queueSegments: Math.max(0, Number(state.queue && state.queue.segmentIndex || 0)),
  };
}

function compactPlanEstimate_(report, fileId) {
  const payload = report.payloadEstimate || emptyPlanPayloadEstimate_();
  const timing = report.applyTimingEstimate || {};
  return {
    schemaVersion: 1,
    fileId: fileId || null,
    createdAt: report.createdAt || null,
    exactRemainingMessages: Number(report.exact && report.exact.remainingMessages || 0),
    sampleMessages: Number(report.sample && report.sample.selectedMessages || 0),
    payloadConfidence: payload.confidence || 'low',
    rawPayload: payload.rawPayload || null,
    storedPayload: payload.storedPayload || null,
    apply: {
      lowSeconds: Number(timing.lowSeconds || 0),
      low: timing.low || formatDuration_(0),
      typicalSeconds: Number(timing.typicalSeconds || 0),
      typical: timing.typical || formatDuration_(0),
      highSeconds: Number(timing.highSeconds || 0),
      high: timing.high || formatDuration_(0),
      lowQuotaDays: Number(timing.lowQuotaDays || 0),
      typicalQuotaDays: Number(timing.typicalQuotaDays || 0),
      highQuotaDays: Number(timing.highQuotaDays || 0),
      rateBasis: timing.rateBasis || null,
      confidence: timing.confidence || 'low',
    },
  };
}

function formatPlanEstimateText_(report) {
  const payload = report.payloadEstimate;
  const timing = report.applyTimingEstimate;
  const lines = ['GMAIL BACKUP PLAN ESTIMATE'];
  lines.push('Exact remaining: ' + Number(report.exact.remainingMessages || 0).toLocaleString() +
    ' of ' + Number(report.exact.plannedMessages || 0).toLocaleString() + ' planned messages');
  lines.push('Raw payload: ' + payload.rawPayload.low + ' low / ' + payload.rawPayload.typical +
    ' typical / ' + payload.rawPayload.high + ' high');
  lines.push('Stored payload: ' + payload.storedPayload.low + ' low / ' + payload.storedPayload.typical +
    ' typical / ' + payload.storedPayload.high + ' high');
  lines.push('APPLY: ' + timing.low + ' low / ' + timing.typical + ' typical / ' + timing.high + ' high');
  lines.push('APPLY quota-day floor: ' + timing.lowQuotaDays + ' low / ' + timing.typicalQuotaDays +
    ' typical / ' + timing.highQuotaDays + ' high');
  lines.push('Basis: exact PLAN count; ' + String(timing.rateBasis || 'fallback rate') + '; payload confidence ' + payload.confidence + '.');
  return lines.join('\n');
}

function positiveNumberOrNull_(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
