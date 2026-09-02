// -----------------------------------------------------------------------------
// S3-compatible object client (AWS Signature Version 4)
// -----------------------------------------------------------------------------

function storageBackendKind_() {
  return String(backupConfig_().STORAGE_BACKEND || 'GOOGLE_DRIVE').trim().toUpperCase();
}

function isS3StorageBackend_() {
  return storageBackendKind_() === 'S3';
}

function archiveStorageIdentity_() {
  const kind = storageBackendKind_();
  return {
    kind: kind,
    bindingHash: kind === 'S3' ? s3BindingHash_() : 'GOOGLE_DRIVE',
  };
}

function validateS3Configuration_() {
  const config = backupConfig_();
  const runtime = currentBackupRuntime_();
  if (runtime && runtime.serviceOverrideNames && runtime.serviceOverrideNames.indexOf('drive') !== -1) {
    throw new Error('STORAGE_BACKEND S3 cannot be combined with an injected Drive service.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(config.S3_PROFILE || ''))) {
    throw new Error('S3_PROFILE must contain only letters, digits, dot, underscore, and hyphen.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,62}$/.test(String(config.S3_BUCKET || ''))) {
    throw new Error('S3_BUCKET is required and must be a valid S3-compatible bucket name.');
  }
  parseS3Endpoint_(config.S3_ENDPOINT);
  if (!/^[A-Za-z0-9-]{2,32}$/.test(String(config.S3_REGION || ''))) {
    throw new Error('S3_REGION is required (use "auto" for Cloudflare R2).');
  }
  const style = String(config.S3_ADDRESSING_STYLE || '').toUpperCase();
  if (['PATH', 'VIRTUAL'].indexOf(style) === -1) {
    throw new Error('S3_ADDRESSING_STYLE must be PATH or VIRTUAL.');
  }
  const pageSize = Number(config.S3_LIST_PAGE_SIZE);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error('S3_LIST_PAGE_SIZE must be between 1 and 1000.');
  }
  const parallel = Number(config.S3_MAX_PARALLEL_REQUESTS);
  const parallelBytes = Number(config.S3_MAX_PARALLEL_BYTES);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 20) {
    throw new Error('S3_MAX_PARALLEL_REQUESTS must be between 1 and 20.');
  }
  if (!Number.isInteger(parallelBytes) || parallelBytes < 1024 * 1024 || parallelBytes > 48 * 1024 * 1024) {
    throw new Error('S3_MAX_PARALLEL_BYTES must be between 1 MiB and 48 MiB.');
  }
  const threshold = Number(config.S3_MULTIPART_THRESHOLD_BYTES);
  const partSize = Number(config.S3_MULTIPART_PART_BYTES);
  if (!Number.isInteger(partSize) || partSize < 5 * 1024 * 1024 || partSize > 32 * 1024 * 1024) {
    throw new Error('S3_MULTIPART_PART_BYTES must be between 5 MiB and 32 MiB.');
  }
  if (!Number.isInteger(threshold) || threshold < partSize || threshold > 48 * 1024 * 1024) {
    throw new Error('S3_MULTIPART_THRESHOLD_BYTES must be at least one part and at most 48 MiB.');
  }
  if (config.TARGET_ROOT_FOLDER_ID || config.TARGET_PARENT_FOLDER_ID) {
    throw new Error('TARGET_ROOT_FOLDER_ID and TARGET_PARENT_FOLDER_ID apply only to Google Drive.');
  }
}

