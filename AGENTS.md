# CIDRella Agent Instructions

## Canonical IP model gate

Before changing IP allocation, address classification, hostname selection,
reverse DNS, DHCP/DNS synchronization, topology projection, or related UI
display logic, read these contracts:

- `docs/ARCHITECTURE.md`, especially **Canonical IP Model**
- `docs/API_MODEL.md`, especially **IP Read Model**
- `docs/IP-LIFECYCLE-GOVERNANCE-PLAN.md`
- `docs/adr/001-ip-protocol-table-ownership.md`
- `docs/adr/002-ip-topology-projection.md`

Treat `allocation_state` as the only allocation-precedence authority. DNS,
DHCP, topology, liveness, hostname, and PTR data are independent facts or
projections unless the canonical contract explicitly says otherwise. Do not
add a second precedence tree in a route, utility, importer, migration, or
client component.

Route lifecycle writes through `server/src/services/ip-lifecycle-service.js`
and canonical persistence through `server/src/models/ip-address.js`. Render
server-owned fields from `server/src/models/ip-view.js`; the client must not
reconstruct allocation precedence.

Any intentional change to IP precedence or naming policy must update the
canonical contract first. Then update every affected write path,
reconciliation/migration path, read projection, and generated DNS/DHCP sink.
Add differential tests covering the same operation through every affected
entry point and operation order. Run the focused tests, the full relevant
suite, `npm run lint`, and `npm run check:db-ownership`.

## Repository workflow

- Follow the testing, versioning, migration, packaging, and Git conventions in
  `CLAUDE.md`; they apply to all agents despite the filename.
- The maintainer owns commits, tags, and pushes. Prepare changes but do not
  perform those operations unless explicitly requested.

## Review findings

`REVIEW.md` (tracked) is the list of known issues that are not fixed yet.

- When you find an issue you are not fixing in the same change (a bug you
  pass on the way, a review or audit finding), record it in `REVIEW.md`: an
  ID, the severity, the file and line, what happens (input and wrong result),
  why, and the fix you would make. Check for an existing entry first.
- When an issue is fixed, delete its entry from `REVIEW.md` in the commit that
  fixes it, and name its ID in the commit message. Do not strike it through or
  mark it fixed: git history is the record of what was fixed and when.
- If work on an entry starts and then stalls (a blocker, a measurement, a
  rejected approach worth keeping), move it to `BACKLOG.md` with that context.

## Code structure: the graphify graph

`graphify-out/graph.json` is a knowledge graph of this repository (gitignored, local only).
Use it before grep for structural questions: what calls a function, what 
depends on a module, how two parts of the code connect, or where a concept 
lives when you do not know its name.

    graphify query "how does a DHCP scope get its lease time"
    graphify path "ScopeDialog" "defaultLeaseTime"
    graphify explain "resolveEffectiveScopeOptions"

The graph is a map, not the source of truth. Confirm every answer in the code 
before you act on it or report it. Its edges are marked EXTRACTED (read from 
the code) or INFERRED (guessed by a model), so trust INFERRED ones less.

Use grep for literal text: an error message, a setting key, a `data-track` id,
a string in SQL. The graph does not index those.

If the graph is older than the code you are asking about, refresh it first with
`graphify update .`. It re-reads the code files only and needs no API key. If
`graphify-out/` is missing, skip the graph and search the code directly.

## SSH from the agent sandbox

The host's `/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf` is a valid
root-owned symlink to the root-owned mode `0644` file at
`/usr/lib/systemd/ssh_config.d/20-systemd-ssh-proxy.conf`. The agent sandbox
may expose these protected system paths as owned by `nobody:nogroup`, causing
OpenSSH to report `Bad owner or permissions`.

Do not change the host's ownership or permissions in response to this sandbox
artifact. Bypass the sandbox-visible global SSH configuration with
`ssh -F /dev/null` and supply the required identity and connection options
explicitly.

## IPv4 and IPv6

Every feature and fix that touches addresses must handle both families.

- Use the family-aware helpers: `utils/address.js` (`parseIp`,
  `addressFamily`, `sortKey`, `canonicalizeIp`) and `utils/cidr.js`
  (`parseNetwork`, `addressToBig`/`bigToAddress`, `networkContains`). Never
  use a dotted-quad regex, `ipToLong`, or 32-bit arithmetic on an address that
  could be IPv6.
- Supporting both does not mean treating them alike. IPv6 has its own rules
  in `docs/ARCHITECTURE.md` (Canonical IP Model, the IPv6 paragraph): no
  broadcast, sparse address rows, PTRs only for allocated addresses, routers
  from Router Advertisements, SLAAC modes on a /64 only, and DHCPv4 and
  DHCPv6 option codes as separate namespaces. Follow those, don't mirror IPv4.
- IPv6 is behind a switch (`utils/ipv6-support.js`). With it off, features
  still work for IPv4 and refuse IPv6 input with a clear error
  (`refuseIpv6Unless`).
- Something inherently single-family (ARP, DHCPv4 option 42, Neighbor
  Discovery) is fine. Say so in a comment where it is implemented.
- Tests cover both families: an IPv4 case and an IPv6 case for the behavior
  (`enableIpv6` in `tests/helpers/test-db.js` turns the switch on).
