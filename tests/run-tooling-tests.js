#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const wrapper = path.join(root, 'scripts', 'clasp-ops.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-backup-tooling-'));
const fakeClasp = path.join(temporary, 'fake-clasp');

function invoke(mode, environment) {
  return spawnSync(process.execPath, [wrapper, mode], {
    cwd: root,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      CLASP_BIN: fakeClasp,
      CLASP_PROJECT: '.clasp.json',
    }, environment || {}),
  });
}

try {
  fs.writeFileSync(fakeClasp, `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
if (process.env.FAKE_CLASP_MODE === 'error') {
  process.stdout.write(JSON.stringify({error: {message: 'simulated Apps Script failure'}}));
} else if (process.env.FAKE_CLASP_MODE === 'cli-error') {
  process.stderr.write('simulated transient 503');
  process.exit(7);
} else if (process.env.FAKE_CLASP_MODE === 'arguments') {
  process.stdout.write(JSON.stringify({response: {result: JSON.stringify(args)}}));
} else {
  process.stdout.write(JSON.stringify({response: {result: JSON.stringify({phase: 'PLANNED', progressPercent: 100})}}));
}
`, {mode: 0o700});

  const success = invoke('run', {FUNCTION: 'agentStatus'});
  assert.strictEqual(success.status, 0, success.stderr);
  assert.deepStrictEqual(JSON.parse(success.stdout), {phase: 'PLANNED', progressPercent: 100});

  const errorEnvelope = invoke('run', {FUNCTION: 'agentStatus', FAKE_CLASP_MODE: 'error'});
  assert.notStrictEqual(errorEnvelope.status, 0, 'Apps Script error envelope must fail the command');
  assert.match(errorEnvelope.stderr, /simulated Apps Script failure/);

  const cliError = invoke('run', {FUNCTION: 'agentStatus', FAKE_CLASP_MODE: 'cli-error'});
  assert.strictEqual(cliError.status, 7);
  assert.match(cliError.stderr, /simulated transient 503/);

  const argumentsRun = invoke('run', {
    FUNCTION: 'verifyBackupSample',
    PARAMS: '[25]',
    NONDEV: '1',
    FAKE_CLASP_MODE: 'arguments',
  });
  assert.strictEqual(argumentsRun.status, 0, argumentsRun.stderr);
  const args = JSON.parse(argumentsRun.stdout);
  assert.deepStrictEqual(args.slice(-5), ['run', '--nondev', 'verifyBackupSample', '--params', '[25]']);
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('--project'));

  const completedWait = invoke('wait', {
    PHASE: 'PLANNED',
    TIMEOUT_SECONDS: '1',
    POLL_SECONDS: '5',
  });
  assert.strictEqual(completedWait.status, 0, completedWait.stderr);
  assert.match(completedWait.stdout, /phase=PLANNED/);

  process.stdout.write('All repository tooling tests passed.\n');
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}
