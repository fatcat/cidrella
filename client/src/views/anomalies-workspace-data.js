// Sample data for the anomaly triage concept (AnomaliesWorkspacePreview.vue).
// Nothing here touches the API. The numbers are invented but the vocabulary is
// not: feature keys match server/anomaly/config.py FEATURE_NAMES, labels match
// FEATURE_LABELS, and the score scale matches the isolation forest thresholds
// in that same file (flag at -0.50, high severity at -0.60).
//
// The concept's premise: the detector scores "unusual for this device", which
// is not the same axis as "dangerous". Every device here carries both, so the
// triage map can separate them.
import { EMPTY_CELL } from '../utils/format.js';

export const FEATURES = {
  entropy: {
    key: 'avg_domain_entropy',
    label: 'High-entropy domains (possible DGA)',
    unit: 'bits',
    kind: 'decimal',
  },
  nxdomain: { key: 'nxdomain_ratio', label: 'High NXDOMAIN rate', kind: 'ratio' },
  newDomain: { key: 'new_domain_ratio', label: 'Never-before-seen domains', kind: 'ratio' },
  depth: {
    key: 'subdomain_depth_mean',
    label: 'Deep subdomain nesting',
    unit: 'labels',
    kind: 'decimal',
  },
  nameLength: {
    key: 'max_domain_length',
    label: 'Unusually long domain names',
    unit: 'chars',
    kind: 'count',
  },
  queryCount: { key: 'query_count', label: 'Abnormal query volume', kind: 'count' },
  burst: { key: 'burst_ratio', label: 'Bursty query pattern', unit: '×', kind: 'decimal' },
  otherTypes: { key: 'type_other_ratio', label: 'Non-A/AAAA query types', kind: 'ratio' },
  blocked: { key: 'block_ratio', label: 'High blocked query rate', kind: 'ratio' },
  resolvedIps: {
    key: 'unique_resolved_ips',
    label: 'Unusual number of resolved IPs',
    kind: 'count',
  },
  hourOfDay: { key: 'hour_sin', label: 'Unusual time of day', kind: 'decimal' },
};

// Severity band drives both the dot color on the map and the stripe in the
// queue. Kept separate from `severity` because a low-severity device can still
// sit in a band worth drawing attention to (steady tunnel shape, for example).
export const BAND_COLORS = {
  critical: 'var(--cid-red-400)',
  suspicious: 'var(--cid-orange-400)',
  unusual: 'var(--cid-yellow-500)',
  quiet: 'var(--cid-green-400)',
};

