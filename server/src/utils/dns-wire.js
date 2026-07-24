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
