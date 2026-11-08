import dgram from 'dgram';
import net from 'net';
import dnsPacket from 'dns-packet';
import { frameTcpMessage, extractTcpMessages } from '../../src/utils/dns-wire.js';
import { edeOption } from '../../src/utils/dns-ede.js';

// dns-packet takes the rcode from the low bits of flags.
const RCODES = { NOERROR: 0, SERVFAIL: 2, NXDOMAIN: 3 };

// An EDE goes only on an answer to a query with EDNS, as a real server's does.
function answerFor(message, rcode, ede, server) {
  const query = dnsPacket.decode(message);
  const edns = query.additionals.some((record) => record.type === 'OPT');
  if (edns) server.withEdns++;
  return dnsPacket.encode({
    id: query.id,
    type: 'response',
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE | RCODES[rcode],
    questions: query.questions,
    additionals:
      edns && ede !== null
        ? [{ type: 'OPT', name: '.', udpPayloadSize: 1232, flags: 0, options: [edeOption(ede)] }]
        : [],
  });
}

/**
 * A plain DNS server on loopback, either family, that answers every query
 * with `rcode` after `delayMs`, over UDP or (`tcp: true`) TCP, and with the
 * Extended DNS Error `ede` when the query has EDNS. Resolves
 * { port, queries, withEdns, close }; `queries` counts what came in and
 * `withEdns` the queries among them that had an OPT record.
 */
export async function plainDnsServer(
  address,
  { rcode = 'NOERROR', delayMs = 0, tcp = false, port = 0, ede = null } = {},
) {
  const server = { queries: 0, withEdns: 0 };
  if (tcp) {
    const listener = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        const { messages, rest } = extractTcpMessages(Buffer.concat([buffer, chunk]));
        buffer = rest;
        for (const message of messages) {
          server.queries++;
          const reply = frameTcpMessage(answerFor(message, rcode, ede, server));
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
    const reply = answerFor(message, rcode, ede, server);
    setTimeout(() => socket.send(reply, rinfo.port, rinfo.address), delayMs);
  });
  await new Promise((resolve) => socket.bind(port, address, resolve));
  return Object.assign(server, { port: socket.address().port, close: () => socket.close() });
}