export const REVIEW_DEVICES = [
  {
    id: 'basement-nas',
    name: 'basement-nas',
    ip: '10.0.3.44',
    mac: '9c:8e:cd:1a:77:02',
    role: 'Storage server',
    owner: 'DHCP reservation',
    urgency: 94,
    deviation: 88,
    threatShape: 91,
    severity: 'high',
    pattern: 'escalating',
    rawScore: -0.71,
    flaggedWindows: 9,
    queries: 4180,
    band: 'critical',
    trainingWindows: 168,
    why: 'Queries 2,300 never-seen subdomains under one parent, 61% NXDOMAIN, at 03:00.',
    tags: ['DGA-like', 'NXDOMAIN storm', 'off-hours'],
    verdictLede: 'This is the one to look at first.',
    verdict:
      'Three independent signals moved together and stayed moved for nine windows. High entropy plus a NXDOMAIN majority plus fresh subdomains under a single parent is the shape of domain generation, or of a tunnel using the resolver as transport. The device is a file server that normally queries 40 domains a day.',
    signals: [
      { feature: FEATURES.entropy, observed: 3.91, baseline: 2.14, peer: 2.2, contribution: 0.34 },
      {
        feature: FEATURES.nxdomain,
        observed: 0.61,
        baseline: 0.02,
        peer: 0.04,
        contribution: 0.29,
      },
      {
        feature: FEATURES.newDomain,
        observed: 0.78,
        baseline: 0.05,
        peer: 0.11,
        contribution: 0.18,
      },
      {
        feature: FEATURES.queryCount,
        observed: 4180,
        baseline: 210,
        peer: 340,
        contribution: 0.12,
      },
    ],
    evidence: [
      { domain: 'k3f9xq2mvb.cdn-sync.net', type: 'A', response: 'NXDOMAIN', count: 214 },
      { domain: 'p8wzr4nt1c.cdn-sync.net', type: 'A', response: 'NXDOMAIN', count: 198 },
      { domain: 'm2jhy7bd6q.cdn-sync.net', type: 'A', response: 'NXDOMAIN', count: 188 },
      { domain: 'x9vlp3ks0a.cdn-sync.net', type: 'A', response: 'NOERROR', count: 171 },
      { domain: 'update.synology.com', type: 'A', response: 'NOERROR', count: 12 },
    ],
  },
  {
    id: 'cam-garage',
    name: 'cam-garage',
    ip: '10.0.7.18',
    mac: '3c:84:6a:09:11:be',
    role: 'IP camera',
    owner: 'DHCP lease',
    urgency: 81,
    deviation: 42,
    threatShape: 86,
    severity: 'high',
    pattern: 'recurring',
    rawScore: -0.58,
    flaggedWindows: 14,
    queries: 980,
    band: 'suspicious',
    trainingWindows: 168,
    why: 'Long TXT lookups with 5-label nesting, every night since firmware 2.4.1 landed.',
    tags: ['tunnel shape', 'TXT heavy', 'recurring'],
    verdictLede: 'Suspicious shape, but it has always done this.',
    verdict:
      'Deviation from its own baseline is low, which is exactly why the current page buries it: the camera has behaved this way since the firmware update, so the model learned it as normal. The shape has not become normal. TXT records at 5 label depth with 180 character names is a textbook DNS tunnel, and this vendor has no legitimate reason to use TXT at all.',
    signals: [
      {
        feature: FEATURES.otherTypes,
        observed: 0.74,
        baseline: 0.71,
        peer: 0.03,
        contribution: 0.31,
      },
      { feature: FEATURES.nameLength, observed: 182, baseline: 176, peer: 41, contribution: 0.27 },
      { feature: FEATURES.depth, observed: 5.1, baseline: 4.9, peer: 2.1, contribution: 0.22 },
      { feature: FEATURES.burst, observed: 3.4, baseline: 3.1, peer: 1.2, contribution: 0.09 },
    ],
    evidence: [
      {
        domain: 'aG9tZS1jYW0tMDkxMWJl.q4.tun.vstream-io.cc',
        type: 'TXT',
        response: 'NOERROR',
        count: 96,
      },
      {
        domain: 'ZnJhbWUtc2VnLTAwNDIx.q4.tun.vstream-io.cc',
        type: 'TXT',
        response: 'NOERROR',
        count: 94,
      },
      {
        domain: 'c3RhdHVzLXBpbmctMDAx.q4.tun.vstream-io.cc',
        type: 'TXT',
        response: 'NOERROR',
        count: 91,
      },
      { domain: 'pool.ntp.org', type: 'A', response: 'NOERROR', count: 24 },
    ],
  },
  {
    id: 'dan-thinkpad',
    name: 'dan-thinkpad',
    ip: '10.0.1.22',
    mac: '48:e7:da:4c:90:7f',
    role: 'Laptop',
    owner: 'DHCP lease',
    urgency: 63,
    deviation: 79,
    threatShape: 44,
    severity: 'medium',
    pattern: 'one-off',
    rawScore: -0.54,
    flaggedWindows: 2,
    queries: 2640,
    band: 'unusual',
    trainingWindows: 168,
    why: 'Volume 12× baseline for two windows, 300 new domains, all resolving normally.',
    tags: ['volume spike', 'new domains'],
    verdictLede: 'Unusual, probably you.',
    verdict:
      'A big spike in volume and new domains with a normal NXDOMAIN rate and ordinary name shapes. That combination is what a package install, a fresh browser profile or a docs crawl looks like. Two windows, then back to baseline. Worth a glance at the evidence, not worth an evening.',
    signals: [
      {
        feature: FEATURES.queryCount,
        observed: 2640,
        baseline: 220,
        peer: 380,
        contribution: 0.41,
      },
      {
        feature: FEATURES.newDomain,
        observed: 0.52,
        baseline: 0.09,
        peer: 0.12,
        contribution: 0.28,
      },
      { feature: FEATURES.resolvedIps, observed: 412, baseline: 61, peer: 88, contribution: 0.16 },
      {
        feature: FEATURES.hourOfDay,
        observed: 0.31,
        baseline: 0.62,
        peer: 0.58,
        contribution: 0.07,
      },
    ],
    evidence: [
      { domain: 'registry.npmjs.org', type: 'A', response: 'NOERROR', count: 611 },
      { domain: 'objects.githubusercontent.com', type: 'A', response: 'NOERROR', count: 402 },
      { domain: 'deb.debian.org', type: 'A', response: 'NOERROR', count: 288 },
      { domain: 'fonts.gstatic.com', type: 'AAAA', response: 'NOERROR', count: 96 },
    ],
  },
  {
    id: 'living-room-tv',
    name: 'living-room-tv',
    ip: '10.0.1.65',
    mac: 'd4:9d:c0:38:21:aa',
    role: 'Smart TV',
    owner: 'DHCP lease',
    urgency: 58,
    deviation: 34,
    threatShape: 72,
    severity: 'medium',
    pattern: 'recurring',
    rawScore: -0.51,
    flaggedWindows: 11,
    queries: 1870,
    band: 'suspicious',
    trainingWindows: 168,
    why: '38% of queries blocked, 190 distinct telemetry hosts, constant since install.',
    tags: ['block rate', 'telemetry'],
    verdictLede: 'Noisy by design.',
    verdict:
      'A high block rate on a smart TV is the blocklist doing its job, not an intrusion. This is the best candidate for a per-signal suppression: mute blocked query rate for this device and it stops competing for your attention, while entropy and tunnel shape stay armed.',
    signals: [
      { feature: FEATURES.blocked, observed: 0.38, baseline: 0.31, peer: 0.06, contribution: 0.44 },
      {
        feature: FEATURES.queryCount,
        observed: 1870,
        baseline: 1410,
        peer: 380,
        contribution: 0.21,
      },
      {
        feature: FEATURES.newDomain,
        observed: 0.14,
        baseline: 0.08,
        peer: 0.12,
        contribution: 0.11,
      },
    ],
    evidence: [
      { domain: 'metrics.samsungacr.com', type: 'A', response: 'BLOCKED', count: 311 },
      { domain: 'log-config.tvsvc.net', type: 'A', response: 'BLOCKED', count: 274 },
      { domain: 'ads.samsungads.com', type: 'A', response: 'BLOCKED', count: 219 },
      { domain: 'api.netflix.com', type: 'A', response: 'NOERROR', count: 88 },
    ],
  },
  {
    id: 'hvac-controller',
    name: 'hvac-controller',
    ip: '10.0.7.31',
    mac: '00:1e:c0:55:3d:12',
    role: 'Building control',
    owner: 'Static address',
    urgency: 55,
    deviation: 71,
    threatShape: 39,
    severity: 'medium',
    pattern: 'escalating',
    rawScore: -0.52,
    flaggedWindows: 4,
    queries: 520,
    band: 'unusual',
    trainingWindows: 168,
    why: 'Started resolving a second vendor domain three days ago, climbing since.',
    tags: ['new destination', 'climbing'],
    verdictLede: 'Small change, wrong direction.',
    verdict:
      'A device that queried one hostname for eleven months now queries two, and the new one has been climbing every day. Nothing about the traffic is attack shaped, so the threat axis stays low. It still deserves a look, because a controller that changed its mind about where to phone home did so for a reason.',
    signals: [
      {
        feature: FEATURES.newDomain,
        observed: 0.34,
        baseline: 0.0,
        peer: 0.11,
        contribution: 0.48,
      },
      { feature: FEATURES.queryCount, observed: 520, baseline: 180, peer: 340, contribution: 0.22 },
      { feature: FEATURES.resolvedIps, observed: 14, baseline: 3, peer: 88, contribution: 0.1 },
    ],
    evidence: [
      { domain: 'cloud.ecobee.com', type: 'A', response: 'NOERROR', count: 240 },
      { domain: 'iot-relay.hv-partner.io', type: 'A', response: 'NOERROR', count: 188 },
      { domain: 'pool.ntp.org', type: 'A', response: 'NOERROR', count: 61 },
    ],
  },
  {
    id: 'office-printer',
    name: 'office-printer',
    ip: '10.0.1.90',
    mac: '3c:2a:f4:71:0c:55',
    role: 'Printer',
    owner: 'DHCP reservation',
    urgency: 51,
    deviation: 66,
    threatShape: 41,
    severity: 'medium',
    pattern: 'one-off',
    rawScore: -0.5,
    flaggedWindows: 1,
    queries: 310,
    band: 'unusual',
    trainingWindows: 168,
    why: 'One window of SRV and PTR discovery traffic it has never generated before.',
    tags: ['query type shift'],
    verdictLede: 'One window, then quiet.',
    verdict:
      'SRV and PTR bursts from a printer usually mean something on the network started a discovery sweep and the printer answered in kind. Check whether a new device joined the same VLAN in that hour before treating it as the printer misbehaving.',
    signals: [
      {
        feature: FEATURES.otherTypes,
        observed: 0.66,
        baseline: 0.04,
        peer: 0.03,
        contribution: 0.52,
      },
      { feature: FEATURES.queryCount, observed: 310, baseline: 44, peer: 340, contribution: 0.19 },
    ],
    evidence: [
      { domain: '_ipp._tcp.local', type: 'SRV', response: 'NOERROR', count: 84 },
      { domain: '90.1.0.10.in-addr.arpa', type: 'PTR', response: 'NXDOMAIN', count: 71 },
      { domain: '_pdl-datastream._tcp.local', type: 'SRV', response: 'NOERROR', count: 55 },
    ],
  },
];

