#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {spawnSync} = require('child_process');

const mode = process.argv[2] || '';

function fail(message, code) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code || 1);
}

function claspArguments(functionName, params) {
  const args = [];
  if (process.env.CLASP_AUTH) args.push('--auth', process.env.CLASP_AUTH);
  if (process.env.CLASP_USER) args.push('--user', process.env.CLASP_USER);
  if (process.env.CLASP_PROJECT) args.push('--project', process.env.CLASP_PROJECT);
  args.push('--json', 'run');
  if (process.env.NONDEV === '1') args.push('--nondev');
  args.push(functionName);
  if (params) args.push('--params', params);
  return args;
}

function parseJsonOutput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('clasp returned no JSON output.');
  try {
    return JSON.parse(trimmed);
  } catch (ignored) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch (ignoredAgain) {}
    }
  }
  throw new Error(`Could not parse clasp JSON output:\n${trimmed}`);
}

function resultFromEnvelope(envelope) {
  if (envelope && envelope.error) {
    const detail = envelope.error.message || JSON.stringify(envelope.error);
    const error = new Error(detail);
    error.envelope = envelope;
    throw error;
  }
  let result = envelope && envelope.response && Object.prototype.hasOwnProperty.call(envelope.response, 'result')
    ? envelope.response.result
    : envelope && Object.prototype.hasOwnProperty.call(envelope, 'result')
      ? envelope.result
      : envelope && envelope.response !== undefined
        ? envelope.response
        : envelope;
  if (typeof result === 'string' && /^[\[{]/.test(result.trim())) {
    try { result = JSON.parse(result); } catch (ignored) {}
  }
  return result;
}

function execute(functionName, params) {
  const executable = process.env.CLASP_BIN || 'clasp';
  const invocation = spawnSync(executable, claspArguments(functionName, params), {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (invocation.error) throw new Error(`${executable} failed to start: ${invocation.error.message}`);
  if (invocation.status !== 0) {
    const detail = String(invocation.stderr || invocation.stdout || '').trim();
    const error = new Error(`clasp exited with status ${invocation.status}${detail ? `: ${detail}` : '.'}`);
    error.exitCode = invocation.status;
    throw error;
  }
  if (invocation.stderr) process.stderr.write(invocation.stderr);
  const envelope = parseJsonOutput(invocation.stdout);
  return {envelope, result: resultFromEnvelope(envelope)};
}

function parameters() {
  if (process.env.PARAMS_FILE) {
    try {
      return fs.readFileSync(process.env.PARAMS_FILE, 'utf8').trim();
    } catch (error) {
      fail(`Could not read PARAMS_FILE: ${error.message}`);
    }
  }
  return String(process.env.PARAMS || '').trim();
}

function printResult(result) {
  if (result === undefined) return;
  if (typeof result === 'string') process.stdout.write(`${result}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function run() {
  const functionName = String(process.env.FUNCTION || '').trim();
  if (!functionName) fail('FUNCTION is required.');
  try {
    printResult(execute(functionName, parameters()).result);
  } catch (error) {
    fail(`Apps Script ${functionName} failed: ${error.message}`, error.exitCode);
  }
}

function isTransient(message) {
  return /429|rate limit|backend|internal|temporar|timeout|timed out|500|502|503|504|service unavailable/i.test(message);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function wait() {
  const desired = String(process.env.PHASE || '').split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
  if (!desired.length) fail('PHASE is required.');
  const timeoutSeconds = Number(process.env.TIMEOUT_SECONDS || 21600);
  const pollSeconds = Number(process.env.POLL_SECONDS || 60);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) fail('TIMEOUT_SECONDS must be positive.');
  if (!Number.isFinite(pollSeconds) || pollSeconds < 5) fail('POLL_SECONDS must be at least 5.');

  const deadline = Date.now() + timeoutSeconds * 1000;
  let transientFailures = 0;
  while (Date.now() <= deadline) {
    try {
      const status = execute('agentStatus', '').result;
      transientFailures = 0;
      if (!status || typeof status !== 'object') fail(`agentStatus returned an unexpected result: ${JSON.stringify(status)}`);
      const phase = String(status.phase || '').toUpperCase();
      const progress = status.progressPercent === null || status.progressPercent === undefined
        ? ''
        : ` ${Number(status.progressPercent).toFixed(1)}%`;
      process.stdout.write(`[${new Date().toISOString()}] phase=${phase || 'UNKNOWN'}${progress} ${status.progressLabel || ''}\n`);
      if (desired.includes(phase)) {
        printResult(status);
        return;
      }
      if (phase === 'ERROR' || phase === 'PAUSED') {
        fail(`Backup entered terminal phase ${phase} before reaching ${desired.join(', ')}.`);
      }
    } catch (error) {
      if (!isTransient(error.message)) fail(`Status poll failed: ${error.message}`);
      transientFailures += 1;
      process.stderr.write(`[${new Date().toISOString()}] transient status failure ${transientFailures}: ${error.message}\n`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollSeconds * 1000, remaining));
  }
  fail(`Timed out after ${timeoutSeconds}s waiting for phase ${desired.join(', ')}.`);
}

if (mode === 'run') run();
else if (mode === 'wait') wait().catch(error => fail(error.message));
else fail('Usage: clasp-ops.js run|wait');
