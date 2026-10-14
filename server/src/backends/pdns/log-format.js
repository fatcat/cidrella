/**
 * What PowerDNS's log says, for the readers that tail it (passive liveness and
 * the metrics aggregator). Two kinds of query line land in pdns.log:
 *
 * - the DNS proxy's, while it is in front (utils/query-log-line.js), with the
 *   client's address;
 * - Recursor's own in bypass mode, where it answers clients itself and logs
 *   each one (logging.quiet off, backends/pdns/render.js). Recursor 5.3
 *   writes structured lines, read off a real one:
 *
 *   Oct 11 13:43:46 msg="Question" subsystem="syncres" ... qname="example.com" qtype="A" remote="127.0.0.1:39801"
 *   Oct 11 13:44:03 msg="Question answered from packet cache" ... remote="[::1]:57741" ...
 *
 *   Each query logs one of the two, so counting them counts queries.
 */
import { parseQueryLine } from '../../utils/query-log-line.js';

const RECURSOR_QUESTION_RE = /\bmsg="Question(?: answered from packet cache)?"/;
const REMOTE_RE = /\bremote="(?:\[([^\]]+)\]|([^":]+)):\d+"/;

/** The client address of a query line, either kind, or null for any other line. */
export function querySourceIp(line) {
  const proxied = parseQueryLine(line);
  if (proxied) return proxied;
  if (!RECURSOR_QUESTION_RE.test(line)) return null;
  const remote = line.match(REMOTE_RE);
  return remote ? remote[1] || remote[2] : null;
}
