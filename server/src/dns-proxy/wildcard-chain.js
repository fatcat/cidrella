/**
 * Cut a forwarded CNAME chain that ends in a wildcard expansion back to the
 * query name's own records, for a backend that would reject it whole.
 *
 * A forwarder answers with the whole chain and the NSEC proof for the
 * wildcard in one message. PowerDNS Recursor (5.3 and 5.4) checks that proof
 * under the query name instead of the target's, finds it does not cover that
 * name, and calls the answer Bogus. www.nasa.gov, a CNAME to a wildcard under
 * go-vip.net, failed this way on every query. Given only the CNAME, the
 * recursor asks for the target itself, and that answer validates.
 *
 * Nothing is taken on trust: the signatures still reach the validator, and a
 * forged target still fails when it is asked for. A validator that does not
 * chase a CNAME itself (dnsmasq) needs the whole chain, so this is the
 * backend's choice (splitWildcardChains).
 */
import dnsPacket from 'dns-packet';

const AUTHENTIC_DATA = dnsPacket.AUTHENTIC_DATA;

const canonical = (name) => name.toLowerCase().replace(/\.$/, '');
const labelCount = (name) => canonical(name).split('.').filter(Boolean).length;

// RFC 4035 5.3.2: fewer labels in the signature than in the owner name means
// the record was expanded from a wildcard.
const isWildcardSignature = (record) =>
  record.type === 'RRSIG' && record.data.labels < labelCount(record.name);

/**
 * The answer to hand on: `resp` itself unless it is such a chain, or cannot be
 * read. The query name's own proof stays when its own record is an expansion.
 */
export function splitWildcardChain(resp) {
  let decoded;
  try {
    decoded = dnsPacket.decode(resp);
  } catch {
    return resp;
  }
  const qname = canonical(decoded.questions?.[0]?.name ?? '');
  const isOwn = (record) => canonical(record.name) === qname;
  const answers = decoded.answers ?? [];
  const startsWithCname = answers.some((record) => record.type === 'CNAME' && isOwn(record));
  const targetIsExpansion = answers.some((record) => !isOwn(record) && isWildcardSignature(record));
  if (!startsWithCname || !targetIsExpansion) return resp;

  const ownIsExpansion = answers.some((record) => isOwn(record) && isWildcardSignature(record));
  try {
    return dnsPacket.encode({
      ...decoded,
      flags: decoded.flags & ~AUTHENTIC_DATA,
      answers: answers.filter(isOwn),
      authorities: ownIsExpansion ? decoded.authorities : [],
      additionals: (decoded.additionals ?? []).filter((record) => record.type === 'OPT'),
    });
  } catch {
    return resp;
  }
}
