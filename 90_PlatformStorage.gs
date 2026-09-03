// -----------------------------------------------------------------------------
// Gmail, Drive, and integrity helpers
// -----------------------------------------------------------------------------

/**
 * Normalizes Gmail's RAW message representation into an Apps Script Byte[].
 *
 * Important compatibility detail: the public Gmail REST API documents the
 * Message.raw field as a base64url string. Apps Script's Advanced Gmail service
 * is generated from the same discovery document, where raw has format=byte,
 * and in current Apps Script it is commonly materialized as a Byte[] already.
 * Google Workspace's official Apps Script sample passes message.raw directly to
 * Utilities.base64Encode(), and community examples iterate raw as bytes.
 *
 * We intentionally accept both representations so the exporter remains robust
 * across Apps Script runtime/service behavior changes and direct-test mocks.
 */
function gmailRawBytes_(raw) {
  if (raw === null || raw === undefined) {
    throw new Error('Gmail RAW payload is null or undefined.');
  }

  // Current Advanced Gmail service behavior: raw is already a byte array.
  if (Array.isArray(raw)) {
    return normalizeByteArray_(raw);
  }

  // Defensive support for Blob-like or array-like values.
  if (raw && typeof raw.getBytes === 'function') {
    return normalizeByteArray_(raw.getBytes());
  }
  if (typeof raw !== 'string' && raw && typeof raw.length === 'number') {
    try {
      return normalizeByteArray_(Array.prototype.slice.call(raw));
    } catch (ignored) {}
  }

  // REST-style representation: base64url/base64 string. Gmail may omit
  // padding, so normalize it before decoding. Prefer the alphabet we observe.
  if (typeof raw === 'string') {
    let encoded = raw.replace(/\s+/g, '');
    if (!encoded) return [];
    const remainder = encoded.length % 4;
    if (remainder === 1) {
      throw new Error('Gmail RAW payload has an invalid base64 length.');
    }
    if (remainder) encoded += new Array(5 - remainder).join('=');

    try {
      if (/[+\/]/.test(encoded)) {
        return normalizeByteArray_(utilitiesService_().base64Decode(encoded));
      }
      return normalizeByteArray_(utilitiesService_().base64DecodeWebSafe(encoded));
    } catch (error) {
      throw new Error('Could not decode Gmail RAW payload: ' + errorToString_(error));
    }
  }

  throw new Error('Unsupported Gmail RAW payload type: ' + Object.prototype.toString.call(raw));
}

function normalizeByteArray_(values) {
  const source = values || [];
  const length = Number(source.length || 0);
  let needsCopy = !Array.isArray(source);

  for (let index = 0; index < length; index++) {
    const value = source[index];
    const n = Number(value);
    if (!Number.isFinite(n) || Math.floor(n) !== n || n < -128 || n > 255) {
      throw new Error('Invalid Gmail RAW byte at index ' + index + ': ' + value);
    }
    if (value !== n || n > 127) needsCopy = true;
  }

  // Advanced Gmail and UrlFetch both use signed Apps Script Byte[] arrays.
  // Returning an already-normalized array avoids another full payload-sized
  // allocation at every decode, hash, signing, and upload boundary.
  if (!needsCopy) return source;

  const normalized = new Array(length);
  for (let index = 0; index < length; index++) {
    const n = Number(source[index]);
    normalized[index] = n > 127 ? n - 256 : n;
  }
  return normalized;
}

function gmailCall_(fn, operationName) {
  let delay = backupConfig_().INITIAL_RETRY_DELAY_MS;
  let lastError;
  for (let attempt = 1; attempt <= backupConfig_().MAX_RETRIES; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isTransientError_(error) || attempt === backupConfig_().MAX_RETRIES) break;
      logger_().warn(operationName + ' failed transiently (attempt ' + attempt + '): ' + errorToString_(error));
      utilitiesService_().sleep(delay + Math.floor(Math.random() * 250));
      delay *= 2;
    }
  }
  throw lastError;
}

function isTransientError_(error) {
  const text = errorToString_(error).toLowerCase();
  return /429|rate limit|backend error|internal error|service unavailable|temporar|try again|too many times|quota|500|502|503|504/.test(text);
}

function isNotFoundError_(error) {
  const text = errorToString_(error).toLowerCase();
  return /404|not found|requested entity was not found/.test(text);
}