function parseS3Endpoint_(value) {
  const endpoint = String(value || '').trim().replace(/\/+$/, '');
  const match = /^(https):\/\/([^\/?#]+)(\/[^?#]*)?$/.exec(endpoint);
  if (!match || /@/.test(match[2])) {
    throw new Error('S3_ENDPOINT must be an HTTPS origin (optionally with a base path) and must not contain credentials.');
  }
  return {
    endpoint: endpoint,
    scheme: match[1],
    host: match[2],
    basePath: String(match[3] || '').replace(/\/+$/, ''),
  };
}

function normalizeS3Key_(key) {
  return String(key || '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

function normalizeS3Prefix_(prefix) {
  const normalized = normalizeS3Key_(prefix).replace(/\/+$/, '');
  return normalized ? normalized + '/' : '';
}

function s3CredentialPropertyName_(profileName) {
  return backupConfig_().S3_CREDENTIAL_PROPERTY_PREFIX + String(profileName || backupConfig_().S3_PROFILE);
}

function readS3Credentials_() {
  const profileName = String(backupConfig_().S3_PROFILE || '');
  const raw = propertiesService_().getScriptProperties().getProperty(s3CredentialPropertyName_(profileName));
  if (!raw) {
    throw new Error(
      'S3 credentials profile "' + profileName + '" is not configured. ' +
      'Stage the three documented Script Properties, then run configureS3Credentials().'
    );
  }
  let credentials;
  try { credentials = JSON.parse(raw); } catch (error) {
    throw new Error('S3 credentials profile "' + profileName + '" is invalid JSON.');
  }
  if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new Error('S3 credentials profile "' + profileName + '" is incomplete.');
  }
  return {
    accessKeyId: String(credentials.accessKeyId),
    secretAccessKey: String(credentials.secretAccessKey),
    sessionToken: credentials.sessionToken ? String(credentials.sessionToken) : '',
  };
}

function s3StorageDescriptor_() {
  const config = backupConfig_();
  const endpoint = parseS3Endpoint_(config.S3_ENDPOINT);
  return {
    kind: 'S3',
    profile: String(config.S3_PROFILE),
    bucket: String(config.S3_BUCKET),
    endpointHost: endpoint.host,
    region: String(config.S3_REGION),
    keyPrefix: normalizeS3Prefix_(config.S3_KEY_PREFIX),
    addressingStyle: String(config.S3_ADDRESSING_STYLE).toUpperCase(),
    bindingHash: s3BindingHash_(),
  };
}

function s3BindingHash_() {
  const config = backupConfig_();
  return sha256Hex_(utilitiesService_().newBlob(JSON.stringify({
    kind: 'S3',
    profile: String(config.S3_PROFILE),
    bucket: String(config.S3_BUCKET),
    endpoint: parseS3Endpoint_(config.S3_ENDPOINT).endpoint.toLowerCase(),
    region: String(config.S3_REGION).toLowerCase(),
    keyPrefix: normalizeS3Prefix_(config.S3_KEY_PREFIX),
    addressingStyle: String(config.S3_ADDRESSING_STYLE).toUpperCase(),
  })).getBytes());
}

function s3Rfc3986Encode_(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
    return '%' + character.charCodeAt(0).toString(16).toUpperCase();
  });
}

function s3CanonicalPath_(path) {
  const value = String(path || '/');
  return value.split('/').map(s3Rfc3986Encode_).join('/').replace(/^([^/])/, '/$1');
}

function s3CanonicalQuery_(query) {
  const pairs = [];
  Object.keys(query || {}).forEach(function (name) {
    const values = Array.isArray(query[name]) ? query[name] : [query[name]];
    values.forEach(function (value) {
      pairs.push([s3Rfc3986Encode_(name), s3Rfc3986Encode_(value === null || value === undefined ? '' : value)]);
    });
  });
  pairs.sort(function (a, b) {
    return a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]);
  });
  return pairs.map(function (pair) { return pair[0] + '=' + pair[1]; }).join('&');
}

function s3HeaderValue_(value) {
  return String(value === null || value === undefined ? '' : value).trim().replace(/\s+/g, ' ');
}

function s3Hmac_(value, keyBytes) {
  const valueBytes = utilitiesService_().newBlob(String(value)).getBytes();
  return normalizeByteArray_(utilitiesService_().computeHmacSha256Signature(valueBytes, keyBytes));
}

function s3SigningKey_(secretAccessKey, dateStamp, region) {
  const first = utilitiesService_().newBlob('AWS4' + String(secretAccessKey)).getBytes();
  const dateKey = s3Hmac_(dateStamp, first);
  const regionKey = s3Hmac_(region, dateKey);
  const serviceKey = s3Hmac_('s3', regionKey);
  return s3Hmac_('aws4_request', serviceKey);
}

