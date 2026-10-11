import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { sortKey } from '../../utils/address.js';
import { ipForPtrRecord } from '../../models/dns-record.js';
import { MANAGED_LOCAL_DOMAINS, forwardedAddresses, reservedLocalDomains } from '../shared/reserved-zones.js';
import {
  LOCAL_RECORD_TTL,
  loadDnsZones,
  lowerFqdn,
  servedHostsByAddress,
} from '../shared/dns-zone-model.js';
import { getSetting } from '../../db/init.js';
import { ipv6Enabled } from '../../utils/ipv6-support.js';
import { listenableAddresses, selectInterfaceNames } from '../../utils/interface-config.js';
import { atomicWrite, createValidatedFiles } from '../shared/validated-files.js';
import { createUnitControl } from '../shared/unit-control.js';
import { backendDnsPort, ENCRYPTED_FORWARDER_PORT } from '../../config/defaults.js';
import {
  validateConfigSafeValue,
  validateTxtValue,
  isValidPtrName,
} from '../../utils/config-value-validation.js';
import {
  CONF_DIR,
  DHCP_HOSTS_DIR,
  DISABLE_FILE,
  DNSMASQ_CONF,
  DNSMASQ_PID,
  HOSTS_DIR,
  RESTART_PENDING,
} from './paths.js';

export function validateDnsmasqConfig() {
  if (!fs.existsSync(DNSMASQ_CONF)) return { ok: true, skipped: 'no-config' };
  try {
    execFileSync('dnsmasq', ['--test', `--conf-file=${DNSMASQ_CONF}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, skipped: null };
  } catch (err) {
    if (err?.code === 'ENOENT' && process.env.NODE_ENV !== 'production') {
      return { ok: true, skipped: 'dnsmasq-not-installed' };
    }
    const detail = err?.stderr?.toString?.().trim() || err?.message || 'unknown validation error';
    throw new Error(`dnsmasq configuration validation failed: ${detail}`);
  }
}

// One validated update: snapshot every file dnsmasq reads, `dnsmasq --test`
// when something changed, roll back on failure.
export const withValidatedDnsmasqUpdate = createValidatedFiles({
  targets: () => [DNSMASQ_CONF, HOSTS_DIR, CONF_DIR, DHCP_HOSTS_DIR],
  validate: () => validateDnsmasqConfig(),
});

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
  try {
    oldContent = fs.readFileSync(filePath, 'utf-8');
  } catch {
    /* doesn't exist yet */
  }
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

// One file for every zone, so the order across zones is defined: dnsmasq
// takes the PTR from the first hosts line for an address.
const HOSTS_FILE = 'records.hosts';

export function regenerateHostsDir(db) {
  const byAddress = servedHostsByAddress(loadDnsZones(db));
  const lines = [...byAddress.keys()]
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .flatMap((ip) => byAddress.get(ip).map(({ fqdn }) => `${ip} ${fqdn}`));
  const filePath = path.join(HOSTS_DIR, HOSTS_FILE);
  let changed;
  if (lines.length) {
    changed = writeIfChanged(filePath, lines.join('\n') + '\n');
  } else {
    changed = fs.existsSync(filePath);
    if (changed) fs.unlinkSync(filePath);
  }
  // The per-zone files this replaced.
  if (cleanStaleFiles(HOSTS_DIR, 'zone-', '.hosts', new Set())) changed = true;
  return changed;
}

export function regenerateConfDir(db) {
  const model = loadDnsZones(db);
  const { zones } = model;

  const activeIds = new Set();
  let changed = false;
  let hostsCache = null;
  const hostsByAddress = () => (hostsCache ||= servedHostsByAddress(model));

  for (const zone of zones) {
    // Defense in depth: the zone name is interpolated raw into ptr-record= and
    // the SOA comment below. The route validates it, but this writer is the
    // actual config-injection sink, so it must never trust a stored name.
    // Skip any zone whose name carries characters that could break out of the
    // line or smuggle a directive (a legit name is a domain or dotted-decimal
    // in-addr.arpa, so no whitespace, commas, or control chars).
    if (validateConfigSafeValue(zone.name) != null) continue;

    const ofZone = model.records.filter((r) => r.zoneId === zone.id);
    const records = ofZone.filter((r) => r.type !== 'A' && r.type !== 'AAAA' && r.type !== 'PTR');
    // PTR records with hostname values (not bare-IP placeholders of either
    // family) generate ptr-record= lines.
    const ptrRecords = ofZone.filter((r) => r.type === 'PTR' && !r.placeholder);

    if (records.length === 0 && ptrRecords.length === 0) continue;
    // A PTR the hosts file already answers (its value is the first name for
    // the address there) needs no ptr-record line. Leaving those out keeps
    // generated PTRs out of conf.d, whose changes cost a dnsmasq restart.
    const servedPtrs = ptrRecords.filter((ptr) => {
      const ip = ipForPtrRecord(ptr.name, zone.name);
      return !(ip && hostsByAddress().get(ip)?.[0]?.key === lowerFqdn(ptr.value));
    });
    if (records.length === 0 && servedPtrs.length === 0) continue;

    activeIds.add(zone.id);
    const lines = [];

    // SOA comment for documentation
    if (zone.soa_primary_ns) {
      lines.push(
        `# SOA: ${zone.soa_primary_ns} ${zone.soa_admin_email} ${zone.soa_serial || 1} ${zone.soa_refresh} ${zone.soa_retry} ${zone.soa_expire} ${zone.soa_minimum_ttl}`,
      );
    }

    for (const r of records) {
      const { fqdn } = r;
      switch (r.type) {
        case 'CNAME':
          if (validateConfigSafeValue(r.value) != null) break;
          // The one local record dnsmasq takes a TTL for (servedRecordTtl).
          lines.push(`cname=${fqdn},${r.value}${r.ttl ? ',' + r.ttl : ''}`);
          break;
        case 'MX':
          if (validateConfigSafeValue(r.value) != null) break;
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
          if (validateConfigSafeValue(r.value) != null) break;
          lines.push(`srv-host=${fqdn},${r.value},${r.port},${r.priority || 0},${r.weight || 0}`);
          break;
      }
    }

    // PTR records: ptr-record=<octet>.<zone>,<hostname>. Skip any row whose
    // name or value doesn't pass the sanitizer, they would only emit if
    // someone bypassed the route validator or edited the DB directly.
    for (const ptr of servedPtrs) {
      if (!isValidPtrName(ptr.name)) continue;
      if (validateConfigSafeValue(ptr.value) != null) continue;
      lines.push(`ptr-record=${ptr.name}.${zone.name},${ptr.value}`);
    }

    const filePath = path.join(CONF_DIR, `zone-${zone.id}.conf`);
    const newContent = lines.join('\n') + '\n';

    // Comment-only deltas (the SOA serial above) rewrite the file but do NOT
    // count as a change, so lease churn stops restarting dnsmasq.
    if (writeIfChanged(filePath, newContent)) changed = true;
  }

  if (cleanStaleFiles(CONF_DIR, 'zone-', '.conf', activeIds)) changed = true;
  if (writeLocalZones(zones)) changed = true;

  return changed;
}

