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
