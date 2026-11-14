// DNS-over-TCP wire framing (RFC 1035 s4.2.2): every message on a TCP stream
// is prefixed with a 2-byte big-endian length. Pure byte-shuffling shared by
// the DNS proxy's TCP relay and the DoT side of the encrypted forwarder.
// It lives here so neither feature module depends on the other for wire format.

// Prefix a payload with its 2-byte big-endian length (DNS-over-TCP framing).
export function frameTcpMessage(payload) {
  const lenBuf = Buffer.allocUnsafe(2);
  lenBuf.writeUInt16BE(payload.length, 0);
  return Buffer.concat([lenBuf, payload]);
}

// Pull all complete length-prefixed messages out of a stream buffer.
// Returns { messages: Buffer[], rest: Buffer }, `rest` is the unconsumed tail.
export function extractTcpMessages(buf) {
  const messages = [];
  let offset = 0;
  while (buf.length - offset >= 2) {
    const msgLen = buf.readUInt16BE(offset);
    if (buf.length - offset < 2 + msgLen) break; // wait for more bytes
    messages.push(buf.subarray(offset + 2, offset + 2 + msgLen));
    offset += 2 + msgLen;
  }
  return { messages, rest: offset > 0 ? buf.subarray(offset) : buf };
}

// EDNS (RFC 6891). The DNS proxy asks the backend with EDNS on a query that
// came without it, because only an EDNS answer can carry an Extended DNS Error,
// and takes the OPT record out again before the client sees the answer: a
// server must not send one to a client that did not ask with one.

const HEADER = 12;
const OPT_TYPE = 41;

// 0 name (root), 41 type, udp size, extended rcode, version, flags (DO off),
// no options.
function optRecord(udpSize) {
  const rr = Buffer.alloc(11);
  rr.writeUInt16BE(OPT_TYPE, 1);
  rr.writeUInt16BE(udpSize, 3);
  return rr;
}

/** `msg` with an OPT record added: no DO bit, `udpSize` the client's 512. */
export function addEdns(msg, udpSize = 512) {
  if (msg.length < HEADER) return msg;
  const buf = Buffer.concat([msg, optRecord(udpSize)]);
  buf.writeUInt16BE(buf.readUInt16BE(10) + 1, 10);
  return buf;
}

// The offset after the name at `off`, or -1 when it runs past the end.
function skipName(msg, off) {
  while (off < msg.length) {
    const len = msg[off];
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2 <= msg.length ? off + 2 : -1;
    if (len & 0xc0) return -1;
    off += len + 1;
  }
  return -1;
}

/**
 * `msg` without its OPT record, or `msg` itself when it has none or cannot be
 * read. Only an OPT record that is the last record is cut out: one with
 * records after it would shift what their compression pointers may point at,
 * and the backends put it last.
 */
export function removeOpt(msg) {
  if (msg.length < HEADER) return msg;
  const counts = [4, 6, 8, 10].map((at) => msg.readUInt16BE(at));
  let off = HEADER;
  for (let i = 0; i < counts[0]; i++) {
    off = skipName(msg, off);
    if (off < 0 || off + 4 > msg.length) return msg;
    off += 4;
  }
  const records = counts[1] + counts[2] + counts[3];
  for (let i = 0; i < records; i++) {
    const start = off;
    off = skipName(msg, off);
    if (off < 0 || off + 10 > msg.length) return msg;
    const end = off + 10 + msg.readUInt16BE(off + 8);
    if (end > msg.length) return msg;
    if (msg.readUInt16BE(off) === OPT_TYPE) {
      if (i < counts[1] + counts[2] || i !== records - 1 || end !== msg.length) return msg;
      const buf = Buffer.from(msg.subarray(0, start));
      buf.writeUInt16BE(counts[3] - 1, 10);
      return buf;
    }
    off = end;
  }
  return msg;
}
