/**
 * Hash-checks a deterministic sample of exported files against the global
 * catalog. This does not contact Gmail and does not modify the archive.
 *
 * @param {number=} sampleSize number of records to verify
 */
function verifyBackupSampleAction_(sampleSize) {
  return verifyBackupSample_(sampleSize, false);
}

/**
 * Runs the default verification sample with a direct Drive API media probe for
 * files whose contents DriveApp refuses to read. The probe is read-only, never
 * acknowledges abusive content, and records no message bytes or OAuth tokens.
 */
function diagnoseDriveReadAccessAction_() {
  return verifyBackupSample_(backupConfig_().DEFAULT_VERIFY_SAMPLE_SIZE, true);
}

function verifyBackupSample_(sampleSize, probeDriveApiMedia) {
  return withScriptLock_(function () {
    const state = requireState_();
    if ([BACKUP_PHASE.SCANNING, BACKUP_PHASE.AUDITING, BACKUP_PHASE.QUEUEING, BACKUP_PHASE.APPLYING].indexOf(state.phase) !== -1) {
      throw new Error('Run verification after the active plan/apply phase completes, or pause it first.');
    }
    const layout = ensureRootLayout_(state.rootFolderId, archiveRootContext_(state));
    const limit = Math.max(1, Math.floor(Number(sampleSize || backupConfig_().DEFAULT_VERIFY_SAMPLE_SIZE)));
    const selected = [];
    let populationScanned = 0;

    // Choose the globally smallest deterministic scores. Unlike taking the
    // first records from the first few shards, this samples the whole catalog
    // reproducibly without retaining every record in memory.
    const catalogFiles = listFilesByName_(layout.catalog);
    Object.keys(catalogFiles).sort().forEach(function (name) {
      if (!/^shard-[0-9a-f]{2}\.json$/.test(name)) return;
      const records = readJsonFile_(catalogFiles[name], []);
      records.forEach(function (record) {
        if (record.status !== 'exported' || !storageFileIdForRecord_(record) || !record.sha256) return;
        populationScanned++;
        keepDeterministicSampleCandidate_(selected, record, limit);
      });
    });

    selected.sort(function (a, b) {
      return a.score - b.score || String(a.record.id).localeCompare(String(b.record.id));
    });

    const results = [];
    let ok = 0;
    let failed = 0;
    let downloadable = 0;
    let downloadRestricted = 0;
    let rawContentVerified = 0;
    let rawMetadataVerified = 0;

    selected.forEach(function (candidate) {
      const record = candidate.record;
      const diagnostic = {
        id: record.id,
        deterministicScore: candidate.score,
        stage: 'openFile',
      };
      try {
        const file = driveService_().getFileById(storageFileIdForRecord_(record));
        diagnostic.stage = 'readMetadata';
        diagnostic.fileName = file.getName();
        diagnostic.actualBytes = Number(file.getSize());
        diagnostic.mimeType = file.getMimeType();
        diagnostic.stage = 'checkParent';
        const expectedShardFolder = findChildFolder_(layout.data, 'shard-' + shardForId_(record.id));
        diagnostic.inExpectedFolder = Boolean(expectedShardFolder && fileIsInFolder_(file, expectedShardFolder.getId()));
        diagnostic.stage = 'readContent';
        const contentRead = readArchiveFileIntegrity_(file, record, Boolean(probeDriveApiMedia));
        diagnostic.contentReadMethod = contentRead.method;
        if (contentRead.driveAppError) diagnostic.driveAppContentError = contentRead.driveAppError;
        if (contentRead.driveApi) diagnostic.driveApi = contentRead.driveApi;
        if (!contentRead.ok) {
          throw new Error(contentRead.error || 'Drive content could not be verified.');
        }
        const encoding = archiveEncodingForRecord_(record);
        const expectedStoredBytes = expectedStoredBytesForRecord_(record);
        const expectedStoredSha256 = expectedStoredSha256ForRecord_(record);
        const storedIntegrityVerified = Boolean(expectedStoredSha256) &&
          contentRead.storedSha256 === expectedStoredSha256;
        const rawIntegrityVerified = Boolean(contentRead.rawSha256) &&
          contentRead.rawSha256 === record.sha256 &&
          Number(contentRead.rawByteLength) === Number(record.rawBytes);
        const rawContentWasVerified = rawIntegrityVerified &&
          (contentRead.contentDecoded || encoding === 'EML');
        const rawMetadataWasVerified = rawIntegrityVerified &&
          contentRead.rawIntegritySource === 'archiveMetadata';
        const integrityVerified = storedIntegrityVerified &&
          (rawIntegrityVerified || (encoding === 'ZIP' && !contentRead.contentDecoded));
        const verified = {
          id: record.id,
          archiveEncoding: encoding,
          fileName: diagnostic.fileName,
          innerFileName: record.innerFileName || null,
          expectedBytes: expectedStoredBytes,
          actualBytes: diagnostic.actualBytes,
          expectedRawBytes: Number(record.rawBytes),
          actualRawBytes: contentRead.rawByteLength,
          expectedStoredBytes: expectedStoredBytes,
          actualStoredBytes: diagnostic.actualBytes,
          expectedSha256: record.sha256,
          actualSha256: contentRead.rawSha256 || contentRead.storedSha256,
          expectedRawSha256: record.sha256,
          actualRawSha256: contentRead.rawSha256 || null,
          expectedStoredSha256: expectedStoredSha256,
          actualStoredSha256: contentRead.storedSha256,
          rawIntegrityVerified: rawIntegrityVerified,
          rawContentVerified: rawContentWasVerified,
          rawMetadataVerified: rawMetadataWasVerified,
          rawIntegritySource: contentRead.rawIntegritySource || null,
          storedIntegrityVerified: storedIntegrityVerified,
          inExpectedFolder: diagnostic.inExpectedFolder,
          deterministicScore: candidate.score,
          contentReadMethod: contentRead.method,
          driveAppContentError: contentRead.driveAppError || null,
          driveApi: contentRead.driveApi || null,
          downloadable: contentRead.downloadable,
          ok: diagnostic.inExpectedFolder && diagnostic.fileName === record.fileName &&
            integrityVerified && diagnostic.actualBytes === expectedStoredBytes,
        };
        results.push(verified);
        if (verified.downloadable === false) downloadRestricted++;
        if (verified.downloadable === true) downloadable++;
        if (verified.rawContentVerified) rawContentVerified++;
        if (verified.rawMetadataVerified) rawMetadataVerified++;
        if (verified.ok) ok++; else failed++;
      } catch (error) {
        failed++;
        diagnostic.ok = false;
        diagnostic.error = errorToString_(error);
        results.push(diagnostic);
      }
    });

    const report = {
      schemaVersion: 3,
      checkedAt: isoNow_(),
      mode: probeDriveApiMedia ? 'drive-read-diagnostic' : 'verification',
      driveApiMediaProbe: Boolean(probeDriveApiMedia),
      catalogPopulationScanned: populationScanned,
      requested: limit,
      checked: results.length,
      ok: ok,
      integrityVerified: ok,
      rawContentVerified: rawContentVerified,
      rawMetadataVerified: rawMetadataVerified,
      failed: failed,
      downloadable: downloadable,
      downloadRestricted: downloadRestricted,
      portable: failed === 0 && downloadRestricted === 0,
      results: results,
    };
    const verificationFolder = getOrCreateChildFolder_(layout.root, 'verification');
    upsertJsonFile_(verificationFolder, 'sample-' + compactTimestamp_() + '-' + utilitiesService_().getUuid().slice(0, 8) + '.json', report);
    logger_().log(JSON.stringify(report, null, 2));
    return report;
  });
}

