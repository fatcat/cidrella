import dgram from 'dgram';

/** A UDP port free on 127.0.0.1 a moment ago, for a test's own listener. */
export async function freePort() {
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve) => sock.bind(0, '127.0.0.1', resolve));
  const { port } = sock.address();
  sock.close();
  return port;
}
