import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  readStartupStatus,
  startupStatusPath,
  writeStartupStatus,
} from './utils/startup-status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendPath = path.join(__dirname, 'index.js');
const SAFE_MODE_THRESHOLD = Number.parseInt(process.env.CIDRELLA_SAFE_MODE_THRESHOLD || '3', 10) || 3;
const OUTPUT_LINE_LIMIT = 40;
const OUTPUT_CHAR_LIMIT = 8000;

function nowIso() {
  return new Date().toISOString();
}

function dataDir() {
  return process.env.DATA_DIR || '/data';
}

function configuredHttpsPort() {
  const raw = process.env.HTTPS_PORT || '8443';
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 8443;
}

function safeModePorts() {
  return [...new Set([configuredHttpsPort(), 443, 8443])];
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pushOutput(buffer, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean);
  buffer.push(...lines);
  while (buffer.length > OUTPUT_LINE_LIMIT) buffer.shift();
  let total = buffer.reduce((sum, line) => sum + line.length, 0);
  while (total > OUTPUT_CHAR_LIMIT && buffer.length > 1) {
    total -= buffer.shift().length;
  }
}

function previousFailure(previous) {
  if (!previous || previous.state === 'ready') return null;
  if (previous.state === 'starting') {
    return {
      message: 'Previous backend process died before reporting ready.',
      started_at: previous.started_at || null,
      pid: previous.pid || null,
    };
  }
  if (previous.state === 'failed' || previous.state === 'safe_mode') {
    return {
      message: previous.message || 'Previous backend process failed before reporting ready.',
      started_at: previous.started_at || null,
      failed_at: previous.failed_at || null,
      pid: previous.pid || null,
      exit_code: previous.exit_code ?? null,
      signal: previous.signal || null,
      last_output: previous.last_output || [],
    };
  }
  return null;
}

function buildStartingStatus(childPid) {
  const previous = readStartupStatus();
  const failure = previousFailure(previous);
  const failedStarts = failure ? (Number(previous?.failed_start_count) || 0) + 1 : 0;
  return {
    state: 'starting',
    pid: childPid,
    launcher_pid: process.pid,
    started_at: nowIso(),
    failed_start_count: failedStarts,
    previous_failure: failure,
    message: failure
      ? `CIDRella backend is starting after ${failedStarts} early failed start(s).`
      : 'CIDRella backend startup began.',
  };
}

const child = spawn(process.execPath, [backendPath], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
  cwd: process.cwd(),
});
const lastOutput = [];

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  pushOutput(lastOutput, chunk);
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  pushOutput(lastOutput, chunk);
});

writeStartupStatus(buildStartingStatus(child.pid));

let forwardingSignal = false;
function forwardSignal(signal) {
  if (child.exitCode !== null || child.signalCode !== null) {
    const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
    process.exit(signalExitCodes[signal] || 1);
  }
  if (child.killed) return;
  forwardingSignal = true;
  child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => forwardSignal(signal));
}

child.on('error', (err) => {
  const current = readStartupStatus();
  const failedStartCount = Math.max(1, Number(current?.failed_start_count) || 0);
  const failedStatus = {
    state: 'failed',
    pid: child.pid || null,
    launcher_pid: process.pid,
    started_at: current?.started_at || null,
    failed_at: nowIso(),
    failed_start_count: failedStartCount,
    message: `Failed to launch CIDRella backend: ${err.message}`,
    last_output: lastOutput,
  };
  writeStartupStatus(failedStatus);
  console.error(`Failed to launch CIDRella backend: ${err.message}`);

  if (failedStartCount >= SAFE_MODE_THRESHOLD) {
    const safeStatus = {
      ...failedStatus,
      state: 'safe_mode',
      safe_mode_started_at: nowIso(),
      message: `CIDRella entered safe mode after ${failedStartCount} early failed starts.`,
    };
    writeStartupStatus(safeStatus);
    startSafeModeServer(safeStatus);
    return;
  }

  process.exit(1);
});