function buildS3SignedRequest_(profile, credentials, operation) {
  const endpoint = parseS3Endpoint_(profile.endpoint);
  const method = String(operation.method || 'GET').toUpperCase();
  const key = normalizeS3Key_(operation.key);
  const style = String(profile.addressingStyle || 'PATH').toUpperCase();
  const host = style === 'VIRTUAL' ? profile.bucket + '.' + endpoint.host : endpoint.host;
  const objectPath = style === 'VIRTUAL'
    ? endpoint.basePath + '/' + key
    : endpoint.basePath + '/' + profile.bucket + (key ? '/' + key : '');
  const canonicalUri = s3CanonicalPath_(objectPath || '/');
  const canonicalQuery = s3CanonicalQuery_(operation.query || {});
  const bytes = normalizeByteArray_(operation.bytes || []);
  const payloadHash = sha256Hex_(bytes);
  const now = operation.now || new Date();
  const amzDate = utilitiesService_().formatDate(now, 'Etc/UTC', "yyyyMMdd'T'HHmmss'Z'");
  const dateStamp = amzDate.slice(0, 8);
  const headers = {};
  Object.keys(operation.headers || {}).forEach(function (name) {
    headers[String(name).toLowerCase()] = s3HeaderValue_(operation.headers[name]);
  });
  headers.host = host;
  headers['x-amz-content-sha256'] = payloadHash;
  headers['x-amz-date'] = amzDate;
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map(function (name) {
    return name + ':' + s3HeaderValue_(headers[name]) + '\n';
  }).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const scope = dateStamp + '/' + profile.region + '/s3/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope,
    sha256Hex_(utilitiesService_().newBlob(canonicalRequest).getBytes()),
  ].join('\n');
  const signature = bytesToHex_(s3Hmac_(
    stringToSign,
    s3SigningKey_(credentials.secretAccessKey, dateStamp, profile.region)
  ));
  headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + credentials.accessKeyId + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  const requestHeaders = {};
  Object.keys(headers).forEach(function (name) {
    if (name !== 'host') requestHeaders[name] = headers[name];
  });
  const request = {
    url: endpoint.scheme + '://' + host + canonicalUri + (canonicalQuery ? '?' + canonicalQuery : ''),
    method: method.toLowerCase(),
    headers: requestHeaders,
    muteHttpExceptions: true,
  };
  if (bytes.length) request.payload = bytes;
  return request;
}

function bytesToHex_(bytes) {
  return normalizeByteArray_(bytes).map(function (value) {
    return ('0' + ((value < 0 ? value + 256 : value) & 0xff).toString(16)).slice(-2);
  }).join('');
}

function s3ResponseHeaders_(response) {
  const result = {};
  const raw = response && typeof response.getAllHeaders === 'function' ? response.getAllHeaders() : {};
  Object.keys(raw || {}).forEach(function (name) {
    const value = raw[name];
    result[String(name).toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value);
  });
  return result;
}

function s3ResponseBytes_(response) {
  if (!response || typeof response.getBlob !== 'function') return [];
  return normalizeByteArray_(response.getBlob().getBytes());
}

function sanitizeS3ErrorBody_(text) {
  return truncateString_(String(text || '')
    .replace(/<Key>[\s\S]*?<\/Key>/gi, '<Key>[redacted]</Key>')
    .replace(/<StringToSign>[\s\S]*?<\/StringToSign>/gi, '<StringToSign>[redacted]</StringToSign>')
    .replace(/<CanonicalRequest>[\s\S]*?<\/CanonicalRequest>/gi, '<CanonicalRequest>[redacted]</CanonicalRequest>')
    .replace(/(AWSAccessKeyId|X-Amz-Credential|X-Amz-Security-Token)=[^&\s<]+/gi, '$1=[redacted]'), 1200);
}

function S3ObjectClient_(profile, credentials) {
  this.profile = profile;
  this.credentials = credentials;
}

