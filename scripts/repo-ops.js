#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const command = process.argv[2] || '';

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  try {
    return JSON.parse(read(relativePath));
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

function isScriptId(value) {
  return /^[A-Za-z0-9_-]{20,}$/.test(String(value || '')) && value !== 'YOUR_SCRIPT_ID';
}

function claspProjectPath() {
  return path.resolve(root, process.env.CLASP_PROJECT || '.clasp.json');
}

function expectedGsFiles() {
  return fs.readdirSync(root)
    .filter(name => /^\d{2}_[A-Za-z0-9_-]+\.gs$/.test(name))
    .sort();
}

function validatePushOrder(config, sourceName) {
  const order = config.filePushOrder || [];
  if (!Array.isArray(order) || new Set(order).size !== order.length) {
    fail(`${sourceName}.filePushOrder must be a duplicate-free array.`);
  }
  const actual = order.filter(name => name.endsWith('.gs'));
  const expected = expectedGsFiles();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${sourceName}.filePushOrder does not match the numbered .gs modules.\nExpected: ${expected.join(', ')}\nActual:   ${actual.join(', ')}`);
  }
}

function configure() {
  const scriptId = String(process.env.SCRIPT_ID || '').trim();
  if (!isScriptId(scriptId)) {
    fail('SCRIPT_ID must be the Apps Script project ID (at least 20 URL-safe characters).');
  }
  const target = claspProjectPath();
  const template = readJson('.clasp.example.json');
  validatePushOrder(template, '.clasp.example.json');
  template.scriptId = scriptId;

  if (fs.existsSync(target)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      fail(`${path.relative(root, target)} is invalid JSON: ${error.message}`);
    }
    if (existing.scriptId === scriptId) {
      const refreshed = Object.assign({}, existing, template);
      if (JSON.stringify(existing) === JSON.stringify(refreshed)) {
        process.stdout.write(`${path.relative(root, target)} is already bound to ${scriptId}.\n`);
        return;
      }
      fs.writeFileSync(target, `${JSON.stringify(refreshed, null, 2)}\n`, {mode: 0o600});
      process.stdout.write(`Refreshed ${path.relative(root, target)} for ${scriptId} using the current module order.\n`);
      return;
    }
    if (process.env.FORCE !== '1') {
      fail(`${path.relative(root, target)} is bound to a different script. Re-run with FORCE=1 only after verifying the target.`);
    }
  }
  fs.writeFileSync(target, `${JSON.stringify(template, null, 2)}\n`, {mode: 0o600});
  process.stdout.write(`Configured ${path.relative(root, target)} for ${scriptId}.\n`);
}

function configCheck() {
  const target = claspProjectPath();
  if (!fs.existsSync(target)) {
    fail(`${path.relative(root, target)} is missing. Run make configure SCRIPT_ID=...`);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    fail(`${path.relative(root, target)} is invalid JSON: ${error.message}`);
  }
  if (!isScriptId(config.scriptId)) fail(`${path.relative(root, target)} contains a placeholder or invalid scriptId.`);
  if (config.rootDir !== '') fail(`${path.relative(root, target)}.rootDir must remain an empty string.`);
  validatePushOrder(config, path.relative(root, target));
  process.stdout.write(`clasp binding OK: ${config.scriptId}\n`);
}

function validateMetadata() {
  const packageJson = readJson('package.json');
  readJson('appsscript.json');
  const template = readJson('.clasp.example.json');
  validatePushOrder(template, '.clasp.example.json');

  const version = read('VERSION').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`VERSION is invalid: ${version}`);
  if (packageJson.version !== version) fail(`package.json version ${packageJson.version} != VERSION ${version}`);

  const configMatch = read('00_ConfigRuntime.gs').match(/VERSION:\s*'([^']+)'/);
  if (!configMatch || configMatch[1] !== version) fail('BACKUP_CONFIG.VERSION does not match VERSION.');
  if (!read('README.md').includes(`**Release:** ${version}`)) fail('README release does not match VERSION.');
  if (!read('QUICKSTART.md').includes(`Gmail Offline Backup ${version}`)) fail('QUICKSTART release does not match VERSION.');
  if (!read('RELEASE_VALIDATION.md').includes(`Release Validation — ${version}`)) fail('RELEASE_VALIDATION release does not match VERSION.');
  if (!read('CHANGELOG.md').includes(`## ${version} — staging`)) fail('CHANGELOG staging heading does not match VERSION.');

  const claspIgnore = read('.claspignore');
  if (!/^\*\*\s*$/m.test(claspIgnore) || !/^!appsscript\.json\s*$/m.test(claspIgnore) || !/^!\*\.gs\s*$/m.test(claspIgnore)) {
    fail('.claspignore must allow only appsscript.json and root .gs files.');
  }
  process.stdout.write(`Repository metadata OK for ${version}.\n`);
}

function validateSkill() {
  const skillRoot = path.join(root, '.agents', 'skills', 'operate-gmail-backup');
  const skillPath = path.join(skillRoot, 'SKILL.md');
  if (!fs.existsSync(skillPath)) fail('Repo-local skill is missing.');
  const content = fs.readFileSync(skillPath, 'utf8');
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) fail('SKILL.md is missing YAML frontmatter.');
  if (!/^name:\s*operate-gmail-backup\s*$/m.test(frontmatter[1])) fail('SKILL.md name must match its directory.');
  if (!/^description:\s*.+$/m.test(frontmatter[1])) fail('SKILL.md requires a description.');
  if (/TODO|REPLACE_ME|placeholder/i.test(content)) fail('SKILL.md contains unfinished scaffold text.');

  const references = ['operations.md', 'development.md', 'storage-backends.md'];
  references.forEach(name => {
    const relative = `references/${name}`;
    if (!fs.existsSync(path.join(skillRoot, relative))) fail(`Skill reference is missing: ${relative}`);
    if (!content.includes(`(${relative})`)) fail(`SKILL.md does not route to ${relative}.`);
  });

  const metadata = path.join(skillRoot, 'agents', 'openai.yaml');
  if (!fs.existsSync(metadata)) fail('Skill UI metadata is missing.');
  const yaml = fs.readFileSync(metadata, 'utf8');
  if (!yaml.includes('$operate-gmail-backup')) fail('Skill default_prompt must mention $operate-gmail-backup.');
  process.stdout.write('Repo-local skill structure OK.\n');
}

