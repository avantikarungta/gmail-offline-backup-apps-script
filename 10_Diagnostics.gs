/**
 * Fast, non-destructive prerequisite diagnostic.
 *
 * Reads one small raw Gmail message when available, checks size-search support,
 * verifies Drive capacity and a small Drive write/read/hash round-trip, and
 * proves that this user can create/delete an installable trigger. It never
 * modifies Gmail. Temporary synthetic Drive data is moved to Trash.
 */
function doctorBackupAction_() {
  return withScriptLock_(function () {
    const startedMs = Date.now();
    const state = loadState_();
    assertDiagnosticCanRun_(state);
    const report = {
      schemaVersion: 1,
      exporterVersion: backupConfig_().VERSION,
      kind: 'doctor',
      startedAt: isoNow_(),
      completedAt: null,
      durationMs: null,
      ok: true,
      checks: {},
      cautions: [],
    };
    let profile = null;

    runDiagnosticCheck_(report, 'configuration', function () {
      validateConfiguration_();
      assertArchiveConfiguration_(state);
      return {
        query: backupConfig_().GMAIL_QUERY,
        includeSpamTrash: backupConfig_().INCLUDE_SPAM_TRASH,
        scanPasses: backupConfig_().SCAN_PASSES,
        shardCount: backupConfig_().SHARD_COUNT,
        applyOrder: backupConfig_().APPLY_ORDER,
        workQueueSegmentSize: backupConfig_().WORK_QUEUE_SEGMENT_SIZE,
      };
    });

    runDiagnosticCheck_(report, 'gmailProfile', function () {
      profile = gmailCall_(function () {
        return gmailService_().Users.getProfile('me');
      }, 'doctor Gmail.Users.getProfile');
      assertBackupAccount_(state, profile.emailAddress || '');
      return {
        account: profile.emailAddress || null,
        messagesTotal: Number(profile.messagesTotal || 0),
        threadsTotal: Number(profile.threadsTotal || 0),
        historyId: String(profile.historyId || ''),
      };
    });

    runDiagnosticCheck_(report, 'gmailLabels', function () {
      const response = gmailCall_(function () {
        return gmailService_().Users.Labels.list('me');
      }, 'doctor Gmail.Users.Labels.list');
      return {labelCount: (response.labels || []).length};
    });

    runDiagnosticCheck_(report, 'gmailRawRead', function () {
      const preferredQuery = combineGmailQueries_(backupConfig_().GMAIL_QUERY, 'smaller:10485760');
      let response = gmailListForEstimate_(preferredQuery, 1, 'doctor small-message list');
      if (!(response.messages || []).length && backupConfig_().GMAIL_QUERY) {
        response = gmailListForEstimate_(backupConfig_().GMAIL_QUERY, 1, 'doctor fallback message list');
      }
      const messages = response.messages || [];
      if (!messages.length) {
        return {mailboxEmptyOrQueryHasNoMatches: true, rawBytes: 0};
      }
      const message = gmailCall_(function () {
        return gmailService_().Users.Messages.get('me', messages[0].id, {
          format: 'raw',
          fields: 'id,sizeEstimate,raw',
        });
      }, 'doctor Gmail.Users.Messages.get raw');
      if (!message || !message.raw) throw new Error('Gmail returned no raw RFC message data.');
      const bytes = gmailRawBytes_(message.raw);
      return {
        rawBytes: bytes.length,
        sizeEstimate: Number(message.sizeEstimate || 0),
        sha256Computed: Boolean(sha256Hex_(bytes)),
      };
    });

    runDiagnosticCheck_(report, 'largeMessageInventory', function () {
      return {
        over25MiBEstimate: gmailResultCountEstimate_(combineGmailQueries_(backupConfig_().GMAIL_QUERY, 'larger:26214399')),
        over50MiBEstimate: gmailResultCountEstimate_(combineGmailQueries_(backupConfig_().GMAIL_QUERY, 'larger:52428799')),
        over100MiBEstimate: gmailResultCountEstimate_(combineGmailQueries_(backupConfig_().GMAIL_QUERY, 'larger:104857599')),
      };
    });

    runDiagnosticCheck_(report, 'driveStorage', function () {
      const limit = Number(driveService_().getStorageLimit());
      const used = Number(driveService_().getStorageUsed());
      return {
        storageLimitBytes: Number.isFinite(limit) ? limit : null,
        storageUsedBytes: Number.isFinite(used) ? used : null,
        storageAvailableBytes: Number.isFinite(limit) && Number.isFinite(used) && limit > 0
          ? Math.max(0, limit - used)
          : null,
      };
    });

    runDiagnosticCheck_(report, 'driveRoundTrip', function () {
      return benchmarkSyntheticDriveWrite_(backupConfig_().DOCTOR_DRIVE_TEST_BYTES, true, 'doctor');
    });

    runDiagnosticCheck_(report, 'installableTrigger', function () {
      let trigger = null;
      const detail = {created: false, deleted: false};
      trigger = scriptService_().newTrigger('gmailBackupDoctorNoop_')
        .timeBased()
        .after(10 * 60 * 1000)
        .create();
      detail.created = true;
      detail.handler = trigger.getHandlerFunction ? trigger.getHandlerFunction() : 'gmailBackupDoctorNoop_';
      detail.triggerId = trigger.getUniqueId ? trigger.getUniqueId() : null;

      // Trigger creation is the capability PLAN/APPLY require. Deletion can
      // occasionally fail with an Apps Script backend "Unexpected error" even
      // after creation succeeds. Treat cleanup failure as a caution, not a false
      // negative for the whole diagnostic. after() triggers are one-shot and
      // disappear after firing even if this immediate cleanup attempt fails.
      detail.deleted = safeDeleteTrigger_(trigger, 'doctor temporary trigger');
      if (!detail.deleted) {
        detail.cleanupWarning = 'Temporary doctor trigger was created successfully but could not be deleted immediately. It is one-shot and should disappear after firing.';
        report.cautions.push(detail.cleanupWarning);
      }
      return detail;
    });

    const large = report.checks.largeMessageInventory;
    if (large && large.ok && large.over50MiBEstimate > 0) {
      report.cautions.push(
        'The mailbox appears to contain messages above 50 MiB. Raw base64 plus decoded bytes must coexist in Apps Script memory; test these messages before relying on unattended APPLY.'
      );
    }
    report.ok = Object.keys(report.checks).every(function (name) {
      const check = report.checks[name];
      return check.ok || check.skipped;
    });
    report.completedAt = isoNow_();
    report.durationMs = Date.now() - startedMs;
    report.recommendedNextAction = report.ok
      ? (state ? 'Run estimateBackup(), then planBackup().' : 'Run setupBackup(), then estimateBackup() and planBackup().')
      : 'Correct failed checks before starting PLAN/APPLY.';
    report.persisted = persistDiagnosticReport_(state, 'doctor', report);
    logger_().log(formatDoctorText_(report));
    return report;
  });
}