// Devices inside baseline. They carry no signals or evidence: they exist so the
// map reads as a view of the network rather than a list of alarms.
export const QUIET_DEVICES = [
  {
    id: 'kitchen-echo',
    name: 'kitchen-echo',
    ip: '10.0.1.77',
    role: 'Voice assistant',
    urgency: 18,
    deviation: 22,
    threatShape: 19,
    rawScore: -0.21,
    flaggedWindows: 0,
    queries: 640,
    pattern: 'quiet',
    band: 'quiet',
  },
  {
    id: 'pixel-9',
    name: 'pixel-9',
    ip: '10.0.1.31',
    role: 'Phone',
    urgency: 15,
    deviation: 31,
    threatShape: 12,
    rawScore: -0.18,
    flaggedWindows: 0,
    queries: 1120,
    pattern: 'quiet',
    band: 'quiet',
  },
  {
    id: 'workshop-pi',
    name: 'workshop-pi',
    ip: '10.0.3.12',
    role: 'Single-board',
    urgency: 24,
    deviation: 38,
    threatShape: 26,
    rawScore: -0.29,
    flaggedWindows: 1,
    queries: 410,
    pattern: 'quiet',
    band: 'quiet',
  },
  {
    id: 'garage-door',
    name: 'garage-door',
    ip: '10.0.7.22',
    role: 'IoT',
    urgency: 12,
    deviation: 14,
    threatShape: 21,
    rawScore: -0.15,
    flaggedWindows: 0,
    queries: 120,
    pattern: 'quiet',
    band: 'quiet',
  },
  {
    id: 'ipad-kitchen',
    name: 'ipad-kitchen',
    ip: '10.0.1.58',
    role: 'Tablet',
    urgency: 20,
    deviation: 28,
    threatShape: 24,
    rawScore: -0.24,
    flaggedWindows: 0,
    queries: 880,
    pattern: 'quiet',
    band: 'quiet',
  },
  {
    id: 'solar-inverter',
    name: 'solar-inverter',
    ip: '10.0.7.40',
    role: 'Solar',
    urgency: 27,
    deviation: 19,
    threatShape: 44,
    rawScore: -0.31,
    flaggedWindows: 2,
    queries: 260,
    pattern: 'quiet',
    band: 'quiet',
  },
  {
    id: 'sonos-den',
    name: 'sonos-den',
    ip: '10.0.1.44',
    role: 'Speaker',
    urgency: 22,
    deviation: 26,
    threatShape: 33,
    rawScore: -0.26,
    flaggedWindows: 1,
    queries: 540,
    pattern: 'quiet',
    band: 'quiet',
  },
  {
    id: 'guest-laptop',
    name: 'guest-laptop',
    ip: '10.0.9.14',
    role: 'Guest',
    urgency: 33,
    deviation: 58,
    threatShape: 22,
    rawScore: null,
    flaggedWindows: 0,
    queries: 720,
    pattern: 'learning',
    band: 'quiet',
    trainingWindows: 19,
  },
  {
    id: 'roomba',
    name: 'roomba',
    ip: '10.0.7.51',
    role: 'IoT',
    urgency: 11,
    deviation: 12,
    threatShape: 17,
    rawScore: -0.12,
    flaggedWindows: 0,
    queries: 90,
    pattern: 'quiet',
    band: 'quiet',
  },
  {
    id: 'nvr-front',
    name: 'nvr-front',
    ip: '10.0.7.9',
    role: 'NVR',
    urgency: 29,
    deviation: 24,
    threatShape: 49,
    rawScore: -0.33,
    flaggedWindows: 2,
    queries: 1450,
    pattern: 'quiet',
    band: 'quiet',
  },
  {
    id: 'switch-core',
    name: 'switch-core',
    ip: '10.0.0.2',
    role: 'Switch',
    urgency: 9,
    deviation: 8,
    threatShape: 11,
    rawScore: -0.09,
    flaggedWindows: 0,
    queries: 60,
    pattern: 'quiet',
    band: 'quiet',
  },
  {
    id: 'steam-deck',
    name: 'steam-deck',
    ip: '10.0.1.83',
    role: 'Console',
    urgency: 26,
    deviation: 44,
    threatShape: 18,
    rawScore: -0.28,
    flaggedWindows: 1,
    queries: 930,
    pattern: 'quiet',
    band: 'quiet',
  },
];

