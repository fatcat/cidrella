// Offline device/OS classifier. Pure function — combines DHCP option 55/60 +
// hostname + MAC OUI signals against the curated ruleset and returns a best
// guess with a confidence score. Never throws; unknown → nulls + low/zero
// confidence (the caller still records the OUI manufacturer separately).

import { OPT60_RULES, OPT55_SIGNATURES, HOSTNAME_RULES, OUI_RULES } from '../data/device-fingerprints.js';

// Normalize an option-55 list ("1, 3, 6 , 15" or "1:netmask,3:router,...") to a
// bare comma-joined code list "1,3,6,15".
export function normalizeOpt55(opt55) {
  if (!opt55) return '';
  const codes = String(opt55)
    .split(',')
    .map(s => s.trim().split(':')[0].trim())   // tolerate "1:netmask"
    .filter(s => /^\d+$/.test(s));
  return codes.join(',');
}

/**
 * @param {{opt55?:string, opt60?:string, hostname?:string, vendor?:string}} signals
 * @returns {{device_type:string|null, os_family:string|null, confidence:number}}
 */
export function classify({ opt55, opt60, hostname, vendor } = {}) {
  const candidates = [];

  if (opt60) for (const r of OPT60_RULES) if (r.test.test(opt60)) candidates.push(r);
  if (hostname) for (const r of HOSTNAME_RULES) if (r.test.test(hostname)) candidates.push(r);
  if (vendor) for (const r of OUI_RULES) if (r.test.test(vendor)) candidates.push(r);
  if (opt55) {
    const norm = normalizeOpt55(opt55);
    if (norm) for (const s of OPT55_SIGNATURES) if (normalizeOpt55(s.fp) === norm) candidates.push(s);
  }

  // Pick the highest-confidence os_family and device_type independently.
  let os = null, osConf = 0, dev = null, devConf = 0;
  for (const c of candidates) {
    if (c.os_family && c.confidence > osConf) { os = c.os_family; osConf = c.confidence; }
    if (c.device_type && c.confidence > devConf) { dev = c.device_type; devConf = c.confidence; }
  }

  let confidence = Math.max(osConf, devConf);
  // Agreement boost: two+ independent signals naming the same OS family.
  if (os && candidates.filter(c => c.os_family === os).length >= 2) {
    confidence = Math.min(100, confidence + 10);
  }

  return { device_type: dev, os_family: os, confidence };
}