function isInvalidPageTokenError_(error) {
  const text = errorToString_(error).toLowerCase();
  return /invalid.*page[_ ]?token|page[_ ]?token.*invalid|invalid argument.*page[_ ]?token|400.*page[_ ]?token/.test(text);
}

function ensureRootLayout_(preferredRootFolderId, archiveContext) {
  const config = backupConfig_();
  const drive = driveService_();
  let context = archiveContext || {};
  let root = null;
  if (preferredRootFolderId) {
    try {
      root = drive.getFolderById(preferredRootFolderId);
    } catch (error) {
      throw new Error(
        'The configured backup root folder is unavailable (' + preferredRootFolderId + '). ' +
        'Restore access to that folder or clear the script property before creating a new archive. ' +
        errorToString_(error)
      );
    }
  }
  if (!root && config.TARGET_ROOT_FOLDER_ID) {
    try {
      root = drive.getFolderById(config.TARGET_ROOT_FOLDER_ID);
    } catch (error) {
      throw new Error(
        'TARGET_ROOT_FOLDER_ID is unavailable (' + config.TARGET_ROOT_FOLDER_ID + '). ' +
        'Share that folder with the executing account and grant edit access. ' + errorToString_(error)
      );
    }
  }
  // Never discover an archive by name: Drive permits duplicate names, and a
  // second Apps Script project would have a different ScriptLock/state store.
  // A fresh project therefore creates a fresh root, then persists its exact ID.
  if (!root && config.TARGET_PARENT_FOLDER_ID) {
    let parent;
    try {
      parent = drive.getFolderById(config.TARGET_PARENT_FOLDER_ID);
    } catch (error) {
      throw new Error(
        'TARGET_PARENT_FOLDER_ID is unavailable (' + config.TARGET_PARENT_FOLDER_ID + '). ' +
        'Share that folder with the executing account and grant edit access. ' + errorToString_(error)
      );
    }
    // A child inherits its parent's storage domain. Reject an unsupported
    // Shared Drive before createFolder() so a failed setup cannot leave an
    // unclaimed duplicate archive directory behind.
    const parentStorage = inspectArchiveRootStorage_(parent.getId());
    context = Object.assign({}, context, {preverifiedStorage: parentStorage});
    root = parent.createFolder(config.ROOT_FOLDER_NAME);
  }
  if (!root) root = drive.createFolder(config.ROOT_FOLDER_NAME);
  assertOrInitializeArchiveManifest_(root, context);
  return {
    root: root,
    data: getOrCreateChildFolder_(root, 'data'),
    catalog: getOrCreateChildFolder_(root, 'catalog'),
    plans: getOrCreateChildFolder_(root, 'plans'),
  };
}

function archiveRootContext_(state, account, verifyStorage) {
  return {
    state: state || null,
    account: String(account || (state && state.account) || ''),
    allowLegacyAdoption: Boolean(state && state.rootFolderId),
    verifyStorage: Boolean(verifyStorage),
  };
}

function assertOrInitializeArchiveManifest_(root, context) {
  const config = backupConfig_();
  const manifestName = config.ARCHIVE_MANIFEST_FILE;
  const matches = [];
  const iterator = root.getFilesByName(manifestName);
  while (iterator.hasNext()) matches.push(iterator.next());
  if (matches.length > 1) {
    throw new Error('Archive root contains duplicate ' + manifestName + ' files; refusing an ambiguous writer lease.');
  }

  let expected = archiveManifestExpectation_(root, context || {}, null);
  if (matches.length === 0) {
    const hasFiles = root.getFiles().hasNext();
    const hasFolders = root.getFolders().hasNext();
    if ((hasFiles || hasFolders) && !(context && context.allowLegacyAdoption)) {
      throw new Error(
        'TARGET_ROOT_FOLDER_ID must refer to an empty folder or a Gmail Backup root with a valid ' +
        manifestName + '. Refusing to mix this archive with existing content.'
      );
    }
    if (context && context.allowLegacyAdoption) {
      const state = context.state || null;
      const isAnchoredRoot = state && String(state.rootFolderId || '') === String(root.getId());
      const hasLegacyLayout = Boolean(
        findChildFolder_(root, 'data') && findChildFolder_(root, 'catalog') && findChildFolder_(root, 'plans')
      );
      if (!isAnchoredRoot || !hasLegacyLayout) {
        throw new Error(
          'A non-empty manifest-less folder may be adopted only when existing Script Properties ' +
          'anchor this project to a complete legacy Gmail Backup layout.'
        );
      }
    }
    expected = archiveManifestExpectation_(
      root,
      context || {},
      context && context.preverifiedStorage || inspectArchiveRootStorage_(root.getId())
    );
    root.createFile(manifestName, JSON.stringify(expected), 'text/plain');
    return expected;
  }

  const file = matches[0];
  const manifest = readJsonFile_(file, null);
  validateArchiveManifest_(manifest, expected);

  let changed = false;
  if (!manifest.storage || (context && context.verifyStorage)) {
    const storage = inspectArchiveRootStorage_(root.getId());
    if (!manifest.storage) {
      manifest.storage = storage;
      changed = true;
    }
  }
  if (!manifest.account && expected.account) {
    manifest.account = expected.account;
    changed = true;
  }
  if (!manifest.writer.scriptId && expected.writer.scriptId) {
    manifest.writer.scriptId = expected.writer.scriptId;
    changed = true;
  }
  if (changed) {
    manifest.updatedAt = isoNow_();
    file.setContent(JSON.stringify(manifest));
  }
  return manifest;
}

