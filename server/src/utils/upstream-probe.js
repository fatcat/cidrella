/**
 * One query to one address of an encrypted-DNS upstream, to tell whether it
 * works: the release build checks every preset with it
 * (scripts/check-dns-providers.js) and the services health check probes the
 * upstreams in use.
 */
import dnsPacket from 'dns-packet';
import { createUpstreamPool } from './upstream-pool.js';

// Signed, and stable for decades: an answer without an RRSIG means the
// upstream stripped it.
export const PROBE_NAME = 'example.com';

export function probeQuery() {
  return dnsPacket.encode({
    id: 0x5ec5,
    type: 'query',
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type: 'A', name: PROBE_NAME }],
    additionals: [
      { type: 'OPT', name: '.', udpPayloadSize: 1232, flags: dnsPacket.DNSSEC_OK, options: [] },
    ],
  });
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
