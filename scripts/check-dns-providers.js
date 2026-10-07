#!/usr/bin/env node
// Release-build check of the encrypted-DNS presets in
// server/src/data/doh-providers.js. Every listed address must answer a DoT
// and a DoH query with a certificate valid for the preset's hostname, and
// pass DNSSEC signatures through when the preset says it does. The AdGuard
// preset shipped with a hostname its own servers refuse, and nothing noticed
// until a user switched to it.
//
// It only checks. A broken preset needs a person to find the provider's
// current hostname or address; a resolver's service addresses are not what
// its hostname resolves to (cloudflare-dns.com is not 1.1.1.1), so there is
// nothing to refresh automatically. Installs are never changed by this:
// a fixed preset reaches new configurations only.
//
// Exit codes: 0 every preset works; 1 a preset is broken; 3 nothing answered
// over DoT or over DoH, which is the build host's network rather than the
// presets.
const path = require('path');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');

const projectDir = path.resolve(__dirname, '..');
const serverDir = path.join(projectDir, 'server');
const dnsPacket = createRequire(path.join(serverDir, 'package.json'))('dns-packet');

const TIMEOUT_MS = 5000;
// Signed, and stable for decades: an answer without an RRSIG means the
// upstream stripped it.
const PROBE_NAME = 'example.com';
const PROTOCOLS = [
  { protocol: 'dot', label: 'DoT' },
  { protocol: 'doh', label: 'DoH' },
];

function probeQuery() {
  return dnsPacket.encode({
    id: 0x5ec5,
    type: 'query',
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type: 'A', name: PROBE_NAME }],
    additionals: [
      { type: 'OPT', name: '.', udpPayloadSize: 1232, flags: dnsPacket.DNSSEC_OK, options: [] },
    ],
  });
}

// What is wrong with one answer, or null.
function answerProblem(response, { dnssecTransparent }) {
  if (!response) return 'no answer';
  let message;
  try {
    message = dnsPacket.decode(response);
  } catch (error) {
    return `undecodable answer: ${error.message}`;
  }
  if (message.rcode !== 'NOERROR') return `answered ${message.rcode} for ${PROBE_NAME}`;
  if (!message.answers.some((a) => a.type === 'A')) return `no A record for ${PROBE_NAME}`;
  if (dnssecTransparent && !message.answers.some((a) => a.type === 'RRSIG')) {
    return `no RRSIG for ${PROBE_NAME}, but the preset says it passes DNSSEC through`;
  }
  return null;
}

// One query to one address of one preset. Resolves { problem } with null
// for a good answer; `connected` says whether anything got that far.
async function probeAddress({ createUpstreamPool, provider, address, protocol }) {
  const errors = [];
  const pool = createUpstreamPool({
    protocol,
    timeoutMs: TIMEOUT_MS,
    onError: (error) => errors.push(error.message.trim()),
  });
  try {
    const response = await pool.query(probeQuery(), { ...provider, addresses: [address] });
    const problem = response ? answerProblem(response, provider) : errors.at(-1) || 'no answer';
    return { problem, connected: Boolean(response) };
  } finally {
    pool.closeAll();
  }
}

async function checkProviders(providers, probe) {
  const failures = [];
  const answered = Object.fromEntries(PROTOCOLS.map(({ label }) => [label, 0]));
  for (const provider of providers) {
    for (const address of provider.addresses) {
      for (const { protocol, label } of PROTOCOLS) {
        const { problem, connected } = await probe({ provider, address, protocol });
        if (connected) answered[label]++;
        if (problem) failures.push({ provider, address, label, problem });
      }
    }
  }
  return { failures, answered };
}

// A protocol nothing answered over is the build host's network (port 853 or
// 443 blocked, or no network at all), not every preset at once; failures
// over a protocol that did answer elsewhere are broken presets.
function report({ failures, answered }) {
  if (!failures.length) {
    console.log('Encrypted DNS presets OK: every address answers DoT and DoH.');
    return 0;
  }
  const silent = Object.keys(answered).filter((label) => !answered[label]);
  const broken = failures.filter((f) => !silent.includes(f.label));
  if (broken.length) {
    console.error('Broken encrypted DNS presets in server/src/data/doh-providers.js:');
    for (const f of broken) {
      console.error(
        `  ${f.provider.id} ${f.address} ${f.label} (hostname ${f.provider.hostname}` +
          `${f.label === 'DoH' ? `, ${f.provider.doh_url}` : ''}): ${f.problem}`,
      );
    }
    console.error(
      "Find the provider's current hostname or addresses, fix the preset, and add a" +
        ' migration for upstreams saved from the old one (see 084_adguard_upstream_hostname.sql).',
    );
  }
  for (const label of silent) {
    const port = label === 'DoT' ? 853 : 443;
    console.error(
      `No preset answered over ${label}; check that this host can reach TCP port ${port}.`,
    );
    const first = failures.find((f) => f.label === label);
    console.error(`  first error (${first.provider.id} ${first.address}): ${first.problem}`);
  }
  return broken.length ? 1 : 3;
}

async function main() {
  const load = (file) => import(pathToFileURL(path.join(serverDir, file)).href);
  const { DOH_PROVIDERS } = await load('src/data/doh-providers.js');
  const { createUpstreamPool } = await load('src/utils/upstream-pool.js');
  const result = await checkProviders(DOH_PROVIDERS, (args) =>
    probeAddress({ createUpstreamPool, ...args }),
  );
  return report(result);
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`Encrypted DNS preset check failed to run: ${error.stack || error}`);
      process.exit(1);
    },
  );
}

module.exports = { answerProblem, checkProviders, report };