function archiveManifestExpectation_(root, context, storage) {
  const state = context.state || null;
  const writer = archiveWriterIdentity_();
  return {
    schemaVersion: 1,
    archiveId: utilitiesService_().getUuid(),
    rootFolderId: root.getId(),
    account: normalizeAccountEmail_(context.account || (state && state.account) || ''),
    catalogShardCount: Number(
      state && state.archiveConfig && state.archiveConfig.shardCount || backupConfig_().SHARD_COUNT
    ),
    storage: storage || null,
    writer: writer,
    createdAt: isoNow_(),
    updatedAt: isoNow_(),
  };
}

function inspectArchiveRootStorage_(folderId) {
  if (isS3StorageBackend_()) {
    const descriptor = s3StorageDescriptor_();
    descriptor.verifiedAt = isoNow_();
    return descriptor;
  }
  const drive = driveService_();
  if (drive && typeof drive.getStorageDomain === 'function') {
    const reported = drive.getStorageDomain(folderId) || {};
    if (reported.kind === 'SHARED_DRIVE' || reported.driveId) {
      throwUnsupportedSharedDriveRoot_();
    }
    return {
      kind: reported.kind || 'CUSTOM_ADAPTER',
      driveId: reported.driveId || null,
      verifiedAt: isoNow_(),
    };
  }
  const runtime = currentBackupRuntime_();
  if (runtime && runtime.serviceOverrideNames && runtime.serviceOverrideNames.indexOf('drive') !== -1) {
    return {kind: 'CUSTOM_ADAPTER', driveId: null, verifiedAt: isoNow_()};
  }

  const script = scriptService_();
  if (!script || typeof script.getOAuthToken !== 'function') {
    throw new Error('Cannot verify whether the archive root is in My Drive: ScriptApp OAuth token is unavailable.');
  }
  const responses = driveApiFetchAll_([{
    url: 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) +
      '?supportsAllDrives=true&fields=id%2Cname%2CdriveId%2Ccapabilities(canAddChildren%2CcanEdit)',
    method: 'get',
    headers: {Authorization: 'Bearer ' + script.getOAuthToken()},
    muteHttpExceptions: true,
  }], 'Drive root storage check');
  const metadata = responses[0] || {};
  if (metadata.driveId) {
    throwUnsupportedSharedDriveRoot_();
  }
  if (metadata.capabilities && metadata.capabilities.canAddChildren === false) {
    throw new Error('The archive root does not permit this account to add child files and folders.');
  }
  return {kind: 'MY_DRIVE', driveId: null, verifiedAt: isoNow_()};
}

function throwUnsupportedSharedDriveRoot_() {
  const error = new Error(
    'Google Shared Drive roots are not supported because the backup relies on DriveApp for folder, ' +
    'checkpoint, quarantine, and fallback-file operations. Use an editable folder shared from another ' +
    "account's My Drive, or supply a complete custom Drive adapter."
  );
  error.code = 'GMAIL_BACKUP_SHARED_DRIVE_UNSUPPORTED';
  throw error;
}

function archiveWriterIdentity_() {
  let scriptId = '';
  const script = scriptService_();
  if (script && typeof script.getScriptId === 'function') {
    scriptId = String(script.getScriptId() || '');
  }
  const properties = propertiesService_().getScriptProperties();
  const key = backupConfig_().WRITER_INSTANCE_PROPERTY;
  let instanceId = properties.getProperty(key);
  if (!instanceId) {
    instanceId = utilitiesService_().getUuid();
    properties.setProperty(key, instanceId);
  }
  return {scriptId: scriptId, instanceId: String(instanceId)};
}