export const ALL_DEVICES = [...REVIEW_DEVICES, ...QUIET_DEVICES];

export const DETECTOR_STATUS = {
  needsReview: REVIEW_DEVICES.length,
  flaggedWindows: 45,
  monitored: 62,
  learning: 9,
  lastScored: '14m ago',
  lastTrained: '3h ago',
  heartbeat: '42s',
};

export const BACKEND_NOTES = [
  {
    title: 'Already in the database',
    body: 'Hourly score, severity, top three signals with observed and baseline values, model state and training window count.',
    ref: 'anomaly_scores, 30 day retention',
  },
  {
    title: 'Needs a new endpoint',
    body: 'The evidence table. Domains, query types and response codes for one client in one window are kept for 7 days and never surfaced today.',
    ref: 'DuckDB dns_queries',
  },
  {
    title: 'Needs a schema change',
    body: 'The peer median column needs the full 20 feature vector per window, not just the top three the explainer keeps.',
    ref: 'new table, 20 floats per device per hour',
  },
  {
    title: 'Needs a definition',
    body: 'Threat shape is a rule score over entropy, NXDOMAIN rate, name length, subdomain depth and block rate. Independent of the model, which is why the two axes disagree.',
    ref: 'scored alongside the model, not by it',
  },
];

// Isolation forest scores run from roughly 0 (typical) to -0.85 (extreme).
// Both the sparkline and the detail chart map that range onto pixels.
export const SCORE_FLOOR = -0.85;
export const SCORE_CEILING = -0.02;
export const FLAG_THRESHOLD = -0.5;

