// The service chips of an Analytics status rail, from /api/metrics/services:
// each DNS/DHCP backend by name, the DNS proxy, and how many forwarders
// answer. The Dashboard and Performance both lead their rail with these.

import { backendUnits } from './backend-status.js';

const PROTOCOL_LABELS = { dot: 'DoT', doh: 'DoH' };

// One line of the Forwarders tooltip: the provider and address, then the
// time an answer took or why there was none.
function forwarderLine(f) {
  const name = f.label && f.label !== f.ip ? `${f.label} ${f.ip}` : f.ip;
  const via = PROTOCOL_LABELS[f.protocol] ? ` (${PROTOCOL_LABELS[f.protocol]})` : '';
  if (!f.reachable) return `${name}${via}: ${f.problem || 'unreachable'}`;
  return `${name}${via}: ${f.latency_ms != null ? `${f.latency_ms} ms` : 'reachable'}`;
}

// `services` null means the source did not answer, which is its own chip.
export function serviceChips(services) {
  if (!services) return [{ key: 'services', label: 'Services', value: 'unknown', tone: 'muted' }];
  const s = services;
  const fw = s.forwarders || [];
  const up = fw.filter((f) => f.reachable).length;
  return [
    ...backendUnits(s).map((unit) => ({
      key: unit.key,
      label: unit.name,
      value: unit.running ? 'Running' : 'Stopped',
      tone: unit.running ? 'ok' : 'err',
    })),
    {
      key: 'proxy',
      label: 'DNS proxy',
      value: s.geoip_bypassed ? 'Bypassed' : s.geoip_proxy ? 'Running' : 'Stopped',
      tone: s.geoip_bypassed ? 'warn' : s.geoip_proxy ? 'ok' : 'err',
    },
    {
      key: 'forwarders',
      label: 'Forwarders',
      value: fw.length ? `${up} of ${fw.length}` : 'none',
      tone: !fw.length ? 'muted' : up === fw.length ? 'ok' : up ? 'warn' : 'err',
      title: fw.map(forwarderLine).join('\n'),
    },
  ];
}