/**
 * Reads a file hash through DriveApp first. When DriveApp denies content
 * access, the same Apps Script OAuth client fetches Drive metadata and falls
 * back to Drive's server-computed SHA-256 for stored blob files. An optional
 * unacknowledged media probe captures Drive's specific denial reason.
 */
function readDriveFileIntegrity_(file, probeDriveApiMedia) {
  try {
    const bytes = file.getBlob().getBytes();
    return {
      ok: true,
      method: 'driveAppBlob',
      downloadable: true,
      sha256: sha256Hex_(bytes),
      bytes: bytes,
    };
  } catch (driveAppError) {
    const driveAppErrorText = truncateString_(errorToString_(driveAppError), 1000);
    if (isS3StorageBackend_()) {
      return {
        ok: false,
        method: 's3ObjectReadFailed',
        error: driveAppErrorText,
      };
    }
    if (!hasRuntimeService_('urlFetch', typeof UrlFetchApp !== 'undefined' ? UrlFetchApp : null) ||
        !hasRuntimeService_('script', typeof ScriptApp !== 'undefined' ? ScriptApp : null) ||
        typeof scriptService_().getOAuthToken !== 'function') {
      return {
        ok: false,
        method: 'unavailable',
        driveAppError: driveAppErrorText,
        error: 'DriveApp content read failed and the direct Drive API fallback is unavailable.',
      };
    }

    const fileId = file.getId();
    const token = scriptService_().getOAuthToken();
    const metadataResult = driveApiReadIntegrityMetadata_(fileId, token);
    const apiDiagnostic = {
      metadataStatus: metadataResult.status,
      metadata: metadataResult.metadata || null,
      metadataError: metadataResult.error || null,
    };

    if (probeDriveApiMedia) {
      const mediaResult = driveApiProbeMediaRead_(fileId, token);
      apiDiagnostic.mediaStatus = mediaResult.status;
      apiDiagnostic.mediaError = mediaResult.error || null;
      if (mediaResult.ok) {
        return {
          ok: true,
          method: 'driveApiMedia',
          downloadable: true,
          sha256: mediaResult.sha256,
          bytes: mediaResult.bytes,
          driveAppError: driveAppErrorText,
          driveApi: apiDiagnostic,
        };
      }
    }

    if (metadataResult.ok && metadataResult.metadata.sha256Checksum) {
      return {
        ok: true,
        method: 'driveApiServerSha256',
        downloadable: metadataResult.metadata.capabilities &&
          typeof metadataResult.metadata.capabilities.canDownload === 'boolean'
          ? metadataResult.metadata.capabilities.canDownload
          : null,
        sha256: String(metadataResult.metadata.sha256Checksum).toLowerCase(),
        driveAppError: driveAppErrorText,
        driveApi: apiDiagnostic,
      };
    }

    return {
      ok: false,
      method: 'driveApiUnavailable',
      driveAppError: driveAppErrorText,
      driveApi: apiDiagnostic,
      error: 'DriveApp content read failed and Drive returned no usable server-side SHA-256 checksum.',
    };
  }
}

