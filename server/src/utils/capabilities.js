import { readFileSync } from 'fs';

const CAP_NET_RAW = 13;
const CAP_NET_BIND_SERVICE = 10;

function capBit(capNumber) {
  return 1n << BigInt(capNumber);
}

function parseCapHex(value) {
  try {
    return BigInt(`0x${value || '0'}`);
  } catch {
    return 0n;
  }
}

export function readProcessCapabilities(pid = 'self') {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const caps = {};
  for (const line of status.split('\n')) {
    const m = line.match(/^(Cap(?:Inh|Prm|Eff|Bnd|Amb)):\s*([0-9a-fA-F]+)/);
    if (m) caps[m[1]] = parseCapHex(m[2]);
  }
  const netRaw = capBit(CAP_NET_RAW);
  const bindService = capBit(CAP_NET_BIND_SERVICE);
  return {
    cap_net_raw_effective: !!(caps.CapEff & netRaw),
    cap_net_raw_ambient: !!(caps.CapAmb & netRaw),
    cap_net_bind_service_effective: !!(caps.CapEff & bindService),
    cap_net_bind_service_ambient: !!(caps.CapAmb & bindService),
    raw: {
      CapInh: caps.CapInh?.toString(16) || '0',
      CapPrm: caps.CapPrm?.toString(16) || '0',
      CapEff: caps.CapEff?.toString(16) || '0',
      CapBnd: caps.CapBnd?.toString(16) || '0',
      CapAmb: caps.CapAmb?.toString(16) || '0',
    }
  };
}

export function getCapabilityWarning(capabilities = readProcessCapabilities()) {
  if (!capabilities.cap_net_raw_effective) {
    return 'CAP_NET_RAW is not effective; ARP probes will fail.';
  }
  if (!capabilities.cap_net_raw_ambient) {
    return 'CAP_NET_RAW is effective in Node but not ambient; child arping probes will not inherit it.';
  }
  return null;
}