S3ObjectClient_.prototype.request = function (operation, acceptedStatuses) {
  const accepted = acceptedStatuses || [200];
  let delay = backupConfig_().INITIAL_RETRY_DELAY_MS;
  let last;
  for (let attempt = 1; attempt <= backupConfig_().MAX_RETRIES; attempt++) {
    const request = buildS3SignedRequest_(this.profile, this.credentials, operation);
    try {
      const fetchOptions = Object.assign({}, request);
      delete fetchOptions.url;
      const response = urlFetchService_().fetch(request.url, fetchOptions);
      const status = Number(response.getResponseCode());
      const headers = s3ResponseHeaders_(response);
      if (accepted.indexOf(status) !== -1) {
        return {status: status, headers: headers, response: response};
      }
      if ((status === 429 || status >= 500) && attempt < backupConfig_().MAX_RETRIES) {
        const retryAfter = Math.max(0, Number(headers['retry-after'] || 0) * 1000);
        utilitiesService_().sleep(Math.max(delay, retryAfter) + Math.floor(Math.random() * 250));
        delay *= 2;
        continue;
      }
      const body = response.getContentText ? response.getContentText() : '';
      const error = new Error(
        'S3 ' + String(operation.label || operation.method || 'request') + ' failed with HTTP ' + status +
        (headers['x-amz-request-id'] ? ' (request ' + headers['x-amz-request-id'] + ')' : '') +
        ': ' + sanitizeS3ErrorBody_(body)
      );
      error.code = status === 412 ? 'S3_PRECONDITION_FAILED' : 'S3_HTTP_' + status;
      error.status = status;
      throw error;
    } catch (error) {
      last = error;
      if (error && error.status) throw error;
      if (attempt === backupConfig_().MAX_RETRIES || !isTransientError_(error)) throw error;
      utilitiesService_().sleep(delay + Math.floor(Math.random() * 250));
      delay *= 2;
    }
  }
  throw last;
};

S3ObjectClient_.prototype.head = function (key) {
  const normalizedKey = normalizeS3Key_(key);
  const result = this.request({
    method: 'GET', key: key, label: 'HEAD',
    headers: {range: 'bytes=0-0', 'accept-encoding': 'identity'},
  }, [200, 206, 404, 416]);
  if (result.status === 404) return null;
  if (result.status === 416) {
    if (s3ContentRangeSize_(result.headers['content-range']) !== 0) {
      throw new Error('S3 ranged metadata request was not satisfiable for a non-empty object.');
    }
    const empty = this.request({
      method: 'GET', key: key, label: 'HEAD_EMPTY', headers: {'accept-encoding': 'identity'},
    }, [200, 404]);
    if (empty.status === 404) return null;
    return s3HeadFromHeaders_(normalizedKey, empty.headers);
  }
  if (result.status === 200 && Number(result.headers['content-length'] || 0) > 1) {
    throw new Error('S3 endpoint ignored the bounded Range request used for metadata reads.');
  }
  return s3HeadFromHeaders_(normalizedKey, result.headers);
};

