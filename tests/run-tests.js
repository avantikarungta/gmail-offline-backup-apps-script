'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

let nextId = 1;
const filesById = new Map();
const foldersById = new Map();

class MockBlob {
  constructor(bytes, mimeType = 'application/octet-stream', name = '') {
    this.bytes = Array.from(bytes || []);
    this.mimeType = mimeType;
    this.name = name;
  }
  getBytes() { return this.bytes.slice(); }
  getDataAsString() { return Buffer.from(this.bytes).toString('utf8'); }
  getName() { return this.name; }
  getContentType() { return this.mimeType; }
}

class Iterator {
  constructor(items) { this.items = items.slice(); this.index = 0; }
  hasNext() { return this.index < this.items.length; }
  next() { return this.items[this.index++]; }
}

class MockFile {
  constructor(name, bytes, parent, mimeType = 'application/octet-stream') {
    this.id = `file-${nextId++}`;
    this.name = name;
    this.bytes = Array.from(bytes || []);
    this.parent = parent;
    this.mimeType = mimeType;
    this.description = '';
    this.setContentCalls = 0;
    this.setDescriptionCalls = 0;
    this.trashed = false;
    filesById.set(this.id, this);
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getMimeType() { return this.mimeType; }
  setName(name) { this.name = name; return this; }
  getBlob() { return new MockBlob(this.bytes, this.mimeType, this.name); }
  getSize() { return this.bytes.length; }
  setContent(content) {
    this.setContentCalls++;
    this.bytes = Array.from(Buffer.from(String(content)));
    return this;
  }
    setDescription(description) {
    this.setDescriptionCalls++;
    this.description = description;
    return this;
  }
  getDescription() { return this.description; }
  getParents() { return new Iterator(this.parent ? [this.parent] : []); }
  getUrl() { return `mock://file/${this.id}`; }
  moveTo(folder) {
    if (this.parent) this.parent.files = this.parent.files.filter(f => f !== this);
    this.parent = folder;
    folder.files.push(this);
    return this;
  }
  isTrashed() { return this.trashed; }
  setTrashed(value) { this.trashed = Boolean(value); return this; }
}

class MockFolder {
  constructor(name, parent = null) {
    this.id = `folder-${nextId++}`;
    this.name = name;
    this.parent = parent;
    this.files = [];
    this.folders = [];
    this.storageKind = 'MY_DRIVE';
    this.driveId = null;
    foldersById.set(this.id, this);
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return `mock://folder/${this.id}`; }
  createFolder(name) { const f = new MockFolder(name, this); this.folders.push(f); return f; }
  getFolders() { return new Iterator(this.folders.slice()); }
  getFoldersByName(name) { return new Iterator(this.folders.filter(f => f.name === name)); }
  getFiles() { return new Iterator(this.files.filter(f => !f.trashed)); }
  getFilesByName(name) { return new Iterator(this.files.filter(f => !f.trashed && f.name === name)); }
  createFile(arg1, arg2, arg3) {
    let name;
    let bytes;
    let mimeType;
    if (arg1 instanceof MockBlob) {
      name = arg1.name;
      bytes = arg1.bytes;
      mimeType = arg1.mimeType;
    } else {
      name = String(arg1);
      bytes = Array.from(Buffer.from(String(arg2 || '')));
      mimeType = arg3 || 'text/plain';
    }
    const file = new MockFile(name, bytes, this, mimeType);
    this.files.push(file);
    return file;
  }
}

const root = new MockFolder('root');
const data = root.createFolder('data');
const catalog = root.createFolder('catalog');
const plans = root.createFolder('plans');
const gmailMessages = new Map();
const scriptProperties = new Map();
const projectTriggers = [];
let throwDeleteTriggerAfterRemovalOnce = false;
const scriptLogs = [];
const scriptConsole = {
  log(...args) { scriptLogs.push({level: 'log', text: args.map(String).join(' ')}); },
  warn(...args) { scriptLogs.push({level: 'warn', text: args.map(String).join(' ')}); },
  error(...args) { scriptLogs.push({level: 'error', text: args.map(String).join(' ')}); },
};

function digestBytes(algorithm, bytes) {
  const alg = algorithm === 'SHA_256' ? 'sha256' : String(algorithm).toLowerCase().replace('_', '');
  const out = crypto.createHash(alg).update(Buffer.from(bytes)).digest();
  return Array.from(out).map(v => v > 127 ? v - 256 : v);
}

const sandbox = {
  console: scriptConsole,
  Buffer,
  Date,
  Math,
  JSON,
  Object,
  Number,
  String,
  Array,
  Boolean,
  RegExp,
  Error,
  isFinite,
  setTimeout,
  MimeType: {PLAIN_TEXT: 'text/plain'},
  Utilities: {
    DigestAlgorithm: {SHA_256: 'SHA_256'},
    computeDigest: digestBytes,
    computeHmacSha256Signature(value, key) {
      if (!Array.isArray(value) || !Array.isArray(key)) {
        throw new TypeError('Apps Script requires matching byte-array HMAC arguments.');
      }
      const normalizedKey = Buffer.from(Array.from(key || []).map(v => v < 0 ? v + 256 : v));
      const normalizedValue = Buffer.from(Array.from(value || []).map(v => v < 0 ? v + 256 : v));
      const out = crypto.createHmac('sha256', normalizedKey).update(normalizedValue).digest();
      return Array.from(out).map(v => v > 127 ? v - 256 : v);
    },
    base64Encode(value) {
      return Buffer.from(Array.from(value || []).map(v => v < 0 ? v + 256 : v)).toString('base64');
    },
    base64Decode(value) {
      return Array.from(Buffer.from(String(value), 'base64')).map(v => v > 127 ? v - 256 : v);
    },
    base64DecodeWebSafe(value) {
      let normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
      while (normalized.length % 4) normalized += '=';
      return Array.from(Buffer.from(normalized, 'base64')).map(v => v > 127 ? v - 256 : v);
    },
    newBlob(value, mimeType, name) {
      const bytes = typeof value === 'string'
        ? Array.from(Buffer.from(value, 'utf8'))
        : Array.from(value || []).map(v => v < 0 ? v + 256 : v);
      return new MockBlob(bytes, mimeType, name);
    },
    zip(blobs, name) {
      const manifest = JSON.stringify((blobs || []).map(blob => ({
        name: blob.getName(),
        mimeType: blob.getContentType(),
        bytes: Buffer.from(blob.getBytes()).toString('base64'),
      })));
      const bytes = Buffer.concat([
        Buffer.from('MOCKZIP1', 'ascii'),
        zlib.deflateRawSync(Buffer.from(manifest, 'utf8')),
      ]);
      return new MockBlob(Array.from(bytes), 'application/zip', name);
    },
    unzip(blob) {
      const bytes = Buffer.from(blob.getBytes());
      assert.strictEqual(bytes.subarray(0, 8).toString('ascii'), 'MOCKZIP1');
      const manifest = JSON.parse(zlib.inflateRawSync(bytes.subarray(8)).toString('utf8'));
      return manifest.map(entry => new MockBlob(
        Array.from(Buffer.from(entry.bytes, 'base64')),
        entry.mimeType,
        entry.name
      ));
    },
    sleep() {},
    getUuid() { return '12345678-1234-1234-1234-123456789abc'; },
    formatDate() { return '20260826T120000Z'; },
  },
  PropertiesService: {
    getScriptProperties() {
      return {
        getProperty(key) { return scriptProperties.has(key) ? scriptProperties.get(key) : null; },
        setProperty(key, value) { scriptProperties.set(key, String(value)); },
        deleteProperty(key) { scriptProperties.delete(key); },
      };
    },
  },
  LockService: {
    getScriptLock() {
      return {
        waitLock() {},
        tryLock() { return true; },
        releaseLock() {},
      };
    },
  },
  UrlFetchApp: {
    fetchAll(requests) {
      return requests.map(() => ({
        getResponseCode() { return 200; },
        getContentText() {
          return JSON.stringify({
            id: 'mock-my-drive-folder',
            capabilities: {canAddChildren: true, canEdit: true},
          });
        },
      }));
    },
  },
  ScriptApp: {
    getScriptId() { return 'mock-script-id'; },
    newTrigger(handler) {
      const trigger = {
        id: `trigger-${nextId++}`,
        handler,
        getHandlerFunction() { return handler; },
        getUniqueId() { return this.id; },
      };
      return {
        timeBased() { return this; },
        after() { return this; },
        everyMinutes() { return this; },
        create() { projectTriggers.push(trigger); return trigger; },
      };
    },
    deleteTrigger(trigger) {
      const index = projectTriggers.indexOf(trigger);
      if (index >= 0) projectTriggers.splice(index, 1);
      if (throwDeleteTriggerAfterRemovalOnce) {
        throwDeleteTriggerAfterRemovalOnce = false;
        throw new Error('Unexpected error while getting the method or property deleteTrigger on object ScriptApp.');
      }
    },
    getProjectTriggers() { return projectTriggers.slice(); },
  },
  DriveApp: {
    getRootFolder() { return root; },
    createFolder(name) { return root.createFolder(name); },
    getStorageLimit() { return 100 * 1024 * 1024 * 1024; },
    getStorageUsed() {
      let total = 0;
      filesById.forEach(file => { if (!file.trashed) total += file.getSize(); });
      return total;
    },
    getFileById(id) {
      const file = filesById.get(id);
      if (!file || file.trashed) throw new Error('404 file not found');
      return file;
    },
    getFolderById(id) {
      const folder = foldersById.get(id);
      if (!folder) throw new Error('404 folder not found');
      return folder;
    },
    getStorageDomain(id) {
      const folder = foldersById.get(id);
      if (!folder) throw new Error('404 folder not found');
      return {kind: folder.storageKind, driveId: folder.driveId};
    },
  },
  Gmail: {
    Users: {
      getProfile() {
        return {
          emailAddress: 'user@example.com',
          messagesTotal: gmailMessages.size,
          threadsTotal: gmailMessages.size,
          historyId: '100',
        };
      },
      Labels: {
        list() { return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]}; },
      },
      Messages: {
        list(user, params = {}) {
          const query = String(params.q || '');
          const larger = [...query.matchAll(/larger:(\d+)/g)].map(m => Number(m[1]));
          const smaller = [...query.matchAll(/smaller:(\d+)/g)].map(m => Number(m[1]));
          const matches = Array.from(gmailMessages.values()).filter(message => {
            const size = Number(message.sizeEstimate || 0);
            return larger.every(bound => size > bound) && smaller.every(bound => size < bound);
          });
          const max = Math.max(1, Number(params.maxResults || 100));
          return {
            messages: matches.slice(0, max).map(message => ({id: message.id, threadId: message.threadId})),
            resultSizeEstimate: matches.length,
          };
        },
        get(user, id) {
          if (!gmailMessages.has(id)) throw new Error('404 not found');
          return gmailMessages.get(id);
        },
      },
    },
  },
};

