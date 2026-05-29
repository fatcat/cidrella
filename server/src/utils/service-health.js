import { execFileSync } from 'child_process';

const DEFAULT_UNIT = 'cidrella.service';
const JOURNAL_WINDOW = '30 minutes ago';
const JOURNAL_LINE_LIMIT = 160;
const COMMAND_TIMEOUT_MS = 2000;

const crashPatterns = [
  { type: 'oom', pattern: /JavaScript heap out of memory|Allocation failed - JavaScript heap out of memory|Reached heap limit/i },
  { type: 'oom', pattern: /\bout of memory\b|oom-kill|Killed process/i },
  { type: 'fatal', pattern: /FATAL ERROR|uncaught exception|segmentation fault|core dumped/i },
  { type: 'exit', pattern: /Main process exited|Failed with result|service hold-off time over/i },
];

let bootServiceHealth = {
  available: false,
  checked_at: null,
  unit: process.env.CIDRELLA_SYSTEMD_UNIT || DEFAULT_UNIT,
  recent_crash: null,
};

function runCommand(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
  });
}

function parseSystemctlShow(output) {
  const parsed = {};
  for (const line of String(output || '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    parsed[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return parsed;
}

function parseJournalLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+\S+\s+(.*)$/);
  if (!match) return { timestamp: null, message: trimmed };
  return { timestamp: match[1], message: match[2] };
}

function classifyJournalLine(line) {
  const parsed = parseJournalLine(line);
  if (!parsed) return null;

  for (const { type, pattern } of crashPatterns) {
    if (pattern.test(parsed.message)) {
      return {
        type,
        timestamp: parsed.timestamp,
        message: parsed.message.slice(0, 500),
      };
    }
  }
  return null;
}

function findRecentCrash(journalOutput) {
  const matches = [];
  for (const line of String(journalOutput || '').split('\n')) {
    const classified = classifyJournalLine(line);
    if (classified) matches.push(classified);
  }
  return matches.filter(m => m.type !== 'exit').at(-1) || matches.at(-1) || null;
}

export function captureBootServiceHealth() {
  const unit = process.env.CIDRELLA_SYSTEMD_UNIT || DEFAULT_UNIT;
  const checkedAt = new Date().toISOString();
  const next = {
    available: false,
    checked_at: checkedAt,
    unit,
    systemd: null,
    recent_crash: null,
  };

  try {
    const show = runCommand('systemctl', [
      'show',
      unit,
      '--property=ActiveState',
      '--property=SubState',
      '--property=Result',
      '--property=NRestarts',
      '--property=ExecMainCode',
      '--property=ExecMainStatus',
      '--property=InactiveExitTimestamp',
      '--property=StateChangeTimestamp',
    ]);
    const props = parseSystemctlShow(show);
    next.available = true;
    next.systemd = {
      active_state: props.ActiveState || null,
      sub_state: props.SubState || null,
      result: props.Result || null,
      restarts: Number.parseInt(props.NRestarts || '0', 10) || 0,
      exec_main_code: props.ExecMainCode || null,
      exec_main_status: props.ExecMainStatus || null,
      inactive_exit_timestamp: props.InactiveExitTimestamp || null,
      state_change_timestamp: props.StateChangeTimestamp || null,
    };
  } catch (err) {
    next.error = `systemd unavailable: ${err.message}`;
    bootServiceHealth = next;
    return bootServiceHealth;
  }

  try {
    const journal = runCommand('journalctl', [
      '-u',
      unit,
      '--since',
      JOURNAL_WINDOW,
      '-n',
      String(JOURNAL_LINE_LIMIT),
      '-o',
      'short-iso',
      '--no-pager',
    ]);
    next.recent_crash = findRecentCrash(journal);
  } catch (err) {
    next.journal_error = err.message;
  }

  bootServiceHealth = next;
  if (next.recent_crash) {
    console.warn(`[service-health] Recent ${unit} crash detected: ${next.recent_crash.message}`);
  }
  return bootServiceHealth;
}

export function getBootServiceHealth() {
  return bootServiceHealth;
}

export const testExports = {
  parseSystemctlShow,
  parseJournalLine,
  classifyJournalLine,
  findRecentCrash,
};
