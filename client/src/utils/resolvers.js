/**
 * The primary and backup resolver pickers on Settings > DNS. A selection is
 * { choice, custom }: `choice` is a preset id, 'custom' or 'none' (backup
 * only), and `custom` holds what the custom fields hold for either mode:
 * `servers` ([{ ip, status }], plaintext) and `hostname`, `addresses` (a
 * comma list) and `doh_url` (encrypted). Presets come from GET
 * /api/dns/encryption's `providers`; they serve plaintext too.
 */
import { canonicalizeIp } from './ip.js';

export const NONE = 'none';
export const CUSTOM = 'custom';

export function emptyCustom() {
  return { servers: [{ ip: '', status: null }], hostname: '', addresses: '', doh_url: '' };
}

export function selection(choice, custom = {}) {
  return { choice, custom: { ...emptyCustom(), ...custom } };
}

const canonical = (ip) => canonicalizeIp(ip) ?? ip;
const sameAddresses = (a, b) =>
  a.length === b.length &&
  [...a].map(canonical).sort().join() === [...b].map(canonical).sort().join();

/** The selection a saved plaintext address list stands for. */
export function plainSelection(providers, addresses = [], { allowNone = false } = {}) {
  if (!addresses.length) return allowNone ? selection(NONE) : selection(CUSTOM);
  const preset = providers.find((p) => sameAddresses(p.addresses, addresses));
  if (preset) return selection(preset.id);
  return selection(CUSTOM, { servers: addresses.map((ip) => ({ ip, status: null })) });
}

/** The selection a saved encrypted upstream stands for. */
export function encryptedSelection(providers, upstream, { allowNone = false } = {}) {
  if (!upstream) return allowNone ? selection(NONE) : selection(providers[0]?.id ?? CUSTOM);
  const host = String(upstream.hostname || '').toLowerCase();
  const preset = providers.find((p) => p.hostname.toLowerCase() === host);
  if (preset) return selection(preset.id);
  return selection(CUSTOM, {
    hostname: upstream.hostname || '',
    addresses: (upstream.addresses || []).join(', '),
    doh_url: upstream.doh_url || '',
  });
}

const splitList = (text) =>
  String(text)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** The plaintext addresses a selection forwards to; [] for none. */
export function plainAddresses(providers, sel) {
  if (sel.choice === NONE) return [];
  if (sel.choice === CUSTOM) return sel.custom.servers.map((s) => s.ip.trim()).filter(Boolean);
  return [...(providers.find((p) => p.id === sel.choice)?.addresses || [])];
}

/** The encrypted upstream a selection stands for, or null for none. */
export function encryptedUpstream(providers, sel) {
  if (sel.choice === NONE) return null;
  if (sel.choice === CUSTOM) {
    return {
      label: 'Custom',
      hostname: sel.custom.hostname.trim(),
      addresses: splitList(sel.custom.addresses),
      doh_url: sel.custom.doh_url.trim(),
    };
  }
  const p = providers.find((x) => x.id === sel.choice);
  return p
    ? { label: p.label, hostname: p.hostname, addresses: p.addresses, doh_url: p.doh_url }
    : null;
}

/** A comparable form of a selection, for the Save button's dirty check. */
export function selectionKey(providers, sel, encrypted) {
  if (sel.choice !== CUSTOM) return sel.choice;
  return encrypted
    ? JSON.stringify(encryptedUpstream(providers, sel))
    : JSON.stringify(plainAddresses(providers, sel).map(canonical));
}

/**
 * The custom resolvers in the form, as the performance test takes them:
 * only complete ones, so a half-typed field does not fail the whole test.
 */
export function customCandidates(providers, selections, mode) {
  const encrypted = mode !== 'off';
  return selections
    .filter((sel) => sel.choice === CUSTOM)
    .map((sel) =>
      encrypted ? encryptedUpstream(providers, sel) : { addresses: plainAddresses(providers, sel) },
    )
    .filter(
      (c) =>
        c.addresses.length > 0 &&
        (!encrypted || (c.hostname && (mode !== 'https' || /^https:\/\//.test(c.doh_url)))),
    );
}

/** The selection a performance test result row stands for. */
export function resultSelection(row, encrypted) {
  if (row.preset) return selection(row.id);
  return encrypted
    ? selection(CUSTOM, {
        hostname: row.hostname,
        addresses: row.addresses.join(', '),
        doh_url: row.doh_url || '',
      })
    : selection(CUSTOM, { servers: row.addresses.map((ip) => ({ ip, status: null })) });
}
