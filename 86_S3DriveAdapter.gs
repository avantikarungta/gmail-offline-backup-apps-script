// -----------------------------------------------------------------------------
// Drive-shaped virtual filesystem over S3 object keys
// -----------------------------------------------------------------------------

var GMAIL_BACKUP_S3_DRIVE_CACHE = null;

function s3DriveService_() {
  const bindingHash = s3BindingHash_();
  if (!GMAIL_BACKUP_S3_DRIVE_CACHE || GMAIL_BACKUP_S3_DRIVE_CACHE.bindingHash !== bindingHash) {
    GMAIL_BACKUP_S3_DRIVE_CACHE = {
      bindingHash: bindingHash,
      service: new S3DriveService_(newS3ObjectClient_(), {
        bucket: String(backupConfig_().S3_BUCKET),
        rootPrefix: normalizeS3Prefix_(backupConfig_().S3_KEY_PREFIX),
        bindingHash: bindingHash,
      }),
    };
  }
  return GMAIL_BACKUP_S3_DRIVE_CACHE.service;
}

function S3Iterator_(items) {
  this.items = (items || []).slice();
  this.index = 0;
}

S3Iterator_.prototype.hasNext = function () {
  return this.index < this.items.length;
};

S3Iterator_.prototype.next = function () {
  if (!this.hasNext()) throw new Error('S3 iterator is exhausted.');
  return this.items[this.index++];
};

function S3DriveService_(client, options) {
  this.client = client;
  this.bucket = String(options.bucket || '');
  this.rootPrefix = normalizeS3Prefix_(options.rootPrefix);
  this.bindingHash = String(options.bindingHash || '');
  this.backendKind = 'S3';
}

S3DriveService_.prototype.getRootFolder = function () {
  return new S3Folder_(this, this.rootPrefix);
};

S3DriveService_.prototype.createFolder = function (name) {
  return this.getRootFolder().createFolder(name);
};

S3DriveService_.prototype.getFolderById = function (id) {
  const prefix = normalizeS3Prefix_(id);
  if (this.rootPrefix && prefix.indexOf(this.rootPrefix) !== 0) {
    throw new Error('S3 folder key is outside the configured key prefix.');
  }
  return new S3Folder_(this, prefix);
};

S3DriveService_.prototype.getFileById = function (id) {
  const key = normalizeS3Key_(id);
  if (this.rootPrefix && key.indexOf(this.rootPrefix) !== 0) {
    throw new Error('S3 object key is outside the configured key prefix.');
  }
  const head = this.client.head(key);
  if (!head) throw new Error('S3 object was not found.');
  return new S3File_(this, key, head);
};

S3DriveService_.prototype.getStorageLimit = function () {
  return Number.NaN;
};

S3DriveService_.prototype.getStorageUsed = function () {
  return Number.NaN;
};

S3DriveService_.prototype.getStorageDomain = function () {
  return s3StorageDescriptor_();
};

S3DriveService_.prototype.describe = function () {
  return this.client.describe();
};

function S3Folder_(service, prefix) {
  this.service = service;
  this.prefix = normalizeS3Prefix_(prefix);
}

S3Folder_.prototype.getId = function () {
  return this.prefix;
};

S3Folder_.prototype.getName = function () {
  const trimmed = this.prefix.replace(/\/$/, '');
  if (!trimmed) return this.service.bucket;
  return s3KeyBaseName_(trimmed);
};

S3Folder_.prototype.getUrl = function () {
  return 's3://' + this.service.bucket + '/' + this.prefix;
};

S3Folder_.prototype.createFolder = function (name) {
  return new S3Folder_(this.service, this.prefix + s3SafeChildName_(name) + '/');
};

S3Folder_.prototype.getFolders = function () {
  const result = [];
  const seen = {};
  let cursor = null;
  do {
    const page = this.service.client.list(this.prefix, cursor, {delimiter: '/'});
    (page.commonPrefixes || []).forEach(function (prefix) {
      if (!seen[prefix]) {
        seen[prefix] = true;
        result.push(new S3Folder_(this.service, prefix));
      }
    }, this);
    cursor = page.truncated ? page.cursor : null;
    if (page.truncated && !cursor) throw new Error('S3 listing was truncated without a continuation token.');
  } while (cursor);
  return new S3Iterator_(result);
};