function validateArchiveManifest_(manifest, expected) {
  if (!manifest || Number(manifest.schemaVersion) !== 1 || !manifest.archiveId || !manifest.writer) {
    throw new Error('Archive root manifest is missing or unsupported; refusing to write to this folder.');
  }
  if (manifest.storage && manifest.storage.kind === 'SHARED_DRIVE') {
    throw new Error('Archive manifest identifies an unsupported Google Shared Drive root.');
  }
  const expectedStorageKind = storageBackendKind_() === 'S3' ? 'S3' : 'GOOGLE_DRIVE';
  const manifestIsS3 = manifest.storage && manifest.storage.kind === 'S3';
  if (manifest.storage && ((expectedStorageKind === 'S3' && !manifestIsS3) ||
      (expectedStorageKind === 'GOOGLE_DRIVE' && manifestIsS3))) {
    throw new Error('Archive manifest belongs to a different storage backend; refusing to continue.');
  }
  if (manifest.storage && expectedStorageKind === 'S3' &&
      manifest.storage.bindingHash && manifest.storage.bindingHash !== s3BindingHash_()) {
    throw new Error('Archive manifest belongs to a different S3 bucket/endpoint/prefix binding.');
  }
  if (String(manifest.rootFolderId || '') !== String(expected.rootFolderId)) {
    throw new Error('Archive root manifest belongs to a different logical storage root; refusing to continue.');
  }
  const manifestAccount = normalizeAccountEmail_(manifest.account || '');
  if (manifestAccount && expected.account && manifestAccount !== expected.account) {
    throw new Error(
      'Archive root is bound to Gmail account ' + manifest.account +
      ', not ' + expected.account + '; refusing to mix mailboxes.'
    );
  }
  if (Number(manifest.catalogShardCount || 0) !== Number(expected.catalogShardCount || 0)) {
    throw new Error(
      'Archive root uses ' + Number(manifest.catalogShardCount || 0) +
      ' catalog shards, not the required ' + Number(expected.catalogShardCount || 0) + '.'
    );
  }
  const actualWriter = manifest.writer || {};
  const expectedWriter = expected.writer || {};
  const scriptMismatch = actualWriter.scriptId && expectedWriter.scriptId &&
    String(actualWriter.scriptId) !== String(expectedWriter.scriptId);
  const fallbackMismatch = (!actualWriter.scriptId || !expectedWriter.scriptId) &&
    actualWriter.instanceId && expectedWriter.instanceId &&
    String(actualWriter.instanceId) !== String(expectedWriter.instanceId);
  if (scriptMismatch || fallbackMismatch) {
    throw new Error(
      'Archive root is leased to a different Apps Script writer. Use a distinct empty target folder ' +
      'or continue from the project that created this archive.'
    );
  }
}

function normalizeAccountEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function getOrCreateChildFolder_(parent, name) {
  const iterator = parent.getFoldersByName(name);
  if (iterator.hasNext()) return iterator.next();
  return parent.createFolder(name);
}

function findChildFolder_(parent, name) {
  const iterator = parent.getFoldersByName(name);
  return iterator.hasNext() ? iterator.next() : null;
}

function listFoldersByName_(folder) {
  const result = {};
  const iterator = folder.getFolders();
  while (iterator.hasNext()) {
    const child = iterator.next();
    if (!result[child.getName()]) result[child.getName()] = child;
  }
  return result;
}

function fileIsInFolder_(file, folderId) {
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) return true;
  }
  return false;
}

function folderHasAnyFiles_(folder) {
  return folder.getFiles().hasNext();
}

function listFilesByName_(folder) {
  const result = {};
  const iterator = folder.getFiles();
  while (iterator.hasNext()) {
    const file = iterator.next();
    if (!result[file.getName()]) result[file.getName()] = file;
  }
  return result;
}

function firstFileByName_(folder, name) {
  const iterator = folder.getFilesByName(name);
  return iterator.hasNext() ? iterator.next() : null;
}

