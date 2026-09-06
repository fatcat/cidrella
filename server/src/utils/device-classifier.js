// Offline device/OS classifier. Pure function, combines DHCP option 55/60 +
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

function orderedSimilarity(left, right) {
  const a = normalizeOpt55(left).split(',').filter(Boolean);
  const b = normalizeOpt55(right).split(',').filter(Boolean);
  if (!a.length || !b.length) return 0;

  // Longest common subsequence retains the request-list order while allowing
  // a client or OS update to add or omit a small number of options.
  const previous = new Array(b.length + 1).fill(0);
  for (const value of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = value === b[j - 1]
        ? diagonal + 1
        : Math.max(previous[j], previous[j - 1]);
      diagonal = above;
    }
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function opt55Candidate(opt55) {
  const matches = OPT55_SIGNATURES
    .map(rule => ({ rule, similarity: orderedSimilarity(opt55, rule.fp) }))
    .sort((a, b) => b.similarity - a.similarity);
  const best = matches[0];
  const second = matches[1];
  if (!best || best.similarity < 0.85) return null;

  // Do not guess when two different OS families are equally plausible. Exact
  // matches are always unambiguous because signatures are curated uniquely.
  if (best.similarity < 1
      && second
      && second.rule.os_family !== best.rule.os_family
      && best.similarity - second.similarity < 0.08) {
    return null;
  }

  return {
    ...best.rule,
    confidence: Math.round(best.rule.confidence * best.similarity),
    signal: 'opt55'
  };
}

/**
 * @param {{opt55?:string, opt60?:string, hostname?:string, vendor?:string}} signals
 * @returns {{device_type:string|null, os_family:string|null, confidence:number}}
 */
export function classify({ opt55, opt60, hostname, vendor } = {}) {
  const candidates = [];

  if (opt60) for (const r of OPT60_RULES) if (r.test.test(opt60)) candidates.push({ ...r, signal: 'opt60' });
  if (hostname) for (const r of HOSTNAME_RULES) if (r.test.test(hostname)) candidates.push({ ...r, signal: 'hostname' });
  if (vendor) for (const r of OUI_RULES) if (r.test.test(vendor)) candidates.push({ ...r, signal: 'vendor' });
  if (opt55) {
    const candidate = opt55Candidate(opt55);
    if (candidate) candidates.push(candidate);
  }

  // Pick the highest-confidence os_family and device_type independently.
  let os = null, osConf = 0, dev = null, devConf = 0;
  for (const c of candidates) {
    if (c.os_family && c.confidence > osConf) { os = c.os_family; osConf = c.confidence; }
    if (c.device_type && c.confidence > devConf) { dev = c.device_type; devConf = c.confidence; }
  }

  let confidence = Math.max(osConf, devConf);
  // Agreement boost: two+ independent signals naming the same OS family.
  if (os && new Set(candidates.filter(c => c.os_family === os).map(c => c.signal)).size >= 2) {
    confidence = Math.min(100, confidence + 10);
  }

  return { device_type: dev, os_family: os, confidence };
}