S3Folder_.prototype.getFoldersByName = function (name) {
  const expected = this.prefix + s3SafeChildName_(name) + '/';
  const matches = [];
  const iterator = this.getFolders();
  while (iterator.hasNext()) {
    const folder = iterator.next();
    if (folder.getId() === expected) matches.push(folder);
  }
  return new S3Iterator_(matches);
};

S3Folder_.prototype.getFiles = function () {
  const files = [];
  let cursor = null;
  do {
    const page = this.service.client.list(this.prefix, cursor, {delimiter: '/'});
    (page.objects || []).forEach(function (object) {
      if (object.key && object.key !== this.prefix && object.key.slice(-1) !== '/') {
        files.push(new S3File_(this.service, object.key, object));
      }
    }, this);
    cursor = page.truncated ? page.cursor : null;
    if (page.truncated && !cursor) throw new Error('S3 listing was truncated without a continuation token.');
  } while (cursor);
  return new S3Iterator_(files);
};

S3Folder_.prototype.getFilesByName = function (name) {
  const key = this.prefix + s3SafeChildName_(name);
  const head = this.service.client.head(key);
  return new S3Iterator_(head ? [new S3File_(this.service, key, head)] : []);
};

S3Folder_.prototype.createFile = function (arg1, arg2, arg3) {
  let name;
  let bytes;
  let contentType;
  if (arg1 && typeof arg1.getBytes === 'function') {
    name = arg1.getName();
    bytes = arg1.getBytes();
    contentType = arg1.getContentType() || 'application/octet-stream';
  } else {
    name = String(arg1 || '');
    bytes = utilitiesService_().newBlob(String(arg2 === undefined ? '' : arg2)).getBytes();
    contentType = String(arg3 || 'text/plain');
  }
  return this.createFileWithDescription_(name, bytes, contentType, '');
};

S3Folder_.prototype.createFileWithDescription = function (blob, description) {
  return this.createFileWithDescription_(
    blob.getName(), blob.getBytes(), blob.getContentType() || 'application/octet-stream', description
  );
};

S3Folder_.prototype.createFileWithDescription_ = function (name, bytes, contentType, description) {
  const key = this.prefix + s3SafeChildName_(name);
  const metadata = s3FileMetadata_(description);
  const normalizedBytes = normalizeByteArray_(bytes);
  const created = normalizedBytes.length >= Number(backupConfig_().S3_MULTIPART_THRESHOLD_BYTES)
    ? this.service.client.multipartPut(key, normalizedBytes, {
      contentType: contentType,
      metadata: metadata,
      partSize: Number(backupConfig_().S3_MULTIPART_PART_BYTES),
      ifNoneMatch: '*',
    })
    : this.service.client.putIfAbsent(key, normalizedBytes, {
      contentType: contentType,
      metadata: metadata,
    });
  if (!created.ok) {
    const error = new Error('S3 object already exists at the requested logical file key.');
    error.code = 'S3_PRECONDITION_FAILED';
    throw error;
  }
  return new S3File_(this.service, key, created.object);
};

S3Folder_.prototype.setTrashed = function (trashed) {
  if (!trashed) return this;
  if (this.prefix === this.service.rootPrefix) {
    throw new Error('Refusing to recursively delete the configured S3 root prefix.');
  }
  let rounds = 0;
  while (true) {
    const page = this.service.client.list(this.prefix, null, {});
    if (!(page.objects || []).length) break;
    (page.objects || []).forEach(function (object) {
      this.service.client.delete(object.key);
    }, this);
    rounds++;
    if (rounds > 10000) throw new Error('S3 recursive folder cleanup exceeded its safety bound.');
  }
  return this;
};

function S3File_(service, key, head) {
  this.service = service;
  this.key = normalizeS3Key_(key);
  this.head = head || null;
}

S3File_.prototype.refresh_ = function () {
  this.head = this.service.client.head(this.key);
  if (!this.head) throw new Error('S3 object was not found.');
  return this.head;
};

S3File_.prototype.metadata_ = function () {
  return this.head && this.head.metadata ? this.head.metadata : this.refresh_().metadata;
};

S3File_.prototype.getId = function () {
  return this.key;
};

