/**
 * Why a DNS answer failed, from its Extended DNS Error (RFC 8914, EDNS option
 * 15). dnsmasq sets one when its own DNSSEC validation fails and relays the
 * one an upstream sent with its SERVFAIL (measured on dnsmasq 2.91). A dead or
 * refusing upstream gets no answer from dnsmasq at all: the client, or the
 * DNS proxy in front of it, times out instead.
 *
 * `failureCause` is the one place a failed answer is sorted into a cause; the
 * proxy's log and minute counts and the client's labels all use it.
 */

export const EDE_OPTION = 15;

export const EDE_NAMES = Object.freeze({
  0: 'Other',
  1: 'Unsupported DNSKEY Algorithm',
  2: 'Unsupported DS Digest Type',
  3: 'Stale Answer',
  4: 'Forged Answer',
  5: 'DNSSEC Indeterminate',
  6: 'DNSSEC Bogus',
  7: 'Signature Expired',
  8: 'Signature Not Yet Valid',
  9: 'DNSKEY Missing',
  10: 'RRSIGs Missing',
  11: 'No Zone Key Bit Set',
  12: 'NSEC Missing',
  13: 'Cached Error',
  14: 'Not Ready',
  15: 'Blocked',
  16: 'Censored',
  17: 'Filtered',
  18: 'Prohibited',
  19: 'Stale NXDOMAIN Answer',
  20: 'Not Authoritative',
  21: 'Not Supported',
  22: 'No Reachable Authority',
  23: 'Network Error',
  24: 'Invalid Data',
  25: 'Signature Expired before Valid',
  26: 'Too Early',
  27: 'Unsupported NSEC3 Iterations Value',
  28: 'Unable to Conform to Policy',
  29: 'Synthesized',
  30: 'Invalid Query Type',
});

const DNSSEC_CODES = new Set([1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 25, 27]);
const UPSTREAM_CODES = new Set([22, 23]);

// The causes, in the order the client shows them.
export const FAILURE_CAUSES = Object.freeze(['dnssec', 'upstream', 'timeout', 'refused', 'other']);

export const FAILURE_LABELS = Object.freeze({
  dnssec: 'DNSSEC',
  upstream: 'Upstream',
  timeout: 'Timed out',
  refused: 'Refused',
  other: 'Other',
});

/** The first EDE in a decoded (dns-packet) message: { code, text }, or null. */
export function extractEde(message) {
  const opt = message?.additionals?.find((record) => record.type === 'OPT');
  const option = opt?.options?.find((o) => o.code === EDE_OPTION);
  const data = option?.data;
  if (!Buffer.isBuffer(data) || data.length < 2) return null;
  return { code: data.readUInt16BE(0), text: data.subarray(2).toString('utf8') };
}

/** The EDNS option carrying `code`, for an answer CIDRella builds itself. */
export function edeOption(code, text = '') {
  const data = Buffer.alloc(2 + Buffer.byteLength(text));
  data.writeUInt16BE(code, 0);
  data.write(text, 2);
  return { code: EDE_OPTION, data };
}

/**
 * The cause of a failed answer, or null when it did not fail. `timedOut` is
 * the proxy giving up on dnsmasq. A SERVFAIL with no EDE stays 'other': dnsmasq
 * marks its own validation failures, so an unmarked one is an upstream's bare
 * SERVFAIL or something else, and there is no telling which.
 */
export function failureCause(rcode, ede, { timedOut = false } = {}) {
  if (timedOut) return 'timeout';
  if (rcode === 'REFUSED') return 'refused';
  if (rcode !== 'SERVFAIL') return null;
  const code = ede?.code ?? ede;
  if (DNSSEC_CODES.has(code)) return 'dnssec';
  if (UPSTREAM_CODES.has(code)) return 'upstream';
  return 'other';
}
