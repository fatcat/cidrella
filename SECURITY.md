# Security

CIDRella is a self-hosted IPAM/DNS/DHCP appliance. This document covers how to report a vulnerability, what's in scope, the project's security posture, and any historical disclosures worth knowing about.

## Reporting a vulnerability

Please **do not** file public GitHub issues for security vulnerabilities. Instead:

Open a [private security advisory](https://github.com/fatcat/cidrella/security/advisories/new) on this repo

Include enough detail to reproduce: affected version, the request or input that triggers the issue, and the observed vs. expected behavior. A working PoC is appreciated but not required.

I aim to acknowledge reports within a few days and ship a fix in the next release train. CIDRella is a one-maintainer project — please be patient with response times.

## Supported versions

Only the latest released version receives security fixes. Old release tags are kept for installation history but are not patched. Run `cidrella-update` to stay current; the in-app updater is the canonical upgrade path.

## Security posture

A few things worth knowing if you're evaluating CIDRella for self-hosting:

- **Releases are signed.** Every release tarball is signed with [minisign](https://jedisct1.github.io/minisign/). The primary public key ships in `scripts/cidrella.pub` inside every release. `update.sh` verifies the signature against the embedded pubkey before extracting any new slot, and refuses to apply unsigned or mis-signed tarballs.
- **Per-install secrets.** The JWT signing secret and self-signed TLS certificate are generated at install time using `crypto.randomBytes(64)`. Nothing in the release tarball seeds these — every install has its own secrets.
- **A/B slot updates with auto-rollback.** Updates extract to an inactive slot, preflight-probe the new slot's `/api/health/deep`, and only swap the symlink if the probe passes. A failed health check after switchover triggers automatic rollback to the previous slot. DNS and DHCP stay up across updates (the `cidrella-dnsmasq` service is never restarted by the updater).
- **Systemd hardening.** Service units run with `ProtectSystem=strict`, narrow `CapabilityBoundingSet`, `NoNewPrivileges`, `PrivateDevices`, the full `Protect*` family, and explicit `ReadWritePaths`. The Python anomaly daemon runs with an empty capability bounding set.
- **Filesystem permissions.** `cidrella.db`, `analytics.duckdb`, and the TLS private key are mode 0600 and owned by the `cidrella` user. The `certs/`, `backups/`, and `anomaly/` directories are mode 0700.
- **Break-glass key rotation.** Primary signing-key rotation is supported via signed announcements verified against an embedded break-glass pubkey, applied before tarball verification. See `BREAK-GLASS-CEREMONY.md`.

## Historical disclosures

### Releases v0.4.0–v0.4.5: development artifacts shipped in tarballs (fixed in v0.4.6)

**Summary**: Release tarballs for v0.4.0 through v0.4.5 included the maintainer's development data directory under `server/data/`, containing a development SQLite database, a development self-signed TLS private key, and a few related dev artifacts.

**What was leaked**:
- A development JWT signing secret (the `jwt_secret` row in the dev `cidrella.db`)
- A development self-signed TLS private key (`server/data/certs/server.key`)
- A bcrypt hash for a development `admin` account
- A development audit log

**Why it happened**: `scripts/build-release.sh` used `rsync -a --exclude='node_modules'` without a broader exclude list. Anything in `server/` outside `node_modules/` was staged into the tarball. This included the running dev environment's data directory.

**Why it is not currently exploitable against any real install**:
- **The leaked JWT secret has no install that uses it.** Both `install.sh` (native) and the Dockerfile (container) bootstrap from an empty data directory at runtime: `/var/lib/cidrella/` (native) or `/data` (Docker). The leaked `cidrella.db` ends up at `/opt/cidrella/server/data/cidrella.db` (native) or `/app/server/data/cidrella.db` (Docker), which is the wrong path — the running server never opens it. On first start, `db/init.js:ensureDefaults()` finds no `jwt_secret` in the empty DB and generates a fresh per-install secret with `crypto.randomBytes(64)`. A forged token signed with the leaked secret will not verify against any real install's middleware.
- **The leaked TLS key is self-signed and untrusted.** No browser or system trust store accepts it, and `install.sh` generates a fresh self-signed cert per install via `openssl`.
- **The leaked bcrypt hash is for a development `admin` account that does not exist on real installs.** `install.sh` prompts the operator for an admin password during first-run setup and forces a password change on first login.

**What was fixed in v0.4.6**:
- Added `.buildignore` and wired `build-release.sh` to consult it via `rsync --exclude-from`. The exclude list covers `server/data/`, `*.db`, `*.key`, `*.pem`, `.env*`, and several other secret-shaped patterns.
- Rotated the development JWT secret and TLS key on the maintainer's dev environment so the leaked artifacts are dead bytes.
- Added a release-hygiene checklist to the project's automated review pipeline so future release artifacts are inspected for secrets before publish.

**Cannot be remediated**: GitHub release assets are immutable. The v0.4.0 through v0.4.5 tarballs still exist at https://github.com/fatcat/cidrella/releases and any party that scraped them previously may still have copies. Yanking the release tags would break installation history for users of those versions and is not planned.

**Action required by users**: none. If you installed CIDRella from any version (including v0.4.0–v0.4.5), your install generated its own secrets at first start; the leaked dev secrets are not in your data directory and were never used to sign your tokens or your TLS cert. No password change, key rotation, or reinstall is necessary on the basis of this disclosure.

If you are still running v0.4.5 or older, you should update for unrelated reasons: `cidrella-update` will roll you forward through the resilient A/B slot updater.

## Out of scope

Findings against the following are not considered vulnerabilities for this project:

- **Self-signed TLS certificates on a fresh install.** Operators are expected to upload their own certificates via the System → Certificates UI or accept the self-signed cert during first-run setup.
- **Default admin credentials.** First-run setup generates a one-time random admin password that the installer prints to the console exactly once and forces a change at first login.
- **DNS amplification using CIDRella's DNS proxy as an open resolver.** CIDRella binds to the operator-configured interface(s) and is not designed to be exposed to untrusted networks. Operators are responsible for their network boundary.
- **Issues that require privileged local access to the host.** If an attacker is already root on the box, CIDRella's threat model assumes they can do anything CIDRella can do.
- **Brute-forcing the locally-stored bcrypt admin hash from a stolen `cidrella.db`.** The mitigation is filesystem permissions (mode 0600, `cidrella:cidrella` ownership) plus operator host security. CIDRella is not a credential vault.
