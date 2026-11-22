import dgram from 'dgram';
import net from 'net';

/**
 * A port free on 127.0.0.1 a moment ago, for a test's own listener: UDP by
 * default, TCP with `{ tcp: true }`. A port free for one is not free for the
 * other, so ask for the kind the test listens with.
 */
export async function freePort({ tcp = false } = {}) {
  if (tcp) {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
  }
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve) => sock.bind(0, '127.0.0.1', resolve));
  const { port } = sock.address();
  sock.close();
  return port;
}

/**
 * Start `server` on 127.0.0.1 at a port the system picks, and resolve the
 * port. Nothing can take the port in between, which picking one first and
 * listening on it after allows when test files run side by side.
 */
export async function listenLocal(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