S3File_.prototype.getVersion = function () {
  return (this.head || this.refresh_()).etag || null;
};

S3File_.prototype.getName = function () {
  return s3KeyBaseName_(this.key);
};

S3File_.prototype.getMimeType = function () {
  if (!this.head || !this.head.contentType) this.refresh_();
  return this.head.contentType || 'application/octet-stream';
};

S3File_.prototype.getBlob = function () {
  const object = this.service.client.get(this.key);
  if (!object) throw new Error('S3 object was not found.');
  this.head = object;
  return utilitiesService_().newBlob(object.bytes, object.contentType, this.getName());
};

S3File_.prototype.getSize = function () {
  return Number((this.head || this.refresh_()).size || 0);
};

S3File_.prototype.setContent = function (content) {
  const current = this.head || this.refresh_();
  const bytes = utilitiesService_().newBlob(String(content === undefined ? '' : content)).getBytes();
  const replaced = this.service.client.replaceIfMatch(this.key, bytes, current.etag, {
    contentType: current.contentType,
    metadata: current.metadata || {},
  });
  if (!replaced.ok) throw s3ConcurrentModificationError_();
  this.head = replaced.object;
  return this;
};

S3File_.prototype.setDescription = function (description) {
  const current = this.head || this.refresh_();
  const copied = this.service.client.copy(this.key, this.key, {
    sourceEtag: current.etag,
    contentType: current.contentType,
    metadata: s3FileMetadata_(description),
  });
  if (!copied.ok) throw s3ConcurrentModificationError_();
  this.head = copied.object;
  return this;
};

S3File_.prototype.getDescription = function () {
  const encoded = String((this.metadata_() || {})['gb-description-b64'] || '');
  if (!encoded) return '';
  try {
    return utilitiesService_().newBlob(utilitiesService_().base64Decode(encoded)).getDataAsString();
  } catch (error) {
    throw new Error('S3 object integrity metadata is not valid base64.');
  }
};

S3File_.prototype.getParents = function () {
  return new S3Iterator_([new S3Folder_(this.service, s3ParentPrefix_(this.key))]);
};

S3File_.prototype.getUrl = function () {
  return 's3://' + this.service.bucket + '/' + this.key;
};

S3File_.prototype.setName = function (name) {
  const destination = s3ParentPrefix_(this.key) + s3SafeChildName_(name);
  this.moveToKey_(destination);
  return this;
};

S3File_.prototype.moveTo = function (folder) {
  this.moveToKey_(folder.getId() + this.getName());
  return this;
};

S3File_.prototype.moveToKey_ = function (destination) {
  const target = normalizeS3Key_(destination);
  if (target === this.key) return;
  if (this.service.client.head(target)) {
    throw new Error('Refusing to move an S3 object over an existing logical file.');
  }
  const current = this.head || this.refresh_();
  const copied = this.service.client.copy(this.key, target, {sourceEtag: current.etag});
  if (!copied.ok) throw s3ConcurrentModificationError_();
  this.service.client.delete(this.key);
  this.key = target;
  this.head = copied.object;
};

S3File_.prototype.isTrashed = function () {
  return this.service.client.head(this.key) === null;
};

S3File_.prototype.setTrashed = function (trashed) {
  if (trashed) this.service.client.delete(this.key);
  return this;
};

function s3SafeChildName_(name) {
  const value = String(name || '');
  if (!value || value === '.' || value === '..' || /[\\/\u0000-\u001f]/.test(value)) {
    throw new Error('S3 virtual file/folder names must be non-empty single path segments.');
  }
  return value;
}

function s3ParentPrefix_(key) {
  const normalized = normalizeS3Key_(key);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index + 1);
}

function s3KeyBaseName_(key) {
  const normalized = normalizeS3Key_(key).replace(/\/$/, '');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function s3FileMetadata_(description) {
  if (!description) return {};
  return {
    'gb-description-b64': utilitiesService_().base64Encode(
      utilitiesService_().newBlob(String(description)).getBytes()
    ),
  };
}

function s3ConcurrentModificationError_() {
  const error = new Error('S3 object changed concurrently; refusing to overwrite a newer entity version.');
  error.code = 'S3_PRECONDITION_FAILED';
  return error;
}
