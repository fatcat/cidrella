import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, execSync } from 'child_process';
import { parseCidr } from './ip.js';
import { getSetting } from '../db/init.js';
import { DATA_DIR, resolveDnsmasqInternalPort, resolveDnsListenPort, DEFAULT_DNS_LISTEN_PORT, ENCRYPTED_FORWARDER_PORT } from '../config/defaults.js';
import { validateDnsmasqConfigValue, validateTxtValue, isValidPtrName } from './dnsmasq-escape.js';
const HOSTS_DIR = path.join(DATA_DIR, 'dnsmasq', 'hosts.d');
const CONF_DIR = path.join(DATA_DIR, 'dnsmasq', 'conf.d');
const DNSMASQ_CONF = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.conf');

export function atomicWrite(filePath, content) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Strip everything dnsmasq ignores: blank lines and whole-line comments.
 *
 * Only lines whose FIRST non-space character is `#` are dropped. Inline `#` is
 * deliberately left alone because it is meaningful inside directives:
 * `server=127.0.0.1#5353` uses it as the port separator, and a TXT value can
 * contain one. Stripping from the first `#` onward would silently corrupt the
 * comparison for both.
 */
function directivesOf(content) {
  const out = [];
  for (const line of String(content || '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    out.push(trimmed);
  }
  return out.join('\n');
}

/**
 * Write `newContent` when the bytes differ, but report "changed" only when the
 * DIRECTIVES differ. Callers use the return value to decide whether to restart
 * or SIGHUP dnsmasq, and dnsmasq reads no meaning at all from comments.
 *
 * Without this split, a purely cosmetic edit forced a full daemon restart. The
 * SOA serial rides along in a header comment in every zone-*.conf, DHCP lease
 * churn bumps that serial constantly, and the old byte-exact compare read each
 * bump as a config change. Field result: dnsmasq restarted roughly every 18
 * seconds (~4800 times a day), and every restart dropped the whole DNS cache.
 *
 * The file is still rewritten so the comment stays truthful, it just no longer
 * drags the daemon along with it.
 *
 * @returns {boolean} true when dnsmasq needs to be told about this write
 */
function writeIfChanged(filePath, newContent) {
  let oldContent = '';
  try { oldContent = fs.readFileSync(filePath, 'utf-8'); } catch { /* doesn't exist yet */ }
  if (newContent === oldContent) return false;
  const directivesChanged = directivesOf(newContent) !== directivesOf(oldContent);
  atomicWrite(filePath, newContent);
  return directivesChanged;
}

export function cleanStaleFiles(dir, prefix, suffix, activeIds) {
  if (!fs.existsSync(dir)) return false;
  let removed = false;
  const pattern = new RegExp(`^${prefix}(\\d+)${suffix.replace('.', '\\.')}$`);
  for (const file of fs.readdirSync(dir)) {
    const match = file.match(pattern);
    if (match && !activeIds.has(parseInt(match[1], 10))) {
      fs.unlinkSync(path.join(dir, file));
      removed = true;
    }
  }
  return removed;
}

function toFqdn(recordName, zoneName) {
  const raw = String(recordName || '').trim();
  const normalized = raw.replace(/\.$/, '');
  const zone = String(zoneName || '').replace(/\.$/, '');
  if (normalized.toLowerCase() === zone.toLowerCase() ||
      normalized.toLowerCase().endsWith(`.${zone.toLowerCase()}`)) {
    return normalized;
  }
  if (normalized.includes('.')) {
    return raw.endsWith('.') ? raw : normalized;
  }
  return recordName === '@' ? zoneName : `${recordName}.${zoneName}`;
}

export function generateReverseName(cidr) {
  return generateReverseNames(cidr)[0];
}

/**
 * Generate all /24 reverse zone names for a CIDR.
 * Networks /24+ → 1 zone, /17-/23 → multiple /24 zones, /16 → /16 zone, etc.
 */
export function generateReverseNames(cidr) {
  const parsed = parseCidr(cidr);
  const octets = parsed.network.split('.').map(Number);

  if (parsed.prefix >= 24) {
    return [`${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`];
  } else if (parsed.prefix >= 17) {
    // Split into individual /24 zones
    const numBlocks = 1 << (24 - parsed.prefix);
    const zones = [];
    for (let i = 0; i < numBlocks; i++) {
      zones.push(`${octets[2] + i}.${octets[1]}.${octets[0]}.in-addr.arpa`);
    }
    return zones;
  } else if (parsed.prefix >= 16) {
    return [`${octets[1]}.${octets[0]}.in-addr.arpa`];
  } else if (parsed.prefix >= 8) {
    return [`${octets[0]}.in-addr.arpa`];
  }
  return [`${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`];
}

export function regenerateHostsDir(db) {
  const zones = db.prepare(`
    SELECT z.id, z.name FROM dns_zones z WHERE z.enabled = 1
  `).all();

  const activeIds = new Set();
  let changed = false;

  for (const zone of zones) {
    const records = db.prepare(`
      SELECT name, value FROM dns_records
      WHERE zone_id = ? AND type = 'A' AND enabled = 1
    `).all(zone.id);

    if (records.length === 0) continue;

    activeIds.add(zone.id);
    const filePath = path.join(HOSTS_DIR, `zone-${zone.id}.hosts`);
    const newContent = records.map(r => `${r.value} ${toFqdn(r.name, zone.name)}`).join('\n') + '\n';
    if (writeIfChanged(filePath, newContent)) changed = true;
  }

  if (cleanStaleFiles(HOSTS_DIR, 'zone-', '.hosts', activeIds)) changed = true;
  return changed;
}

export function regenerateConfDir(db) {
  const zones = db.prepare(`
    SELECT z.* FROM dns_zones z WHERE z.enabled = 1
  `).all();

  const activeIds = new Set();
  let changed = false;

  for (const zone of zones) {
    // Defense in depth: the zone name is interpolated raw into ptr-record= and
    // the SOA comment below. The route validates it, but this writer is the
    // actual config-injection sink, so it must never trust a stored name.
    // Skip any zone whose name carries characters that could break out of the
    // line or smuggle a directive (a legit name is a domain or dotted-decimal
    // in-addr.arpa, so no whitespace, commas, or control chars).
    if (validateDnsmasqConfigValue(zone.name) != null) continue;

    const records = db.prepare(`
      SELECT name, type, value, priority, weight, port, ttl FROM dns_records
      WHERE zone_id = ? AND type NOT IN ('A', 'PTR') AND enabled = 1
    `).all(zone.id);

    // PTR records with hostname values (not bare IPs) generate ptr-record= lines
    const ptrRecords = db.prepare(`
      SELECT name, value FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND enabled = 1 AND value LIKE '%.%' AND value NOT GLOB '[0-9]*.[0-9]*.[0-9]*.[0-9]*'
    `).all(zone.id);

    if (records.length === 0 && ptrRecords.length === 0) continue;

    activeIds.add(zone.id);
    const lines = [];

    // SOA comment for documentation
    if (zone.soa_primary_ns) {
      lines.push(`# SOA: ${zone.soa_primary_ns} ${zone.soa_admin_email} ${zone.soa_serial || 1} ${zone.soa_refresh} ${zone.soa_retry} ${zone.soa_expire} ${zone.soa_minimum_ttl}`);
    }

    for (const r of records) {
      const fqdn = toFqdn(r.name, zone.name);
      switch (r.type) {
        case 'CNAME':
          if (validateDnsmasqConfigValue(r.value) != null) break;
          lines.push(`cname=${fqdn},${r.value}${r.ttl ? ',' + r.ttl : ''}`);
          break;
        case 'MX':
          if (validateDnsmasqConfigValue(r.value) != null) break;
          lines.push(`mx-host=${fqdn},${r.value},${r.priority || 10}`);
          break;
        case 'TXT':
          // Belt-and-suspenders: reject any TXT value that would terminate
          // the quoted span (newlines, control chars). The route validator
          // already blocks these; a bad row in the DB from a pre-v0.4.15
          // install is silently skipped rather than emitted.
          if (validateTxtValue(r.value) != null) break;
          lines.push(`txt-record=${fqdn},"${r.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
          break;
        case 'SRV':
          if (validateDnsmasqConfigValue(r.value) != null) break;
          lines.push(`srv-host=${fqdn},${r.value},${r.port},${r.priority || 0},${r.weight || 0}`);
          break;
      }
    }

    // PTR records: ptr-record=<octet>.<zone>,<hostname>. Skip any row whose
    // name or value doesn't pass the sanitizer, they would only emit if
    // someone bypassed the route validator or edited the DB directly.
    for (const ptr of ptrRecords) {
      if (!isValidPtrName(ptr.name)) continue;
      if (validateDnsmasqConfigValue(ptr.value) != null) continue;
      lines.push(`ptr-record=${ptr.name}.${zone.name},${ptr.value}`);
    }

    const filePath = path.join(CONF_DIR, `zone-${zone.id}.conf`);
    const newContent = lines.join('\n') + '\n';

    // Comment-only deltas (the SOA serial above) rewrite the file but do NOT
    // count as a change, so lease churn stops restarting dnsmasq.
    if (writeIfChanged(filePath, newContent)) changed = true;
  }

  if (cleanStaleFiles(CONF_DIR, 'zone-', '.conf', activeIds)) changed = true;

  return changed;
}

// ─── DNSSEC ──────────────────────────────────────────────
// Distro-maintained root trust-anchor file (Debian/Ubuntu ship this with
// dnsmasq-base). Preferred over a hardcoded key because it survives root KSK
// rollovers via package updates.
const DISTRO_TRUST_ANCHORS = '/usr/share/dnsmasq/trust-anchors.conf';
// Fallback root KSK (KSK-2017, key tag 20326) used only when the distro file
// is absent. dnsmasq trust-anchor format: name,key_tag,algo,digest_type,digest.
const ROOT_KSK_TRUST_ANCHOR =
  'trust-anchor=.,20326,8,2,E06D44B80B8F1D39A95C0B0D7C65D08458E880409BBC683457104237C7F8EC8D';

// Memoized: dnsmasq's compile-time options don't change at runtime.
let _dnssecSupportCache = null;

/**
 * Whether the installed dnsmasq was built with DNSSEC support. dnsmasq prints
 * its compile flags on `--version`; an unsupported build lists the token
 * "no-DNSSEC" instead of "DNSSEC", so an exact token match distinguishes them.
 * Returns false (and we refuse to emit the DNSSEC block) when dnsmasq is
 * missing or lacks support, rather than producing a config it rejects on start.
 */
export function dnsmasqSupportsDnssec() {
  if (_dnssecSupportCache !== null) return _dnssecSupportCache;
  try {
    const out = execFileSync('dnsmasq', ['--version'], { encoding: 'utf-8' });
    _dnssecSupportCache = out.split(/\s+/).includes('DNSSEC');
  } catch {
    _dnssecSupportCache = false;
  }
  return _dnssecSupportCache;
}

// True for any dnsmasq.conf line this module injects for DNSSEC, so regen can
// strip them before re-adding, keeping the conf a pure function of the setting.
function isManagedDnssecLine(line) {
  const t = line.trim();
  if (t === 'dnssec' || t === 'dnssec-no-timecheck') return true;
  if (/^dnssec-check-unsigned(=.*)?$/.test(t)) return true;
  if (/^trust-anchor=/.test(t)) return true;
  if (/^conf-file=.*trust-anchor/i.test(t)) return true;
  return false;
}

function buildDnssecLines() {
  // dnssec-no-timecheck: start lenient on signature time windows so early-boot
  // lookups don't SERVFAIL on clock skew. timesync.js SIGHUPs dnsmasq once the
  // clock is NTP-synced, which clears this mode. Re-armed on every restart
  // because the directive stays in the conf.
  const lines = ['dnssec', 'dnssec-check-unsigned', 'dnssec-no-timecheck'];
  if (fs.existsSync(DISTRO_TRUST_ANCHORS)) {
    lines.push(`conf-file=${DISTRO_TRUST_ANCHORS}`);
  } else {
    lines.push(ROOT_KSK_TRUST_ANCHOR);
  }
  return lines;
}

export function regenerateDnsmasqConf(_db) {
  if (!fs.existsSync(DNSMASQ_CONF)) return false;

  // dnsmasq always uses real upstream servers, proxy sits in front, not behind
  const servers = getSetting('dns_upstream_servers');
  const dnssecEnabled = getSetting('dnssec_enabled') === 'true';
  const encryption = getSetting('forwarder_encryption') || 'off';
  const noRecursion = getSetting('dns_no_recursion') === 'true';

  const content = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
  const lines = content.split('\n');
  // Strip existing server= lines and any DNSSEC-managed lines so regen is
  // idempotent regardless of which setting changed.
  const filtered = lines.filter(line => !/^server=/.test(line) && !isManagedDnssecLine(line));

  // Insert server lines after no-resolv or at the start. When recursion is
  // disabled, emit NO upstreams (authoritative-only). Otherwise, when encrypted
  // forwarding is on, send everything to the in-Node DoT/DoH stub on loopback
  // instead of the plain upstream IPs (the stub encrypts to the real upstreams).
  const noResolvIdx = filtered.findIndex(l => l.trim() === 'no-resolv');
  const insertIdx = noResolvIdx >= 0 ? noResolvIdx + 1 : 0;
  const serverLines = noRecursion
    ? []
    : (encryption === 'tls' || encryption === 'https')
      ? [`server=127.0.0.1#${ENCRYPTED_FORWARDER_PORT}`]
      : servers.map(s => `server=${s}`);
  filtered.splice(insertIdx, 0, ...serverLines);

  // Append the DNSSEC block when enabled and the local dnsmasq supports it.
  if (dnssecEnabled) {
    if (dnsmasqSupportsDnssec()) {
      filtered.push(...buildDnssecLines());
    } else {
      console.warn('[dnsmasq] dnssec_enabled is true but dnsmasq was not built with DNSSEC support, skipping DNSSEC directives');
    }
  }

  // Skip the write when nothing changed so callers (boot especially) can skip
  // the dnsmasq restart. Same changed-boolean convention as regenerateConfigs.
  return writeIfChanged(DNSMASQ_CONF, filtered.join('\n'));
}

export function isDnsmasqRunning() {
  try {
    execSync('pidof dnsmasq', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Liveness of OUR dnsmasq specifically. `pidof dnsmasq` matches any dnsmasq
// on the host (libvirt, LXD, and NetworkManager all spawn their own), so a
// dead cidrella-dnsmasq could look alive. Ask systemd about the exact unit;
// fall back to pidof only where systemctl doesn't exist (Docker/s6, where
// the only dnsmasq in the container is ours).
export function isCidrellaDnsmasqRunning() {
  try {
    execFileSync('systemctl', ['is-active', '--quiet', 'cidrella-dnsmasq'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return isDnsmasqRunning();
    // systemctl exists and says the unit is not active
    return false;
  }
}

const DNSMASQ_PID = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.pid');
const RESTART_PENDING = path.join(DATA_DIR, 'runtime', 'dnsmasq-restart-pending');

// True when a previous restartDnsmasq() could not complete, meaning the conf
// on disk may be newer than what the running dnsmasq loaded. The boot path
// checks this so change-detection can't skip the restart that would heal a
// stale-loaded config.
export function dnsmasqRestartPending() {
  return fs.existsSync(RESTART_PENDING);
}

function setRestartPending(pending) {
  try {
    if (pending) {
      fs.mkdirSync(path.dirname(RESTART_PENDING), { recursive: true });
      fs.writeFileSync(RESTART_PENDING, new Date().toISOString());
    } else {
      fs.rmSync(RESTART_PENDING, { force: true });
    }
  } catch { /* marker is best-effort */ }
}

export function signalDnsmasq() {
  // Reload dnsmasq via systemctl. cidrella-dnsmasq.service has
  // ExecReload=/bin/kill -HUP $MAINPID (added in v0.4.11), and the cidrella
  // service account is authorized to reload that exact unit by
  // /etc/polkit-1/rules.d/49-cidrella.rules, no sudo, no setuid escalation.
  //
  // This path replaces the sudo+wrapper path (cidrella-dnsmasq-hup) which
  // was broken from v0.4.8 onward by the systemd hardening on
  // cidrella.service implicitly setting NoNewPrivileges=yes.
  try {
    execFileSync('systemctl', ['reload', 'cidrella-dnsmasq'], { stdio: 'pipe' });
    return;
  } catch (err) {
    const stderr = err?.stderr?.toString?.().trim();
    if (stderr) console.warn('systemctl reload cidrella-dnsmasq failed:', stderr);
  }

  // Docker / dev fallback: try to send SIGHUP directly. This works inside
  // the s6-supervised container where cidrella-dnsmasq.service doesn't
  // exist and the cidrella process has the same uid as dnsmasq.
  try {
    const pid = parseInt(fs.readFileSync(DNSMASQ_PID, 'utf-8').trim(), 10);
    if (pid) process.kill(pid, 'SIGHUP');
  } catch {
    console.warn('Could not send SIGHUP to dnsmasq (may not be running)');
  }
}

export function restartDnsmasq() {
  // Native installs: polkit-gated systemctl restart (no sudo).
  try {
    execFileSync('systemctl', ['restart', 'cidrella-dnsmasq'], { stdio: 'pipe' });
    console.log('dnsmasq restarted via systemctl');
    setRestartPending(false);
    return;
  } catch (err) {
    const stderr = err?.stderr?.toString?.().trim();
    if (stderr) console.warn('systemctl restart cidrella-dnsmasq failed:', stderr);
  }

  // Docker / supervisor fallback: terminate and let the supervisor restart.
  try {
    execFileSync('pkill', ['-TERM', '-x', 'dnsmasq'], { stdio: 'pipe' });
    console.log('dnsmasq terminated (supervisor will restart)');
    setRestartPending(false);
  } catch {
    // Both restart paths failed: the conf on disk may now be ahead of the
    // running process. Leave a marker so the next boot restarts even if
    // change-detection sees an unchanged file.
    console.warn('Could not restart dnsmasq');
    setRestartPending(true);
  }
}

export function applyInterfaceConfig(_db) {
  if (!fs.existsSync(DNSMASQ_CONF)) return false;

  const content = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
  const lines = content.split('\n');

  // Strip existing interface-related directives (not comments)
  const filtered = lines.filter(line => {
    if (line.startsWith('#')) return true;
    if (/^listen-address=/.test(line)) return false;
    if (/^interface=/.test(line)) return false;
    if (/^no-dhcp-interface=/.test(line)) return false;
    if (/^bind-dynamic$/.test(line)) return false;
    if (/^port=/.test(line)) return false;
    return true;
  });

  // Read settings
  let ifaceConfig = {};
  let dnsEnabled = true;
  let dhcpEnabled = true;

  try {
    const raw = getSetting('interface_config');
    if (raw) ifaceConfig = JSON.parse(raw);
  } catch { /* use default */ }

  try {
    const val = getSetting('dns_enabled');
    if (val === 'false') dnsEnabled = false;
  } catch { /* use default */ }

  try {
    const val = getSetting('dhcp_enabled');
    if (val === 'false') dhcpEnabled = false;
  } catch { /* use default */ }

  // Check for proxy bypass mode, dnsmasq takes over port 53 on LAN IPs
  let proxyBypass = false;
  try {
    const val = getSetting('dns_proxy_bypass');
    if (val === 'true') proxyBypass = true;
  } catch { /* use default */ }

  const sysIfaces = os.networkInterfaces();

  // Normal mode: dnsmasq DNS listens on localhost:5353 only, proxy handles
  //   LAN-facing DNS on the configured `dns_listen_port` (default 53).
  // Bypass mode: proxy is dead, dnsmasq listens on `dns_listen_port` + LAN IPs directly.
  // DHCP always needs interface= directives for LAN interfaces.
  // resolveDnsListenPort is shared with dns-proxy.js, which used to range-check
  // this differently. See REVIEW.md, duplicate-logic audit #10.
  let configuredListenPort = DEFAULT_DNS_LISTEN_PORT;
  try {
    configuredListenPort = resolveDnsListenPort(getSetting('dns_listen_port'));
  } catch { /* default 53 */ }
  const internalPort = resolveDnsmasqInternalPort(configuredListenPort);
  const dnsPort = !dnsEnabled ? 0 : proxyBypass ? configuredListenPort : internalPort;
  const newDirectives = [
    'bind-dynamic',
    'listen-address=127.0.0.1',
    `port=${dnsPort}`,
  ];
  if (sysIfaces.lo?.some(a => a.family === 'IPv6')) {
    newDirectives.push('listen-address=::1');
  }
  const hasExplicitConfig = Object.keys(ifaceConfig).length > 0;

  if (hasExplicitConfig) {
    for (const [ifName, cfg] of Object.entries(ifaceConfig)) {
      if (!cfg.dns && !cfg.dhcp) continue;
      // Skip any stored ifName that isn't a real host interface, guards
      // against prototype-chain lookups (constructor/__proto__/toString)
      // in stored config that predates the validator fix for C1.
      if (!Object.hasOwn(sysIfaces, ifName)) continue;
      // interface= needed for DHCP binding (and DNS in bypass mode)
      newDirectives.push(`interface=${ifName}`);
      // In bypass mode, dnsmasq also needs listen-address for DNS on LAN IPs
      if (proxyBypass && cfg.dns && dnsEnabled) {
        const addrs = sysIfaces[ifName];
        if (addrs) {
          for (const a of addrs) {
            if (a.family === 'IPv4') newDirectives.push(`listen-address=${a.address}`);
          }
        }
      }
      if (!cfg.dhcp || !dhcpEnabled) {
        newDirectives.push(`no-dhcp-interface=${ifName}`);
      }
    }
  } else {
    // Fresh deploy, bind DHCP to all real interfaces
    for (const [ifName, addrs] of Object.entries(sysIfaces)) {
      if (ifName === 'lo') continue;
      if (dhcpEnabled) {
        newDirectives.push(`interface=${ifName}`);
      } else {
        newDirectives.push(`no-dhcp-interface=${ifName}`);
      }
      // In bypass mode, add listen-address for DNS on LAN IPs
      if (proxyBypass && dnsEnabled) {
        for (const a of addrs) {
          if (a.family === 'IPv4') newDirectives.push(`listen-address=${a.address}`);
        }
      }
    }
  }

  // Append directives at the end
  filtered.push(...newDirectives);

  // Same changed-boolean convention as regenerateDnsmasqConf/regenerateConfigs.
  return writeIfChanged(DNSMASQ_CONF, filtered.join('\n'));
}

export function regenerateConfigs(db) {
  const hostsChanged = regenerateHostsDir(db);
  const confChanged = regenerateConfDir(db);

  // dnsmasq rereads hostsdir/dhcp-hostsdir on SIGHUP, but it does not reread
  // the main config file or conf-dir includes. CNAME/MX/TXT/SRV/PTR records
  // live in conf.d/zone-*.conf, so those changes need a full restart to take
  // effect. Hosts-only updates can keep using the cheaper reload path.
  if (confChanged) {
    restartDnsmasq();
  } else if (hostsChanged) {
    signalDnsmasq();
  }
}