function safeModePage(status, protocol, port) {
  const reason = status?.message || 'CIDRella backend did not reach ready state.';
  const previous = status?.previous_failure?.message || 'None recorded';
  const output = Array.isArray(status?.last_output) ? status.last_output.join('\n') : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CIDRella Safe Mode</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #e5e7eb; }
    main { max-width: 900px; margin: 0 auto; padding: 48px 24px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    .lead { color: #fca5a5; font-size: 17px; margin: 0 0 28px; }
    section { border: 1px solid #374151; border-radius: 8px; padding: 18px; margin: 16px 0; background: #1f2937; }
    dl { display: grid; grid-template-columns: 190px 1fr; gap: 8px 16px; margin: 0; }
    dt { color: #9ca3af; }
    dd { margin: 0; }
    code, pre { background: #030712; color: #d1d5db; border-radius: 6px; }
    code { padding: 2px 5px; }
    pre { padding: 14px; overflow: auto; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <h1>CIDRella Safe Mode</h1>
    <p class="lead">The normal backend repeatedly died before reporting ready, so the launcher is serving this diagnostic page.</p>
    <section>
      <dl>
        <dt>Reason</dt><dd>${escapeHtml(reason)}</dd>
        <dt>Failed starts</dt><dd>${escapeHtml(status?.failed_start_count ?? 0)}</dd>
        <dt>Backend PID</dt><dd>${escapeHtml(status?.pid ?? 'unknown')}</dd>
        <dt>Failed at</dt><dd>${escapeHtml(status?.failed_at ?? 'unknown')}</dd>
        <dt>Previous failure</dt><dd>${escapeHtml(previous)}</dd>
        <dt>Status file</dt><dd><code>${escapeHtml(startupStatusPath())}</code></dd>
        <dt>Diagnostic API</dt><dd><code>${escapeHtml(`${protocol}://127.0.0.1:${port}/api/startup-status`)}</code></dd>
      </dl>
    </section>
    <section>
      <h2>Last backend output</h2>
      <pre>${escapeHtml(output || '(no output captured)')}</pre>
    </section>
    <section>
      <h2>Recovery</h2>
      <p>Check <code>journalctl -u cidrella</code>, correct the startup issue, then run <code>systemctl restart cidrella</code>.</p>
    </section>
  </main>
</body>
</html>`;
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function startSafeModeServer(status) {
  const certPath = path.join(dataDir(), 'certs', 'server.crt');
  const keyPath = path.join(dataDir(), 'certs', 'server.key');
  const hasTls = fs.existsSync(certPath) && fs.existsSync(keyPath);
  const protocol = hasTls ? 'https' : 'http';
  const tlsOptions = hasTls ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) } : null;

  const handler = (port) => (req, res) => {
    const current = readStartupStatus() || status;
    if (req.url === '/api/startup-status') {
      sendJson(res, 200, current);
      return;
    }
    if (req.url === '/api/health' || req.url === '/api/health/deep' || req.url === '/api/health/system') {
      sendJson(res, 503, {
        status: 'safe_mode',
        message: 'CIDRella backend is in safe mode after repeated early startup failures.',
        service: { startup: current },
        timestamp: nowIso(),
      });
      return;
    }
    res.writeHead(503, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(safeModePage(current, protocol, port));
  };

  for (const port of safeModePorts()) {
    const server = hasTls
      ? https.createServer(tlsOptions, handler(port))
      : http.createServer(handler(port));
    server.once('error', (err) => {
      console.error(`CIDRella safe mode could not listen on ${protocol} port ${port}: ${err.message}`);
    });
    server.listen(port, () => {
      console.error(`CIDRella safe mode listening on ${protocol} port ${port}`);
    });
  }
}

child.on('exit', (code, signal) => {
  const current = readStartupStatus();
  let failedStatus = null;
  if (current?.state === 'starting' && current.pid === child.pid) {
    const failedStartCount = Math.max(1, Number(current.failed_start_count) || 0);
    failedStatus = {
      ...current,
      state: 'failed',
      failed_at: nowIso(),
      failed_start_count: failedStartCount,
      exit_code: code,
      signal: signal || null,
      last_output: lastOutput,
      message: forwardingSignal
        ? `CIDRella backend stopped during startup after ${signal || `exit ${code}`}.`
        : `CIDRella backend died before reporting ready (${signal || `exit ${code}`}).`,
    };
    writeStartupStatus(failedStatus);
  }

  if (signal && forwardingSignal) {
    const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
    process.exit(signalExitCodes[signal] || 1);
  }

  if (!forwardingSignal && failedStatus && failedStatus.failed_start_count >= SAFE_MODE_THRESHOLD) {
    const safeStatus = {
      ...failedStatus,
      state: 'safe_mode',
      safe_mode_started_at: nowIso(),
      message: `CIDRella entered safe mode after ${failedStatus.failed_start_count} early failed starts.`,
    };
    writeStartupStatus(safeStatus);
    startSafeModeServer(safeStatus);
    return;
  }

  process.exit(code ?? 1);
});

console.log(`CIDRella launcher supervising backend pid ${child.pid}; startup status: ${startupStatusPath()}`);
