// The service chips of an Analytics status rail, from /api/metrics/services:
// each DNS/DHCP backend by name, the DNS proxy, and how many forwarders
// answer. The Dashboard and Performance both lead their rail with these.

import { backendUnits } from './backend-status.js';

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
      title: fw.map((f) => `${f.ip} ${f.reachable ? 'reachable' : 'unreachable'}`).join('\n'),
    },
  ];
}
