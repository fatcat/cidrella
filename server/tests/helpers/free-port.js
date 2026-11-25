import dgram from 'dgram';
import net from 'net';

/**
 * A port free on 127.0.0.1 a moment ago, for a test's own listener: UDP by
 * default, TCP with `{ tcp: true }`, both with `{ both: true }` (a DNS
 * listener, which takes the port on each). A port free for one is not free for
 * the other, so ask for the kind the test listens with.
 */
export async function freePort({ tcp = false, both = false } = {}) {
  if (both) return freeForBoth();
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

// A TCP port the system picks, kept while the same number is tried on UDP;
// another one when UDP has it taken.
async function freeForBoth(tries = 20) {
  for (let i = 0; i < tries; i++) {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const sock = dgram.createSocket('udp4');
    const free = await new Promise((resolve) => {
      sock.once('error', () => resolve(false));
      sock.bind(port, '127.0.0.1', () => resolve(true));
    });
    sock.close();
    await new Promise((resolve) => server.close(resolve));
    if (free) return port;
  }
  throw new Error('No port free for both TCP and UDP on 127.0.0.1');
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