function driveApiCreateFiles_(specs, oauthToken) {
  if (isS3StorageBackend_()) return s3ApiCreateFiles_(specs);
  const requests = (specs || []).map(function (spec, index) {
    return buildDriveMultipartCreateRequest_(spec, oauthToken, index);
  });
  return driveApiFetchAll_(requests, 'Drive API parallel create');
}

function driveApiUpdateMedia_(updates, oauthToken) {
  if (isS3StorageBackend_()) return s3ApiUpdateMedia_(updates);
  const token = String(oauthToken || '');
  const requests = (updates || []).map(function (update) {
    return {
      url: 'https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(update.fileId) +
        '?uploadType=media&supportsAllDrives=true&fields=id%2Csize',
      method: 'patch',
      contentType: update.mimeType || 'application/json',
      headers: {Authorization: 'Bearer ' + token},
      payload: String(update.content || ''),
      muteHttpExceptions: true,
    };
  });
  return driveApiFetchAll_(requests, 'Drive API parallel media update');
}

function buildDriveMultipartCreateRequest_(spec, oauthToken, index) {
  const boundary = 'gmail_backup_' + utilitiesService_().getUuid().replace(/-/g, '') + '_' + Number(index || 0);
  const metadata = {
    name: spec.name,
    mimeType: spec.mimeType || 'application/octet-stream',
    parents: [spec.parentId],
  };
  if (spec.appProperties) metadata.appProperties = spec.appProperties;
  const prefix = utilitiesService_().newBlob(
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + metadata.mimeType + '\r\n\r\n'
  ).getBytes();
  const suffix = utilitiesService_().newBlob('\r\n--' + boundary + '--').getBytes();
  return {
    url: 'https://www.googleapis.com/upload/drive/v3/files' +
      '?uploadType=multipart&supportsAllDrives=true&fields=id%2Cname%2Csize%2CmimeType%2Cparents%2CappProperties',
    method: 'post',
    contentType: 'multipart/related; boundary=' + boundary,
    headers: {Authorization: 'Bearer ' + String(oauthToken || '')},
    payload: prefix.concat(spec.bytes || [], suffix),
    muteHttpExceptions: true,
  };
}

function driveApiFetchAll_(requests, operationName) {
  if (!(requests || []).length) return [];
  const parsedResponses = [];
  const waveSize = Math.max(1, Number(backupConfig_().DRIVE_API_MAX_PARALLEL_FILES || 1));
  for (let offset = 0; offset < requests.length; offset += waveSize) {
    const wave = requests.slice(offset, offset + waveSize);
    const responses = urlFetchService_().fetchAll(wave);
    responses.forEach(function (response, waveIndex) {
      const index = offset + waveIndex;
      const status = Number(response.getResponseCode());
      const text = response.getContentText();
      if (status < 200 || status >= 300) {
        throw new Error(
          operationName + ' failed for request ' + index + ' with HTTP ' + status + ': ' +
          truncateString_(text, 1000)
        );
      }
      let parsed;
      try {
        parsed = JSON.parse(text || '{}');
      } catch (error) {
        throw new Error(operationName + ' returned invalid JSON for request ' + index + '.');
      }
      if (!parsed.id) throw new Error(operationName + ' returned no Drive file ID for request ' + index + '.');
      parsedResponses.push(parsed);
    });
  }
  return parsedResponses;
}

function listCanonicalArchiveFiles_(folder) {
  const byId = {};
  const allById = {};
  let duplicates = 0;
  let invalidFiles = 0;
  const iterator = folder.getFiles();
  while (iterator.hasNext()) {
    const file = iterator.next();
    const name = file.getName();
    const match = /^([A-Za-z0-9_-]+)\.eml(?:\.zip)?$/i.exec(name);
    if (!match) {
      invalidFiles++;
      continue;
    }
    const id = match[1];
    if (!allById[id]) allById[id] = [];
    allById[id].push(file);
    if (byId[id]) duplicates++;
    else byId[id] = file;
  }
  return {byId: byId, allById: allById, duplicates: duplicates, invalidFiles: invalidFiles};
}

function chooseCanonicalFile_(existing, id, catalogRecord) {
  const files = (existing.allById && existing.allById[id]) || [];
  const catalogStorageFileId = storageFileIdForRecord_(catalogRecord);
  if (catalogRecord && catalogStorageFileId) {
    for (let i = 0; i < files.length; i++) {
      if (files[i].getId() === catalogStorageFileId) return files[i];
    }
  }
  return existing.byId[id] || null;
}

