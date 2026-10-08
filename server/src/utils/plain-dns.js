/**
 * One query over plain DNS to one resolver address, either family: UDP from a
 * fresh source port, or TCP for a query that came in over TCP (dnsmasq asks
 * again over TCP when a UDP answer was truncated). Used by the forwarder for
 * plaintext forwarding and by the resolver performance test.
 */
import dgram from 'dgram';
import net from 'net';
import { addressFamily } from './address.js';
import { frameTcpMessage, extractTcpMessages } from './dns-wire.js';

/**
 * Over UDP. Resolves { answer, ms }: the answer, or null when none came in
 * time or it did not match the query's id, and the round trip from the send.
 * The clock starts once the socket is bound, so setting it up is not counted.
 */
export function plainUdpQuery(address, query, { timeoutMs, port = 53 }) {
  const id = query.readUInt16BE(0);
  return new Promise((resolve) => {
    const socket = dgram.createSocket(addressFamily(address) === 6 ? 'udp6' : 'udp4');
    let started = null;
    let timer = null;
    let settled = false;
    // A failed send can report through both the callback and the 'error'
    // event; the socket is closed once.
    const done = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve({ answer, ms: started == null ? 0 : performance.now() - started });
    };
    socket.on('error', () => done(null));
    socket.on('message', (message) => {
      if (message.length >= 2 && message.readUInt16BE(0) === id) done(message);
    });
    socket.bind(0, () => {
      timer = setTimeout(() => done(null), timeoutMs);
      started = performance.now();
      try {
        socket.send(query, port, address, (error) => error && done(null));
      } catch {
        done(null); // a bad port or address throws rather than calling back
      }
    });
  });
}

/**
 * Over TCP, one connection per query. Resolves { answer, ms, refused }:
 * `refused` says the connection itself failed, as against no answer in time.
 */
export function plainTcpQuery(address, query, { timeoutMs, port = 53 }) {
  const id = query.readUInt16BE(0);
  return new Promise((resolve) => {
    const started = performance.now();
    let buffer = Buffer.alloc(0);
    let settled = false;
    const socket = net.connect({ host: address, port });
    const done = (answer, refused = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ answer, ms: performance.now() - started, refused });
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on('connect', () => socket.write(frameTcpMessage(query)));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, rest } = extractTcpMessages(buffer);
      buffer = rest;
      const answer = messages.find((m) => m.length >= 2 && m.readUInt16BE(0) === id);
      if (answer) done(answer);
    });
    socket.on('error', () => done(null, true));
    socket.on('close', () => done(null));
  });
}
