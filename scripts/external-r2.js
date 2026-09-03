#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');

function parseEnv(text) {
  const result = {};
  String(text || '').split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid .env syntax on line ${index + 1}.`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    result[match[1]] = value;
  });
  return result;
}

function resolveEnvPath(value) {
  const configured = value || process.env.EXTERNAL_ENV || '.env';
  const expanded = configured === '~' || configured.startsWith('~/')
    ? path.join(os.homedir(), configured.slice(2))
    : configured;
  return path.resolve(repositoryRoot, expanded);
}

function loadEnvFile(value) {
  const envPath = resolveEnvPath(value);
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing ${path.relative(repositoryRoot, envPath) || envPath}. Copy .env.example to .env.`);
  }
  const parsed = parseEnv(fs.readFileSync(envPath, 'utf8'));
  Object.keys(parsed).forEach(name => {
    if (process.env[name] === undefined) process.env[name] = parsed[name];
  });
  return envPath;
}

function updateEnvFile(envPath, updates) {
  const existing = fs.readFileSync(envPath, 'utf8');
  const remaining = Object.assign({}, updates);
  const lines = existing.split(/\r?\n/).map(line => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !Object.prototype.hasOwnProperty.call(remaining, match[1])) return line;
    const value = String(remaining[match[1]]);
    delete remaining[match[1]];
    return `${match[1]}=${value}`;
  });
  Object.keys(remaining).sort().forEach(name => lines.push(`${name}=${remaining[name]}`));
  fs.writeFileSync(envPath, lines.join('\n').replace(/\n*$/, '\n'), {mode: 0o600});
  fs.chmodSync(envPath, 0o600);
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required in the selected .env file.`);
  return value;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fingerprint(value) {
  return sha256Hex(Buffer.from(String(value))).slice(0, 16);
}

function base64UrlToBuffer(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}

function recentEmlFiles(directory, maximumAgeMinutes, nowMs) {
  const cutoff = Number(nowMs || Date.now()) - Number(maximumAgeMinutes) * 60_000;
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
  return fs.readdirSync(directory, {withFileTypes: true})
    .filter(entry => entry.isFile() && /\.eml$/i.test(entry.name))
    .map(entry => {
      const absolutePath = path.join(directory, entry.name);
      return {absolutePath, stat: fs.statSync(absolutePath)};
    })
    .filter(file => file.stat.mtimeMs >= cutoff && file.stat.size > 0)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
}

function validateEmlBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('The selected EML is empty.');
  const header = bytes.subarray(0, Math.min(bytes.length, 256 * 1024)).toString('latin1');
  const separator = header.search(/\r?\n\r?\n/);
  const headerBlock = separator >= 0 ? header.slice(0, separator) : header;
  if (!/^(?:From|Date|Message-ID|MIME-Version|Subject):/im.test(headerBlock)) {
    throw new Error('The selected file does not look like an RFC 822 message.');
  }
  return bytes;
}

function selectRecentDownload(envPath) {
  const directory = path.resolve(expandHome(String(process.env.EXTERNAL_DOWNLOAD_DIR || '~/Downloads')));
  const maximumAgeMinutes = Number(process.env.EXTERNAL_DOWNLOAD_MAX_AGE_MINUTES || 30);
  if (!Number.isFinite(maximumAgeMinutes) || maximumAgeMinutes <= 0 || maximumAgeMinutes > 24 * 60) {
    throw new Error('EXTERNAL_DOWNLOAD_MAX_AGE_MINUTES must be between 1 and 1440.');
  }
  const files = recentEmlFiles(directory, maximumAgeMinutes);
  if (files.length !== 1) {
    throw new Error(`Expected exactly one recent .eml download; found ${files.length}. ` +
      'Move unrelated recent EML files aside or reduce EXTERNAL_DOWNLOAD_MAX_AGE_MINUTES.');
  }
  const bytes = validateEmlBytes(fs.readFileSync(files[0].absolutePath));
  updateEnvFile(envPath, {LOCAL_EML_PATH: files[0].absolutePath});
  return {
    selected: true,
    fileFingerprint: fingerprint(files[0].absolutePath),
    rawBytes: bytes.length,
    rawSha256Prefix: sha256Hex(bytes).slice(0, 16),
  };
}

function localEml() {
  const absolutePath = path.resolve(expandHome(required('LOCAL_EML_PATH')));
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch (ignored) {
    throw new Error('LOCAL_EML_PATH does not exist or is not readable.');
  }
  if (!stat.isFile() || !/\.eml$/i.test(absolutePath)) {
    throw new Error('LOCAL_EML_PATH must name a regular .eml file.');
  }
  let bytes;
  try {
    bytes = fs.readFileSync(absolutePath);
  } catch (ignored) {
    throw new Error('LOCAL_EML_PATH could not be read.');
  }
  return {absolutePath, bytes: validateEmlBytes(bytes)};
}

function localCheck() {
  const messageId = required('GMAIL_MESSAGE_ID');
  const selected = localEml();
  const rawSha256 = sha256Hex(selected.bytes);
  return {
    ok: true,
    messageFingerprint: fingerprint(messageId),
    fileFingerprint: fingerprint(selected.absolutePath),
    rawBytes: selected.bytes.length,
    rawSha256Prefix: rawSha256.slice(0, 16),
    encoding: 'RAW_EML',
  };
}

function expandHome(value) {
  const text = String(value || '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function claspCredentials() {
  const authPath = path.resolve(expandHome(required('CLASP_AUTH_FILE')));
  if (!fs.existsSync(authPath)) throw new Error('CLASP_AUTH_FILE does not exist. Run make login-project or correct .env.');
  const document = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const profileName = String(process.env.CLASP_AUTH_PROFILE || 'default');
  const token = document.tokens && document.tokens[profileName];
  if (!token || !token.client_id || !token.client_secret || !token.refresh_token) {
    throw new Error(`The clasp auth profile ${profileName} lacks refreshable OAuth credentials.`);
  }
  return token;
}

async function oauthAccessToken() {
  const token = claspCredentials();
  if (token.access_token && Number(token.expiry_date || 0) > Date.now() + 60_000) return token.access_token;
  const body = new URLSearchParams({
    client_id: token.client_id,
    client_secret: token.client_secret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Google OAuth refresh failed (${response.status}); run make login-project.`);
  }
  return payload.access_token;
}