// Deterministic 48 hour history per device. Hand-typing 48 numbers for every
// device would bloat this file for no gain, and a random series would jump on
// every re-render, so the series is seeded from the device id and the shape
// comes from its pattern.
export function scoreSeries(device) {
  let seed = 0;
  for (const char of device.id) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const peak = device.rawScore ?? -0.55;
  const out = [];
  for (let hour = 0; hour < 48; hour++) {
    const calm = -0.18 - random() * 0.1;
    let value = calm;
    if (device.pattern === 'escalating') {
      const ramp = Math.max(0, (hour - 26) / 21);
      value = calm + ramp * (peak - calm) * (0.75 + random() * 0.35);
    } else if (device.pattern === 'recurring') {
      const hourOfDay = hour % 24;
      value = hourOfDay >= 1 && hourOfDay <= 5 ? peak * (0.85 + random() * 0.2) : calm;
    } else if (device.pattern === 'one-off') {
      value = hour >= 39 && hour <= 41 ? peak * (0.9 + random() * 0.15) : calm;
    }
    out.push(Math.max(SCORE_FLOOR, Math.min(SCORE_CEILING, value)));
  }
  return out;
}

export function formatSignalValue(feature, value) {
  if (value == null) return EMPTY_CELL;
  if (feature.kind === 'ratio') return `${(value * 100).toFixed(1)}%`;
  if (feature.kind === 'count') return Math.round(value).toLocaleString();
  return value.toFixed(2) + (feature.unit ? ` ${feature.unit}` : '');
}
