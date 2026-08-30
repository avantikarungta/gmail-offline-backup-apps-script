// -----------------------------------------------------------------------------
// Secret-safe S3 profile operations and bounded capability probe
// -----------------------------------------------------------------------------

function s3CapabilityPropertyName_() {
  return 'GMAIL_BACKUP_S3_CAPABILITIES_V1_' + String(backupConfig_().S3_PROFILE || 'default');
}

function assertS3CapabilityProbe_() {
  if (!isS3StorageBackend_()) return;
  const raw = propertiesService_().getScriptProperties().getProperty(s3CapabilityPropertyName_());
  let probe = null;
  try { probe = raw ? JSON.parse(raw) : null; } catch (ignored) {}
  if (!probe || probe.ok !== true || probe.bindingHash !== s3BindingHash_()) {
    throw new Error(
      'The selected S3 binding has not passed its capability probe. Run probeS3Storage() before backup operations.'
    );
  }
}

function configureS3CredentialsAction_() {
  return withScriptLock_(function () {
    if (!isS3StorageBackend_()) throw new Error('Set STORAGE_BACKEND to S3 before configuring an S3 profile.');
    validateS3Configuration_();
    const config = backupConfig_();
    const properties = propertiesService_().getScriptProperties();
    const accessKeyId = properties.getProperty(config.S3_STAGING_ACCESS_KEY_PROPERTY);
    const secretAccessKey = properties.getProperty(config.S3_STAGING_SECRET_KEY_PROPERTY);
    const sessionToken = properties.getProperty(config.S3_STAGING_SESSION_TOKEN_PROPERTY) || '';
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'Missing staged S3 credentials. Add ' + config.S3_STAGING_ACCESS_KEY_PROPERTY + ' and ' +
        config.S3_STAGING_SECRET_KEY_PROPERTY + ' in Apps Script Project Settings; add ' +
        config.S3_STAGING_SESSION_TOKEN_PROPERTY + ' only for temporary credentials.'
      );
    }
    const profileName = String(config.S3_PROFILE);
    properties.setProperty(s3CredentialPropertyName_(profileName), JSON.stringify({
      schemaVersion: 1,
      accessKeyId: String(accessKeyId),
      secretAccessKey: String(secretAccessKey),
      sessionToken: String(sessionToken),
      configuredAt: isoNow_(),
    }));
    properties.deleteProperty(config.S3_STAGING_ACCESS_KEY_PROPERTY);
    properties.deleteProperty(config.S3_STAGING_SECRET_KEY_PROPERTY);
    properties.deleteProperty(config.S3_STAGING_SESSION_TOKEN_PROPERTY);
    GMAIL_BACKUP_S3_DRIVE_CACHE = null;
    const result = {
      ok: true,
      backend: 'S3',
      profile: profileName,
      temporaryCredentials: Boolean(sessionToken),
      stagingPropertiesRemoved: true,
      next: 'Run probeS3Storage() before setupBackup(), PLAN, or APPLY.',
    };
    logger_().log(JSON.stringify(result, null, 2));
    return result;
  });
}

function clearS3CredentialsAction_(confirmation) {
  return withScriptLock_(function () {
    const profileName = String(backupConfig_().S3_PROFILE || 'default');
    if (String(confirmation || '') !== 'clear-' + profileName) {
      throw new Error('Refusing to clear credentials without confirmation "clear-' + profileName + '".');
    }
    const properties = propertiesService_().getScriptProperties();
    properties.deleteProperty(s3CredentialPropertyName_(profileName));
    properties.deleteProperty(s3CapabilityPropertyName_());
    GMAIL_BACKUP_S3_DRIVE_CACHE = null;
    return {ok: true, backend: 'S3', profile: profileName, credentialsConfigured: false};
  });
}

function s3StorageStatusAction_() {
  if (!isS3StorageBackend_()) {
    return {ok: true, backend: storageBackendKind_(), message: 'S3 is not the selected storage backend.'};
  }
  validateS3Configuration_();
  const config = backupConfig_();
  const properties = propertiesService_().getScriptProperties();
  const rawCapabilities = properties.getProperty(s3CapabilityPropertyName_());
  let capabilities = null;
  try { capabilities = rawCapabilities ? JSON.parse(rawCapabilities) : null; } catch (ignored) {}
  const descriptor = s3StorageDescriptor_();
  const result = {
    ok: true,
    backend: 'S3',
    profile: descriptor.profile,
    bucket: descriptor.bucket,
    endpointHost: descriptor.endpointHost,
    region: descriptor.region,
    keyPrefix: descriptor.keyPrefix,
    addressingStyle: descriptor.addressingStyle,
    bindingHash: descriptor.bindingHash,
    credentialsConfigured: Boolean(properties.getProperty(s3CredentialPropertyName_(config.S3_PROFILE))),
    lastProbe: capabilities,
  };
  logger_().log(JSON.stringify(result, null, 2));
  return result;
}