function s3ContentRangeSize_(value) {
  const match = /\/(\d+)\s*$/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

function s3HeadFromHeaders_(key, headers) {
  const metadata = {};
  Object.keys(headers || {}).forEach(function (name) {
    if (name.indexOf('x-amz-meta-') === 0) metadata[name.slice(11)] = headers[name];
  });
  const rangedSize = s3ContentRangeSize_(headers['content-range']);
  return {
    key: key,
    size: rangedSize === null ? Number(headers['content-length'] || 0) : rangedSize,
    etag: String(headers.etag || ''),
    contentType: String(headers['content-type'] || 'application/octet-stream'),
    lastModified: headers['last-modified'] || null,
    versionId: headers['x-amz-version-id'] || null,
    metadata: metadata,
  };
}

S3ObjectClient_.prototype.get = function (key) {
  // Some S3-compatible CDNs dynamically compress text objects and return a
  // weak ETag for that representation. Besides changing the transferred byte
  // stream, a weak ETag can never satisfy a later strong If-Match. Request the
  // stored representation so integrity checks and conditional writes use the
  // canonical bytes and strong entity tag.
  const result = this.request({
    method: 'GET', key: key, label: 'GET', headers: {'accept-encoding': 'identity'},
  }, [200, 404]);
  if (result.status === 404) return null;
  const head = s3HeadFromHeaders_(normalizeS3Key_(key), result.headers);
  head.bytes = s3ResponseBytes_(result.response);
  head.size = head.bytes.length;
  return head;
};

S3ObjectClient_.prototype.put = function (key, bytes, options) {
  const settings = options || {};
  const headers = {'content-type': settings.contentType || 'application/octet-stream'};
  Object.keys(settings.metadata || {}).forEach(function (name) {
    headers['x-amz-meta-' + String(name).toLowerCase()] = String(settings.metadata[name]);
  });
  if (settings.ifNoneMatch) headers['if-none-match'] = settings.ifNoneMatch;
  if (settings.ifMatch) headers['if-match'] = settings.ifMatch;
  const result = this.request({method: 'PUT', key: key, headers: headers, bytes: bytes, label: 'PUT'}, [200, 201, 204, 412]);
  if (result.status === 412) return {ok: false, preconditionFailed: true};
  const head = this.head(key);
  if (!head) throw new Error('S3 PUT succeeded but the object was not visible to HEAD.');
  return {ok: true, object: head};
};

S3ObjectClient_.prototype.putIfAbsent = function (key, bytes, options) {
  return this.put(key, bytes, Object.assign({}, options || {}, {ifNoneMatch: '*'}));
};

S3ObjectClient_.prototype.replaceIfMatch = function (key, bytes, etag, options) {
  if (!etag) throw new Error('replaceIfMatch requires an entity tag.');
  return this.put(key, bytes, Object.assign({}, options || {}, {ifMatch: etag}));
};

S3ObjectClient_.prototype.list = function (prefix, cursor, options) {
  const settings = options || {};
  const query = {
    'list-type': '2',
    prefix: normalizeS3Key_(prefix),
    'max-keys': Math.max(1, Math.min(1000, Number(settings.maxKeys || backupConfig_().S3_LIST_PAGE_SIZE))),
  };
  if (settings.delimiter !== undefined && settings.delimiter !== null) query.delimiter = settings.delimiter;
  if (cursor) query['continuation-token'] = cursor;
  const result = this.request({method: 'GET', key: '', query: query, label: 'LIST'}, [200]);
  return parseS3ListXml_(result.response.getContentText());
};

S3ObjectClient_.prototype.copy = function (sourceKey, destinationKey, options) {
  const settings = options || {};
  const source = '/' + s3Rfc3986Encode_(this.profile.bucket) + '/' +
    normalizeS3Key_(sourceKey).split('/').map(s3Rfc3986Encode_).join('/');
  const headers = {'x-amz-copy-source': source};
  if (settings.sourceEtag) headers['x-amz-copy-source-if-match'] = settings.sourceEtag;
  if (settings.metadata) {
    headers['x-amz-metadata-directive'] = 'REPLACE';
    Object.keys(settings.metadata).forEach(function (name) {
      headers['x-amz-meta-' + String(name).toLowerCase()] = String(settings.metadata[name]);
    });
    if (settings.contentType) headers['content-type'] = settings.contentType;
  }
  const result = this.request({method: 'PUT', key: destinationKey, headers: headers, label: 'COPY'}, [200, 412]);
  if (result.status === 412) return {ok: false, preconditionFailed: true};
  return {ok: true, object: this.head(destinationKey)};
};

S3ObjectClient_.prototype.delete = function (key) {
  this.request({method: 'DELETE', key: key, label: 'DELETE'}, [200, 202, 204, 404]);
  return true;
};

S3ObjectClient_.prototype.multipartPut = function (key, bytes, options) {
  const settings = options || {};
  const partSize = Number(settings.partSize || backupConfig_().S3_MULTIPART_PART_BYTES);
  const headers = {'content-type': settings.contentType || 'application/octet-stream'};
  Object.keys(settings.metadata || {}).forEach(function (name) {
    headers['x-amz-meta-' + String(name).toLowerCase()] = String(settings.metadata[name]);
  });
  const started = this.request({method: 'POST', key: key, query: {uploads: ''}, headers: headers, label: 'MULTIPART_CREATE'}, [200]);
  const uploadId = s3XmlValue_(started.response.getContentText(), 'UploadId');
  if (!uploadId) throw new Error('S3 multipart initiation returned no upload ID.');
  const parts = [];
  try {
    for (let offset = 0, number = 1; offset < bytes.length; offset += partSize, number++) {
      const partBytes = bytes.slice(offset, Math.min(bytes.length, offset + partSize));
      const uploaded = this.request({
        method: 'PUT', key: key, query: {partNumber: number, uploadId: uploadId},
        bytes: partBytes, label: 'MULTIPART_PART',
      }, [200]);
      const etag = uploaded.headers.etag;
      if (!etag) throw new Error('S3 multipart part returned no entity tag.');
      parts.push({number: number, etag: etag});
    }
    const completeXml = '<CompleteMultipartUpload>' + parts.map(function (part) {
      return '<Part><PartNumber>' + part.number + '</PartNumber><ETag>' +
        s3XmlEscape_(part.etag) + '</ETag></Part>';
    }).join('') + '</CompleteMultipartUpload>';
    const completeHeaders = {'content-type': 'application/xml'};
    if (settings.ifNoneMatch) completeHeaders['if-none-match'] = settings.ifNoneMatch;
    if (settings.ifMatch) completeHeaders['if-match'] = settings.ifMatch;
    const completed = this.request({
      method: 'POST', key: key, query: {uploadId: uploadId},
      headers: completeHeaders,
      bytes: utilitiesService_().newBlob(completeXml).getBytes(), label: 'MULTIPART_COMPLETE',
    }, [200, 409, 412]);
    if (completed.status !== 200) {
      try {
        this.request({method: 'DELETE', key: key, query: {uploadId: uploadId}, label: 'MULTIPART_ABORT'}, [200, 204, 404]);
      } catch (ignored) {}
      return {ok: false, preconditionFailed: completed.status === 412, conflict: completed.status === 409};
    }
    return {ok: true, object: this.head(key), parts: parts.length};
  } catch (error) {
    try {
      this.request({method: 'DELETE', key: key, query: {uploadId: uploadId}, label: 'MULTIPART_ABORT'}, [200, 204, 404]);
    } catch (ignored) {}
    throw error;
  }
};

S3ObjectClient_.prototype.describe = function () {
  return Object.assign({}, this.profile, {accessKeyConfigured: Boolean(this.credentials.accessKeyId)});
};

function parseS3ListXml_(xml) {
  const text = String(xml || '');
  const contents = [];
  const contentPattern = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = contentPattern.exec(text))) {
    contents.push({
      key: s3XmlValue_(match[1], 'Key'),
      etag: s3XmlValue_(match[1], 'ETag'),
      size: Number(s3XmlValue_(match[1], 'Size') || 0),
      lastModified: s3XmlValue_(match[1], 'LastModified') || null,
    });
  }
  const prefixes = [];
  const prefixPattern = /<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;
  while ((match = prefixPattern.exec(text))) prefixes.push(s3XmlDecode_(match[1]));
  return {
    objects: contents,
    commonPrefixes: prefixes,
    truncated: String(s3XmlValue_(text, 'IsTruncated')).toLowerCase() === 'true',
    cursor: s3XmlValue_(text, 'NextContinuationToken') || null,
  };
}