function driveApiReadIntegrityMetadata_(fileId, oauthToken) {
  const fields = [
    'id', 'name', 'size', 'mimeType', 'parents', 'ownedByMe', 'isAppAuthorized',
    'sha256Checksum', 'md5Checksum', 'appProperties',
    'capabilities(canDownload,canReadRevisions,canCopy,canEdit)',
    'contentRestrictions', 'downloadRestrictions',
  ].join(',');
  const response = urlFetchService_().fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
      '?supportsAllDrives=true&fields=' + encodeURIComponent(fields),
    {
      method: 'get',
      headers: {Authorization: 'Bearer ' + String(oauthToken || '')},
      muteHttpExceptions: true,
    }
  );
  const status = Number(response.getResponseCode());
  const text = response.getContentText();
  if (status < 200 || status >= 300) {
    return {ok: false, status: status, error: truncateString_(text, 1500)};
  }
  try {
    return {ok: true, status: status, metadata: JSON.parse(text || '{}')};
  } catch (error) {
    return {ok: false, status: status, error: 'Drive metadata response was not valid JSON.'};
  }
}

function driveApiProbeMediaRead_(fileId, oauthToken) {
  const response = urlFetchService_().fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
      '?alt=media&supportsAllDrives=true',
    {
      method: 'get',
      headers: {Authorization: 'Bearer ' + String(oauthToken || '')},
      muteHttpExceptions: true,
    }
  );
  const status = Number(response.getResponseCode());
  if (status >= 200 && status < 300) {
    const bytes = response.getBlob().getBytes();
    return {ok: true, status: status, sha256: sha256Hex_(bytes), bytes: bytes};
  }
  return {
    ok: false,
    status: status,
    error: truncateString_(response.getContentText(), 1500),
  };
}