/**
 * Cheap sampled estimator. This is not an authoritative plan.
 *
 * Uses one ID page, mutually exclusive Gmail size searches, a few metadata/raw
 * samples, and synthetic target-storage writes. It does not save sampled mail to
 * Drive. PLAN remains necessary to calculate the exact ID-level delta.
 */
function estimateBackupAction_() {
  return withScriptLock_(function () {
    const startedMs = Date.now();
    const state = loadState_();
    assertDiagnosticCanRun_(state);
    validateConfiguration_();
    assertArchiveConfiguration_(state);

    const profile = gmailCall_(function () {
      return gmailService_().Users.getProfile('me');
    }, 'estimate Gmail.Users.getProfile');
    assertBackupAccount_(state, profile.emailAddress || '');

    const overallStartedMs = Date.now();
    const overall = gmailListForEstimate_(backupConfig_().GMAIL_QUERY, backupConfig_().SCAN_PAGE_SIZE, 'estimate overall list');
    const overallListMs = Math.max(1, Date.now() - overallStartedMs);
    const listEstimate = Number(overall.resultSizeEstimate || 0);
    const profileCount = Number(profile.messagesTotal || 0);
    const messageEstimate = backupConfig_().GMAIL_QUERY
      ? listEstimate
      : Math.max(listEstimate, profileCount);

    const rawCandidates = [];
    const dateRawCandidates = [];
    const coverageCandidateIds = [];
    const bucketReports = BACKUP_ESTIMATE_SIZE_BUCKETS.map(function (bucket) {
      const query = combineGmailQueries_(backupConfig_().GMAIL_QUERY, sizeBucketQuery_(bucket));
      const listStartedMs = Date.now();
      const response = gmailListForEstimate_(query, backupConfig_().ESTIMATE_METADATA_SAMPLES_PER_BUCKET, 'estimate bucket ' + bucket.name);
      const listDurationMs = Math.max(1, Date.now() - listStartedMs);
      const samples = [];
      (response.messages || []).forEach(function (listed) {
        coverageCandidateIds.push(listed.id);
        const getStartedMs = Date.now();
        const metadata = gmailCall_(function () {
          return gmailService_().Users.Messages.get('me', listed.id, {
            format: 'metadata',
            fields: 'id,sizeEstimate',
          });
        }, 'estimate metadata sample');
        const sample = {
          sizeEstimate: Number(metadata.sizeEstimate || 0),
          metadataGetMs: Math.max(1, Date.now() - getStartedMs),
        };
        samples.push(sample);
        if (sample.sizeEstimate > 0 && sample.sizeEstimate <= backupConfig_().ESTIMATE_MAX_RAW_SAMPLE_BYTES) {
          rawCandidates.push({
            id: listed.id,
            sizeEstimate: sample.sizeEstimate,
            bucket: bucket.name,
            sampleDimension: 'size',
          });
        }
      });
      return {
        name: bucket.name,
        minBytes: bucket.minBytes,
        maxBytesExclusive: bucket.maxBytesExclusive,
        query: query,
        resultSizeEstimate: Number(response.resultSizeEstimate || 0),
        listDurationMs: listDurationMs,
        samples: samples,
      };
    });

    const dateBucketReports = BACKUP_ESTIMATE_DATE_BUCKETS.map(function (bucket) {
      const dateQuery = dateBucketQuery_(bucket, new Date());
      const query = combineGmailQueries_(backupConfig_().GMAIL_QUERY, dateQuery);
      const listStartedMs = Date.now();
      const response = gmailListForEstimate_(
        query,
        backupConfig_().ESTIMATE_METADATA_SAMPLES_PER_DATE_BUCKET,
        'estimate date bucket ' + bucket.name
      );
      const samples = [];
      (response.messages || []).forEach(function (listed) {
        coverageCandidateIds.push(listed.id);
        const getStartedMs = Date.now();
        const metadata = gmailCall_(function () {
          return gmailService_().Users.Messages.get('me', listed.id, {
            format: 'metadata',
            fields: 'id,internalDate,sizeEstimate',
          });
        }, 'estimate date metadata sample');
        const sample = {
          internalDate: String(metadata.internalDate || ''),
          sizeEstimate: Number(metadata.sizeEstimate || 0),
          metadataGetMs: Math.max(1, Date.now() - getStartedMs),
        };
        samples.push(sample);
        if (sample.sizeEstimate > 0 && sample.sizeEstimate <= backupConfig_().ESTIMATE_MAX_RAW_SAMPLE_BYTES) {
          dateRawCandidates.push({
            id: listed.id,
            sizeEstimate: sample.sizeEstimate,
            bucket: bucket.name,
            sampleDimension: 'date',
          });
        }
      });
      return {
        name: bucket.name,
        query: query,
        resultSizeEstimate: Number(response.resultSizeEstimate || 0),
        listDurationMs: Math.max(1, Date.now() - listStartedMs),
        samples: samples,
      };
    });

    // Add an evenly spaced sample from the first full ID page for a cheap,
    // explicitly non-authoritative estimate of existing archive coverage.
    selectEvenlySpaced_((overall.messages || []), backupConfig_().ESTIMATE_COVERAGE_SAMPLE_IDS).forEach(function (listed) {
      if (listed && listed.id) coverageCandidateIds.push(listed.id);
    });

    // Add candidates from the main page if sparse buckets yielded too few.
    const candidateIds = {};
    rawCandidates.concat(dateRawCandidates).forEach(function (candidate) { candidateIds[candidate.id] = true; });
    (overall.messages || []).slice(0, 20).forEach(function (listed) {
      if (rawCandidates.length + dateRawCandidates.length >= backupConfig_().ESTIMATE_RAW_SAMPLES * 4 || candidateIds[listed.id]) return;
      const metadata = gmailCall_(function () {
        return gmailService_().Users.Messages.get('me', listed.id, {format: 'metadata', fields: 'id,sizeEstimate'});
      }, 'estimate fallback metadata sample');
      const size = Number(metadata.sizeEstimate || 0);
      if (size > 0 && size <= backupConfig_().ESTIMATE_MAX_RAW_SAMPLE_BYTES) {
        candidateIds[listed.id] = true;
        rawCandidates.push({id: listed.id, sizeEstimate: size, bucket: 'overall-page', sampleDimension: 'size'});
      }
    });

    const rawBenchmarks = [];
    selectEstimatorRawCandidates_(dateRawCandidates, rawCandidates, backupConfig_().ESTIMATE_RAW_SAMPLES)
      .forEach(function (candidate, index) {
      const getStartedMs = Date.now();
      const rawMessage = gmailCall_(function () {
        return gmailService_().Users.Messages.get('me', candidate.id, {
          format: 'raw',
          fields: 'id,sizeEstimate,raw',
        });
      }, 'estimate raw sample');
      const getMs = Math.max(1, Date.now() - getStartedMs);
      const cpuStartedMs = Date.now();
      const bytes = gmailRawBytes_(rawMessage.raw);
      sha256Hex_(bytes);
      const decodeAndHashMs = Math.max(1, Date.now() - cpuStartedMs);
      rawBenchmarks.push({
        sample: index + 1,
        bucket: candidate.bucket,
        sampleDimension: candidate.sampleDimension || 'size',
        bytes: bytes.length,
        sizeEstimate: Number(rawMessage.sizeEstimate || candidate.sizeEstimate || 0),
        gmailGetMs: getMs,
        decodeAndHashMs: decodeAndHashMs,
        totalMs: getMs + decodeAndHashMs,
      });
    });

    const driveBenchmarks = [
      benchmarkSyntheticDriveWrite_(backupConfig_().ESTIMATE_DRIVE_TEST_SMALL_BYTES, false, 'estimate-small'),
      benchmarkSyntheticDriveWrite_(backupConfig_().ESTIMATE_DRIVE_TEST_LARGE_BYTES, false, 'estimate-large'),
    ];

    const volume = estimateMailboxVolume_(messageEstimate, bucketReports);
    const exactRemaining = exactRemainingFromCurrentState_(state);
    const coverageEstimate = estimateArchiveCoverageSample_(state, coverageCandidateIds, messageEstimate);
    let remainingContext = null;
    if (exactRemaining !== null && exactRemaining !== undefined) {
      remainingContext = {
        messages: exactRemaining,
        basis: 'exact remaining count from the current frozen plan',
        exact: true,
      };
    } else if (coverageEstimate && coverageEstimate.available && coverageEstimate.sampleSize >= 5) {
      remainingContext = {
        messages: coverageEstimate.estimatedRemainingMessages,
        basis: 'sampled committed-catalog coverage estimate',
        exact: false,
        lowMessages: coverageEstimate.lowRemainingMessages,
        highMessages: coverageEstimate.highRemainingMessages,
      };
    }
    const timing = buildBackupTimingEstimate_(
      messageEstimate,
      volume,
      overallListMs,
      rawBenchmarks,
      driveBenchmarks,
      remainingContext
    );

    const storageLimit = safeNumberCall_(function () { return driveService_().getStorageLimit(); });
    const storageUsed = safeNumberCall_(function () { return driveService_().getStorageUsed(); });
    const available = storageLimit !== null && storageUsed !== null && storageLimit > 0
      ? Math.max(0, storageLimit - storageUsed)
      : null;

    const report = {
      schemaVersion: 1,
      exporterVersion: backupConfig_().VERSION,
      kind: 'estimate',
      createdAt: isoNow_(),
      durationMs: Date.now() - startedMs,
      account: profile.emailAddress || null,
      query: backupConfig_().GMAIL_QUERY,
      includeSpamTrash: backupConfig_().INCLUDE_SPAM_TRASH,
      profileMessagesTotal: profileCount,
      listResultSizeEstimate: listEstimate,
      estimatedMessages: messageEstimate,
      firstPageRows: (overall.messages || []).length,
      firstPageDurationMs: overallListMs,
      sizeHistogram: bucketReports,
      dateHistogram: dateBucketReports,
      volumeEstimate: volume,
      archiveCoverageEstimate: coverageEstimate,
      rawBenchmarks: rawBenchmarks,
      driveBenchmarks: driveBenchmarks,
      timingEstimate: timing,
      driveStorage: {
        limitBytes: storageLimit,
        usedBytes: storageUsed,
        availableBytes: available,
        typicalBackupFitsByEstimate: available === null ? null : available >= volume.typicalBytes,
        highScenarioFitsByEstimate: available === null ? null : available >= volume.highScenarioBytes,
      },
      caveats: [
        'Gmail resultSizeEstimate is approximate; PLAN is authoritative for message IDs.',
        'Size, date, and archive-coverage samples are deterministic convenience samples, not statistically random samples.',
        'Date strata use Gmail search date boundaries and are approximate; they exist to reduce newest-first sample bias.',
        'Coverage sampling checks committed catalog records only; PLAN verifies the exact ID set and canonical file health.',
        'The >=50 MiB band has no strict upper bound; its high figure is a scenario, not a guarantee.',
        'The apply estimate excludes administrator throttling, daily quota already consumed by other scripts, and unusually slow target-storage behavior.',
        'No sampled email content was written to storage; only synthetic benchmark data was created and then deleted.',
      ],
      recommendedNextAction: 'Run setupBackup() if needed, then planBackup(). After 50-200 applied messages, backupStatus() will provide a mailbox-specific ETA.',
    };
    report.persisted = persistDiagnosticReport_(state, 'estimate', report);
    logger_().log(formatEstimateText_(report));
    return report;
  });
}

/** Harmless target used only to validate trigger creation/deletion. */
function gmailBackupDoctorNoop_() {
  logger_().log('[GMAIL-BACKUP] doctor no-op trigger fired; it is safe to delete this execution.');
}