async function googleFetch(url, options) {
  const accessToken = await oauthAccessToken();
  const response = await fetch(url, Object.assign({}, options || {}, {
    headers: Object.assign({}, (options || {}).headers || {}, {authorization: `Bearer ${accessToken}`}),
  }));
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const first = payload && payload.error && Array.isArray(payload.error.errors)
      ? payload.error.errors[0] : null;
    const rawReason = String((first && first.reason) || (payload.error && payload.error.status) || 'authorization-failed');
    const reason = /^[A-Za-z0-9_.-]{1,80}$/.test(rawReason) ? rawReason : 'authorization-failed';
    throw new Error(`Google API request failed (${response.status}; ${reason}). ` +
      'The current clasp OAuth grant may not be authorized for this resource.');
  }
  return response;
}

function driveQueryUrl(parentId, name) {
  const q = [`'${String(parentId).replace(/'/g, "\\'")}' in parents`, 'trashed = false'];
  if (name) q.push(`name = '${String(name).replace(/'/g, "\\'")}'`);
  const query = new URLSearchParams({
    q: q.join(' and '),
    fields: 'files(id,name,mimeType,size,modifiedTime)',
    pageSize: '100',
    orderBy: 'modifiedTime desc',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  return `https://www.googleapis.com/drive/v3/files?${query}`;
}

async function driveChildren(parentId, name) {
  const response = await googleFetch(driveQueryUrl(parentId, name));
  const payload = await response.json();
  return payload.files || [];
}

async function driveChild(parentId, name, mimeType) {
  const matches = (await driveChildren(parentId, name)).filter(file => !mimeType || file.mimeType === mimeType);
  if (matches.length !== 1) throw new Error(`Expected exactly one Drive child named ${name}; found ${matches.length}.`);
  return matches[0];
}

async function driveJson(fileId) {
  const response = await googleFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
  return response.json();
}

async function gmailMessageMetadata(messageId) {
  const userId = encodeURIComponent(String(process.env.GMAIL_USER_ID || 'me'));
  const fields = 'id,threadId,labelIds,historyId,internalDate,sizeEstimate';
  const url = `https://gmail.googleapis.com/gmail/v1/users/${userId}/messages/${encodeURIComponent(messageId)}` +
    `?format=metadata&fields=${encodeURIComponent(fields)}`;
  return (await googleFetch(url)).json();
}

async function locateBlockedMessage(envPath) {
  const folderMime = 'application/vnd.google-apps.folder';
  const rootId = required('GMAIL_BACKUP_DRIVE_ROOT_ID');
  const statusFile = await driveChild(rootId, 'status.json');
  const status = await driveJson(statusFile.id);
  const inFlight = status && status.apply && status.apply.inFlight;
  if (!status.planId || !inFlight || !Number.isInteger(Number(inFlight.segmentIndex)) ||
      !Number.isInteger(Number(inFlight.start))) {
    throw new Error('status.json does not contain a usable APPLY in-flight checkpoint.');
  }
  const plans = await driveChild(rootId, 'plans', folderMime);
  const plan = await driveChild(plans.id, status.planId, folderMime);
  const queue = await driveChild(plan.id, 'work-queue', folderMime);
  const segmentName = `segment-${String(Number(inFlight.segmentIndex)).padStart(8, '0')}.json`;
  const segmentFile = await driveChild(queue.id, segmentName);
  const segment = await driveJson(segmentFile.id);
  const entry = segment && Array.isArray(segment.entries) ? segment.entries[Number(inFlight.start)] : null;
  if (!entry || !entry.id) throw new Error('The checkpointed queue entry is missing or malformed.');
  const metadata = await gmailMessageMetadata(entry.id);
  if (!metadata || metadata.id !== entry.id) throw new Error('Gmail metadata did not match the checkpointed message.');
  updateEnvFile(envPath, {
    GMAIL_MESSAGE_ID: entry.id,
    GMAIL_MESSAGE_SIZE_ESTIMATE: String(metadata.sizeEstimate || ''),
  });
  return {
    selected: true,
    messageFingerprint: fingerprint(entry.id),
    sizeEstimateBytes: Number(metadata.sizeEstimate || 0),
    checkpoint: {segmentIndex: Number(inFlight.segmentIndex), offset: Number(inFlight.start)},
  };
}

function normalizeKey(value) {
  return String(value || '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

function normalizePrefix(value) {
  const normalized = normalizeKey(value).replace(/\/+$/, '');
  return normalized ? `${normalized}/` : '';
}

function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(value) {
  return String(value || '/').split('/').map(rfc3986).join('/').replace(/^([^/])/, '/$1');
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function signingKey(secret, dateStamp, region) {
  return hmac(hmac(hmac(hmac(Buffer.from(`AWS4${secret}`), dateStamp), region), 's3'), 'aws4_request');
}

function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function s3Profile() {
  const endpoint = new URL(required('R2_ENDPOINT').replace(/\/+$/, ''));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new Error('R2_ENDPOINT must be an HTTPS origin without embedded credentials.');
  }
  const style = String(process.env.R2_ADDRESSING_STYLE || 'PATH').toUpperCase();
  if (!['PATH', 'VIRTUAL'].includes(style)) throw new Error('R2_ADDRESSING_STYLE must be PATH or VIRTUAL.');
  const prefix = normalizePrefix(required('R2_KEY_PREFIX'));
  if (!prefix) throw new Error('R2_KEY_PREFIX must be a non-empty isolated prefix.');
  return {
    endpoint,
    region: String(process.env.R2_REGION || 'auto'),
    bucket: required('R2_BUCKET'),
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    sessionToken: String(process.env.R2_SESSION_TOKEN || ''),
    style,
    prefix,
  };
}

function buildSignedS3Request(profile, operation) {
  const method = String(operation.method || 'GET').toUpperCase();
  const key = normalizeKey(operation.key);
  const body = operation.body ? Buffer.from(operation.body) : Buffer.alloc(0);
  const payloadHash = sha256Hex(body);
  const now = operation.now || new Date();
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const basePath = profile.endpoint.pathname.replace(/\/+$/, '');
  const host = profile.style === 'VIRTUAL' ? `${profile.bucket}.${profile.endpoint.host}` : profile.endpoint.host;
  const objectPath = profile.style === 'VIRTUAL'
    ? `${basePath}/${key}`
    : `${basePath}/${profile.bucket}${key ? `/${key}` : ''}`;
  const uri = canonicalPath(objectPath || '/');
  const headers = {};
  Object.keys(operation.headers || {}).forEach(name => {
    headers[name.toLowerCase()] = String(operation.headers[name]).trim().replace(/\s+/g, ' ');
  });
  headers.host = host;
  headers['x-amz-content-sha256'] = payloadHash;
  headers['x-amz-date'] = amzDate;
  if (profile.sessionToken) headers['x-amz-security-token'] = profile.sessionToken;
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map(name => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = signedNames.join(';');
  const canonicalRequest = [method, uri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${profile.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(Buffer.from(canonicalRequest))].join('\n');
  const signature = hmac(signingKey(profile.secretAccessKey, dateStamp, profile.region), stringToSign).toString('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${profile.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host;
  return {url: `${profile.endpoint.protocol}//${host}${uri}`, method, headers, body: body.length ? body : undefined};
}

async function s3Request(profile, operation) {
  const request = buildSignedS3Request(profile, operation);
  return fetch(request.url, {method: request.method, headers: request.headers, body: request.body, redirect: 'error'});
}

async function headObject(profile, key) {
  const response = await s3Request(profile, {method: 'HEAD', key});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`R2 HEAD failed (${response.status}).`);
  const metadata = {};
  response.headers.forEach((value, name) => {
    const normalized = String(name).toLowerCase();
    if (normalized.startsWith('x-amz-meta-')) metadata[normalized.slice(11)] = value;
  });
  return {
    bytes: Number(response.headers.get('content-length') || 0),
    rawSha256: response.headers.get('x-amz-meta-raw-sha256') || '',
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    etag: response.headers.get('etag') || '',
    metadata,
  };
}

async function getObject(profile, key) {
  const response = await s3Request(profile, {
    method: 'GET', key, headers: {'accept-encoding': 'identity'},
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`R2 GET failed (${response.status}).`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
}

async function readJsonObject(profile, key, label) {
  const object = await getObject(profile, key);
  if (!object) throw new Error(`${label || 'JSON object'} was not found in R2.`);
  if (object.bytes.length > 16 * 1024 * 1024) {
    throw new Error(`${label || 'JSON object'} exceeds the bounded 16 MiB reader limit.`);
  }
  try {
    return JSON.parse(object.bytes.toString('utf8'));
  } catch (ignored) {
    throw new Error(`${label || 'JSON object'} is not valid JSON.`);
  }
}

function safeS3ChildName(value, label) {
  const text = String(value || '');
  if (!text || text === '.' || text === '..' || /[\\/\u0000-\u001f]/.test(text)) {
    throw new Error(`${label || 'S3 path component'} must be one non-empty path component.`);
  }
  return text;
}

function archiveRootPrefix(profile, rootName) {
  return `${profile.prefix}${safeS3ChildName(rootName, 'R2_ARCHIVE_ROOT_NAME')}/`;
}

function messageShard(messageId, shardCount) {
  const normalized = String(messageId || '').toLowerCase();
  if (!normalized) throw new Error('Cannot shard an empty Gmail message ID.');
  const tail = normalized.slice(-2).padStart(2, '0');
  let value;
  if (/^[0-9a-f]{2}$/.test(tail)) {
    value = parseInt(tail, 16);
  } else {
    value = 0;
    for (let index = 0; index < normalized.length; index++) {
      value = ((value * 31) + normalized.charCodeAt(index)) & 0xff;
    }
  }
  const count = Number(shardCount || 64);
  if (!Number.isInteger(count) || count < 1 || count > 256) {
    throw new Error('Archive shard count must be an integer between 1 and 256.');
  }
  return (value % count).toString(16).padStart(2, '0');
}

function applyCommitFileName(start, endExclusive) {
  return `${String(Number(start)).padStart(8, '0')}-${String(Number(endExclusive)).padStart(8, '0')}.json`;
}

function parseAppsScriptArchiveMarker(encoded) {
  const value = String(encoded || '');
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('Canonical R2 object lacks valid Apps Script integrity metadata.');
  }
  const description = Buffer.from(value, 'base64').toString('utf8');
  const prefix = 'GMAIL_BACKUP_ARCHIVE_V1 ';
  if (!description.startsWith(prefix)) {
    throw new Error('Canonical R2 object has an unsupported integrity marker.');
  }
  let marker;
  try {
    marker = JSON.parse(description.slice(prefix.length));
  } catch (ignored) {
    throw new Error('Canonical R2 object integrity metadata is not valid JSON.');
  }
  const rawBytes = Number(marker && marker.gbRawBytes);
  const rawSha256 = String(marker && marker.gbRawSha256 || '').toLowerCase();
  if (!marker || marker.gbSchema !== '1' || String(marker.gbEncoding || '').toUpperCase() !== 'EML' ||
      !Number.isInteger(rawBytes) || rawBytes <= 0 || !/^[0-9a-f]{64}$/.test(rawSha256)) {
    throw new Error('Canonical R2 object integrity metadata is incomplete or incompatible.');
  }
  return {archiveEncoding: 'EML', rawBytes, rawSha256};
}

function validatePausedSingleMessageCheckpoint(status) {
  const inFlight = status && status.apply && status.apply.inFlight;
  const segmentIndex = Number(inFlight && inFlight.segmentIndex);
  const start = Number(inFlight && inFlight.start);
  const endExclusive = Number(inFlight && inFlight.endExclusive);
  if (!status || status.phase !== 'PAUSED' || status.effectivePhase !== 'APPLYING') {
    throw new Error('R2 status must show a checkpoint-safe PAUSED APPLY before external repair.');
  }
  if (!status.planId || !Number.isInteger(segmentIndex) || segmentIndex < 0 ||
      !Number.isInteger(start) || start < 0 || endExclusive !== start + 1 ||
      Number(status.apply.segmentIndex) !== segmentIndex || Number(status.apply.offset) !== start) {
    throw new Error('R2 status does not contain an exact one-message APPLY checkpoint.');
  }
  return {
    planId: safeS3ChildName(status.planId, 'plan ID'),
    segmentIndex,
    start,
    endExclusive,
  };
}

function buildExternalRepairCommit(context, integrity, now) {
  const timestamp = (now || new Date()).toISOString();
  const record = {
    id: context.entry.id,
    threadId: context.entry.threadId || '',
    archiveShard: context.archiveShard,
    queueSegment: context.checkpoint.segmentIndex,
    status: 'exported',
    labelIds: [],
    historyId: '',
    internalDate: '',
    sizeEstimate: integrity.rawBytes,
    archiveEncoding: 'EML',
    rawBytes: integrity.rawBytes,
    sha256: integrity.rawSha256,
    storedBytes: integrity.rawBytes,
    storedSha256: integrity.rawSha256,
    fileName: `${context.entry.id}.eml`,
    innerFileName: null,
    mimeType: 'message/rfc822',
    storageFileId: context.canonicalKey,
    foundExisting: true,
    recoveredExisting: true,
    replacedConflict: false,
    quarantinedExistingFiles: 0,
    exportedAt: timestamp,
  };
  return {
    schemaVersion: 2,
    planId: context.checkpoint.planId,
    queueSegment: context.checkpoint.segmentIndex,
    start: context.checkpoint.start,
    endExclusive: context.checkpoint.endExclusive,
    createdAt: timestamp,
    durationMs: 1,
    finishedAt: timestamp,
    summary: {
      processed: 1,
      exported: 1,
      gone: 0,
      rawBytes: integrity.rawBytes,
      storedBytes: integrity.rawBytes,
    },
    records: [record],
  };
}

function validateExternalRepairCommit(commit, context, integrity) {
  const record = commit && Array.isArray(commit.records) && commit.records[0];
  const summary = commit && commit.summary;
  if (!commit || Number(commit.schemaVersion) !== 2 ||
      commit.planId !== context.checkpoint.planId ||
      Number(commit.queueSegment) !== context.checkpoint.segmentIndex ||
      Number(commit.start) !== context.checkpoint.start ||
      Number(commit.endExclusive) !== context.checkpoint.endExclusive ||
      !record || commit.records.length !== 1 || record.id !== context.entry.id ||
      record.status !== 'exported' || record.archiveEncoding !== 'EML' ||
      record.archiveShard !== context.archiveShard || record.fileName !== `${context.entry.id}.eml` ||
      record.storageFileId !== context.canonicalKey || Number(record.rawBytes) !== integrity.rawBytes ||
      Number(record.storedBytes) !== integrity.rawBytes || record.sha256 !== integrity.rawSha256 ||
      record.storedSha256 !== integrity.rawSha256 || !summary ||
      Number(summary.processed) !== 1 || Number(summary.exported) !== 1 ||
      Number(summary.gone) !== 0 || Number(summary.rawBytes) !== integrity.rawBytes ||
      Number(summary.storedBytes) !== integrity.rawBytes) {
    throw new Error('Existing APPLY commit does not match the paused queue entry and canonical R2 object.');
  }
  return commit;
}

async function blockedS3Context(profile) {
  const rootPrefix = archiveRootPrefix(profile, required('R2_ARCHIVE_ROOT_NAME'));
  const status = await readJsonObject(profile, `${rootPrefix}status.json`, 'R2 status.json');
  const checkpoint = validatePausedSingleMessageCheckpoint(status);
  const segmentName = `segment-${String(checkpoint.segmentIndex).padStart(8, '0')}.json`;
  const segmentKey = `${rootPrefix}plans/${checkpoint.planId}/work-queue/${segmentName}`;
  const segment = await readJsonObject(profile, segmentKey, 'immutable work-queue segment');
  const entry = segment && Array.isArray(segment.entries) ? segment.entries[checkpoint.start] : null;
  if (!segment || segment.planId !== checkpoint.planId ||
      Number(segment.segmentIndex) !== checkpoint.segmentIndex || !entry || !entry.id) {
    throw new Error('Immutable work-queue segment does not match the paused APPLY checkpoint.');
  }
  const messageId = safeS3ChildName(entry.id, 'Gmail message ID');
  const archiveShard = messageShard(messageId, 64);
  const canonicalKey = `${rootPrefix}data/shard-${archiveShard}/${messageId}.eml`;
  const commitKey = `${rootPrefix}plans/${checkpoint.planId}/commits/segment-${String(checkpoint.segmentIndex).padStart(8, '0')}/` +
    applyCommitFileName(checkpoint.start, checkpoint.endExclusive);
  return {status, checkpoint, entry, archiveShard, canonicalKey, commitKey};
}

async function validateCanonicalR2Object(profile, context) {
  const head = await headObject(profile, context.canonicalKey);
  if (!head) return null;
  if (!/^message\/rfc822(?:\s*;|$)/i.test(head.contentType)) {
    throw new Error('Canonical R2 object has an unexpected content type.');
  }
  const integrity = parseAppsScriptArchiveMarker(head.metadata['gb-description-b64']);
  const object = await getObject(profile, context.canonicalKey);
  if (!object || object.bytes.length !== head.bytes || object.bytes.length !== integrity.rawBytes) {
    throw new Error('Canonical R2 object byte length does not match its integrity metadata.');
  }
  const actualSha256 = sha256Hex(object.bytes);
  if (actualSha256 !== integrity.rawSha256) {
    throw new Error('Canonical R2 object SHA-256 does not match its integrity metadata.');
  }
  return integrity;
}

async function inspectBlockedS3() {
  const profile = s3Profile();
  const context = await blockedS3Context(profile);
  const integrity = await validateCanonicalR2Object(profile, context);
  const commitExists = Boolean(await headObject(profile, context.commitKey));
  return {
    ok: true,
    phase: context.status.phase,
    checkpoint: {
      segmentIndex: context.checkpoint.segmentIndex,
      start: context.checkpoint.start,
      endExclusive: context.checkpoint.endExclusive,
    },
    messageFingerprint: fingerprint(context.entry.id),
    canonicalObjectPresent: Boolean(integrity),
    canonicalObjectValid: Boolean(integrity),
    rawBytes: integrity ? integrity.rawBytes : null,
    rawSha256Prefix: integrity ? integrity.rawSha256.slice(0, 16) : null,
    commitPresent: commitExists,
  };
}

async function selectBlockedS3(envPath) {
  const profile = s3Profile();
  const context = await blockedS3Context(profile);
  updateEnvFile(envPath, {GMAIL_MESSAGE_ID: context.entry.id});
  return {
    selected: true,
    checkpoint: {
      segmentIndex: context.checkpoint.segmentIndex,
      start: context.checkpoint.start,
      endExclusive: context.checkpoint.endExclusive,
    },
    messageFingerprint: fingerprint(context.entry.id),
  };
}

function appsScriptArchiveMarker(rawBytes, rawSha256) {
  const description = 'GMAIL_BACKUP_ARCHIVE_V1 ' + JSON.stringify({
    gbSchema: '1',
    gbEncoding: 'EML',
    gbRawBytes: String(rawBytes),
    gbRawSha256: String(rawSha256),
  });
  return Buffer.from(description, 'utf8').toString('base64');
}

async function publishExternalRepairCommit(profile, context, integrity) {
  const expectedCommit = buildExternalRepairCommit(context, integrity);
  const existing = await headObject(profile, context.commitKey);
  let created = false;
  if (existing) {
    validateExternalRepairCommit(
      await readJsonObject(profile, context.commitKey, 'existing APPLY commit'), context, integrity
    );
  } else {
    const bytes = Buffer.from(JSON.stringify(expectedCommit), 'utf8');
    const response = await s3Request(profile, {
      method: 'PUT', key: context.commitKey, body: bytes,
      headers: {'content-type': 'text/plain', 'if-none-match': '*'},
    });
    if (![200, 201, 204, 412].includes(response.status)) {
      throw new Error(`R2 conditional commit PUT failed (${response.status}).`);
    }
    created = response.status !== 412;
    validateExternalRepairCommit(
      await readJsonObject(profile, context.commitKey, 'published APPLY commit'), context, integrity
    );
  }
  return {created, replayed: !created};
}

async function repairBlockedS3() {
  if (String(process.env.CONFIRM || '') !== 'external-repair-s3-blocked') {
    throw new Error('Refusing R2 commit write. Re-run with CONFIRM=external-repair-s3-blocked.');
  }
  const profile = s3Profile();
  const context = await blockedS3Context(profile);
  const integrity = await validateCanonicalR2Object(profile, context);
  if (!integrity) {
    throw new Error('The paused message has no canonical R2 object to recover; no commit was written.');
  }
  const published = await publishExternalRepairCommit(profile, context, integrity);
  return {
    ok: true,
    checkpoint: {
      segmentIndex: context.checkpoint.segmentIndex,
      start: context.checkpoint.start,
      endExclusive: context.checkpoint.endExclusive,
    },
    messageFingerprint: fingerprint(context.entry.id),
    objectFingerprint: fingerprint(context.canonicalKey),
    commitFingerprint: fingerprint(context.commitKey),
    rawBytes: integrity.rawBytes,
    rawSha256Prefix: integrity.rawSha256.slice(0, 16),
    created: published.created,
    replayed: published.replayed,
  };
}

async function importBlockedS3() {
  if (String(process.env.CONFIRM || '') !== 'external-import-s3-blocked') {
    throw new Error('Refusing canonical R2 import. Re-run with CONFIRM=external-import-s3-blocked.');
  }
  const profile = s3Profile();
  const context = await blockedS3Context(profile);
  if (required('GMAIL_MESSAGE_ID') !== context.entry.id) {
    throw new Error('Selected Gmail message does not match the current paused queue entry.');
  }
  const selected = localEml();
  const rawSha256 = sha256Hex(selected.bytes);
  const expectedIntegrity = {
    archiveEncoding: 'EML', rawBytes: selected.bytes.length, rawSha256,
  };
  let canonicalCreated = false;
  const existing = await headObject(profile, context.canonicalKey);
  if (!existing) {
    const response = await s3Request(profile, {
      method: 'PUT', key: context.canonicalKey, body: selected.bytes,
      headers: {
        'content-type': 'message/rfc822',
        'if-none-match': '*',
        'x-amz-meta-gb-description-b64': appsScriptArchiveMarker(selected.bytes.length, rawSha256),
      },
    });
    if (![200, 201, 204, 412].includes(response.status)) {
      throw new Error(`R2 conditional canonical PUT failed (${response.status}).`);
    }
    canonicalCreated = response.status !== 412;
  }
  const actualIntegrity = await validateCanonicalR2Object(profile, context);
  if (!actualIntegrity || actualIntegrity.rawBytes !== expectedIntegrity.rawBytes ||
      actualIntegrity.rawSha256 !== expectedIntegrity.rawSha256) {
    throw new Error('Canonical R2 object does not match the selected local EML; refusing to publish a commit.');
  }
  const published = await publishExternalRepairCommit(profile, context, actualIntegrity);
  return {
    ok: true,
    checkpoint: {
      segmentIndex: context.checkpoint.segmentIndex,
      start: context.checkpoint.start,
      endExclusive: context.checkpoint.endExclusive,
    },
    messageFingerprint: fingerprint(context.entry.id),
    fileFingerprint: fingerprint(selected.absolutePath),
    objectFingerprint: fingerprint(context.canonicalKey),
    commitFingerprint: fingerprint(context.commitKey),
    rawBytes: actualIntegrity.rawBytes,
    rawSha256Prefix: actualIntegrity.rawSha256.slice(0, 16),
    canonicalCreated,
    canonicalReplayed: !canonicalCreated,
    commitCreated: published.created,
    commitReplayed: published.replayed,
  };
}

async function putVerifiedObject(profile, key, bytes, rawSha256) {
  const existing = await headObject(profile, key);
  if (existing) {
    if (existing.bytes !== bytes.length || existing.rawSha256 !== rawSha256) {
      throw new Error('The target object already exists with different integrity metadata; refusing to overwrite it.');
    }
    return {created: false, replayed: true};
  }
  const response = await s3Request(profile, {
    method: 'PUT', key, body: bytes,
    headers: {'content-type': 'message/rfc822', 'if-none-match': '*', 'x-amz-meta-raw-sha256': rawSha256},
  });
  if (!response.ok) {
    throw new Error(`R2 conditional PUT failed (${response.status}).`);
  }
  const verified = await headObject(profile, key);
  if (!verified || verified.bytes !== bytes.length || verified.rawSha256 !== rawSha256) {
    throw new Error('R2 read-after-write verification did not match byte length and raw SHA-256.');
  }
  return {created: true, replayed: false};
}

async function fetchRawMessage(messageId) {
  const userId = encodeURIComponent(String(process.env.GMAIL_USER_ID || 'me'));
  const fields = 'id,threadId,labelIds,historyId,internalDate,sizeEstimate,raw';
  const url = `https://gmail.googleapis.com/gmail/v1/users/${userId}/messages/${encodeURIComponent(messageId)}` +
    `?format=raw&fields=${encodeURIComponent(fields)}`;
  const message = await (await googleFetch(url)).json();
  if (!message || message.id !== messageId || !message.raw) {
    throw new Error('Gmail RAW response was missing or did not match the selected message.');
  }
  return {message, bytes: base64UrlToBuffer(message.raw)};
}

async function fetchCheck() {
  const messageId = required('GMAIL_MESSAGE_ID');
  const fetched = await fetchRawMessage(messageId);
  const rawSha256 = sha256Hex(fetched.bytes);
  return {
    ok: true,
    messageFingerprint: fingerprint(messageId),
    rawBytes: fetched.bytes.length,
    sizeEstimateBytes: Number(fetched.message.sizeEstimate || 0),
    rawSha256Prefix: rawSha256.slice(0, 16),
    encoding: 'RAW_EML',
  };
}

async function exportOne() {
  if (String(process.env.CONFIRM || '') !== 'external-export-one') {
    throw new Error('Refusing R2 write. Re-run with CONFIRM=external-export-one.');
  }
  const messageId = required('GMAIL_MESSAGE_ID');
  const profile = s3Profile();
  const fetched = await fetchRawMessage(messageId);
  const rawSha256 = sha256Hex(fetched.bytes);
  const key = `${profile.prefix}oversize/${messageId}.eml`;
  const result = await putVerifiedObject(profile, key, fetched.bytes, rawSha256);
  return {
    ok: true,
    messageFingerprint: fingerprint(messageId),
    objectFingerprint: fingerprint(key),
    rawBytes: fetched.bytes.length,
    rawSha256Prefix: rawSha256.slice(0, 16),
    encoding: 'RAW_EML',
    created: result.created,
    replayed: result.replayed,
  };
}

async function uploadLocal() {
  if (String(process.env.CONFIRM || '') !== 'external-upload-local') {
    throw new Error('Refusing R2 write. Re-run with CONFIRM=external-upload-local.');
  }
  const messageId = required('GMAIL_MESSAGE_ID');
  const profile = s3Profile();
  const selected = localEml();
  const rawSha256 = sha256Hex(selected.bytes);
  const key = `${profile.prefix}oversize/${messageId}.eml`;
  const result = await putVerifiedObject(profile, key, selected.bytes, rawSha256);
  return {
    ok: true,
    messageFingerprint: fingerprint(messageId),
    objectFingerprint: fingerprint(key),
    rawBytes: selected.bytes.length,
    rawSha256Prefix: rawSha256.slice(0, 16),
    encoding: 'RAW_EML',
    created: result.created,
    replayed: result.replayed,
  };
}

async function probeR2() {
  if (String(process.env.CONFIRM || '') !== 'external-r2-probe') {
    throw new Error('Refusing R2 capability writes. Re-run with CONFIRM=external-r2-probe.');
  }
  const profile = s3Profile();
  const payload = crypto.randomBytes(32);
  const digest = sha256Hex(payload);
  const key = `${profile.prefix}__probe__/${crypto.randomUUID()}.bin`;
  const put = await s3Request(profile, {
    method: 'PUT', key, body: payload,
    headers: {'if-none-match': '*', 'x-amz-meta-raw-sha256': digest},
  });
  if (!put.ok) throw new Error(`R2 probe PUT failed (${put.status}); the credential needs Object Write.`);
  try {
    const head = await headObject(profile, key);
    if (!head || head.bytes !== payload.length || head.rawSha256 !== digest) {
      throw new Error('R2 probe HEAD integrity check failed.');
    }
    const get = await s3Request(profile, {method: 'GET', key});
    if (!get.ok || !Buffer.from(await get.arrayBuffer()).equals(payload)) {
      throw new Error(`R2 probe GET failed (${get.status}).`);
    }
  } finally {
    const deletion = await s3Request(profile, {method: 'DELETE', key});
    if (!deletion.ok && deletion.status !== 404) throw new Error(`R2 probe cleanup failed (${deletion.status}).`);
  }
  return {ok: true, conditionalCreate: true, head: true, get: true, cleanup: true};
}

function configStatus() {
  const auth = (() => { try { claspCredentials(); return true; } catch (ignored) { return false; } })();
  const r2Names = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_KEY_PREFIX'];
  return {
    claspAuthReady: auth,
    driveRootConfigured: Boolean(process.env.GMAIL_BACKUP_DRIVE_ROOT_ID),
    messageSelected: Boolean(process.env.GMAIL_MESSAGE_ID),
    localEmlSelected: Boolean(process.env.LOCAL_EML_PATH),
    r2Ready: r2Names.every(name => Boolean(process.env[name])),
    missingR2Fields: r2Names.filter(name => !process.env[name]),
  };
}

function selfTest() {
  const parsed = parseEnv('A=one\nB="two words"\n# comment\nexport C=three\n');
  if (parsed.A !== 'one' || parsed.B !== 'two words' || parsed.C !== 'three') throw new Error('env parser failed');
  if (base64UrlToBuffer('aGVsbG8').toString() !== 'hello') throw new Error('base64url decoding failed');
  if (normalizePrefix('/a//b/') !== 'a/b/') throw new Error('prefix normalization failed');
  if (canonicalPath('/bucket/a b!*') !== '/bucket/a%20b%21%2A') throw new Error('canonical path encoding failed');
  return {ok: true};
}

async function main() {
  const command = process.argv[2] || 'config-check';
  if (command === 'self-test') {
    process.stdout.write(`${JSON.stringify(selfTest())}\n`);
    return;
  }
  const envPath = loadEnvFile();
  let result;
  if (command === 'config-check') result = configStatus();
  else if (command === 'locate-blocked') result = await locateBlockedMessage(envPath);
  else if (command === 'select-download') result = selectRecentDownload(envPath);
  else if (command === 'local-check') result = localCheck();
  else if (command === 'fetch-check') result = await fetchCheck();
  else if (command === 'inspect-s3-blocked') result = await inspectBlockedS3();
  else if (command === 'select-s3-blocked') result = await selectBlockedS3(envPath);
  else if (command === 'repair-s3-blocked') result = await repairBlockedS3();
  else if (command === 'import-s3-blocked') result = await importBlockedS3();
  else if (command === 'probe-r2') result = await probeR2();
  else if (command === 'export-one') result = await exportOne();
  else if (command === 'upload-local') result = await uploadLocal();
  else throw new Error(`Unknown external R2 command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    const safeMessage = String(error && error.message || 'Unknown failure')
      .replace(/https?:\/\/\S+/g, '[redacted-url]')
      .replace(/\/(?:Users|private)\/\S+/g, '[redacted-local-path]');
    process.stderr.write(`ERROR: ${safeMessage}\n`);
    process.exit(1);
  });
}

module.exports = {
  base64UrlToBuffer,
  buildSignedS3Request,
  buildExternalRepairCommit,
  appsScriptArchiveMarker,
  canonicalPath,
  fingerprint,
  applyCommitFileName,
  archiveRootPrefix,
  messageShard,
  normalizePrefix,
  parseAppsScriptArchiveMarker,
  parseEnv,
  recentEmlFiles,
  selfTest,
  updateEnvFile,
  validateExternalRepairCommit,
  validatePausedSingleMessageCheckpoint,
  validateEmlBytes,
};
