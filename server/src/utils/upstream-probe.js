/**
 * One query to one address of an encrypted-DNS upstream, to tell whether it
 * works: the release build checks every preset with it
 * (scripts/check-dns-providers.js) and the services health check probes the
 * upstreams in use.
 */
import crypto from 'crypto';
import dnsPacket from 'dns-packet';
import { createUpstreamPool } from './upstream-pool.js';
import { plainUdpQuery } from './plain-dns.js';

// Signed, and stable for decades: an answer without an RRSIG means the
// upstream stripped it.
export const PROBE_NAME = 'example.com';

// Names a resolver usually answers from its own cache: what clients feel.
export const COMMON_NAMES = Object.freeze([
  'wikipedia.org',
  'github.com',
  'youtube.com',
  'amazon.com',
  'microsoft.com',
  'apple.com',
  'cloudflare.com',
  'netflix.com',
  'reddit.com',
  'example.com',
]);

// Large UNSIGNED zones (no DNSKEY, checked 2026-10-08). A random label under
// one is in no resolver's cache, and with no NSEC records to reuse (RFC 8198)
// the resolver must ask the zone's servers. google.com is left out: Google's
// resolver sits next to its own authority.
export const UNCACHED_ZONES = Object.freeze([
  'amazon.com',
  'microsoft.com',
  'apple.com',
  'facebook.com',
  'yahoo.com',
  'netflix.com',
]);

/** A name no resolver has cached, under `zone`. */
export function uncachedName(zone) {
  return `${crypto.randomBytes(8).toString('hex')}.${zone}`;
}

/** An A query for `name` with EDNS and the DO bit, as dnsmasq sends them. */
export function nameQuery(name, id = crypto.randomInt(0, 0x10000)) {
  return dnsPacket.encode({
    id,
    type: 'query',
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type: 'A', name }],
    additionals: [
      { type: 'OPT', name: '.', udpPayloadSize: 1232, flags: dnsPacket.DNSSEC_OK, options: [] },
    ],
  });
}

export function probeQuery() {
  return nameQuery(PROBE_NAME, 0x5ec5);
}

/** Why an answer does not count as one when timing a resolver, or null. */
export function timingProblem(response) {
  if (!response) return 'no answer';
  let rcode;
  try {
    rcode = dnsPacket.decode(response).rcode;
  } catch (error) {
    return `undecodable answer: ${error.message}`;
  }
  // NXDOMAIN is the right answer for a random name.
  return rcode === 'NOERROR' || rcode === 'NXDOMAIN' ? null : `answered ${rcode}`;
}

/**
 * Time one query for `name` to one address of a resolver, straight over the
 * wire (dnsmasq and its cache are not involved). `pool` is the caller's
 * createUpstreamPool for 'dot' and 'doh', kept open across queries the way
 * the forwarder keeps its connections; 'plain' needs none.
 * Resolves { ms, problem }.
 */
export async function timeQuery({ protocol, provider, address, name, pool, timeoutMs, port }) {
  const query = nameQuery(name);
  if (protocol === 'plain') {
    const { answer, ms } = await plainUdpQuery(address, query, { timeoutMs, port });
    return { ms, problem: timingProblem(answer) };
  }
  const started = performance.now();
  const response = await pool.query(query, { ...provider, addresses: [address] });
  return { ms: performance.now() - started, problem: timingProblem(response) };
}

/** What is wrong with one answer, or null. */
export function answerProblem(response, { dnssecTransparent } = {}) {
  if (!response) return 'no answer';
  let message;
  try {
    message = dnsPacket.decode(response);
  } catch (error) {
    return `undecodable answer: ${error.message}`;
  }
  if (message.rcode !== 'NOERROR') return `answered ${message.rcode} for ${PROBE_NAME}`;
  if (!message.answers.some((a) => a.type === 'A')) return `no A record for ${PROBE_NAME}`;
  if (dnssecTransparent && !message.answers.some((a) => a.type === 'RRSIG')) {
    return `no RRSIG for ${PROBE_NAME}, but the preset says it passes DNSSEC through`;
  }
  return null;
}

/**
 * Resolves { problem, connected, ms }: problem is null for a good answer,
 * connected says whether anything answered at all, and ms is how long it took.
 * `poolOptions` reach createUpstreamPool (tests pass a port and a CA).
 */
export async function probeAddress({
  provider,
  address,
  protocol,
  timeoutMs = 5000,
  poolOptions = {},
}) {
  const errors = [];
  const pool = createUpstreamPool({
    protocol,
    timeoutMs,
    onError: (error) => errors.push(error.message.trim()),
    ...poolOptions,
  });
  const started = performance.now();
  try {
    const response = await pool.query(probeQuery(), { ...provider, addresses: [address] });
    const problem = response ? answerProblem(response, provider) : errors.at(-1) || 'no answer';
    return { problem, connected: Boolean(response), ms: Math.round(performance.now() - started) };
  } finally {
    pool.closeAll();
  }
}