// Every enabled zone answers the names under it itself (local=/zone/), so a
// name or type CIDRella has no record for gets NXDOMAIN or NODATA here rather
// than a trip upstream: the AAAA and HTTPS lookups browsers send for a host with
// only an A record would otherwise end at the domain's public nameservers. A
// zone with forward_unknown set still forwards them (split horizon). local=
// only stops forwarding; hostsdir and the zone lines answer as before.
const LOCAL_ZONES_FILE = path.join(CONF_DIR, 'local-zones.conf');

function writeLocalZones(zones) {
  const lines = zones
    .filter((zone) => !zone.forward_unknown && validateConfigSafeValue(zone.name) == null)
    .map((zone) => `local=/${zone.name}/`)
    .sort();
  if (lines.length) return writeIfChanged(LOCAL_ZONES_FILE, lines.join('\n') + '\n');
  if (!fs.existsSync(LOCAL_ZONES_FILE)) return false;
  fs.rmSync(LOCAL_ZONES_FILE, { force: true });
  return true;
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

// The TTL dnsmasq answers local records with. Hosts files carry no TTL and
// mx-host, txt-record, srv-host and ptr-record take none, so everything but a
// CNAME with its own TTL is served with this. dnsmasq's default of 0 made
// clients look the name up again on every request.
export const LOCAL_TTL = LOCAL_RECORD_TTL;

/** The TTL dnsmasq serves `record` ({type, ttl}) with. */
export function servedRecordTtl(record) {
  return record.type === 'CNAME' && record.ttl ? record.ttl : LOCAL_TTL;
}

// What CIDRella's own dnsmasq answers beyond its records. no-hosts keeps the
// appliance's /etc/hosts off the network: Proxmox and Debian map the host's own
// name to 127.0.1.1 there, which dnsmasq would otherwise hand to every client
// next to the real addresses. These live in dnsmasq.conf, not conf.d, because
// the installer's include mode points a host's own dnsmasq at conf.d.
const LOCAL_ANSWER_LINES = ['no-hosts', `local-ttl=${LOCAL_TTL}`];

/** The local=/domain/ lines for the reserved names, given where queries go. */
export function reservedLocalLines({ addresses = [] } = {}) {
  return reservedLocalDomains({ addresses }).map((domain) => `local=/${domain}/`);
}

function isManagedLocalAnswerLine(line) {
  const t = line.trim();
  const local = /^local=\/([^/]+)\/$/.exec(t);
  return (
    t === 'no-hosts' || /^local-ttl=/.test(t) || (!!local && MANAGED_LOCAL_DOMAINS.has(local[1]))
  );
}

export function regenerateDnsmasqConf(_db) {
  if (!fs.existsSync(DNSMASQ_CONF)) return false;

  const dnssecEnabled = getSetting('dnssec_enabled') === 'true';
  const noRecursion = getSetting('dns_no_recursion') === 'true';

  const content = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
  const lines = content.split('\n');
  // Strip existing server= lines and any DNSSEC-managed lines so regen is
  // idempotent regardless of which setting changed.
  const filtered = lines.filter(
    (line) =>
      !/^server=/.test(line) && !isManagedDnssecLine(line) && !isManagedLocalAnswerLine(line),
  );

  // Insert server lines after no-resolv or at the start. When recursion is
  // disabled, emit NO upstreams (authoritative-only). Otherwise send everything
  // to the in-Node forwarder stub on loopback, in every mode: it picks the
  // resolver (primary, backup, turns) and speaks plain DNS, DoT or DoH to it.
  const noResolvIdx = filtered.findIndex((l) => l.trim() === 'no-resolv');
  const insertIdx = noResolvIdx >= 0 ? noResolvIdx + 1 : 0;
  const serverLines = noRecursion ? [] : [`server=127.0.0.1#${ENCRYPTED_FORWARDER_PORT}`];
  const localLines = reservedLocalLines({ addresses: forwardedAddresses({ noRecursion }) });
  filtered.splice(insertIdx, 0, ...LOCAL_ANSWER_LINES, ...localLines, ...serverLines);

  // Append the DNSSEC block when enabled and the local dnsmasq supports it.
  if (dnssecEnabled) {
    if (dnsmasqSupportsDnssec()) {
      filtered.push(...buildDnssecLines());
    } else {
      console.warn(
        '[dnsmasq] dnssec_enabled is true but dnsmasq was not built with DNSSEC support, skipping DNSSEC directives',
      );
    }
  }

  // Skip the write when nothing changed so callers (boot especially) can skip
  // the dnsmasq restart. Same changed-boolean convention as the other writers here.
  return writeIfChanged(DNSMASQ_CONF, filtered.join('\n'));
}

const dnsmasqUnit = createUnitControl({
  unit: 'cidrella-dnsmasq',
  processName: 'dnsmasq',
  pidFile: DNSMASQ_PID,
  restartPendingFile: RESTART_PENDING,
  disableFile: DISABLE_FILE,
});

// Stopped when another stack takes DNS and DHCP; restartDnsmasq() clears
// the flag again.
export const stopDnsmasq = () => dnsmasqUnit.stop();
export const awaitDnsmasqStopped = (opts) => dnsmasqUnit.awaitStopped(opts);

// Liveness of OUR dnsmasq specifically (DNSMASQ-05): libvirt, LXD and
// NetworkManager all spawn their own dnsmasq.
export const isCidrellaDnsmasqRunning = () => dnsmasqUnit.isRunning();

// Does CIDRella run dnsmasq here (cidrella-dnsmasq.service, or s6)?
export const dnsmasqUnitInstalled = () => dnsmasqUnit.installed();

// True when a previous restartDnsmasq() could not complete. The boot path
// checks this so change-detection can't skip the restart that would heal a
// stale-loaded config.
export const dnsmasqRestartPending = () => dnsmasqUnit.restartPending();

// cidrella-dnsmasq.service has ExecReload=/bin/kill -HUP $MAINPID (v0.4.11).
export function signalDnsmasq() {
  validateDnsmasqConfig();
  dnsmasqUnit.reload();
}

export function restartDnsmasq() {
  validateDnsmasqConfig();
  dnsmasqUnit.restart();
}

export function applyInterfaceConfig(_db) {
  if (!fs.existsSync(DNSMASQ_CONF)) return false;

  const content = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
  const lines = content.split('\n');

  // Strip existing interface-related directives (not comments)
  const filtered = lines.filter((line) => {
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
  } catch {
    /* use default */
  }

  try {
    const val = getSetting('dns_enabled');
    if (val === 'false') dnsEnabled = false;
  } catch {
    /* use default */
  }

  try {
    const val = getSetting('dhcp_enabled');
    if (val === 'false') dhcpEnabled = false;
  } catch {
    /* use default */
  }

  // Check for proxy bypass mode, dnsmasq takes over port 53 on LAN IPs
  let proxyBypass = false;
  try {
    const val = getSetting('dns_proxy_bypass');
    if (val === 'true') proxyBypass = true;
  } catch {
    /* use default */
  }

  const sysIfaces = os.networkInterfaces();

  // Normal mode: dnsmasq DNS listens on localhost:5353 only, proxy handles
  //   LAN-facing DNS on the configured `dns_listen_port` (default 53).
  // Bypass mode: proxy is dead, dnsmasq listens on `dns_listen_port` + LAN IPs directly.
  // DHCP always needs interface= directives for LAN interfaces.
  // backendDnsPort is shared with the PowerDNS adapter and the stack switch.
  let listenPort = null;
  try {
    listenPort = getSetting('dns_listen_port');
  } catch {
    /* default 53 */
  }
  const dnsPort = backendDnsPort({ listenPort, bypass: proxyBypass, enabled: dnsEnabled }) ?? 0;
  const newDirectives = ['bind-dynamic', 'listen-address=127.0.0.1', `port=${dnsPort}`];
  if (ipv6Enabled() && sysIfaces.lo?.some((a) => a.family === 'IPv6')) {
    newDirectives.push('listen-address=::1');
  }
  // Interface SELECTION is shared with dns-proxy.js and dhcp-probe.js so the
  // three cannot disagree about which interfaces are in play (audit #9). The
  // directive emission below is dnsmasq's alone and stays here. 'any' because
  // dnsmasq needs an interface= line for a DNS-only interface too.
  const { explicit: hasExplicitConfig, names: selectedIfNames } = selectInterfaceNames('any', {
    config: ifaceConfig,
    sysIfaces,
  });

  if (hasExplicitConfig) {
    for (const ifName of selectedIfNames) {
      const cfg = ifaceConfig[ifName];
      // interface= needed for DHCP binding (and DNS in bypass mode)
      newDirectives.push(`interface=${ifName}`);
      // In bypass mode, dnsmasq also needs listen-address for DNS on LAN IPs
      if (proxyBypass && cfg.dns && dnsEnabled) {
        for (const address of listenableAddresses(sysIfaces[ifName])) {
          newDirectives.push(`listen-address=${address}`);
        }
      }
      if (!cfg.dhcp || !dhcpEnabled) {
        newDirectives.push(`no-dhcp-interface=${ifName}`);
      }
    }
  } else {
    // Fresh deploy, bind DHCP to all real interfaces
    for (const ifName of selectedIfNames) {
      const addrs = sysIfaces[ifName] || [];
      if (dhcpEnabled) {
        newDirectives.push(`interface=${ifName}`);
      } else {
        newDirectives.push(`no-dhcp-interface=${ifName}`);
      }
      // In bypass mode, add listen-address for DNS on LAN IPs
      if (proxyBypass && dnsEnabled) {
        for (const address of listenableAddresses(addrs)) {
          newDirectives.push(`listen-address=${address}`);
        }
      }
    }
  }

  // Place the block just above the DNSSEC block, which regenerateDnsmasqConf
  // keeps at the end. Appending below it moved the DNSSEC lines on every
  // write, so each writer saw a directive change in the other's output and a
  // reboot (or an Interfaces save) with DNSSEC on restarted dnsmasq for nothing
  // (DNSMASQ-03). With this order the file is a fixed point for both writers.
  const dnssecIdx = filtered.findIndex(isManagedDnssecLine);
  filtered.splice(dnssecIdx >= 0 ? dnssecIdx : filtered.length, 0, ...newDirectives);

  // Same changed-boolean convention as regenerateDnsmasqConf.
  return writeIfChanged(DNSMASQ_CONF, filtered.join('\n'));
}