function shouldSkip(relativePath, directory) {
  const parts = relativePath.split(path.sep);
  const first = parts[0];
  if (directory && ['.git', '.vscode', '.credentials', 'credentials', 'node_modules', 'dist'].includes(first)) return true;
  if (directory && /^\.clasp-live-compare\./.test(first)) return true;
  if (!directory && ['.clasp.json', '.clasprc.json', '.env', '.DS_Store'].includes(relativePath)) return true;
  if (!directory && /^\.env\./.test(relativePath) && relativePath !== '.env.example') return true;
  if (!directory && /^credentials.*\.json$/i.test(relativePath)) return true;
  return false;
}

function releaseFiles(includeChecksum) {
  const files = [];
  function walk(relativeDir) {
    const absoluteDir = path.join(root, relativeDir);
    fs.readdirSync(absoluteDir, {withFileTypes: true}).forEach(entry => {
      const relative = path.join(relativeDir, entry.name);
      if (shouldSkip(relative, entry.isDirectory())) return;
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile()) files.push(relative.split(path.sep).join('/'));
    });
  }
  walk('');
  return files
    .filter(name => includeChecksum || name !== 'SHA256SUMS.txt')
    .sort();
}

function sha256(relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');
}

function checksumsWrite() {
  const lines = releaseFiles(false).map(name => `${sha256(name)}  ./${name}`);
  fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  process.stdout.write(`Wrote ${lines.length} checksums.\n`);
}

function checksumsVerify() {
  const manifestPath = path.join(root, 'SHA256SUMS.txt');
  if (!fs.existsSync(manifestPath)) fail('SHA256SUMS.txt is missing.');
  const entries = read('SHA256SUMS.txt').trim().split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^([a-f0-9]{64})  \.\/(.+)$/.exec(line);
    if (!match) fail(`Invalid checksum line: ${line}`);
    return {hash: match[1], name: match[2]};
  });
  const names = entries.map(entry => entry.name);
  const expectedNames = releaseFiles(false);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    fail('SHA256SUMS.txt file list is stale. Run make checksums.');
  }
  entries.forEach(entry => {
    if (sha256(entry.name) !== entry.hash) fail(`Checksum mismatch: ${entry.name}`);
  });
  process.stdout.write(`Verified ${entries.length} checksums.\n`);
}

function runChecked(executable, args, options) {
  const result = spawnSync(executable, args, Object.assign({cwd: root, stdio: 'inherit'}, options || {}));
  if (result.error) fail(`${executable} failed to start: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status || 1);
}

function packagePath() {
  const configured = process.env.PACKAGE || `dist/gmail-offline-backup-${read('VERSION').trim()}.zip`;
  return path.resolve(root, configured);
}

function buildPackage() {
  const output = packagePath();
  fs.mkdirSync(path.dirname(output), {recursive: true});
  if (fs.existsSync(output)) fs.unlinkSync(output);
  runChecked('zip', ['-q', '-X', output].concat(releaseFiles(true)));
  process.stdout.write(`Created ${path.relative(root, output)}.\n`);
}

function verifyPackage() {
  const archive = packagePath();
  if (!fs.existsSync(archive)) fail(`Package not found: ${path.relative(root, archive)}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-backup-package-'));
  try {
    runChecked('unzip', ['-q', archive, '-d', temporary]);
    runChecked(process.execPath, ['scripts/repo-ops.js', 'checksums-verify'], {cwd: temporary});
    runChecked(process.execPath, ['tests/run-tests.js'], {cwd: temporary});
    runChecked(process.execPath, ['tests/run-tooling-tests.js'], {cwd: temporary});
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
  process.stdout.write(`Verified packaged artifact ${path.relative(root, archive)}.\n`);
}

function tools() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) fail(`Node.js >=18 is required; found ${process.version}.`);
  process.stdout.write(`Node.js ${process.version} is supported.\n`);
}

switch (command) {
  case 'tools': tools(); break;
  case 'configure': configure(); break;
  case 'config-check': configCheck(); break;
  case 'validate': validateMetadata(); break;
  case 'validate-skill': validateSkill(); break;
  case 'checksums-write': checksumsWrite(); break;
  case 'checksums-verify': checksumsVerify(); break;
  case 'package': buildPackage(); break;
  case 'package-verify': verifyPackage(); break;
  default: fail('Usage: repo-ops.js tools|configure|config-check|validate|validate-skill|checksums-write|checksums-verify|package|package-verify');
}