function canonicalArchiveHealth_(file, catalogRecord) {
  if (!file) return {ok: false, category: 'missing', reason: 'canonical-file-missing'};
  if (!catalogRecord || catalogRecord.status !== 'exported') {
    return {ok: false, category: 'uncommitted', reason: 'canonical-file-has-no-exported-catalog-record'};
  }
  const catalogStorageFileId = storageFileIdForRecord_(catalogRecord);
  if (!catalogStorageFileId || file.getId() !== catalogStorageFileId) {
    return {ok: false, category: 'catalog-mismatch', reason: 'catalog-storage-file-id-mismatch'};
  }
  const actualFileName = String(file.getName() || '');
  if (catalogRecord.fileName && actualFileName !== String(catalogRecord.fileName)) {
    return {ok: false, category: 'catalog-mismatch', reason: 'canonical-file-name-mismatch'};
  }
  const expectedEncoding = archiveEncodingForRecord_(catalogRecord);
  const actualEncoding = archiveEncodingForFileName_(actualFileName);
  if (!actualEncoding || actualEncoding !== expectedEncoding) {
    return {ok: false, category: 'catalog-mismatch', reason: 'canonical-file-encoding-mismatch'};
  }
  const actualMimeType = String(file.getMimeType() || '');
  if (catalogRecord.mimeType && actualMimeType !== String(catalogRecord.mimeType)) {
    return {ok: false, category: 'catalog-mismatch', reason: 'canonical-file-mime-type-mismatch'};
  }
  const expectedSize = expectedStoredBytesForRecord_(catalogRecord);
  if (!Number.isFinite(expectedSize) || expectedSize < 0) {
    return {ok: false, category: 'catalog-mismatch', reason: 'catalog-byte-size-missing'};
  }
  if (Number(file.getSize()) !== expectedSize) {
    return {ok: false, category: 'catalog-mismatch', reason: 'canonical-file-size-mismatch'};
  }
  return {ok: true, category: 'healthy', reason: 'committed'};
}

function storageFileIdForRecord_(record) {
  return record && (record.storageFileId || record.driveFileId) || null;
}

function readJsonFile_(file, fallback) {
  if (!file) return fallback;
  const text = file.getBlob().getDataAsString();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Invalid JSON in Drive file "' + file.getName() + '" (' + file.getId() + '): ' + errorToString_(error));
  }
}

function upsertJsonFile_(folder, name, value) {
  return upsertTextFile_(folder, name, JSON.stringify(value, null, 2));
}

function upsertTextFile_(folder, name, content) {
  const file = firstFileByName_(folder, name);
  if (file) {
    file.setContent(content);
    return file;
  }
  return folder.createFile(name, content, 'text/plain');
}

