import dgram from 'dgram';
import net from 'net';
import dnsPacket from 'dns-packet';
import { frameTcpMessage, extractTcpMessages } from '../../src/utils/dns-wire.js';

// dns-packet takes the rcode from the low bits of flags.
const RCODES = { NOERROR: 0, SERVFAIL: 2, NXDOMAIN: 3 };

function answerFor(message, rcode) {
  const query = dnsPacket.decode(message);
  return dnsPacket.encode({
    id: query.id,
    type: 'response',
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE | RCODES[rcode],
    questions: query.questions,
  });
}

/**
 * A plain DNS server on loopback, either family, that answers every query
 * with `rcode` after `delayMs`, over UDP or (`tcp: true`) TCP. Resolves
 * { port, queries, close }; `queries` counts what came in.
 */
export async function plainDnsServer(
  address,
  { rcode = 'NOERROR', delayMs = 0, tcp = false, port = 0 } = {},
) {
  const server = { queries: 0 };
  if (tcp) {
    const listener = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        const { messages, rest } = extractTcpMessages(Buffer.concat([buffer, chunk]));
        buffer = rest;
        for (const message of messages) {
          server.queries++;
          const reply = frameTcpMessage(answerFor(message, rcode));
          setTimeout(() => !socket.destroyed && socket.write(reply), delayMs);
        }
      });
    });
    await new Promise((resolve) => listener.listen(port, address, resolve));
    return Object.assign(server, {
      port: listener.address().port,
      close: () => listener.close(),
    });
  }
  const socket = dgram.createSocket(address.includes(':') ? 'udp6' : 'udp4');
  socket.on('message', (message, rinfo) => {
    server.queries++;
    const reply = answerFor(message, rcode);
    setTimeout(() => socket.send(reply, rinfo.port, rinfo.address), delayMs);
  });
  await new Promise((resolve) => socket.bind(port, address, resolve));
  return Object.assign(server, { port: socket.address().port, close: () => socket.close() });
}