function s3XmlValue_(xml, name) {
  const match = new RegExp('<' + name + '>([\\s\\S]*?)<\\/' + name + '>').exec(String(xml || ''));
  return match ? s3XmlDecode_(match[1]) : '';
}

function s3XmlDecode_(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function s3XmlEscape_(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function newS3ObjectClient_() {
  validateS3Configuration_();
  const config = backupConfig_();
  return new S3ObjectClient_({
    bucket: String(config.S3_BUCKET),
    endpoint: parseS3Endpoint_(config.S3_ENDPOINT).endpoint,
    region: String(config.S3_REGION),
    addressingStyle: String(config.S3_ADDRESSING_STYLE).toUpperCase(),
  }, readS3Credentials_());
}

function s3ApiCreateFiles_(specs) {
  const client = newS3ObjectClient_();
  const requests = (specs || []).map(function (spec) {
    const description = spec.appProperties
      ? 'GMAIL_BACKUP_ARCHIVE_V1 ' + JSON.stringify(spec.appProperties)
      : '';
    const metadata = s3FileMetadata_(description);
    const headers = {
      'content-type': spec.mimeType || 'application/octet-stream',
      'if-none-match': '*',
    };
    Object.keys(metadata).forEach(function (name) {
      headers['x-amz-meta-' + name] = metadata[name];
    });
    const key = normalizeS3Prefix_(spec.parentId) + s3SafeChildName_(spec.name);
    return {
      spec: spec,
      key: key,
      request: buildS3SignedRequest_(client.profile, client.credentials, {
        method: 'PUT', key: key, headers: headers, bytes: spec.bytes || [],
      }),
    };
  });
  const results = [];
  const maxFiles = Math.max(1, Number(backupConfig_().S3_MAX_PARALLEL_REQUESTS || 1));
  const maxBytes = Math.max(1, Number(backupConfig_().S3_MAX_PARALLEL_BYTES || 1));
  let offset = 0;
  while (offset < requests.length) {
    const wave = [];
    let waveBytes = 0;
    while (offset < requests.length && wave.length < maxFiles) {
      const candidate = requests[offset];
      const size = (candidate.spec.bytes || []).length;
      if (wave.length && waveBytes + size > maxBytes) break;
      wave.push(candidate);
      waveBytes += size;
      offset++;
    }
    const responses = urlFetchService_().fetchAll(wave.map(function (item) { return item.request; }));
    responses.forEach(function (response, index) {
      const status = Number(response.getResponseCode());
      const headers = s3ResponseHeaders_(response);
      if (status < 200 || status >= 300) {
        const error = new Error(
          'Parallel S3 conditional create failed for request ' + index + ' with HTTP ' + status + ': ' +
          sanitizeS3ErrorBody_(response.getContentText ? response.getContentText() : '')
        );
        error.code = status === 412 ? 'S3_PRECONDITION_FAILED' : 'S3_HTTP_' + status;
        error.status = status;
        throw error;
      }
      const item = wave[index];
      results.push({
        id: item.key,
        name: item.spec.name,
        size: String((item.spec.bytes || []).length),
        mimeType: item.spec.mimeType || 'application/octet-stream',
        parents: [normalizeS3Prefix_(item.spec.parentId)],
        appProperties: item.spec.appProperties || null,
        etag: headers.etag || null,
      });
    });
  }
  return results;
}

function s3ApiUpdateMedia_(updates) {
  const client = newS3ObjectClient_();
  const prepared = (updates || []).map(function (update) {
    const key = normalizeS3Key_(update.fileId);
    const current = update.etag ? {etag: update.etag} : client.head(key);
    if (!current || !current.etag) throw new Error('S3 catalog update target is unavailable or has no entity tag.');
    const bytes = utilitiesService_().newBlob(String(update.content || '')).getBytes();
    return {
      update: update,
      key: key,
      bytes: bytes,
      request: buildS3SignedRequest_(client.profile, client.credentials, {
        method: 'PUT', key: key, bytes: bytes,
        headers: {
          'content-type': update.mimeType || 'application/json',
          'if-match': current.etag,
        },
      }),
    };
  });
  const results = [];
  const maxFiles = Math.max(1, Number(backupConfig_().S3_MAX_PARALLEL_REQUESTS || 1));
  const maxBytes = Math.max(1, Number(backupConfig_().S3_MAX_PARALLEL_BYTES || 1));
  let offset = 0;
  while (offset < prepared.length) {
    const wave = [];
    let waveBytes = 0;
    while (offset < prepared.length && wave.length < maxFiles) {
      const candidate = prepared[offset];
      if (wave.length && waveBytes + candidate.bytes.length > maxBytes) break;
      wave.push(candidate);
      waveBytes += candidate.bytes.length;
      offset++;
    }
    const responses = urlFetchService_().fetchAll(wave.map(function (item) { return item.request; }));
    responses.forEach(function (response, index) {
      const status = Number(response.getResponseCode());
      if (status < 200 || status >= 300) {
        const error = new Error(
          'Parallel S3 conditional update failed for request ' + index + ' with HTTP ' + status + ': ' +
          sanitizeS3ErrorBody_(response.getContentText ? response.getContentText() : '')
        );
        error.code = status === 412 ? 'S3_PRECONDITION_FAILED' : 'S3_HTTP_' + status;
        error.status = status;
        throw error;
      }
      const item = wave[index];
      const headers = s3ResponseHeaders_(response);
      results.push({id: item.key, size: String(item.bytes.length), etag: headers.etag || null});
    });
  }
  return results;
}