vm.createContext(sandbox);
const projectRoot = path.join(__dirname, '..');
const claspConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, '.clasp.example.json'), 'utf8'));
const moduleFiles = claspConfig.filePushOrder.filter(name => name.endsWith('.gs'));
const expectedModuleFiles = [
  '00_ConfigRuntime.gs',
  '10_Diagnostics.gs',
  '20_Application.gs',
  '25_Verification.gs',
  '30_Worker.gs',
  '40_Scan.gs',
  '45_Audit.gs',
  '50_Queue.gs',
  '60_Export.gs',
  '65_PlanEstimate.gs',
  '70_DiagnosticsSupport.gs',
  '80_StateStatus.gs',
  '85_S3Client.gs',
  '86_S3DriveAdapter.gs',
  '87_S3Operations.gs',
  '90_PlatformStorage.gs',
  '95_CoreUtilities.gs',
  '98_Library.gs',
  '99_Main.gs',
];
assert.deepStrictEqual(moduleFiles, expectedModuleFiles, 'deployment module order is part of the tested build');
assert.strictEqual(fs.existsSync(path.join(projectRoot, 'GmailBackup.gs')), false, 'the monolith must not return');
const moduleSources = moduleFiles.map(name => ({
  name,
  source: fs.readFileSync(path.join(projectRoot, name), 'utf8'),
}));
moduleSources.forEach(module => {
  assert(module.source.split('\n').length <= 1100, `${module.name} has grown beyond a maintainable module size`);
});
const declaredFunctions = new Map();
moduleSources.forEach(module => {
  for (const match of module.source.matchAll(/^function\s+([A-Za-z0-9_]+)\s*\(/gm)) {
    assert.strictEqual(
      declaredFunctions.has(match[1]),
      false,
      `duplicate function ${match[1]} in ${module.name} and ${declaredFunctions.get(match[1])}`
    );
    declaredFunctions.set(match[1], module.name);
  }
});
[
  'doctorBackup', 'estimateBackup', 'setupBackup', 'planBackup', 'applyBackup',
  'backupStatus', 'agentStatus', 'pauseBackup', 'resumeBackup',
  'verifyBackupSample', 'diagnoseDriveReadAccess', 'gmailBackupWorker',
  'benchmarkArchiveCompression', 'benchmarkDriveWritePaths',
  'configureS3Credentials', 'clearS3Credentials', 'probeS3Storage', 's3StorageStatus',
].forEach(name => assert.strictEqual(declaredFunctions.get(name), '99_Main.gs'));
const code = moduleSources.map(module => module.source).join('\n') +
  '\n;globalThis.__BACKUP_CONFIG = BACKUP_CONFIG;';
vm.runInContext(code, sandbox, {filename: 'GmailBackupModules.gs'});

const defaultGmailMessagesList = sandbox.Gmail.Users.Messages.list;
const defaultGmailGetProfile = sandbox.Gmail.Users.getProfile;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function addMessage(id, text, labels = ['INBOX']) {
  const raw = Buffer.isBuffer(text) ? Buffer.from(text) : Buffer.from(text, 'utf8');
  gmailMessages.set(id, {
    id,
    threadId: `thread-${id}`,
    labelIds: labels,
    historyId: '99',
    internalDate: '1700000000000',
    sizeEstimate: raw.length,
    // Apps Script Advanced Gmail currently materializes discovery format=byte
    // fields as Byte[]; mirror that runtime behavior in the primary mock.
    raw: Array.from(raw).map(v => v > 127 ? v - 256 : v),
  });
}

function listCanonical(folder) {
  return folder.files.filter(f => !f.trashed && /^[A-Za-z0-9_-]+\.eml(?:\.zip)?$/.test(f.name));
}

(function run() {
  assert.strictEqual(sandbox.shardForId_('abcdef12'), '12');
  assert.strictEqual(sandbox.commitFileName_(5, 20), '00000005-00000020.json');
  assert.strictEqual(
    sandbox.shiftIsoTimestamp_('2026-08-26T12:00:00.000Z', 60 * 1000),
    '2026-08-26T12:01:00.000Z'
  );

  // Doctor/estimate helpers keep queries composable and produce monotonic,
  // bounded scenarios without touching Gmail or Drive.
  assert.strictEqual(sandbox.combineGmailQueries_('', 'larger:1024'), 'larger:1024');
  assert.strictEqual(sandbox.combineGmailQueries_('in:inbox OR in:sent', 'smaller:2048'), '(in:inbox OR in:sent) smaller:2048');
  assert.strictEqual(
    sandbox.sizeBucketQuery_({minBytes: 1024, maxBytesExclusive: 2048}),
    'larger:1023 smaller:2048'
  );
  assert.strictEqual(
    sandbox.dateBucketQuery_({newerDays: 30, olderDays: null}, new Date('2026-08-26T12:00:00Z')),
    'after:2026/07/27'
  );
  assert.strictEqual(
    sandbox.dateBucketQuery_({newerDays: 180, olderDays: 30}, new Date('2026-08-26T12:00:00Z')),
    'after:2026/02/27 before:2026/07/27'
  );
  assert.deepStrictEqual(
    Array.from(sandbox.selectEstimatorRawCandidates_(
      [{id: 'd1'}, {id: 'd2'}],
      [{id: 's1'}, {id: 'd1'}, {id: 's2'}],
      4
    )).map(x => x.id),
    ['d1', 's1', 'd2', 's2']
  );
  assert.strictEqual(sandbox.__BACKUP_CONFIG.VERSION, '1.3.0-dev.14');
  assert.strictEqual(sandbox.__BACKUP_CONFIG.DRIVE_WRITE_MODE, 'PARALLEL_API');
  assert.strictEqual(sandbox.__BACKUP_CONFIG.ARCHIVE_ENCODING, 'ZIP');
  assert.strictEqual(sandbox.__BACKUP_CONFIG.S3_MAX_PARALLEL_BYTES, 8 * 1024 * 1024);
  assert.strictEqual(sandbox.__BACKUP_CONFIG.S3_APPLY_BATCH_SIZE, 1);
  assert.strictEqual(sandbox.__BACKUP_CONFIG.S3_REPLAY_FULL_HASH_MAX_BYTES, 8 * 1024 * 1024);
  assert.strictEqual(sandbox.GmailBackupLibrary.version(), '1.3.0-dev.14');

  // SigV4 requests never expose credentials in URLs and sign all required
  // S3 headers. The XML parser covers paginated objects and virtual folders.
  const signedPayload = [0, 1, -1];
  assert.strictEqual(
    sandbox.normalizeByteArray_(signedPayload),
    signedPayload,
    'already-normalized Apps Script Byte[] values should not be copied'
  );
  assert.deepStrictEqual(
    Array.from(sandbox.normalizeByteArray_([0, 127, 128, 255])),
    [0, 127, -128, -1],
    'unsigned byte arrays should still be converted to Apps Script signed bytes'
  );
  const signedS3 = sandbox.buildS3SignedRequest_(
    {bucket: 'archive-bucket', endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto', addressingStyle: 'PATH'},
    {accessKeyId: 'ACCESS123', secretAccessKey: 'secret-value', sessionToken: 'temporary-token'},
    {
      method: 'PUT', key: 'prefix/message.eml.zip', bytes: signedPayload,
      payloadHash: sandbox.sha256Hex_(signedPayload), headers: {'if-none-match': '*'},
    }
  );
  assert.match(signedS3.url, /^https:\/\/example\.r2\.cloudflarestorage\.com\/archive-bucket\/prefix\/message\.eml\.zip$/);
  assert(!signedS3.url.includes('ACCESS123'));
  assert(!signedS3.url.includes('secret-value'));
  assert.match(signedS3.headers.authorization, /^AWS4-HMAC-SHA256 Credential=ACCESS123\//);
  assert.strictEqual(signedS3.headers['if-none-match'], '*');
  assert.strictEqual(signedS3.headers['x-amz-security-token'], 'temporary-token');
  assert.strictEqual(signedS3.payload, signedPayload, 'SigV4 should reuse normalized payload bytes');
  assert.throws(
    () => sandbox.buildS3SignedRequest_(
      {bucket: 'archive-bucket', endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto', addressingStyle: 'PATH'},
      {accessKeyId: 'ACCESS123', secretAccessKey: 'secret-value'},
      {method: 'PUT', key: 'bad-hash', bytes: signedPayload, payloadHash: 'not-a-sha256'}
    ),
    /payloadHash/
  );
  const capturedHeadRequests = [];
  const s3HeadRuntime = sandbox.GmailBackupLibrary.createRuntime({services: {
    urlFetch: {
      fetch(url, options) {
        capturedHeadRequests.push({url, options});
        if (String(options.method).toLowerCase() === 'head') {
          throw new TypeError('Apps Script UrlFetchApp does not support HEAD.');
        }
        return {
          getResponseCode() { return 206; },
          getAllHeaders() {
            return {
              'Content-Length': '1', 'Content-Range': 'bytes 0-0/1234',
              ETag: '"ranged-etag"', 'Content-Type': 'message/rfc822',
              'x-amz-meta-gb-probe': 'true',
            };
          },
        };
      },
    },
  }});
  const rangedHead = sandbox.GmailBackupLibrary.withRuntime(s3HeadRuntime, function () {
    return new sandbox.S3ObjectClient_(
      {bucket: 'archive-bucket', endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto', addressingStyle: 'PATH'},
      {accessKeyId: 'ACCESS123', secretAccessKey: 'secret-value', sessionToken: ''}
    ).head('prefix/message.eml');
  });
  assert.strictEqual(capturedHeadRequests.length, 1);
  assert.strictEqual(capturedHeadRequests[0].options.method, 'get');
  assert.strictEqual(capturedHeadRequests[0].options.headers.range, 'bytes=0-0');
  assert.strictEqual(capturedHeadRequests[0].options.headers['accept-encoding'], 'identity');
  assert.strictEqual(rangedHead.size, 1234);
  assert.strictEqual(rangedHead.etag, '"ranged-etag"');
  assert.strictEqual(rangedHead.metadata['gb-probe'], 'true');
  const capturedGetRequests = [];
  const s3GetRuntime = sandbox.GmailBackupLibrary.createRuntime({services: {
    urlFetch: {
      fetch(url, options) {
        capturedGetRequests.push({url, options});
        const identity = options.headers['accept-encoding'] === 'identity';
        return {
          getResponseCode() { return 200; },
          getAllHeaders() {
            return {
              'Content-Length': '3', ETag: identity ? '"strong-etag"' : 'W/"weak-etag"',
              'Content-Type': 'application/json',
            };
          },
          getBlob() { return new MockBlob([91, 93, 10], 'application/json', 'object.json'); },
        };
      },
    },
  }});
  const identityObject = sandbox.GmailBackupLibrary.withRuntime(s3GetRuntime, function () {
    return new sandbox.S3ObjectClient_(
      {bucket: 'archive-bucket', endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto', addressingStyle: 'PATH'},
      {accessKeyId: 'ACCESS123', secretAccessKey: 'secret-value', sessionToken: ''}
    ).get('prefix/object.json');
  });
  assert.strictEqual(capturedGetRequests.length, 1);
  assert.strictEqual(capturedGetRequests[0].options.headers['accept-encoding'], 'identity');
  assert.strictEqual(identityObject.etag, '"strong-etag"');
  assert.deepStrictEqual(Array.from(identityObject.bytes), [91, 93, 10]);
  const parsedS3List = sandbox.parseS3ListXml_(
    '<ListBucketResult><IsTruncated>true</IsTruncated>' +
    '<NextContinuationToken>next&amp;token</NextContinuationToken>' +
    '<Contents><Key>prefix/a.txt</Key><ETag>&quot;etag-a&quot;</ETag><Size>3</Size></Contents>' +
    '<CommonPrefixes><Prefix>prefix/child/</Prefix></CommonPrefixes></ListBucketResult>'
  );
  assert.strictEqual(parsedS3List.truncated, true);
  assert.strictEqual(parsedS3List.cursor, 'next&token');
  assert.deepStrictEqual(Array.from(parsedS3List.objects).map(item => item.key), ['prefix/a.txt']);
  assert.deepStrictEqual(Array.from(parsedS3List.commonPrefixes), ['prefix/child/']);

  const isolatedS3Properties = new Map([
    ['GMAIL_BACKUP_S3_PROFILE_V1_default', JSON.stringify({
      accessKeyId: 'batch-access', secretAccessKey: 'batch-secret', sessionToken: '',
    })],
  ]);
  const isolatedS3PropertyService = {
    getScriptProperties() {
      return {
        getProperty(key) { return isolatedS3Properties.has(key) ? isolatedS3Properties.get(key) : null; },
        setProperty(key, value) { isolatedS3Properties.set(key, String(value)); },
        deleteProperty(key) { isolatedS3Properties.delete(key); },
      };
    },
  };
  const capturedS3Waves = [];
  const s3BatchRuntime = sandbox.GmailBackupLibrary.createRuntime({
    config: {
      STORAGE_BACKEND: 'S3', S3_BUCKET: 'archive-bucket',
      S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com', S3_REGION: 'auto',
      S3_KEY_PREFIX: 'mail/', S3_ADDRESSING_STYLE: 'PATH',
    },
    services: {
      properties: isolatedS3PropertyService,
      urlFetch: {
        fetchAll(requests) {
          capturedS3Waves.push(requests);
          return requests.map(() => ({
            getResponseCode() { return 200; },
            getAllHeaders() { return {ETag: '"batch-etag"'}; },
            getContentText() { return ''; },
          }));
        },
      },
    },
  });
  isolatedS3Properties.set('GMAIL_BACKUP_S3_STAGING_ACCESS_KEY_ID', 'rotated-access');
  isolatedS3Properties.set('GMAIL_BACKUP_S3_STAGING_SECRET_ACCESS_KEY', 'rotated-secret');
  const configuredS3Profile = sandbox.GmailBackupLibrary.configureS3Credentials(s3BatchRuntime);
  assert.strictEqual(configuredS3Profile.ok, true);
  assert.strictEqual(configuredS3Profile.stagingPropertiesRemoved, true);
  assert(!JSON.stringify(configuredS3Profile).includes('rotated-access'));
  assert(!JSON.stringify(configuredS3Profile).includes('rotated-secret'));
  assert.strictEqual(isolatedS3Properties.has('GMAIL_BACKUP_S3_STAGING_ACCESS_KEY_ID'), false);
  assert.strictEqual(isolatedS3Properties.has('GMAIL_BACKUP_S3_STAGING_SECRET_ACCESS_KEY'), false);
  assert.throws(() => sandbox.GmailBackupLibrary.withRuntime(s3BatchRuntime, sandbox.validateConfiguration_), /has not passed its capability probe/);
  const testedS3BindingHash = sandbox.GmailBackupLibrary.withRuntime(s3BatchRuntime, sandbox.s3BindingHash_);
  isolatedS3Properties.set('GMAIL_BACKUP_S3_CAPABILITIES_V1_default', JSON.stringify({
    ok: true, bindingHash: testedS3BindingHash,
  }));
  sandbox.GmailBackupLibrary.withRuntime(s3BatchRuntime, sandbox.validateConfiguration_);
  const s3BatchResults = sandbox.GmailBackupLibrary.withRuntime(s3BatchRuntime, function () {
    return sandbox.s3ApiCreateFiles_([{
      name: 'batch.eml.zip', mimeType: 'application/zip', parentId: 'mail/root/data/',
      bytes: [1, 2, 3], appProperties: {gbSchema: '1', gbRawSha256: 'abc'},
    }]);
  });
  assert.strictEqual(capturedS3Waves.length, 1);
  assert.strictEqual(capturedS3Waves[0][0].headers['if-none-match'], '*');
  assert.match(capturedS3Waves[0][0].headers.authorization, /^AWS4-HMAC-SHA256/);
  assert(capturedS3Waves[0][0].headers['x-amz-meta-gb-description-b64']);
  assert.strictEqual(s3BatchResults[0].id, 'mail/root/data/batch.eml.zip');
  const s3UpdateResults = sandbox.GmailBackupLibrary.withRuntime(s3BatchRuntime, function () {
    return sandbox.s3ApiUpdateMedia_([{
      fileId: 'mail/root/catalog/shard-00.json', content: '[{"id":"1"}]',
      mimeType: 'application/json', etag: '"prior-etag"',
    }]);
  });
  assert.strictEqual(capturedS3Waves.length, 2);
  assert.strictEqual(capturedS3Waves[1][0].headers['if-match'], '"prior-etag"');
  assert.strictEqual(s3UpdateResults[0].id, 'mail/root/catalog/shard-00.json');

  // The S3 virtual filesystem preserves the Drive-like contract used by the
  // core planner/exporter while enforcing create-only and versioned updates.
  const s3Objects = new Map();
  let s3Etag = 0;
  function s3Stored(key, bytes, options) {
    const object = {
      key,
      bytes: Array.from(bytes || []),
      size: Array.from(bytes || []).length,
      etag: `"etag-${++s3Etag}"`,
      contentType: (options && options.contentType) || 'application/octet-stream',
      metadata: Object.assign({}, (options && options.metadata) || {}),
    };
    s3Objects.set(key, object);
    return object;
  }
  function s3HeadCopy(object) {
    if (!object) return null;
    return Object.assign({}, object, {bytes: undefined, metadata: Object.assign({}, object.metadata)});
  }
  const memoryS3Client = {
    head(key) { return s3HeadCopy(s3Objects.get(key)); },
    get(key) {
      const object = s3Objects.get(key);
      return object ? Object.assign(s3HeadCopy(object), {bytes: object.bytes.slice()}) : null;
    },
    putIfAbsent(key, bytes, options) {
      if (s3Objects.has(key)) return {ok: false, preconditionFailed: true};
      return {ok: true, object: s3HeadCopy(s3Stored(key, bytes, options))};
    },
    replaceIfMatch(key, bytes, etag, options) {
      const current = s3Objects.get(key);
      if (!current || current.etag !== etag) return {ok: false, preconditionFailed: true};
      return {ok: true, object: s3HeadCopy(s3Stored(key, bytes, options))};
    },
    copy(source, destination, options = {}) {
      const current = s3Objects.get(source);
      if (!current || (options.sourceEtag && options.sourceEtag !== current.etag)) {
        return {ok: false, preconditionFailed: true};
      }
      const metadata = options.metadata || current.metadata;
      const copied = s3Stored(destination, current.bytes, {
        contentType: options.contentType || current.contentType,
        metadata,
      });
      return {ok: true, object: s3HeadCopy(copied)};
    },
    delete(key) { s3Objects.delete(key); return true; },
    list(prefix, cursor, options = {}) {
      const objects = [];
      const common = new Set();
      Array.from(s3Objects.keys()).sort().forEach(key => {
        if (!key.startsWith(prefix)) return;
        const remainder = key.slice(prefix.length);
        if (options.delimiter && remainder.includes(options.delimiter)) {
          common.add(prefix + remainder.slice(0, remainder.indexOf(options.delimiter) + 1));
        } else {
          objects.push(s3HeadCopy(s3Objects.get(key)));
        }
      });
      return {objects, commonPrefixes: Array.from(common), truncated: false, cursor: null};
    },
    describe() { return {bucket: 'test-bucket'}; },
  };
  const s3Drive = new sandbox.S3DriveService_(memoryS3Client, {
    bucket: 'test-bucket', rootPrefix: 'backups/', bindingHash: 'binding',
  });
  const s3Folder = s3Drive.getRootFolder().createFolder('archive').createFolder('data');
  const s3Blob = sandbox.Utilities.newBlob('first', 'text/plain', 'message.txt');
  const s3File = s3Folder.createFileWithDescription(s3Blob, 'integrity-metadata');
  assert.strictEqual(s3File.getId(), 'backups/archive/data/message.txt');
  assert.strictEqual(s3File.getDescription(), 'integrity-metadata');
  assert.strictEqual(s3File.getBlob().getDataAsString(), 'first');
  assert.throws(() => s3Folder.createFile(s3Blob), /already exists/);
  s3File.setContent('second');
  assert.strictEqual(s3File.getBlob().getDataAsString(), 'second');
  const s3Quarantine = s3Drive.getRootFolder().createFolder('archive').createFolder('quarantine');
  s3File.moveTo(s3Quarantine).setName('renamed.txt');
  assert.strictEqual(s3File.getId(), 'backups/archive/quarantine/renamed.txt');
  assert.strictEqual(s3Drive.getFileById(s3File.getId()).getBlob().getDataAsString(), 'second');
  assert.strictEqual(s3Folder.getFiles().hasNext(), false);

  const s3ConfigRuntime = sandbox.GmailBackupLibrary.createRuntime({config: {
    STORAGE_BACKEND: 'S3',
    S3_BUCKET: 'archive-bucket',
    S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    S3_REGION: 'auto',
    S3_KEY_PREFIX: 'mail/',
    S3_ADDRESSING_STYLE: 'PATH',
  }});
  assert.throws(() => sandbox.GmailBackupLibrary.withRuntime(s3ConfigRuntime, function () {
    sandbox.assertArchiveConfiguration_({archiveConfig: {
      shardCount: 64,
      storage: {kind: 'GOOGLE_DRIVE', bindingHash: 'GOOGLE_DRIVE'},
    }});
  }), /pinned to a different storage backend/);

  // The library runtime isolates configuration and platform dependencies from
  // the thin Apps Script entry points.
  const injectedLogs = [];
  const defaultGmailQuery = sandbox.backupConfig_().GMAIL_QUERY;
  const injectedRuntime = sandbox.GmailBackupLibrary.createRuntime({
    config: {GMAIL_QUERY: 'label:runtime-test'},
    services: {
      logger: {
        log(value) { injectedLogs.push(String(value)); },
        warn(value) { injectedLogs.push(String(value)); },
        error(value) { injectedLogs.push(String(value)); },
      },
    },
  });
  const injectedQuery = sandbox.GmailBackupLibrary.withRuntime(injectedRuntime, function () {
    sandbox.logger_().log('injected logger works');
    return sandbox.backupConfig_().GMAIL_QUERY;
  });
  assert.strictEqual(injectedQuery, 'label:runtime-test');
  assert.deepStrictEqual(injectedLogs, ['injected logger works']);
  assert.strictEqual(sandbox.backupConfig_().GMAIL_QUERY, defaultGmailQuery, 'runtime overrides must not leak');
  assert.strictEqual(injectedRuntime.continuationMode, 'MANUAL');
  projectTriggers.length = 0;
  sandbox.GmailBackupLibrary.withRuntime(injectedRuntime, sandbox.ensureWorkerTrigger_);
  assert.strictEqual(projectTriggers.length, 0, 'injected runtimes must not silently schedule a native worker');
  assert.throws(
    () => sandbox.GmailBackupLibrary.createRuntime({
      continuationMode: 'AUTO_TRIGGER',
      services: {logger: scriptConsole},
    }),
    /cannot preserve injected services/
  );
  assert.throws(
    () => sandbox.GmailBackupLibrary.createRuntime({
      continuationMode: 'AUTO_TRIGGER',
      config: {SHARD_COUNT: 128},
    }),
    /cannot preserve these runtime-only configuration overrides: SHARD_COUNT/
  );
  const durableAutoRuntime = sandbox.GmailBackupLibrary.createRuntime({
    continuationMode: 'AUTO_TRIGGER',
    config: {GMAIL_QUERY: 'label:durable-auto'},
  });
  assert.strictEqual(durableAutoRuntime.continuationMode, 'AUTO_TRIGGER');

  // A Drive folder owned by another account is just a target adapter/config
  // choice, provided the executing identity has edit access to the folder.
  const sharedTargetRoot = root.createFolder('shared-target-root');
  const rootRuntime = sandbox.GmailBackupLibrary.forTargetRoot(sharedTargetRoot.getId());
  const rootLayout = sandbox.GmailBackupLibrary.withRuntime(rootRuntime, function () {
    return sandbox.GmailBackupLibrary.storage.ensureLayout(null);
  });
  assert.strictEqual(rootLayout.root.getId(), sharedTargetRoot.getId());
  assert(rootLayout.data && rootLayout.catalog && rootLayout.plans);
  assert.strictEqual(sharedTargetRoot.getFilesByName('archive-manifest.json').hasNext(), true);
  const isolatedProperties = new Map();
  let injectedDriveFolderReads = 0;
  const injectedDrive = Object.assign({}, sandbox.DriveApp, {
    getFolderById(id) {
      injectedDriveFolderReads++;
      return sandbox.DriveApp.getFolderById(id);
    },
  });
  const isolatedPropertyService = {
    getScriptProperties() {
      return {
        getProperty(key) { return isolatedProperties.has(key) ? isolatedProperties.get(key) : null; },
        setProperty(key, value) { isolatedProperties.set(key, String(value)); },
        deleteProperty(key) { isolatedProperties.delete(key); },
      };
    },
  };
  const isolatedSetupRuntime = sandbox.GmailBackupLibrary.forTargetRoot(sharedTargetRoot.getId(), {
    services: {drive: injectedDrive, properties: isolatedPropertyService},
  });
  const isolatedSetup = sandbox.GmailBackupLibrary.setup(isolatedSetupRuntime);
  const isolatedState = JSON.parse(isolatedProperties.get(sandbox.__BACKUP_CONFIG.STATE_PROPERTY));
  assert.strictEqual(isolatedSetup.ok, true);
  assert.strictEqual(isolatedState.rootFolderId, sharedTargetRoot.getId());
  assert(injectedDriveFolderReads > 0, 'setup must use the injected Drive port');
  assert.strictEqual(
    scriptProperties.has(sandbox.__BACKUP_CONFIG.STATE_PROPERTY),
    false,
    'injected state storage must not leak into the default runtime'
  );
  const sharedManifest = JSON.parse(
    sharedTargetRoot.getFilesByName('archive-manifest.json').next().getBlob().getDataAsString()
  );
  assert.strictEqual(sharedManifest.account, 'user@example.com');
  assert.strictEqual(sharedManifest.writer.scriptId, 'mock-script-id');
  assert.throws(
    () => sandbox.ensureRootLayout_(sharedTargetRoot.getId(), {account: 'other@example.com'}),
    /bound to Gmail account/
  );
  const otherWriterRuntime = sandbox.GmailBackupLibrary.createRuntime({
    targetRootFolderId: sharedTargetRoot.getId(),
    services: {script: {getScriptId() { return 'other-script-id'; }}},
  });
  assert.throws(
    () => sandbox.GmailBackupLibrary.withRuntime(otherWriterRuntime, function () {
      return sandbox.ensureRootLayout_(null, {account: 'user@example.com'});
    }),
    /leased to a different Apps Script writer/
  );

  const nonEmptyTarget = root.createFolder('unsafe-nonempty-target');
  nonEmptyTarget.createFile('unrelated.txt', 'keep me', 'text/plain');
  const nonEmptyRuntime = sandbox.GmailBackupLibrary.forTargetRoot(nonEmptyTarget.getId());
  assert.throws(
    () => sandbox.GmailBackupLibrary.withRuntime(nonEmptyRuntime, function () {
      return sandbox.GmailBackupLibrary.storage.ensureLayout(null);
    }),
    /must refer to an empty folder/
  );

  const sharedDriveTarget = root.createFolder('unsupported-shared-drive-target');
  sharedDriveTarget.storageKind = 'SHARED_DRIVE';
  sharedDriveTarget.driveId = 'shared-drive-id';
  const defaultRootMetadataFetchAll = sandbox.UrlFetchApp.fetchAll;
  const defaultStorageDomain = sandbox.DriveApp.getStorageDomain;
  const defaultRootOAuthToken = sandbox.ScriptApp.getOAuthToken;
  delete sandbox.DriveApp.getStorageDomain;
  sandbox.ScriptApp.getOAuthToken = () => 'root-check-token';
  sandbox.UrlFetchApp.fetchAll = function () {
    return [{
      getResponseCode() { return 200; },
      getContentText() {
        return JSON.stringify({
          id: sharedDriveTarget.getId(),
          driveId: 'shared-drive-id',
          capabilities: {canAddChildren: true, canEdit: true},
        });
      },
    }];
  };
  const sharedDriveRuntime = sandbox.GmailBackupLibrary.forTargetRoot(sharedDriveTarget.getId());
  assert.throws(
    () => sandbox.GmailBackupLibrary.withRuntime(sharedDriveRuntime, function () {
      return sandbox.GmailBackupLibrary.storage.ensureLayout(null);
    }),
    /Shared Drive roots are not supported/
  );
  assert.strictEqual(sharedDriveTarget.files.length, 0, 'rejection must happen before claiming the root');
  sandbox.UrlFetchApp.fetchAll = defaultRootMetadataFetchAll;
  sandbox.DriveApp.getStorageDomain = defaultStorageDomain;
  if (defaultRootOAuthToken) sandbox.ScriptApp.getOAuthToken = defaultRootOAuthToken;
  else delete sandbox.ScriptApp.getOAuthToken;

  const sharedDriveParent = root.createFolder('unsupported-shared-drive-parent');
  sharedDriveParent.storageKind = 'SHARED_DRIVE';
  sharedDriveParent.driveId = 'shared-parent-drive-id';
  const sharedDriveParentRuntime = sandbox.GmailBackupLibrary.forTargetParent(sharedDriveParent.getId());
  assert.throws(
    () => sandbox.GmailBackupLibrary.withRuntime(sharedDriveParentRuntime, function () {
      return sandbox.GmailBackupLibrary.storage.ensureLayout(null);
    }),
    /Shared Drive roots are not supported/
  );
  assert.strictEqual(
    sharedDriveParent.folders.length,
    0,
    'an unsupported parent must be rejected before the archive child is created'
  );

  const sharedTargetParent = root.createFolder('shared-target-parent');
  const parentRuntime = sandbox.GmailBackupLibrary.forTargetParent(sharedTargetParent.getId());
  const parentLayout = sandbox.GmailBackupLibrary.withRuntime(parentRuntime, function () {
    return sandbox.GmailBackupLibrary.storage.ensureLayout(null);
  });
  assert.strictEqual(parentLayout.root.parent.getId(), sharedTargetParent.getId());
  assert.strictEqual(parentLayout.root.getName(), 'Gmail Offline Backup');
  const invalidTargetRuntime = sandbox.GmailBackupLibrary.createRuntime({
    targetRootFolderId: sharedTargetRoot.getId(),
    targetParentFolderId: sharedTargetParent.getId(),
  });
  assert.throws(
    () => sandbox.GmailBackupLibrary.withRuntime(invalidTargetRuntime, sandbox.validateConfiguration_),
    /Set only one/
  );

  const multipartRequest = sandbox.buildDriveMultipartCreateRequest_({
    name: 'message.eml',
    mimeType: 'message/rfc822',
    parentId: 'folder-123',
    bytes: [0, 1, -1, 65],
    appProperties: {gbSchema: '1', gbRawSha256: 'abc123'},
  }, 'oauth-token', 3);
  assert.strictEqual(multipartRequest.method, 'post');
  assert.strictEqual(multipartRequest.headers.Authorization, 'Bearer oauth-token');
  assert.match(multipartRequest.url, /supportsAllDrives=true/);
  assert.match(multipartRequest.contentType, /^multipart\/related; boundary=gmail_backup_/);
  const multipartPayload = Buffer.from(Array.from(multipartRequest.payload).map(v => v < 0 ? v + 256 : v));
  assert(multipartPayload.includes(Buffer.from('"name":"message.eml"')));
  assert(multipartPayload.includes(Buffer.from('"parents":["folder-123"]')));
  assert(multipartPayload.includes(Buffer.from('"appProperties":{"gbSchema":"1","gbRawSha256":"abc123"}')));
  assert(multipartPayload.includes(Buffer.from([0, 1, 255, 65])));
  let capturedDriveRequests = [];
  sandbox.UrlFetchApp = {
    fetchAll(requests) {
      capturedDriveRequests = requests.slice();
      return requests.map((request, index) => ({
        getResponseCode() { return 200; },
        getContentText() { return JSON.stringify({id: `api-file-${index}`, size: '4'}); },
      }));
    },
  };
  assert.deepStrictEqual(
    Array.from(sandbox.driveApiFetchAll_([multipartRequest], 'test')).map(x => x.id),
    ['api-file-0']
  );
  sandbox.driveApiUpdateMedia_([{
    fileId: 'shared-drive-file',
    content: '[]',
    mimeType: 'application/json',
  }], 'oauth-token');
  assert.match(capturedDriveRequests[0].url, /supportsAllDrives=true/);
  sandbox.UrlFetchApp.fetchAll = function () {
    return [{getResponseCode() { return 403; }, getContentText() { return '{"error":"denied"}'; }}];
  };
  assert.throws(() => sandbox.driveApiFetchAll_([multipartRequest], 'test'), /HTTP 403/);
  sandbox.UrlFetchApp.fetchAll = defaultRootMetadataFetchAll;
  let diagnosticReadbackAttempts = 0;
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(sandbox.waitForDiagnosticDriveReadback_(function () {
      diagnosticReadbackAttempts++;
      return diagnosticReadbackAttempts >= 2;
    }))),
    {ok: true, attempts: 2, lastError: null}
  );

  // The production parallel upload path fills its original commit slot and
  // validates Drive's returned name, size, MIME type, and parent.
  const originalDriveApiCreateFiles = sandbox.driveApiCreateFiles_;
  sandbox.ScriptApp.getOAuthToken = () => 'apps-script-token';
  let observedParallelSpecs = [];
  sandbox.driveApiCreateFiles_ = function (specs) {
    observedParallelSpecs = specs;
    return specs.map((spec, index) => ({
      id: `parallel-created-${index}`,
      name: spec.name,
      size: String(spec.bytes.length),
      mimeType: spec.mimeType,
      parents: [spec.parentId],
    }));
  };
  assert.strictEqual(sandbox.parallelDriveApiEnabled_(), true);
  const parallelRecords = [null];
  const parallelArchive = sandbox.buildArchivePayload_('parallel-message', [0, 1, -1, 65]);
  sandbox.flushParallelDriveUploads_([{
    recordIndex: 0,
    id: 'parallel-message',
    entry: {id: 'parallel-message', threadId: 'thread-parallel'},
    message: {threadId: 'thread-parallel', labelIds: ['INBOX'], sizeEstimate: 4},
    archiveShard: '01',
    queueSegment: 0,
    archive: parallelArchive,
    folderId: 'parallel-folder',
    resolution: {file: null, foundExisting: false, replacedConflict: false, quarantinedCount: 0},
  }], parallelRecords, {metrics: sandbox.newOperationMetrics_()});
  assert.strictEqual(parallelRecords[0].id, 'parallel-message');
  assert.strictEqual(parallelRecords[0].driveFileId, 'parallel-created-0');
  assert.strictEqual(parallelRecords[0].rawBytes, 4);
  assert.strictEqual(parallelRecords[0].archiveEncoding, 'ZIP');
  assert.strictEqual(parallelRecords[0].fileName, 'parallel-message.eml.zip');
  assert.strictEqual(observedParallelSpecs[0].appProperties.gbRawSha256, parallelArchive.rawSha256);
  assert.strictEqual(parallelRecords[0].recoveredExisting, false);

  // Catalog updates use one parallel media request while keeping the cached
  // shard map authoritative for later batches in the same execution.
  const parallelCatalog = root.createFolder('parallel-catalog');
  parallelCatalog.createFile('shard-01.json', '[]', 'text/plain');
  const originalDriveApiUpdateMedia = sandbox.driveApiUpdateMedia_;
  let observedCatalogUpdates = [];
  sandbox.driveApiUpdateMedia_ = function (updates) {
    observedCatalogUpdates = updates;
    return updates.map(update => ({
      id: update.fileId,
      size: String(Buffer.byteLength(update.content, 'utf8')),
    }));
  };
  sandbox.mergeCommitIntoCatalogByShardParallel_(parallelCatalog, {
    records: [{id: 'catalog-entry-01', archiveShard: '01', status: 'exported'}],
  }, {catalogByShard: {}});
  assert.strictEqual(observedCatalogUpdates.length, 1);
  assert.match(observedCatalogUpdates[0].content, /catalog-entry-01/);
  sandbox.driveApiCreateFiles_ = originalDriveApiCreateFiles;
  sandbox.driveApiUpdateMedia_ = originalDriveApiUpdateMedia;
  delete sandbox.ScriptApp.getOAuthToken;
  assert.strictEqual(sandbox.parallelDriveApiEnabled_(), false);
  assert.strictEqual(sandbox.auditSummaryNeedsFile_({planned: 10, alreadyPresent: 10}), false);
  assert.strictEqual(sandbox.auditSummaryNeedsFile_({remaining: 1}), true);
  assert.strictEqual(sandbox.auditSummaryNeedsFile_({orphanFiles: 1}), true);

  // Gmail Advanced Service may return Message.raw as Byte[] even though the
  // public REST representation is base64url. Support both without double-decoding.
  const rawProbe = Buffer.from([0x00, 0x7f, 0x80, 0xff]);
  const signedProbe = Array.from(rawProbe).map(v => v > 127 ? v - 256 : v);
  assert.deepStrictEqual(
    Buffer.from(Array.from(sandbox.gmailRawBytes_(signedProbe)).map(v => v < 0 ? v + 256 : v)),
    rawProbe
  );
  assert.deepStrictEqual(
    Buffer.from(Array.from(sandbox.gmailRawBytes_(base64url(rawProbe))).map(v => v < 0 ? v + 256 : v)),
    rawProbe
  );
  assert.strictEqual(sandbox.queueSegmentFileName_(12), 'segment-00000012.json');
  const operationMetrics = sandbox.newOperationMetrics_();
  [10, 20, 30, 40].forEach(duration => {
    sandbox.recordOperationMetric_(operationMetrics, 'probe', duration, 100);
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.summarizeOperationMetrics_(operationMetrics).probe)), {
    count: 4,
    bytes: 400,
    totalMs: 100,
    meanMs: 25,
    p50Ms: 20,
    p95Ms: 40,
    maxMs: 40,
  });
  const allRemainingFastPath = sandbox.selectMissingUnseenQueueEntries_(
    [{id: 'fast01', threadId: 'thread-fast01'}],
    {},
    {},
    true
  );
  assert.deepStrictEqual(Array.from(allRemainingFastPath.entries).map(x => x.id), ['fast01']);
  assert.strictEqual(allRemainingFastPath.nonRemainingRows, 0);
  const volumeEstimate = sandbox.estimateMailboxVolume_(100, [
    {
      name: 'small', minBytes: 0, maxBytesExclusive: 1024,
      resultSizeEstimate: 75, samples: [{sizeEstimate: 500}, {sizeEstimate: 700}],
    },
    {
      name: 'large', minBytes: 1024, maxBytesExclusive: 4096,
      resultSizeEstimate: 25, samples: [{sizeEstimate: 2048}],
    },
  ]);
  assert.strictEqual(volumeEstimate.estimatedMessages, 100);
  assert(volumeEstimate.lowBytes <= volumeEstimate.typicalBytes);
  assert(volumeEstimate.typicalBytes <= volumeEstimate.highScenarioBytes);
  assert(volumeEstimate.averageTypicalBytesPerMessage > 0);

  const planTiming = sandbox.estimatePlanTiming_(100000, 200, [
    {bytes: 65536, createMs: 250},
    {bytes: 1048576, createMs: 600},
  ]);
  assert.strictEqual(planTiming.pagesPerPass, 200);
  assert.strictEqual(planTiming.totalListPages, 400);
  assert.strictEqual(planTiming.estimatedWorkerSlices, 20);
  const boundaryTiming = sandbox.estimatePlanTiming_(15000, 200, [
    {bytes: 65536, createMs: 250},
    {bytes: 1048576, createMs: 600},
  ]);
  assert.strictEqual(boundaryTiming.pagesPerPass, 30);
  assert.strictEqual(boundaryTiming.estimatedSlicesPerPass, 2);
  assert.strictEqual(boundaryTiming.estimatedWorkerSlices, 4);
  assert(planTiming.lowSeconds <= planTiming.typicalSeconds);
  assert(planTiming.typicalSeconds <= planTiming.highSeconds);

  const applyTiming = sandbox.estimateApplyTiming_(10000, {
    estimatedMessages: 10000,
    typicalBytes: 5 * 1024 * 1024 * 1024,
  }, [
    {bytes: 100000, totalMs: 300},
    {bytes: 1000000, totalMs: 900},
  ], [
    {bytes: 65536, createMs: 250},
    {bytes: 1048576, createMs: 600},
  ]);
  assert.strictEqual(applyTiming.messages, 10000);
  assert(applyTiming.lowSeconds <= applyTiming.typicalSeconds);
  assert(applyTiming.typicalSeconds <= applyTiming.highSeconds);
  assert(applyTiming.typicalQuotaDays >= 1);
  const priorPerformance = sandbox.priorApplyPerformance_({
    plan: {id: 'prior-plan'},
    apply: {
      processed: 600,
      exported: 595,
      gone: 5,
      batches: 30,
      activeRuntimeMs: 600000,
      ewmaMsPerMessage: 1000,
      ewmaWallMsPerMessage: 1400,
      ewmaBytesPerMessage: 500000,
      completedAt: '2026-08-26T12:00:00.000Z',
    },
  });
  assert.strictEqual(priorPerformance.sourcePlanId, 'prior-plan');
  assert.strictEqual(priorPerformance.processedMessages, 600);
  const observedTiming = sandbox.estimateApplyTimingFromPrior_(100, {
    rawPayload: {typicalBytes: 50 * 1000000},
  }, priorPerformance);
  assert.strictEqual(observedTiming.messages, 100);
  assert.strictEqual(observedTiming.confidence, 'high');
  assert.match(observedTiming.rateBasis, /prior-plan/);
  assert(observedTiming.lowSeconds <= observedTiming.typicalSeconds);
  assert(observedTiming.typicalSeconds <= observedTiming.highSeconds);
  assert.strictEqual(
    sandbox.exactRemainingFromCurrentState_({
      phase: 'PLANNED',
      previousPhase: null,
      plan: {query: sandbox.__BACKUP_CONFIG.GMAIL_QUERY, includeSpamTrash: true},
      audit: {remaining: 123},
      apply: {},
    }),
    123
  );

  assert.deepStrictEqual(
    Array.from(sandbox.selectEvenlySpaced_([0, 1, 2, 3, 4], 3)),
    [0, 2, 4]
  );
  const modeledPopulation = sandbox.estimatePopulationTotal_(1000, [100, 200, 300]);
  assert(modeledPopulation.lowBytes <= modeledPopulation.typicalBytes);
  assert(modeledPopulation.typicalBytes <= modeledPopulation.highBytes);
  const fallbackPayload = sandbox.estimateExactPlanPayload_(100, 10, [
    {id: 'error-only', status: 'error'},
  ], [], {ewmaBytesPerMessage: 250000});
  assert.strictEqual(fallbackPayload.confidence, 'low');
  assert.strictEqual(fallbackPayload.averageTypicalRawBytesPerMessage, 250000);
  const wilson = sandbox.wilsonInterval_(5, 10);
  assert(wilson.low < 0.5 && wilson.high > 0.5);

  const coverageRoot = new MockFolder('coverage-root');
  coverageRoot.createFolder('data');
  const coverageCatalog = coverageRoot.createFolder('catalog');
  coverageRoot.createFolder('plans');
  coverageCatalog.createFile('shard-01.json', JSON.stringify([
    {id: 'coverage01', status: 'exported', driveFileId: 'file-x'},
  ]), 'text/plain');
  const coverage = sandbox.estimateArchiveCoverageSample_(
    {rootFolderId: coverageRoot.getId()},
    ['coverage01', 'coverage02'],
    100
  );
  assert.strictEqual(coverage.available, true);
  assert.strictEqual(coverage.sampleSize, 2);
  assert.strictEqual(coverage.committedCatalogHits, 1);
  assert.strictEqual(coverage.estimatedRemainingMessages, 50);
  assert(coverage.lowRemainingMessages <= coverage.estimatedRemainingMessages);
  assert(coverage.estimatedRemainingMessages <= coverage.highRemainingMessages);
  sandbox.assertBackupAccount_({account: 'User@Example.com'}, 'user@example.com');
  let mismatchError = null;
  try {
    sandbox.assertBackupAccount_({account: 'first@example.com'}, 'second@example.com');
  } catch (error) {
    mismatchError = error;
  }
  assert(mismatchError);
  assert.match(mismatchError.message, /refusing to mix accounts/);
  assert.strictEqual(mismatchError.code, 'GMAIL_BACKUP_ACCOUNT_MISMATCH');

  const sampleA = [];
  const records = Array.from({length: 100}, (_, i) => ({id: `id-${i}`, status: 'exported'}));
  records.forEach(r => sandbox.keepDeterministicSampleCandidate_(sampleA, r, 10));
  const sampleB = [];
  records.slice().reverse().forEach(r => sandbox.keepDeterministicSampleCandidate_(sampleB, r, 10));
  assert.deepStrictEqual(sampleA.map(x => x.record.id), sampleB.map(x => x.record.id));

  const stateForBatch = {apply: sandbox.newApplyState_()};
  const batchSize = sandbox.chooseApplyBatchSize_(stateForBatch, Date.now(), 100);
  assert(batchSize >= 1 && batchSize <= sandbox.__BACKUP_CONFIG.INITIAL_APPLY_BATCH_SIZE);
  const s3ApplyRuntime = sandbox.GmailBackupLibrary.createRuntime({config: {
    STORAGE_BACKEND: 'S3',
    S3_APPLY_BATCH_SIZE: 1,
  }, services: {drive: sandbox.DriveApp}});
  sandbox.GmailBackupLibrary.withRuntime(s3ApplyRuntime, function () {
    assert.strictEqual(sandbox.applyBatchSizeLimit_(), 1);
    assert.strictEqual(sandbox.applyReplayBatchEnd_(5, 25), 6);
    assert.strictEqual(sandbox.chooseApplyBatchSize_({apply: {ewmaMsPerMessage: 250}}, Date.now(), 100), 1);
  });

  const commit = {
    planId: 'plan-1', shard: 'ab', start: 0, endExclusive: 2,
    summary: {processed: 2},
    records: [{id: 'a', status: 'exported'}, {id: 'b', status: 'gone'}],
  };
  sandbox.validateCommit_(commit, 'plan-1', 'ab', 0, 2, [{id: 'a'}, {id: 'b'}]);
  assert.throws(() => sandbox.validateCommit_(commit, 'plan-1', 'ab', 0, 2, [{id: 'b'}, {id: 'a'}]));

  addMessage('abc001', 'From: a@example.com\r\nTo: b@example.com\r\nSubject: One\r\n\r\nHello');
  addMessage('abc002', 'From: c@example.com\r\nTo: d@example.com\r\nSubject: Two\r\n\r\nWorld', ['SENT']);

  const state = {plan: {id: 'plan-1'}};
  const layout = {root, data, catalog, plans};
  const entries = [{id: 'abc001', threadId: 'thread-abc001'}, {id: 'abc002', threadId: 'thread-abc002'}];

  const first = sandbox.exportBatch_(state, layout, '01', 0, 2, entries, {canonicalByShard: {}, catalogByShard: {}});
  assert.strictEqual(first.summary.exported, 2);
  const shardFolder = data.folders.find(f => f.name === 'shard-01');
  assert(shardFolder);
  assert.strictEqual(listCanonical(shardFolder).length, 2);
  assert(first.records.every(r => !r.recoveredExisting));
  assert(
    listCanonical(shardFolder).every(file => file.setDescriptionCalls === 1 &&
      sandbox.parseArchiveIntegrityDescription_(file.getDescription()).gbRawSha256),
    'DriveApp-created archives need a raw-integrity marker for policy-blocked crash replay'
  );

  const second = sandbox.exportBatch_(state, layout, '01', 0, 2, entries, {canonicalByShard: {}, catalogByShard: {}});
  assert.strictEqual(listCanonical(shardFolder).length, 2, 'idempotent replay must not duplicate archive files');
  assert(second.records.every(r => r.recoveredExisting));

  // Raw export must preserve non-ASCII and arbitrary byte values exactly.
  const binaryRaw = Buffer.concat([
    Buffer.from('From: utf8@example.com\r\nSubject: UTF-8 \u2713\r\n\r\n', 'utf8'),
    Buffer.from([0x00, 0x7f, 0x80, 0xff]),
  ]);
  addMessage('abc003', binaryRaw);
  const binaryCommit = sandbox.exportBatch_(
    state,
    layout,
    '03',
    0,
    1,
    [{id: 'abc003', threadId: 'thread-abc003'}],
    {canonicalByShard: {}, catalogByShard: {}}
  );
  const binaryFolder = data.folders.find(f => f.name === 'shard-03');
  const binaryFile = binaryFolder.files.find(f => f.name === 'abc003.eml.zip');
  const binaryEntries = sandbox.Utilities.unzip(binaryFile.getBlob());
  assert.strictEqual(binaryEntries.length, 1);
  assert.strictEqual(binaryEntries[0].getName(), 'abc003.eml');
  assert.deepStrictEqual(Buffer.from(binaryEntries[0].getBytes()), binaryRaw);
  assert.strictEqual(binaryCommit.records[0].rawBytes, binaryRaw.length);
  assert.strictEqual(binaryCommit.records[0].storedBytes, binaryFile.getSize());
  assert.strictEqual(binaryCommit.records[0].sha256, sandbox.sha256Hex_(Array.from(binaryRaw)));
  assert.strictEqual(binaryCommit.records[0].storedSha256, sandbox.sha256Hex_(binaryFile.getBlob().getBytes()));
  const binaryIntegrity = sandbox.readArchiveFileIntegrity_(binaryFile, binaryCommit.records[0], false);
  assert.strictEqual(binaryIntegrity.ok, true);
  assert.strictEqual(binaryIntegrity.contentDecoded, true);
  assert.strictEqual(binaryIntegrity.rawSha256, binaryCommit.records[0].sha256);

  // Replay can trust the separately stored raw marker even if Workspace blocks
  // ZIP reads and a fresh ZIP container would have different stored bytes.
  const originalBinaryGetBlob = binaryFile.getBlob;
  const originalReadDriveFileIntegrity = sandbox.readDriveFileIntegrity_;
  binaryFile.getBlob = function () { throw new Error('Access denied: DriveApp.'); };
  sandbox.readDriveFileIntegrity_ = function () {
    return {
      ok: true,
      method: 'driveApiServerSha256',
      downloadable: false,
      sha256: binaryCommit.records[0].storedSha256,
    };
  };
  const replayArchive = sandbox.buildArchivePayload_('abc003', Array.from(binaryRaw));
  replayArchive.storedSha256 = 'intentionally-different-zip-container-hash';
  const blockedReplay = sandbox.resolveCanonicalForExport_({
    byId: {abc003: binaryFile},
    allById: {abc003: [binaryFile]},
  }, 'abc003', replayArchive, root);
  assert.strictEqual(blockedReplay.file, binaryFile);
  assert.strictEqual(blockedReplay.storage.rawSha256, binaryCommit.records[0].sha256);
  binaryFile.getBlob = originalBinaryGetBlob;
  sandbox.readDriveFileIntegrity_ = originalReadDriveFileIntegrity;

  // A pre-existing legacy EML remains canonical after ZIP becomes the
  // preferred encoding; mixed archives must not rewrite healthy data.
  const legacyRaw = Buffer.from('From: legacy@example.com\r\nSubject: Legacy\r\n\r\nStill valid', 'utf8');
  addMessage('abc004', legacyRaw);
  const legacyFolder = data.createFolder('shard-04');
  const legacyFile = legacyFolder.createFile(new MockBlob(legacyRaw, 'message/rfc822', 'abc004.eml'));
  const legacyCommit = sandbox.exportBatch_(
    state,
    layout,
    '04',
    0,
    1,
    [{id: 'abc004', threadId: 'thread-abc004'}],
    {canonicalByShard: {}, catalogByShard: {}}
  );
  assert.strictEqual(legacyCommit.records[0].recoveredExisting, true);
  assert.strictEqual(legacyCommit.records[0].archiveEncoding, 'EML');
  assert.strictEqual(legacyCommit.records[0].fileName, 'abc004.eml');
  assert.strictEqual(legacyCommit.records[0].storedSha256, legacyCommit.records[0].sha256);
  assert.strictEqual(listCanonical(legacyFolder).length, 1);
  assert.strictEqual(listCanonical(legacyFolder)[0], legacyFile);

  // Public DOCTOR/estimate stages execute end-to-end against the mocks, do not
  // leave triggers behind, and produce ordered timing scenarios.
  throwDeleteTriggerAfterRemovalOnce = true;
  const doctorReport = sandbox.doctorBackup();
  assert.strictEqual(doctorReport.ok, true, 'doctor must not fail solely because temporary trigger cleanup throws');
  assert.strictEqual(projectTriggers.length, 0);
  assert.strictEqual(doctorReport.checks.gmailRawRead.ok, true);
  assert.strictEqual(doctorReport.checks.driveRoundTrip.hashVerified, true);
  assert.strictEqual(doctorReport.checks.installableTrigger.ok, true);
  assert.strictEqual(doctorReport.checks.installableTrigger.created, true);
  assert.strictEqual(doctorReport.checks.installableTrigger.deleted, false);
  assert(doctorReport.cautions.some(text => /could not be deleted immediately/i.test(text)));

  const quickEstimate = sandbox.estimateBackup();
  assert.strictEqual(quickEstimate.estimatedMessages, gmailMessages.size);
  assert(quickEstimate.volumeEstimate.typicalBytes > 0);
  assert(quickEstimate.volumeEstimate.lowBytes <= quickEstimate.volumeEstimate.typicalBytes);
  assert(quickEstimate.volumeEstimate.typicalBytes <= quickEstimate.volumeEstimate.highScenarioBytes);
  assert(quickEstimate.timingEstimate.plan.lowSeconds <= quickEstimate.timingEstimate.plan.typicalSeconds);
  assert(quickEstimate.timingEstimate.apply.typicalSeconds <= quickEstimate.timingEstimate.apply.highSeconds);
  assert.strictEqual(projectTriggers.length, 0);
  assert(scriptLogs.some(entry => /GMAIL BACKUP DOCTOR: PASS/.test(entry.text)));
  assert(scriptLogs.some(entry => /GMAIL BACKUP QUICK ESTIMATE/.test(entry.text)));
  const compressionReport = sandbox.benchmarkArchiveCompression();
  assert.strictEqual(compressionReport.archiveEncoding, 'ZIP');
  assert(compressionReport.sampledMessages > 0);
  assert.strictEqual(compressionReport.rows.length, compressionReport.sampledMessages);
  assert(compressionReport.rows.every(row => row.storedBytes > 0 && row.encodeMs >= 1));
  assert.strictEqual(compressionReport.roundTripVerified, true);

  // Corrupt one partial file. A retry must quarantine and replace it.
  const corrupt = shardFolder.files.find(f => f.name === 'abc001.eml.zip');
  corrupt.bytes = Array.from(Buffer.from('corrupt'));
  const repaired = sandbox.exportBatch_(state, layout, '01', 0, 1, [entries[0]], {canonicalByShard: {}, catalogByShard: {}});
  assert.strictEqual(repaired.records[0].replacedConflict, true);
  assert.strictEqual(listCanonical(shardFolder).filter(f => f.name === 'abc001.eml.zip').length, 1);
  const quarantine = root.folders.find(f => f.name === 'quarantine');
  assert(quarantine && quarantine.files.length >= 1);

  // Catalog merge is idempotent.
  const context = {catalogByShard: {}};
  sandbox.mergeCommitIntoCatalog_(catalog, '01', first, context);
  sandbox.mergeCommitIntoCatalog_(catalog, '01', first, context);
  const catalogFile = catalog.files.find(f => f.name === 'shard-01.json');
  const catalogRecords = JSON.parse(catalogFile.getBlob().getDataAsString());
  assert.strictEqual(catalogRecords.length, 2);

  const repairedCommit = {
    planId: 'plan-1', shard: '01', start: 0, endExclusive: 1,
    summary: {processed: 1, exported: 1, gone: 0, rawBytes: repaired.records[0].rawBytes},
    records: repaired.records,
    durationMs: 100,
  };
  assert.strictEqual(sandbox.validateCommittedFiles_(repairedCommit, layout).ok, true);

  // Oversized S3 replay must use a separately persisted full-hash attestation
  // and metadata marker instead of reloading the object into the V8 heap.
  const attestedId = 'oversize3e';
  const attestedShard = sandbox.shardForId_(attestedId);
  const attestedFolder = data.createFolder('shard-' + attestedShard);
  const attestedFile = attestedFolder.createFile(
    new MockBlob(Buffer.from('not-loaded'), 'message/rfc822', attestedId + '.eml')
  );
  const attestedBytes = 9 * 1024 * 1024;
  const attestedSha = 'a'.repeat(64);
  attestedFile.getSize = function () { return attestedBytes; };
  attestedFile.setDescription(sandbox.archiveIntegrityDescription_({
    archiveEncoding: 'EML', rawByteLength: attestedBytes, rawSha256: attestedSha,
  }));
  attestedFile.getBlob = function () { throw new Error('oversized object content must not be loaded'); };
  const attestedPlan = plans.createFolder('attestation-plan');
  const attestedRoot = attestedPlan.createFolder('integrity-attestations');
  const attestedSegment = attestedRoot.createFolder('segment-00000000');
  const attestedRecord = {
    id: attestedId,
    archiveShard: attestedShard,
    queueSegment: 0,
    status: 'exported',
    archiveEncoding: 'EML',
    rawBytes: attestedBytes,
    sha256: attestedSha,
    storedBytes: attestedBytes,
    storedSha256: attestedSha,
    fileName: attestedId + '.eml',
    mimeType: 'message/rfc822',
    storageFileId: attestedFile.getId(),
  };
  const attestedCommit = {
    schemaVersion: 2,
    planId: 'attestation-plan',
    queueSegment: 0,
    start: 7,
    endExclusive: 8,
    summary: {processed: 1, exported: 1, gone: 0, rawBytes: attestedBytes, storedBytes: attestedBytes},
    records: [attestedRecord],
  };
  const attestationFile = attestedSegment.createFile(
    '00000007-00000008.json',
    JSON.stringify({
      schemaVersion: 1,
      kind: 'EXTERNAL_S3_FULL_SHA256_V1',
      planId: 'attestation-plan',
      queueSegment: 0,
      start: 7,
      endExclusive: 8,
      messageId: attestedId,
      storageFileId: attestedFile.getId(),
      archiveEncoding: 'EML',
      rawBytes: attestedBytes,
      rawSha256: attestedSha,
      storedBytes: attestedBytes,
      storedSha256: attestedSha,
      verifiedAt: '2026-09-03T12:00:00.000Z',
    }),
    'text/plain'
  );
  sandbox.GmailBackupLibrary.withRuntime(s3ApplyRuntime, function () {
    const validation = sandbox.validateCommittedFiles_(attestedCommit, layout);
    assert.strictEqual(validation.ok, true, JSON.stringify(validation.failures));
    assert.strictEqual(attestedRecord.integrityVerification.kind, 'EXTERNAL_S3_FULL_SHA256_V1');
    const boundedRead = sandbox.readArchiveFileIntegrity_(attestedFile, attestedRecord, false);
    assert.strictEqual(boundedRead.ok, true);
    assert.strictEqual(boundedRead.method, 'externalFullHashAttestation+S3Metadata');
    assert.strictEqual(boundedRead.rawIntegritySource, 'externalFullHashAttestation');
    attestationFile.setTrashed(true);
    const missing = sandbox.validateCommittedFiles_(attestedCommit, layout);
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.failures[0].reason, 'oversized-replay-attestation-missing');
  });

  const applyState = {apply: sandbox.newApplyState_()};
  applyState.apply.total = 10;
  sandbox.advanceApplyStateFromCommit_(applyState, repairedCommit);
  assert.strictEqual(applyState.apply.processed, 1);
  assert.strictEqual(applyState.apply.exported, 1);
  assert(applyState.apply.ewmaMsPerMessage > 0);

  const healthFile = shardFolder.files.find(f => f.name === 'abc001.eml.zip');
  const health = sandbox.canonicalArchiveHealth_(healthFile, repaired.records[0]);
  assert.strictEqual(health.ok, true);
  healthFile.setName('abc001.eml');
  const renamedHealth = sandbox.canonicalArchiveHealth_(healthFile, repaired.records[0]);
  assert.strictEqual(renamedHealth.ok, false);
  assert.strictEqual(renamedHealth.category, 'catalog-mismatch');
  assert.strictEqual(renamedHealth.reason, 'canonical-file-name-mismatch');
  const encodingOnlyRecord = Object.assign({}, repaired.records[0], {fileName: null});
  assert.strictEqual(
    sandbox.canonicalArchiveHealth_(healthFile, encodingOnlyRecord).reason,
    'canonical-file-encoding-mismatch'
  );
  healthFile.setName('abc001.eml.zip');
  healthFile.mimeType = 'message/rfc822';
  assert.strictEqual(
    sandbox.canonicalArchiveHealth_(healthFile, repaired.records[0]).reason,
    'canonical-file-mime-type-mismatch'
  );
  healthFile.mimeType = 'application/zip';
  assert.strictEqual(sandbox.canonicalArchiveHealth_(healthFile, repaired.records[0]).ok, true);

  // A stable second scan pass must not rewrite every membership shard when it
  // contributes no new IDs or thread mappings.
  const stableShardFolder = new MockFolder('stable-plan-shards');
  const stableShardFile = stableShardFolder.createFile(
    'shard-01.json',
    JSON.stringify([{id: 'same01', threadId: 'thread-same01'}]),
    'text/plain'
  );
  sandbox.flushPlanShardBuffer_(stableShardFolder, {
    '01': [{id: 'same01', threadId: 'thread-same01'}],
  });
  assert.strictEqual(stableShardFile.setContentCalls, 0, 'unchanged shard must not be rewritten');
  sandbox.flushPlanShardBuffer_(stableShardFolder, {
    '01': [{id: 'new01', threadId: 'thread-new01'}],
  });
  assert.strictEqual(stableShardFile.setContentCalls, 1, 'new membership must remain durable');
  assert.deepStrictEqual(
    JSON.parse(stableShardFile.getBlob().getDataAsString()).map(entry => entry.id),
    ['new01', 'same01']
  );

  // An S3 precondition conflict must reload and re-merge the newer shard so a
  // concurrent set-union contribution is preserved instead of overwritten.
  const conflictShardFolder = new MockFolder('conflict-plan-shards');
  const conflictShardFile = conflictShardFolder.createFile(
    'shard-02.json',
    JSON.stringify([{id: 'same02', threadId: 'thread-same02'}]),
    'text/plain'
  );
  const originalConflictSetContent = conflictShardFile.setContent.bind(conflictShardFile);
  let injectShardConflict = true;
  conflictShardFile.setContent = function (content) {
    if (injectShardConflict) {
      injectShardConflict = false;
      this.bytes = Array.from(Buffer.from(JSON.stringify([
        {id: 'same02', threadId: 'thread-same02'},
        {id: 'concurrent02', threadId: 'thread-concurrent02'},
      ])));
      const error = new Error('injected S3 precondition conflict');
      error.code = 'S3_PRECONDITION_FAILED';
      throw error;
    }
    return originalConflictSetContent(content);
  };
  sandbox.flushPlanShardBuffer_(conflictShardFolder, {
    '02': [{id: 'new02', threadId: 'thread-new02'}],
  });
  assert.strictEqual(injectShardConflict, false);
  assert.deepStrictEqual(
    JSON.parse(conflictShardFile.getBlob().getDataAsString()).map(entry => entry.id),
    ['concurrent02', 'new02', 'same02']
  );

  // A scan crash after journal creation but before shard/state advancement
  // must replay the durable journal without issuing the Gmail list call again.
  const journalRoot = new MockFolder('journal-root');
  journalRoot.createFolder('data');
  journalRoot.createFolder('catalog');
  const journalPlans = journalRoot.createFolder('plans');
  const journalPlanFolder = journalPlans.createFolder('journal-plan');
  const journalShards = journalPlanFolder.createFolder('mailbox-shards');
  const journalFolder = journalPlanFolder.createFolder('scan-journal');
  const journalState = sandbox.newBaseState_(journalRoot.getId());
  journalState.phase = 'SCANNING';
  journalState.account = 'user@example.com';
  journalState.plan = {
    id: 'journal-plan',
    shardsFolderId: journalShards.getId(),
    scanJournalFolderId: journalFolder.getId(),
    query: '', includeSpamTrash: true,
  };
  journalState.scan = {
    pass: 1, passes: 1, nextPageToken: '', pagesCommitted: 0, rowsSeen: 0,
    rowsSeenThisPass: 0, pageTokenResets: 0, generation: 0, chunkIndex: 0,
    chunksCommitted: 0, resultSizeEstimate: 1, historyIdStart: '1',
    startedAt: new Date().toISOString(),
  };
  let journalListCalls = 0;
  sandbox.Gmail.Users.Messages.list = function () {
    journalListCalls++;
    return {messages: [{id: 'jrnl01', threadId: 'tj'}], resultSizeEstimate: 1};
  };
  sandbox.Gmail.Users.getProfile = function () {
    return {emailAddress: 'user@example.com', messagesTotal: 1, threadsTotal: 1, historyId: '2'};
  };
  const originalFlushPlan = sandbox.flushPlanShardBuffer_;
  let failJournalFlush = true;
  sandbox.flushPlanShardBuffer_ = function (...args) {
    if (failJournalFlush) {
      failJournalFlush = false;
      throw new Error('injected scan crash after journal');
    }
    return originalFlushPlan.apply(this, args);
  };
  assert.throws(() => sandbox.processScanSlice_(journalState, Date.now()), /injected scan crash/);
  assert.strictEqual(journalListCalls, 1);
  assert.strictEqual(journalFolder.files.length, 1);
  assert.strictEqual(journalState.scan.chunkIndex, 0);
  sandbox.flushPlanShardBuffer_ = originalFlushPlan;
  sandbox.processScanSlice_(journalState, Date.now());
  assert.strictEqual(journalListCalls, 1, 'retry must consume the durable scan journal');
  assert.strictEqual(journalState.phase, 'AUDITING');

  // PLAN scan performs set-union across repeated ID-only passes.
  const scanRoot = new MockFolder('scan-root');
  scanRoot.createFolder('data');
  scanRoot.createFolder('catalog');
  const scanPlans = scanRoot.createFolder('plans');
  const scanPlanFolder = scanPlans.createFolder('scan-plan');
  const scanShards = scanPlanFolder.createFolder('mailbox-shards');
  const scanRemaining = scanPlanFolder.createFolder('remaining-shards');
  const scanAudit = scanPlanFolder.createFolder('audit');
  const scanCommits = scanPlanFolder.createFolder('commits');
  const scanJournal = scanPlanFolder.createFolder('scan-journal');
  const scanWorkQueue = scanPlanFolder.createFolder('work-queue');
  const scanQueueCommits = scanPlanFolder.createFolder('queue-commits');
  const scanQueueSeen = scanPlanFolder.createFolder('queue-seen');
  const scanState = sandbox.newBaseState_(scanRoot.getId());
  scanState.phase = 'SCANNING';
  scanState.account = 'user@example.com';
  scanState.plan = {
    id: 'scan-plan', folderId: scanPlanFolder.getId(), shardsFolderId: scanShards.getId(),
    remainingFolderId: scanRemaining.getId(), auditFolderId: scanAudit.getId(), commitsFolderId: scanCommits.getId(),
    scanJournalFolderId: scanJournal.getId(), workQueueFolderId: scanWorkQueue.getId(),
    queueCommitsFolderId: scanQueueCommits.getId(), queueSeenFolderId: scanQueueSeen.getId(),
    query: 'label:frozen-plan', includeSpamTrash: false, applyOrder: 'NEWEST_FIRST', createdAt: new Date().toISOString(),
  };
  scanState.scan = {
    pass: 1, passes: 2, nextPageToken: '', pagesCommitted: 0, rowsSeen: 0,
    rowsSeenThisPass: 0, pageTokenResets: 0, resultSizeEstimate: 3,
    generation: 0, chunkIndex: 0, chunksCommitted: 0,
    finalPassGeneration: null, finalPassChunkCount: null, finalPassRows: null,
    historyIdStart: '10', historyIdEnd: '', startedAt: new Date().toISOString(),
  };
  scanState.audit = sandbox.newAuditState_();
  scanState.queue = sandbox.newQueueState_();
  const passPages = [
    [
      {messages: [{id: 'scan01', threadId: 't1'}, {id: 'scan02', threadId: 't2'}], nextPageToken: 'p2', resultSizeEstimate: 3},
      {messages: [{id: 'scan03', threadId: 't3'}], resultSizeEstimate: 3},
    ],
    [
      {messages: [{id: 'scan03', threadId: 't3'}, {id: 'scan02', threadId: 't2'}], nextPageToken: 'p2', resultSizeEstimate: 3},
      {messages: [{id: 'scan01', threadId: 't1'}], resultSizeEstimate: 3},
    ],
  ];
  let activePass = 0;
  let pageIndex = 0;
  const scanParams = [];
  sandbox.Gmail.Users.Messages.list = function (user, params) {
    scanParams.push(Object.assign({}, params));
    const response = passPages[activePass][pageIndex++];
    if (!response.nextPageToken) { activePass++; pageIndex = 0; }
    return response;
  };
  sandbox.Gmail.Users.getProfile = function () {
    return {emailAddress: 'user@example.com', messagesTotal: 3, threadsTotal: 3, historyId: '11'};
  };
  sandbox.processScanSlice_(scanState, Date.now());
  assert.strictEqual(scanState.scan.pass, 2);
  assert.strictEqual(scanState.phase, 'SCANNING');
  sandbox.processScanSlice_(scanState, Date.now());
  assert.strictEqual(scanState.phase, 'AUDITING');
  assert(scanParams.length >= 4);
  scanParams.forEach(params => {
    assert.strictEqual(params.q, 'label:frozen-plan', 'every slice must use the immutable plan query');
    assert.strictEqual(params.includeSpamTrash, false, 'every slice must use the immutable spam/trash scope');
  });
  let plannedIds = [];
  scanShards.files.forEach(file => {
    plannedIds = plannedIds.concat(JSON.parse(file.getBlob().getDataAsString()).map(x => x.id));
  });
  assert.deepStrictEqual(plannedIds.sort(), ['scan01', 'scan02', 'scan03']);

  sandbox.processAuditSlice_(scanState, Date.now());
  assert.strictEqual(scanState.phase, 'QUEUEING');
  assert.strictEqual(scanState.audit.planned, 3);
  assert.strictEqual(scanState.audit.remaining, 3);
  assert.strictEqual(scanRemaining.files.length, 3, 'remaining evidence should exist only for non-empty shards');
  assert.strictEqual(scanAudit.files.length, 3, 'audit evidence should exist only for anomalous shards');

  addMessage('scan01', 'From: scan@example.com\r\nSubject: Scan 1\r\n\r\nSmall');
  addMessage('scan02', 'From: scan@example.com\r\nSubject: Scan 2\r\n\r\n' + 'medium '.repeat(50));
  addMessage('scan03', 'From: scan@example.com\r\nSubject: Scan 3\r\n\r\n' + 'large '.repeat(200));
  sandbox.processQueueSlice_(scanState, Date.now());
  assert.strictEqual(scanState.phase, 'PLANNED');
  assert.strictEqual(scanState.queue.queued, 3);
  assert.strictEqual(
    scanState.queue.tailShardIndex,
    0,
    'an exact ordered queue must skip the redundant 64-shard fallback scan'
  );
  const queueSegment = JSON.parse(
    scanWorkQueue.files.find(f => f.name === 'segment-00000000.json').getBlob().getDataAsString()
  );
  assert.deepStrictEqual(queueSegment.entries.map(x => x.id), ['scan03', 'scan02', 'scan01']);
  const exactPlanEstimateFile = scanPlanFolder.files.find(f => f.name === 'plan-estimate.json');
  const exactPlanEstimate = JSON.parse(exactPlanEstimateFile.getBlob().getDataAsString());
  assert.strictEqual(exactPlanEstimate.exact.remainingMessages, 3);
  assert.strictEqual(exactPlanEstimate.exact.countAuthoritative, true);
  assert.strictEqual(exactPlanEstimate.sample.selectedMessages, 3);
  assert.strictEqual(exactPlanEstimate.sample.metadataAvailable, 3);
  assert.strictEqual(exactPlanEstimate.sample.rawAvailable, 3);
  assert.strictEqual(exactPlanEstimate.payloadEstimate.rawPayload.exact, true);
  assert.strictEqual(exactPlanEstimate.payloadEstimate.storedPayload.exact, true);
  assert.strictEqual(exactPlanEstimate.applyTimingEstimate.messages, 3);
  assert.strictEqual(exactPlanEstimate.applyTimingEstimate.countExact, true);
  assert.strictEqual(scanState.plan.estimate.exactRemainingMessages, 3);
  assert(Buffer.byteLength(JSON.stringify(scanState), 'utf8') < 8500, 'compact PLAN estimate must fit the state property budget');
  assert.strictEqual(sandbox.statusObject_(scanState).planEstimate.exactRemainingMessages, 3);
  const completedPlanSummary = JSON.parse(
    scanPlanFolder.files.find(f => f.name === 'plan.json').getBlob().getDataAsString()
  );
  assert.strictEqual(completedPlanSummary.estimate.planId, 'scan-plan');
  assert(scriptLogs.some(entry => /GMAIL BACKUP PLAN ESTIMATE/.test(entry.text)));
  ['scan01', 'scan02', 'scan03'].forEach(id => gmailMessages.delete(id));

  const largeEstimateQueue = scanPlanFolder.createFolder('large-estimate-queue');
  for (let segmentIndex = 0; segmentIndex < 100; segmentIndex++) {
    largeEstimateQueue.createFile(
      sandbox.queueSegmentFileName_(segmentIndex),
      JSON.stringify({
        schemaVersion: 1,
        planId: 'large-estimate-plan',
        applyOrder: 'NEWEST_FIRST',
        segmentIndex,
        entries: [
          {id: `large-${String(segmentIndex).padStart(3, '0')}-a`},
          {id: `large-${String(segmentIndex).padStart(3, '0')}-b`},
        ],
      }),
      'text/plain'
    );
  }
  const largeEstimateSelection = sandbox.selectPlanEstimateQueueEntries_({
    plan: {id: 'large-estimate-plan', workQueueFolderId: largeEstimateQueue.getId()},
    audit: {remaining: 200},
    queue: {segmentIndex: 100},
  }, 64);
  assert.strictEqual(largeEstimateSelection.length, 64);
  assert.strictEqual(largeEstimateSelection[0].id, 'large-000-a');
  assert.strictEqual(largeEstimateSelection[63].id, 'large-099-b');

  // OLDEST_FIRST reverses final-pass chunk order and row order, suppresses
  // duplicates, and replays a queue commit safely after a crash between
  // segment creation and seen/state advancement.
  const oldRoot = new MockFolder('oldest-root');
  oldRoot.createFolder('data');
  oldRoot.createFolder('catalog');
  const oldPlans = oldRoot.createFolder('plans');
  const oldPlanFolder = oldPlans.createFolder('old-plan');
  const oldRemaining = oldPlanFolder.createFolder('remaining-shards');
  const oldJournal = oldPlanFolder.createFolder('scan-journal');
  const oldQueue = oldPlanFolder.createFolder('work-queue');
  const oldQueueCommits = oldPlanFolder.createFolder('queue-commits');
  const oldSeen = oldPlanFolder.createFolder('queue-seen');
  oldPlanFolder.createFolder('commits');
  ['01', '02', '03', '04'].forEach(suffix => {
    oldRemaining.createFile('shard-' + suffix + '.json', JSON.stringify([
      {id: 'ord0' + suffix, threadId: 't-' + suffix, auditReason: 'missing'},
    ]), 'text/plain');
  });
  // Final-pass chunks are each newest -> oldest. OLDEST_FIRST must reverse
  // both chunk order and row order to produce one global oldest -> newest queue.
  oldJournal.createFile(
    sandbox.scanJournalFileName_(2, 0, 0),
    JSON.stringify({
      schemaVersion: 1,
      planId: 'old-plan',
      pass: 2,
      generation: 0,
      chunkIndex: 0,
      messages: [
        {id: 'ord004', threadId: 't-04'},
        {id: 'ord003', threadId: 't-03'},
        {id: 'ord002', threadId: 't-02'},
      ],
    }),
    'text/plain'
  );
  oldJournal.createFile(
    sandbox.scanJournalFileName_(2, 0, 1),
    JSON.stringify({
      schemaVersion: 1,
      planId: 'old-plan',
      pass: 2,
      generation: 0,
      chunkIndex: 1,
      messages: [
        {id: 'ord002', threadId: 't-02'},
        {id: 'ord001', threadId: 't-01'},
      ],
    }),
    'text/plain'
  );
  const oldState = sandbox.newBaseState_(oldRoot.getId());
  oldState.phase = 'QUEUEING';
  oldState.account = 'user@example.com';
  oldState.plan = {
    id: 'old-plan', folderId: oldPlanFolder.getId(),
    remainingFolderId: oldRemaining.getId(), scanJournalFolderId: oldJournal.getId(),
    workQueueFolderId: oldQueue.getId(), queueCommitsFolderId: oldQueueCommits.getId(),
    queueSeenFolderId: oldSeen.getId(), applyOrder: 'OLDEST_FIRST', query: '',
    includeSpamTrash: true, createdAt: new Date().toISOString(),
  };
  oldState.scan = {
    passes: 2, finalPassGeneration: 0, finalPassChunkCount: 2, finalPassRows: 5,
    historyIdStart: '1', historyIdEnd: '1',
  };
  oldState.audit = sandbox.newAuditState_();
  oldState.audit.planned = 4;
  oldState.audit.remaining = 4;
  oldState.audit.completedAt = new Date().toISOString();
  oldState.queue = sandbox.newQueueState_();
  oldState.queue.order = 'OLDEST_FIRST';
  oldState.queue.total = 4;
  oldState.queue.startedAt = new Date().toISOString();
  oldState.apply = sandbox.newApplyState_();
  oldState.apply.total = 4;

  const originalMergeSeen = sandbox.mergeQueueCommitIntoSeen_;
  let injectQueueCrash = true;
  sandbox.mergeQueueCommitIntoSeen_ = function (...args) {
    if (injectQueueCrash) {
      injectQueueCrash = false;
      throw new Error('injected queue crash after segments');
    }
    return originalMergeSeen.apply(this, args);
  };
  assert.throws(() => sandbox.processQueueSlice_(oldState, Date.now()), /injected queue crash/);
  assert(oldState.queue.inFlight);
  assert.strictEqual(oldQueue.files.length, 1);
  sandbox.mergeQueueCommitIntoSeen_ = originalMergeSeen;
  sandbox.processQueueSlice_(oldState, Date.now());
  assert.strictEqual(oldState.phase, 'PLANNED');
  assert.strictEqual(oldState.queue.queued, 4);
  assert.strictEqual(oldState.queue.duplicatesSuppressed, 1);
  assert.strictEqual(oldState.queue.tailShardIndex, 0, 'complete OLDEST_FIRST queue must skip fallback');
  assert.strictEqual(oldQueue.files.length, 2, 'queue replay must not duplicate segments');
  const oldOrderedIds = oldQueue.files
    .slice()
    .sort((a, b) => a.getName().localeCompare(b.getName()))
    .flatMap(file => JSON.parse(file.getBlob().getDataAsString()).entries.map(x => x.id));
  assert.deepStrictEqual(oldOrderedIds, ['ord001', 'ord002', 'ord003', 'ord004']);

  // If a seen-shard merge crashes after one remote write, replay must skip
  // that already-durable shard and continue with the remaining additions.
  const partialSeen = oldPlanFolder.createFolder('partial-seen-replay');
  const partial01 = partialSeen.createFile('shard-01.json', '[]', 'text/plain');
  const partial02 = partialSeen.createFile('shard-02.json', '[]', 'text/plain');
  const partialSeenFiles = sandbox.listFilesByName_(partialSeen);
  const partialCommit = {
    segments: [{entries: [{id: 'partial01'}, {id: 'partial02'}]}],
  };
  const originalPartial02SetContent = partial02.setContent;
  let failPartial02 = true;
  partial02.setContent = function (content) {
    if (failPartial02) {
      failPartial02 = false;
      throw new Error('injected seen-shard write failure');
    }
    return originalPartial02SetContent.call(this, content);
  };
  assert.throws(
    () => sandbox.mergeQueueCommitIntoSeen_(partialSeen, partialSeenFiles, partialCommit),
    /injected seen-shard write failure/
  );
  assert.strictEqual(partial01.setContentCalls, 1);
  sandbox.mergeQueueCommitIntoSeen_(partialSeen, partialSeenFiles, partialCommit);
  assert.strictEqual(partial01.setContentCalls, 1, 'replay must not rewrite an already-complete seen shard');
  assert.deepStrictEqual(JSON.parse(partial02.getBlob().getDataAsString()), ['partial02']);

  // A terminal PLAN summary failure must leave QUEUEING resumable.
  scanState.phase = 'QUEUEING';
  scanState.queue.stage = 'FINALIZING';
  scanState.queue.completedAt = null;
  scanState.plan.completedAt = null;
  const estimateWritesBeforeReplay = exactPlanEstimateFile.setContentCalls;
  const originalUpsertJson = sandbox.upsertJsonFile_;
  sandbox.upsertJsonFile_ = function (folder, name, value) {
    if (name === 'plan.json') throw new Error('injected plan summary failure');
    return originalUpsertJson(folder, name, value);
  };
  assert.throws(() => sandbox.processQueueSlice_(scanState, Date.now()), /injected plan summary failure/);
  assert.strictEqual(scanState.phase, 'QUEUEING');
  sandbox.upsertJsonFile_ = originalUpsertJson;
  sandbox.processQueueSlice_(scanState, Date.now());
  assert.strictEqual(scanState.phase, 'PLANNED');
  assert.strictEqual(
    exactPlanEstimateFile.setContentCalls,
    estimateWritesBeforeReplay,
    'PLAN summary replay must reuse the durable estimate without repeating it'
  );

  // A zero-delta APPLY should complete immediately, but only after its durable
  // apply-summary exists. Failure must preserve APPLYING for retry.
  const zeroState = sandbox.newBaseState_(scanRoot.getId());
  zeroState.phase = 'APPLYING';
  zeroState.account = 'user@example.com';
  zeroState.plan = {
    id: 'scan-plan', folderId: scanPlanFolder.getId(), appliedAt: null,
    workQueueFolderId: scanWorkQueue.getId(),
  };
  zeroState.audit = scanState.audit;
  zeroState.queue = sandbox.newQueueState_();
  zeroState.queue.completedAt = new Date().toISOString();
  zeroState.queue.segmentIndex = 0;
  zeroState.apply = sandbox.newApplyState_();
  zeroState.apply.total = 0;
  sandbox.upsertJsonFile_ = function (folder, name, value) {
    if (name === 'apply-summary.json') throw new Error('injected apply summary failure');
    return originalUpsertJson(folder, name, value);
  };
  assert.throws(() => sandbox.processApplySlice_(zeroState, Date.now()), /injected apply summary failure/);
  assert.strictEqual(zeroState.phase, 'APPLYING');
  sandbox.upsertJsonFile_ = originalUpsertJson;
  sandbox.processApplySlice_(zeroState, Date.now());
  assert.strictEqual(zeroState.phase, 'COMPLETE');

  // Simulate a crash after deterministic commit creation but before catalog
  // merge/state advancement. The next slice must replay exactly once.
  const txRoot = new MockFolder('transaction-root');
  const txData = txRoot.createFolder('data');
  const txCatalog = txRoot.createFolder('catalog');
  const txPlans = txRoot.createFolder('plans');
  const txPlanFolder = txPlans.createFolder('tx-plan');
  const txRemaining = txPlanFolder.createFolder('remaining-shards');
  const txCommits = txPlanFolder.createFolder('commits');
  const txWorkQueue = txPlanFolder.createFolder('work-queue');
  txPlanFolder.createFolder('mailbox-shards');
  txPlanFolder.createFolder('audit');
  addMessage('tx0001', 'From: tx@example.com\r\nTo: dst@example.com\r\nSubject: Tx 1\r\n\r\nCheckpoint one');
  addMessage('tx0002', 'From: tx@example.com\r\nTo: dst@example.com\r\nSubject: Tx 2\r\n\r\nCheckpoint two');
  txRemaining.createFile('shard-01.json', JSON.stringify([{id: 'tx0001', threadId: 'thread-tx0001'}]), 'text/plain');
  txRemaining.createFile('shard-02.json', JSON.stringify([{id: 'tx0002', threadId: 'thread-tx0002'}]), 'text/plain');
  txWorkQueue.createFile('segment-00000000.json', JSON.stringify({
    schemaVersion: 1,
    planId: 'tx-plan',
    applyOrder: 'NEWEST_FIRST',
    segmentIndex: 0,
    entries: [
      {id: 'tx0001', threadId: 'thread-tx0001'},
      {id: 'tx0002', threadId: 'thread-tx0002'},
    ],
  }), 'text/plain');

  const txState = sandbox.newBaseState_(txRoot.getId());
  txState.phase = 'APPLYING';
  txState.account = 'user@example.com';
  txState.plan = {
    id: 'tx-plan',
    folderId: txPlanFolder.getId(),
    remainingFolderId: txRemaining.getId(),
    commitsFolderId: txCommits.getId(),
    workQueueFolderId: txWorkQueue.getId(),
  };
  txState.queue = sandbox.newQueueState_();
  txState.queue.order = 'NEWEST_FIRST';
  txState.queue.total = 2;
  txState.queue.queued = 2;
  txState.queue.segmentIndex = 1;
  txState.queue.completedAt = new Date().toISOString();
  txState.apply = sandbox.newApplyState_();
  txState.apply.total = 2;
  txState.apply.segmentIndex = 0;
  txState.apply.startedAt = new Date().toISOString();

  const originalMerge = sandbox.mergeCommitIntoCatalog_;
  let injected = true;
  sandbox.mergeCommitIntoCatalog_ = function (...args) {
    if (injected) {
      injected = false;
      throw new Error('injected crash after commit');
    }
    return originalMerge.apply(this, args);
  };
  assert.throws(() => sandbox.processApplySlice_(txState, Date.now()), /injected crash/);
  assert(txState.apply.inFlight, 'crash must preserve in-flight range');
  assert.strictEqual(txState.apply.processed, 0);
  const txShardFolder1 = txData.folders.find(f => f.name === 'shard-01');
  const txShardFolder2 = txData.folders.find(f => f.name === 'shard-02');
  assert.strictEqual(listCanonical(txShardFolder1).length, 1);
  assert.strictEqual(listCanonical(txShardFolder2).length, 1);
  const txCommitFolder = txCommits.folders.find(f => f.name === 'segment-00000000');
  assert.strictEqual(txCommitFolder.files.length, 1);

  sandbox.mergeCommitIntoCatalog_ = originalMerge;
  sandbox.processApplySlice_(txState, Date.now());
  assert.strictEqual(txState.phase, 'COMPLETE');
  assert.strictEqual(txState.apply.processed, 2);
  assert.strictEqual(txState.apply.inFlight, null);
  assert.strictEqual(listCanonical(txShardFolder1).length, 1, 'commit replay must not duplicate files');
  assert.strictEqual(listCanonical(txShardFolder2).length, 1, 'mixed-shard commit replay must not duplicate files');
  assert(txCatalog.files.some(file => file.getName() === 'shard-01.json'));
  assert(txCatalog.files.some(file => file.getName() === 'shard-02.json'));

  // Public setup anchors one exact Drive root and is idempotent on rerun.
  // Restore the baseline Gmail mocks after the scan-order fault-injection tests.
  sandbox.Gmail.Users.Messages.list = defaultGmailMessagesList;
  sandbox.Gmail.Users.getProfile = defaultGmailGetProfile;
  scriptProperties.clear();
  projectTriggers.length = 0;
  const setupFirst = sandbox.setupBackup();
  const anchoredState = JSON.parse(scriptProperties.get(sandbox.__BACKUP_CONFIG.STATE_PROPERTY));
  assert.strictEqual(setupFirst.ok, true);
  assert.strictEqual(setupFirst.account, 'user@example.com');
  assert(setupFirst.rawMessagePreflightBytes > 0);
  assert(anchoredState.rootFolderId);
  const setupSecond = sandbox.setupBackup();
  const anchoredStateAgain = JSON.parse(scriptProperties.get(sandbox.__BACKUP_CONFIG.STATE_PROPERTY));
  assert.strictEqual(anchoredStateAgain.rootFolderId, anchoredState.rootFolderId);
  assert.strictEqual(setupSecond.rootFolderUrl, setupFirst.rootFolderUrl);

  // Pause/resume are control-plane mutations and must reject a different
  // authenticated Gmail identity before state, pause flags, or triggers move.
  const anchoredRaw = scriptProperties.get(sandbox.__BACKUP_CONFIG.STATE_PROPERTY);
  const pauseRequestBefore = scriptProperties.get(sandbox.__BACKUP_CONFIG.PAUSE_REQUEST_PROPERTY);
  const triggerIdsBeforeGuard = projectTriggers.map(trigger => trigger.getUniqueId());
  sandbox.Gmail.Users.getProfile = function () {
    return {emailAddress: 'wrong-user@example.com', messagesTotal: 0, threadsTotal: 0, historyId: '999'};
  };
  assert.throws(() => sandbox.pauseBackup(), /anchored to Gmail account user@example.com/);
  assert.strictEqual(scriptProperties.get(sandbox.__BACKUP_CONFIG.STATE_PROPERTY), anchoredRaw);
  assert.strictEqual(
    scriptProperties.get(sandbox.__BACKUP_CONFIG.PAUSE_REQUEST_PROPERTY),
    pauseRequestBefore,
    'wrong-account pause must not write the cooperative pause flag'
  );
  assert.deepStrictEqual(projectTriggers.map(trigger => trigger.getUniqueId()), triggerIdsBeforeGuard);

  const pausedForGuard = JSON.parse(anchoredRaw);
  pausedForGuard.phase = 'PAUSED';
  pausedForGuard.previousPhase = 'SCANNING';
  pausedForGuard.pausedAt = new Date().toISOString();
  const pausedRaw = JSON.stringify(pausedForGuard);
  scriptProperties.set(sandbox.__BACKUP_CONFIG.STATE_PROPERTY, pausedRaw);
  assert.throws(() => sandbox.resumeBackup(), /anchored to Gmail account user@example.com/);
  assert.strictEqual(scriptProperties.get(sandbox.__BACKUP_CONFIG.STATE_PROPERTY), pausedRaw);
  assert.deepStrictEqual(projectTriggers.map(trigger => trigger.getUniqueId()), triggerIdsBeforeGuard);
  scriptProperties.set(sandbox.__BACKUP_CONFIG.STATE_PROPERTY, anchoredRaw);
  sandbox.Gmail.Users.getProfile = defaultGmailGetProfile;

  const statusTextFile = anchoredStateAgain.rootFolderId
    ? foldersById.get(anchoredStateAgain.rootFolderId).files.find(file => file.name === 'STATUS.txt')
    : null;
  const statusWritesBefore = statusTextFile ? statusTextFile.setContentCalls : 0;
  const machineStatus = sandbox.agentStatus();
  assert.strictEqual(machineStatus.exporterVersion, '1.3.0-dev.14');
  assert.strictEqual(
    statusTextFile ? statusTextFile.setContentCalls : 0,
    statusWritesBefore,
    'agentStatus must not mutate Drive status files'
  );

  // Verification falls back to Drive's server-side SHA-256 when DriveApp can
  // read file metadata but is denied access to the blob contents.
  const verifyRoot = root.createFolder('verify-root');
  const verifyData = verifyRoot.createFolder('data');
  const verifyCatalog = verifyRoot.createFolder('catalog');
  verifyRoot.createFolder('plans');
  const verifyMessageId = 'verify-message-1';
  const verifyShard = verifyData.createFolder('shard-' + sandbox.shardForId_(verifyMessageId));
  const verifyBytes = Array.from(Buffer.from('verification payload', 'utf8'));
  const deniedFile = verifyShard.createFile(new MockBlob(verifyBytes, 'message/rfc822', verifyMessageId + '.eml'));
  deniedFile.getBlob = function () { throw new Error('Access denied: DriveApp.'); };
  verifyCatalog.createFile(
    'shard-' + sandbox.shardForId_(verifyMessageId) + '.json',
    JSON.stringify([{
      id: verifyMessageId,
      status: 'exported',
      driveFileId: deniedFile.getId(),
      fileName: deniedFile.getName(),
      rawBytes: verifyBytes.length,
      sha256: sandbox.sha256Hex_(verifyBytes),
    }]),
    'application/json'
  );
  const verifyState = sandbox.newBaseState_(verifyRoot.getId());
  verifyState.phase = 'COMPLETE';
  scriptProperties.set(sandbox.__BACKUP_CONFIG.STATE_PROPERTY, JSON.stringify(verifyState));
  sandbox.ScriptApp.getOAuthToken = () => 'apps-script-token';
  sandbox.UrlFetchApp.fetch = function (url) {
    if (String(url).includes('alt=media')) {
      return {
        getResponseCode() { return 403; },
        getContentText() {
          return JSON.stringify({error: {errors: [{reason: 'downloadRestricted'}], code: 403}});
        },
      };
    }
    return {
      getResponseCode() { return 200; },
      getContentText() {
        return JSON.stringify({
          id: deniedFile.getId(),
          name: deniedFile.getName(),
          size: String(verifyBytes.length),
          mimeType: 'message/rfc822',
          parents: [verifyShard.getId()],
          ownedByMe: true,
          isAppAuthorized: true,
          sha256Checksum: sandbox.sha256Hex_(verifyBytes),
          capabilities: {canDownload: false, canReadRevisions: true, canCopy: false, canEdit: true},
          downloadRestrictions: {
            effectiveDownloadRestrictionWithContext: {restrictedForWriters: true},
          },
        });
      },
    };
  };
  const verifyReport = sandbox.verifyBackupSample(1);
  assert.strictEqual(verifyReport.checked, 1);
  assert.strictEqual(verifyReport.ok, 1);
  assert.strictEqual(verifyReport.integrityVerified, 1);
  assert.strictEqual(verifyReport.failed, 0);
  assert.strictEqual(verifyReport.downloadable, 0);
  assert.strictEqual(verifyReport.downloadRestricted, 1);
  assert.strictEqual(verifyReport.portable, false);
  assert.strictEqual(verifyReport.results[0].contentReadMethod, 'driveApiServerSha256');
  assert.strictEqual(verifyReport.results[0].downloadable, false);
  assert.strictEqual(verifyReport.results[0].fileName, verifyMessageId + '.eml');
  assert.strictEqual(verifyReport.results[0].actualBytes, verifyBytes.length);
  assert.strictEqual(verifyReport.results[0].inExpectedFolder, true);
  assert.strictEqual(verifyReport.results[0].driveApi.metadata.ownedByMe, true);
  assert.strictEqual(verifyReport.results[0].driveApi.metadata.capabilities.canDownload, false);

  const diagnosticReport = sandbox.diagnoseDriveReadAccess();
  assert.strictEqual(diagnosticReport.mode, 'drive-read-diagnostic');
  assert.strictEqual(diagnosticReport.results[0].driveApi.mediaStatus, 403);
  assert.match(diagnosticReport.results[0].driveApi.mediaError, /downloadRestricted/);

  console.log('All Gmail backup tests passed.');
})();