function probeS3StorageAction_() {
  return withScriptLock_(function () {
    if (!isS3StorageBackend_()) throw new Error('Set STORAGE_BACKEND to S3 before probing S3 storage.');
    validateS3Configuration_();
    const client = newS3ObjectClient_();
    const probePrefix = normalizeS3Prefix_(backupConfig_().S3_KEY_PREFIX) +
      '__gmail_backup_probe__/' + utilitiesService_().getUuid() + '/';
    const primaryKey = probePrefix + 'primary.bin';
    const copyKey = probePrefix + 'copy.bin';
    const multipartKey = probePrefix + 'multipart.bin';
    const payload = utilitiesService_().newBlob('gmail-backup-s3-probe-' + isoNow_()).getBytes();
    const replacement = utilitiesService_().newBlob('gmail-backup-s3-probe-replacement').getBytes();
    const checks = {};
    const cleanup = [primaryKey, copyKey, multipartKey];
    try {
      const created = client.putIfAbsent(primaryKey, payload, {
        contentType: 'application/octet-stream',
        metadata: {'gb-probe': 'true'},
      });
      checks.conditionalCreate = Boolean(created.ok);
      if (!created.ok) throw new Error('S3 probe could not conditionally create its unique object.');

      const duplicate = client.putIfAbsent(primaryKey, payload, {contentType: 'application/octet-stream'});
      checks.createConflictRejected = Boolean(duplicate.preconditionFailed);
      if (!checks.createConflictRejected) throw new Error('S3 endpoint did not enforce If-None-Match on PUT.');

      const head = client.head(primaryKey);
      checks.head = Boolean(head && head.size === payload.length && head.etag);
      checks.metadata = Boolean(head && head.metadata && head.metadata['gb-probe'] === 'true');
      if (!checks.head || !checks.metadata) throw new Error('S3 HEAD or user metadata behavior is incompatible.');

      const read = client.get(primaryKey);
      checks.get = Boolean(read && sha256Hex_(read.bytes) === sha256Hex_(payload));
      if (!checks.get) throw new Error('S3 GET did not return the uploaded bytes.');

      const wrongReplace = client.replaceIfMatch(primaryKey, replacement, '"gmail-backup-invalid-etag"', {
        contentType: 'application/octet-stream',
      });
      checks.staleReplaceRejected = Boolean(wrongReplace.preconditionFailed);
      if (!checks.staleReplaceRejected) throw new Error('S3 endpoint did not enforce If-Match on PUT.');

      const replaced = client.replaceIfMatch(primaryKey, replacement, head.etag, {
        contentType: 'application/octet-stream', metadata: {'gb-probe': 'replaced'},
      });
      checks.conditionalReplace = Boolean(replaced.ok);
      if (!checks.conditionalReplace) throw new Error('S3 conditional replacement failed.');

      const listed = client.list(probePrefix, null, {maxKeys: 1});
      checks.list = Boolean((listed.objects || []).some(function (object) { return object.key === primaryKey; }));
      if (!checks.list) throw new Error('S3 LIST did not expose the probe object.');

      const copied = client.copy(primaryKey, copyKey, {sourceEtag: replaced.object.etag});
      checks.copy = Boolean(copied.ok && copied.object && copied.object.size === replacement.length);
      if (!checks.copy) throw new Error('S3 COPY failed.');

      client.delete(copyKey);
      checks.delete = client.head(copyKey) === null;
      if (!checks.delete) throw new Error('S3 DELETE did not remove the copied object.');

      if (backupConfig_().S3_PROBE_MULTIPART) {
        const partSize = Number(backupConfig_().S3_MULTIPART_PART_BYTES);
        const multipartBytes = utilitiesService_().newBlob('A'.repeat(partSize + 1)).getBytes();
        const multipart = client.multipartPut(multipartKey, multipartBytes, {
          contentType: 'application/octet-stream', partSize: partSize,
          metadata: {'gb-probe': 'multipart'},
          ifNoneMatch: '*',
        });
        checks.multipart = Boolean(multipart.ok && multipart.object && multipart.object.size === multipartBytes.length);
        if (!checks.multipart) throw new Error('S3 multipart upload failed.');
      } else {
        checks.multipart = 'not-requested';
      }

      const descriptor = s3StorageDescriptor_();
      const result = {
        ok: true,
        backend: 'S3',
        profile: descriptor.profile,
        bucket: descriptor.bucket,
        endpointHost: descriptor.endpointHost,
        region: descriptor.region,
        addressingStyle: descriptor.addressingStyle,
        bindingHash: descriptor.bindingHash,
        checkedAt: isoNow_(),
        checks: checks,
      };
      propertiesService_().getScriptProperties().setProperty(s3CapabilityPropertyName_(), JSON.stringify(result));
      logger_().log(JSON.stringify(result, null, 2));
      return result;
    } finally {
      cleanup.forEach(function (key) {
        try { client.delete(key); } catch (ignored) {}
      });
    }
  });
}
