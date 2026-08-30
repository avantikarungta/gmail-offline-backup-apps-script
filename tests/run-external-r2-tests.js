#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tool = require('../scripts/external-r2');

assert.deepStrictEqual(tool.selfTest(), {ok: true});
assert.deepStrictEqual(tool.parseEnv('A=1\nB="two words"\nexport C=3\n'), {
  A: '1', B: 'two words', C: '3',
});
const syntheticEml = Buffer.from('From: sender@example.invalid\r\n\r\nbody');
assert.strictEqual(tool.validateEmlBytes(syntheticEml).length, syntheticEml.length);
assert.throws(() => tool.validateEmlBytes(Buffer.from('not an email')), /RFC 822/);
assert.throws(() => tool.parseEnv('not valid'), /line 1/);
assert.strictEqual(tool.base64UrlToBuffer('AAECA_7_').toString('hex'), '00010203feff');
assert.strictEqual(tool.fingerprint('message-id').length, 16);

const profile = {
  endpoint: new URL('https://account.r2.cloudflarestorage.com'),
  region: 'auto',
  bucket: 'bucket-name',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  sessionToken: '',
  style: 'PATH',
};
const signed = tool.buildSignedS3Request(profile, {
  method: 'PUT',
  key: 'prefix/a b.eml',
  body: Buffer.from('hello'),
  headers: {'content-type': 'message/rfc822', 'if-none-match': '*'},
  now: new Date('2026-08-30T12:34:56.000Z'),
});
assert.strictEqual(signed.url, 'https://account.r2.cloudflarestorage.com/bucket-name/prefix/a%20b.eml');
assert.match(signed.headers.authorization,
  /^AWS4-HMAC-SHA256 Credential=test-access-key\/20260830\/auto\/s3\/aws4_request,/);
assert.strictEqual(signed.headers['x-amz-content-sha256'],
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
assert.ok(!signed.headers.authorization.includes('test-secret-key'));

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-backup-env-test-'));
try {
  const envPath = path.join(temporary, '.env');
  fs.writeFileSync(envPath, 'A=old\nB=keep\n', {mode: 0o600});
  tool.updateEnvFile(envPath, {A: 'new', C: 'added'});
  assert.deepStrictEqual(tool.parseEnv(fs.readFileSync(envPath, 'utf8')), {
    A: 'new', B: 'keep', C: 'added',
  });
  assert.strictEqual(fs.statSync(envPath).mode & 0o777, 0o600);

  const downloadDirectory = path.join(temporary, 'downloads');
  fs.mkdirSync(downloadDirectory);
  const emlPath = path.join(downloadDirectory, 'synthetic.eml');
  fs.writeFileSync(emlPath, 'Message-ID: <synthetic@example.invalid>\r\n\r\nbody');
  const recent = tool.recentEmlFiles(downloadDirectory, 30, Date.now());
  assert.strictEqual(recent.length, 1);
  assert.strictEqual(recent[0].absolutePath, emlPath);
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}

process.stdout.write('All external R2 bridge tests passed.\n');