function sha256Hex_(bytes) {
  const digest = utilitiesService_().computeDigest(utilitiesService_().DigestAlgorithm.SHA_256, bytes);
  return digest.map(function (b) {
    const value = b < 0 ? b + 256 : b;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function buildArchivePayload_(id, rawBytes, rawSha256) {
  const rawFileName = id + '.eml';
  const rawDigest = rawSha256 || sha256Hex_(rawBytes);
  if (backupConfig_().ARCHIVE_ENCODING === 'ZIP') {
    const fileName = rawFileName + '.zip';
    const zipBlob = utilitiesService_().zip([
      utilitiesService_().newBlob(rawBytes, 'message/rfc822', rawFileName),
    ], fileName);
    const storedBytes = zipBlob.getBytes();
    return {
      archiveEncoding: 'ZIP',
      fileName: fileName,
      innerFileName: rawFileName,
      mimeType: 'application/zip',
      rawBytes: rawBytes,
      rawByteLength: rawBytes.length,
      rawSha256: rawDigest,
      storedBytes: storedBytes,
      storedByteLength: storedBytes.length,
      storedSha256: sha256Hex_(storedBytes),
    };
  }
  return {
    archiveEncoding: 'EML',
    fileName: rawFileName,
    innerFileName: null,
    mimeType: 'message/rfc822',
    rawBytes: rawBytes,
    rawByteLength: rawBytes.length,
    rawSha256: rawDigest,
    storedBytes: rawBytes,
    storedByteLength: rawBytes.length,
    storedSha256: rawDigest,
  };
}

function archiveIntegrityProperties_(archive) {
  return {
    gbSchema: '1',
    gbEncoding: archive.archiveEncoding,
    gbRawBytes: String(archive.rawByteLength),
    gbRawSha256: archive.rawSha256,
  };
}

function archiveIntegrityDescription_(archive) {
  return 'GMAIL_BACKUP_ARCHIVE_V1 ' + JSON.stringify(archiveIntegrityProperties_(archive));
}

function parseArchiveIntegrityDescription_(description) {
  const prefix = 'GMAIL_BACKUP_ARCHIVE_V1 ';
  const text = String(description || '');
  if (text.indexOf(prefix) !== 0) return null;
  try {
    return JSON.parse(text.slice(prefix.length));
  } catch (ignored) {
    return null;
  }
}

function archiveIntegrityMarkerForFile_(file, storedRead) {
  let marker = null;
  try {
    if (typeof file.getDescription === 'function') {
      marker = parseArchiveIntegrityDescription_(file.getDescription());
    }
  } catch (ignored) {}
  if (!marker && storedRead && storedRead.driveApi && storedRead.driveApi.metadata) {
    marker = storedRead.driveApi.metadata.appProperties || null;
  }
  if (!marker || marker.gbSchema !== '1' || !marker.gbRawSha256) return null;
  const rawBytes = Number(marker.gbRawBytes);
  if (!Number.isFinite(rawBytes) || rawBytes < 0) return null;
  return {
    archiveEncoding: String(marker.gbEncoding || '').toUpperCase(),
    rawByteLength: rawBytes,
    rawSha256: String(marker.gbRawSha256).toLowerCase(),
  };
}

function archiveEncodingForFileName_(fileName) {
  const name = String(fileName || '');
  if (/\.eml\.zip$/i.test(name)) return 'ZIP';
  if (/\.eml$/i.test(name)) return 'EML';
  return null;
}

function archiveEncodingForRecord_(record) {
  const explicit = String((record || {}).archiveEncoding || '').toUpperCase();
  if (explicit === 'ZIP' || explicit === 'EML') return explicit;
  return archiveEncodingForFileName_((record || {}).fileName) || 'EML';
}

function archiveMimeTypeForEncoding_(encoding) {
  return String(encoding || '').toUpperCase() === 'ZIP'
    ? 'application/zip'
    : 'message/rfc822';
}

function expectedStoredBytesForRecord_(record) {
  const stored = Number((record || {}).storedBytes);
  if (Number.isFinite(stored) && stored >= 0) return stored;
  return Number((record || {}).rawBytes);
}

function expectedStoredSha256ForRecord_(record) {
  if ((record || {}).storedSha256) return String(record.storedSha256).toLowerCase();
  return archiveEncodingForRecord_(record) === 'EML'
    ? String((record || {}).sha256 || '').toLowerCase()
    : '';
}

function inspectArchiveBlob_(blob, id, encoding, expectedInnerFileName) {
  const storedBytes = blob.getBytes();
  const normalizedEncoding = String(encoding || 'EML').toUpperCase();
  if (normalizedEncoding === 'EML') {
    return {
      archiveEncoding: 'EML',
      storedBytes: storedBytes,
      storedByteLength: storedBytes.length,
      storedSha256: sha256Hex_(storedBytes),
      rawBytes: storedBytes,
      rawByteLength: storedBytes.length,
      rawSha256: sha256Hex_(storedBytes),
      innerFileName: null,
    };
  }
  if (normalizedEncoding !== 'ZIP') {
    throw new Error('Unsupported archive encoding: ' + normalizedEncoding);
  }
  const entries = utilitiesService_().unzip(blob);
  if (!entries || entries.length !== 1) {
    throw new Error('ZIP archive for Gmail ID ' + id + ' must contain exactly one EML entry.');
  }
  const inner = entries[0];
  const expectedName = expectedInnerFileName || id + '.eml';
  if (typeof inner.getName === 'function' && inner.getName() !== expectedName) {
    throw new Error(
      'ZIP archive for Gmail ID ' + id + ' contains "' + inner.getName() +
      '" instead of "' + expectedName + '".'
    );
  }
  const rawBytes = inner.getBytes();
  return {
    archiveEncoding: 'ZIP',
    storedBytes: storedBytes,
    storedByteLength: storedBytes.length,
    storedSha256: sha256Hex_(storedBytes),
    rawBytes: rawBytes,
    rawByteLength: rawBytes.length,
    rawSha256: sha256Hex_(rawBytes),
    innerFileName: expectedName,
  };
}

function readArchiveFileIntegrity_(file, record, probeDriveApiMedia) {
  const encoding = archiveEncodingForRecord_(record);
  const boundedAttestation = readExternallyAttestedS3Integrity_(file, record);
  if (boundedAttestation) return boundedAttestation;
  let blob;
  try {
    blob = file.getBlob();
  } catch (driveAppError) {
    const storedRead = readDriveFileIntegrity_(file, Boolean(probeDriveApiMedia));
    if (!storedRead.ok) return storedRead;
    if (storedRead.bytes) {
      try {
        const inspected = inspectArchiveBlob_(
          utilitiesService_().newBlob(storedRead.bytes, file.getMimeType(), file.getName()),
          record.id,
          encoding,
          record.innerFileName
        );
        return Object.assign(inspected, {
          ok: true,
          method: storedRead.method,
          downloadable: storedRead.downloadable,
          contentDecoded: true,
          rawIntegritySource: 'content',
          driveAppError: storedRead.driveAppError || null,
          driveApi: storedRead.driveApi || null,
        });
      } catch (decodeError) {
        return {
          ok: false,
          method: 'archiveDecodeFailed',
          downloadable: storedRead.downloadable,
          driveAppError: storedRead.driveAppError || null,
          driveApi: storedRead.driveApi || null,
          error: errorToString_(decodeError),
        };
      }
    }
    const marker = archiveIntegrityMarkerForFile_(file, storedRead);
    const markerMatchesEncoding = marker && marker.archiveEncoding === encoding;
    return {
      ok: true,
      method: storedRead.method,
      downloadable: storedRead.downloadable,
      contentDecoded: encoding === 'EML',
      storedSha256: storedRead.sha256,
      rawSha256: encoding === 'EML'
        ? storedRead.sha256
        : markerMatchesEncoding ? marker.rawSha256 : null,
      storedByteLength: Number(file.getSize()),
      rawByteLength: encoding === 'EML'
        ? Number(file.getSize())
        : markerMatchesEncoding ? marker.rawByteLength : null,
      rawIntegritySource: encoding === 'EML'
        ? 'storedBlob'
        : markerMatchesEncoding ? 'archiveMetadata' : null,
      driveAppError: storedRead.driveAppError || null,
      driveApi: storedRead.driveApi || null,
    };
  }

  try {
    return Object.assign(inspectArchiveBlob_(blob, record.id, encoding, record.innerFileName), {
      ok: true,
      method: 'driveAppBlob',
      downloadable: true,
      contentDecoded: true,
      rawIntegritySource: 'content',
    });
  } catch (decodeError) {
    return {
      ok: false,
      method: 'archiveDecodeFailed',
      downloadable: true,
      error: errorToString_(decodeError),
    };
  }
}

function readExternallyAttestedS3Integrity_(file, record) {
  const verification = record && record.integrityVerification;
  if (!isS3StorageBackend_() || !verification ||
      verification.kind !== 'EXTERNAL_S3_FULL_SHA256_V1' ||
      archiveEncodingForRecord_(record) !== 'EML' ||
      expectedStoredBytesForRecord_(record) <= Number(backupConfig_().S3_REPLAY_FULL_HASH_MAX_BYTES)) {
    return null;
  }
  const marker = archiveIntegrityMarkerForFile_(file, null);
  const rawBytes = Number(record.rawBytes);
  const storedBytes = expectedStoredBytesForRecord_(record);
  const rawSha256 = String(record.sha256 || '').toLowerCase();
  const storedSha256 = String(expectedStoredSha256ForRecord_(record) || '').toLowerCase();
  const markerMatches = marker && marker.archiveEncoding === 'EML' &&
    Number(marker.rawByteLength) === rawBytes && marker.rawSha256 === rawSha256;
  if (!markerMatches || Number(file.getSize()) !== storedBytes ||
      storedBytes !== rawBytes || storedSha256 !== rawSha256) {
    return {
      ok: false,
      method: 'externalFullHashAttestation+S3Metadata',
      downloadable: null,
      error: 'Externally attested S3 object metadata no longer matches its catalog record.',
    };
  }
  return {
    ok: true,
    method: 'externalFullHashAttestation+S3Metadata',
    downloadable: null,
    contentDecoded: false,
    storedSha256: storedSha256,
    rawSha256: rawSha256,
    storedByteLength: storedBytes,
    rawByteLength: rawBytes,
    rawIntegritySource: 'externalFullHashAttestation',
  };
}
