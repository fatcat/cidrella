#!/usr/bin/env node
'use strict';
/**
 * Guard: the same class rule must not be declared, byte for byte, in more
 * than one scoped <style> block.
 *
 * Scoped styles are private to a component on purpose, so copying `.muted {
 * color: var(--cid-text-muted-color); }` into eleven files is what the tool
 * makes easy. Then one copy changes and the other ten do not. A rule that is
 * identical in two files is by definition shared, and belongs in one of the
 * shared sheets (client/src/assets/*.css) or App.vue.
 *
 * Only byte-identical bodies count (whitespace ignored). Two rules with the
 * same name and different bodies may be the same idea drifting apart, or may
 * be two ideas that happen to share a name; that is a judgement call, so it is
 * reported with --drift but never fails the build.
 *
 * BASELINE: the copies that existed when the guard was written are listed by
 * class name and file set, so this passes today and fails on any NEW copy.
 * Moving a rule into a shared sheet means deleting its baseline entry. Adding
 * an entry to silence a new finding defeats the guard.
 *
 * Usage: node scripts/check-scoped-css-dupes.js [--drift] [project-dir]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const showDrift = args.includes('--drift');
const PROJECT_DIR = path.resolve(
  args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..'),
);
const SCAN_ROOT = path.join(PROJECT_DIR, 'client/src');

// class name -> sorted list of files (relative to client/src) that carry an
// identical body today. A finding matches a baseline entry only when its file
// set is a subset of the listed one, so a copy in a NEW file still fails.
const BASELINE = {
  'available-toggle': ['components/DhcpPanel.vue', 'views/SubnetDetail.vue'],
  board: ['views/Anomalies.vue', 'views/Dashboard.vue'],
  button: [
    'views/networks-workspace/WorkspaceContextHeader.vue',
    'views/networks-workspace/WorkspaceToolbar.vue',
  ],
  'content-card': [
    'views/settings/BackupSettings.vue',
    'views/settings/CertificateSettings.vue',
    'views/settings/LogsSettings.vue',
    'views/settings/NetworkDefaultsSettings.vue',
    'views/settings/NetworkSettings.vue',
  ],
  error: [
    'views/networks-workspace/ApplyStatusBanner.vue',
    'views/networks-workspace/dialogs/IpReservationEditor.vue',
  ],
  eyebrow: [
    'views/networks-workspace/ResourceExplorer.vue',
    'views/networks-workspace/WorkspaceDetailsHost.vue',
  ],
  field: [
    'components/NetworkDialogs.vue',
    'components/PiholeImportPanel.vue',
    'views/settings/BackupSettings.vue',
    'views/settings/CertificateSettings.vue',
    'views/settings/NetworkDefaultsSettings.vue',
    'views/settings/NetworkSettings.vue',
    'views/settings/VlanSettings.vue',
  ],
  'field-help': [
    'views/settings/BackupSettings.vue',
    'views/settings/CertificateSettings.vue',
    'views/settings/NetworkSettings.vue',
  ],
  'form-grid': [
    'components/DhcpPanel.vue',
    'components/NetworkDialogs.vue',
    'components/PiholeImportPanel.vue',
    'views/DHCP.vue',
    'views/SubnetDetail.vue',
    'views/Users.vue',
    'views/settings/NetworkSettings.vue',
    'views/settings/VlanSettings.vue',
  ],
  help: ['components/BackupCodesPanel.vue', 'components/PasswordPolicyEditor.vue'],
  'icon-button': [
    'views/networks-workspace/AddressDetailsPanel.vue',
    'views/networks-workspace/ResourceExplorer.vue',
    'views/networks-workspace/WorkspaceDetailsHost.vue',
  ],
  'network-copy': [
    'views/networks-workspace/ResourceExplorer.vue',
    'views/networks-workspace/ResourceExplorerNode.vue',
  ],
  'network-state': [
    'views/networks-workspace/ResourceExplorer.vue',
    'views/networks-workspace/ResourceExplorerNode.vue',
  ],
  'page-info': ['views/settings/BlocklistSearch.vue', 'views/settings/LogsSettings.vue'],
  'pihole-reachable': ['components/NetworkDialogs.vue', 'components/PiholeImportPanel.vue'],
  'pihole-unreachable': ['components/NetworkDialogs.vue', 'components/PiholeImportPanel.vue'],
  'preview-count': ['components/NetworkDialogs.vue', 'components/PiholeImportPanel.vue'],
  'preview-item': ['components/NetworkDialogs.vue', 'components/PiholeImportPanel.vue'],
  'preview-label': ['components/NetworkDialogs.vue', 'components/PiholeImportPanel.vue'],
  'preview-summary': ['components/NetworkDialogs.vue', 'components/PiholeImportPanel.vue'],
  'quick-actions': [
    'views/networks-workspace/AddressDetailsPanel.vue',
    'views/networks-workspace/WorkspaceDetailsHost.vue',
  ],
  'scan-toggle-group': ['components/ScanToggle.vue', 'views/SubnetDetail.vue'],
  'setting-group': ['views/settings/BackupSettings.vue', 'views/settings/CertificateSettings.vue'],
  'settings-actions': ['views/settings/BackupSettings.vue', 'views/settings/NetworkSettings.vue'],
  'soa-help': ['components/DnsPanel.vue', 'views/DNS.vue'],
  'type-badge': ['components/DhcpPanel.vue', 'components/DnsPanel.vue'],
  'wl-hint': ['views/settings/BlocklistAllowedDomains.vue', 'views/settings/GeoIpAllowedIps.vue'],
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

// { className -> { body -> Set<file> } }
const rules = new Map();
for (const file of walk(SCAN_ROOT)) {
  const rel = path.relative(SCAN_ROOT, file).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');
  const styleRe = /<style[^>]*\bscoped\b[^>]*>([\s\S]*?)<\/style>/g;
  let block;
  while ((block = styleRe.exec(src))) {
    // Top-level single-class rules only: `.name { ... }` at line start.
    const ruleRe = /^\s*\.([a-zA-Z][\w-]*)\s*\{([^}]*)\}/gm;
    let m;
    while ((m = ruleRe.exec(block[1]))) {
      const body = m[2].replace(/\s+/g, '');
      if (!body) continue;
      if (!rules.has(m[1])) rules.set(m[1], new Map());
      const byBody = rules.get(m[1]);
      if (!byBody.has(body)) byBody.set(body, new Set());
      byBody.get(body).add(rel);
    }
  }
}

const failures = [];
const drift = [];
for (const [cls, byBody] of rules) {
  for (const [, files] of byBody) {
    if (files.size < 2) continue;
    const list = [...files].sort();
    const allowed = new Set(BASELINE[cls] || []);
    const newFiles = list.filter((f) => !allowed.has(f));
    if (newFiles.length) failures.push({ cls, files: list, newFiles });
  }
  if (byBody.size > 1) {
    drift.push({
      cls,
      versions: byBody.size,
      files: new Set([...byBody.values()].flatMap((s) => [...s])).size,
    });
  }
}

const scanned = walk(SCAN_ROOT).length;
if (showDrift && drift.length) {
  console.log('Same class name, different bodies (report only):');
  for (const d of drift.sort((a, b) => b.files - a.files)) {
    console.log(`  .${d.cls}: ${d.versions} versions across ${d.files} files`);
  }
  console.log('');
}

if (failures.length) {
  console.error('Identical scoped CSS rule declared in more than one component:');
  for (const f of failures) {
    console.error(`  .${f.cls} in ${f.files.join(', ')}`);
    console.error(`    not in baseline: ${f.newFiles.join(', ')}`);
  }
  console.error(
    '\nMove the rule into a shared sheet under client/src/assets/ (or App.vue) and import it, or, if the copy is already there, delete the scoped one.',
  );
  process.exit(1);
}
console.log(
  `  Scoped-CSS duplicate check OK (${scanned} components, ${Object.keys(BASELINE).length} baselined rules, 0 new)`,
);
