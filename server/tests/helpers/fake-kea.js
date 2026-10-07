/**
 * A stand-in for Kea's HTTP control API, enough for the Kea adapter's tests:
 * basic auth, the list-shaped replies, and the lease_cmds and stat_cmds
 * commands the adapter sends, with leases kept per family in memory.
 *
 *   const kea = await startFakeKea({ password });
 *   kea.port            the port it listens on (127.0.0.1)
 *   kea.leases[4|6]     Map of address -> Kea lease JSON
 *   kea.stats[4|6]      { name: number } statistics, as statistic-get-all reports them
 *   kea.fail(command, { result, text } | { status })   make the next call fail
 *   kea.calls           every command received, in order
 *   kea.churn = true    every statistics read sees one more address handed
 *                       out, as if leases changed during each scan
 *   await kea.close()
 */
import http from 'http';
import { addressToBig } from '../../src/utils/cidr.js';

const familyOf = (command) => (/6/.test(command) ? 6 : 4);

export async function startFakeKea({ password, user = 'cidrella' } = {}) {
  const leases = { 4: new Map(), 6: new Map() };
  const stats = { 4: {}, 6: {} };
  const failures = new Map();
  const calls = [];
  const expectedAuth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

  const byAddress = (family) =>
    [...leases[family].values()].sort((a, b) =>
      addressToBig(a['ip-address']).value < addressToBig(b['ip-address']).value ? -1 : 1,
    );

  function handle(command, args = {}, family) {
    switch (command) {
      case 'status-get':
        return { result: 0, arguments: { pid: 1 } };
      case 'statistic-get-all':
        if (fake.churn) {
          const name = family === 6 ? 'cumulative-assigned-nas' : 'cumulative-assigned-addresses';
          stats[family][name] = (stats[family][name] || 0) + 1;
        }
        return {
          result: 0,
          arguments: Object.fromEntries(
            Object.entries(stats[family]).map(([name, value]) => [name, [[value, 'now']]]),
          ),
        };
      case 'lease4-get-page':
      case 'lease6-get-page': {
        const all = byAddress(family);
        const start =
          args.from === 'start'
            ? 0
            : all.findIndex(
                (l) => addressToBig(l['ip-address']).value > addressToBig(args.from).value,
              );
        const page = start < 0 ? [] : all.slice(start, start + args.limit);
        return page.length
          ? { result: 0, arguments: { leases: page, count: page.length } }
          : { result: 3, text: '0 lease(s) found.', arguments: { leases: [], count: 0 } };
      }
      case 'lease4-add':
      case 'lease6-add': {
        const lease = { ...args, state: 0 };
        lease.cltt = args.expire ? args.expire - args['valid-lft'] : Math.floor(Date.now() / 1000);
        delete lease.expire;
        leases[family].set(args['ip-address'], lease);
        return { result: 0, text: 'added' };
      }
      case 'lease4-del':
      case 'lease6-del':
        return leases[family].delete(args['ip-address'])
          ? { result: 0, text: 'deleted' }
          : { result: 3, text: 'lease not found.' };
      default:
        return { result: 2, text: `'${command}' command not supported.` };
    }
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 401, text: 'Unauthorized' }));
        return;
      }
      const { command, arguments: args } = JSON.parse(body);
      // Each daemon has its own port in Kea; here one server stands in for
      // both, told apart by the command or the port asked.
      const port = Number(req.headers.host.split(':')[1]);
      const family = command.startsWith('lease')
        ? familyOf(command)
        : port === server.v6Port
          ? 6
          : 4;
      calls.push({ command, arguments: args, family });
      const failure = failures.get(command);
      if (failure) {
        failures.delete(command);
        if (failure.status) {
          res.writeHead(failure.status);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([failure]));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([handle(command, args, family)]));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // A second listener for the DHCPv6 daemon's port.
  const v6 = http.createServer((req, res) => server.emit('request', req, res));
  await new Promise((resolve) => v6.listen(0, '127.0.0.1', resolve));
  server.v6Port = v6.address().port;

  const fake = {
    churn: false,
    port: server.address().port,
    v6Port: server.v6Port,
    leases,
    stats,
    calls,
    fail: (command, failure) => failures.set(command, failure),
    close: () =>
      Promise.all([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => v6.close(resolve)),
      ]),
  };
  return fake;
}
