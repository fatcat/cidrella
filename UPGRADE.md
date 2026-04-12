# CIDRella Upgrade and Recovery Guide

This document covers installing, updating, rolling back, and recovering a CIDRella installation on a Debian/Ubuntu system (native or LXC).

If CIDRella is down and you are reading this, jump to [Emergency Recovery](#emergency-recovery).

---

## How updates work

CIDRella uses an **A/B slot** layout for atomic updates with automatic rollback.

```
/opt/cidrella        -> symlink to the active slot
/opt/cidrella-a/     slot A
/opt/cidrella-b/     slot B
```

- A new release is extracted to the **inactive** slot while the current version keeps running
- A pre-flight probe starts the new version on a temporary port and verifies every subsystem (SQLite, DuckDB, bcrypt, raw-socket) before any switchover
- Databases are snapshotted to `/var/lib/cidrella/snapshots/pre-update/` before the symlink swap
- The symlink swap is atomic — only the Node.js process is restarted, which takes a few seconds
- `dnsmasq` (DNS/DHCP) runs as a separate systemd unit and is **not** restarted during updates. DNS and DHCP stay up throughout.
- If the new version fails its post-switch health check, `update.sh` automatically rolls back to the previous slot and restores the database snapshot.

### What the release tarball contains

Release tarballs ship as `cidrella-vX.Y.Z-linux-x64.tar.gz` and include:

- `server/` — Node.js server code
- `server/node_modules/` — **pre-built** with native binaries. No `npm install` runs during updates.
- `client/dist/` — built Vue frontend
- `scripts/` — install, rollback, systemd units, sudoers
- `update.sh` — the update script (extracted and re-execed on self-update)

Because native modules are bundled, updates do not require:

- DNS resolution (avoiding the chicken-and-egg when CIDRella *is* the DNS resolver)
- Python or `python3-setuptools` on the target
- `build-essential` or a C compiler
- Network access during the install phase

The tarball is ~45 MB. Sign verification uses minisign against the public key at `/opt/cidrella/scripts/cidrella.pub`.

---

## Installing

Fresh install on Debian 12+ or Ubuntu 22.04+:

```bash
curl -sSL https://raw.githubusercontent.com/fatcat/cidrella/main/scripts/install.sh | sudo bash
```

The installer will:

1. Install system dependencies (Node 22, dnsmasq, build tools, `python3-setuptools`)
2. Create the `cidrella` service user
3. Extract the latest release tarball to `/opt/cidrella-a/` and create the symlink `/opt/cidrella -> /opt/cidrella-a`
4. Install the systemd units (`cidrella.service`, `cidrella-dnsmasq.service`, `cidrella-anomaly.service`)
5. Install the `cidrella-update` and `cidrella-rollback` commands to `/usr/local/bin/`
6. Start the services

If you need a specific version:

```bash
sudo bash install.sh --version 0.5.0
```

---

## Updating

### Normal update

From the command line:

```bash
sudo cidrella-update
```

From the web UI: **System → Updates** tab, click **Install Update**.

Both paths run the same `update.sh` script. The UI variant spawns the update in a systemd transient scope so it survives `cidrella.service` being restarted.

The update proceeds through these phases:

| Phase | Action |
|---|---|
| Preflight | Verify root, disk space (400 MB minimum), detect A/B slots |
| DNS fallback | If `/etc/resolv.conf` points at localhost, inject 8.8.8.8 / 1.1.1.1 temporarily |
| Download | Fetch tarball + signature from GitHub |
| Verify | minisign signature verification against embedded public key |
| Extract | Unpack to the inactive slot (old version keeps running) |
| Validate | `node --check` + spawn on temp port 18443 + hit `/api/health/deep` |
| Snapshot | SQLite WAL checkpoint + copy DB files + copy `analytics.duckdb` |
| Switch | Swap symlink + `systemctl daemon-reload` + restart `cidrella` |
| Verify | Poll health for up to 20 seconds |
| Success or auto-rollback | If the new version fails, revert to previous slot + restore DB |

`cidrella-dnsmasq.service` is never restarted, so DNS/DHCP stay up even if the update fails catastrophically.

### Update to a specific version

```bash
sudo cidrella-update --version 0.5.0
```

Downgrades via `cidrella-update` are refused — use `cidrella-rollback` instead (it restores the DB snapshot too).

### Skipping versions

Jumping multiple versions at once (for example, v0.4.2 to v0.7.0) is supported:

- **Schema migrations apply sequentially** from whatever `schema_version` is in your DB to the latest. All historical migrations ship with every release.
- **Bundled dependencies** are whatever the target version built against — you do not accumulate cruft from intermediate versions.
- **update.sh will warn** when you skip more than one minor version and point you at the release notes.

Before a large jump, read the release notes for each intermediate version on GitHub. Watch for:

- **Breaking config changes** — new required settings or format changes to settings in `cidrella.db`
- **Node.js version changes** — `install.sh` ships with `NODE_MAJOR=22`. Tarballs include native binaries built against the release's Node ABI. If a future release moves to Node 24, the bundled binaries will not load on Node 22 and the update script will exit cleanly during pre-flight.
- **DuckDB major version changes** — DuckDB on-disk format is **not backward compatible** across major versions. Once an update runs migrations that touch `analytics.duckdb`, a rollback to the previous DuckDB version will lose analytics data (the snapshot is restored, but it was written by the older DuckDB, so it is readable again).
- **Minisign key rotation** — if the public signing key ever rotates, you will need to update `/opt/cidrella/scripts/cidrella.pub` manually before `cidrella-update` can verify new releases.

### Triggering from the API

```
POST /api/version/install         # uses whatever is in update_available_version
```

This endpoint returns 400 if no update is available, 409 if an update is already running, and 202 if it started successfully. Follow progress via:

```
GET /api/version/update-status    # reads /var/lib/cidrella/update-status.json
```

---

## Rolling back

A rollback restores the **previous slot and the pre-update database snapshot** that `update.sh` took before cutting over. It is deliberately a single-step operation — we keep only one previous version, not a multi-version history.

### When rollback is available

After any successful update that used the A/B system, the previous version remains in the inactive slot and the pre-update snapshot remains in `/var/lib/cidrella/snapshots/pre-update/`. Both are overwritten on the next update.

### How to roll back

Interactive:

```bash
sudo cidrella-rollback
```

Non-interactive (for scripts or when SSH session might get dropped):

```bash
sudo cidrella-rollback --yes
```

Preview without doing anything:

```bash
sudo cidrella-rollback --list
```

`cidrella-rollback` is a standalone bash script installed at `/usr/local/bin/cidrella-rollback`. It does **not** depend on CIDRella's Node.js code, DNS resolution, or network access. The script is copied from the currently running version **before** each update, so the rollback script is always the last known-good logic — not the new version's logic.

### What rollback does

1. Stops `cidrella.service`
2. Restores `cidrella.db`, `cidrella.db-wal`, `cidrella.db-shm`, and `analytics.duckdb` from `/var/lib/cidrella/snapshots/pre-update/`
3. Swaps the `/opt/cidrella` symlink back to the previous slot
4. `systemctl daemon-reload` and restarts `cidrella.service`
5. Waits up to 15 seconds for the service to come up
6. Reports success or failure

`cidrella-dnsmasq.service` is not touched — DNS/DHCP stay up during rollback.

### What rollback does NOT do

- It does not roll back `cidrella-dnsmasq.service` or its config. dnsmasq configuration in `/var/lib/cidrella/dnsmasq/` is considered part of the live state and is shared between slots.
- It does not preserve data written between the pre-update snapshot and the rollback. That window is typically a few seconds for successful updates, or minutes for a failed update that auto-rolled back. Any DHCP leases, audit log entries, or setting changes written in that window are lost.
- It does not roll back more than one version. If you need to go back further, manually extract an older release tarball to an empty slot or reinstall.

---

## Emergency Recovery

If CIDRella is not starting after an update, try these in order.

### 1. Look at the logs

```bash
journalctl -u cidrella -n 100 --no-pager
```

The most common failures:

- **`ERR_DLOPEN_FAILED: compiled against a different Node.js version`** — the bundled native binaries in the tarball do not match the installed Node.js ABI. Usually caused by a Node.js upgrade that happened outside the CIDRella install flow. Fix: `cd /opt/cidrella/server && npm rebuild` (requires `build-essential` + `python3-setuptools`).
- **`Cannot find module 'express'`** — `server/node_modules/` is missing or incomplete. This used to happen with the old update script when `npm install` failed silently. With the new bundled tarballs, it indicates a botched manual change. Fix: extract the tarball fresh or `cd /opt/cidrella/server && npm install --omit=dev`.
- **`Database schema v{N} is newer than code max v{M}`** — the database has been migrated to a newer version than the currently running code supports. This happens if someone manually swapped code directories without restoring the DB. Fix: `sudo cidrella-rollback` (restores the DB snapshot too).

### 2. Automatic rollback

If `update.sh` detected the failure and rolled back automatically, `systemctl status cidrella` will show the service running from the previous slot. Check:

```bash
readlink /opt/cidrella
node -e "console.log(require('/opt/cidrella/package.json').version)"
```

If the symlink points to the previous slot and the version matches what you had before the update, the auto-rollback worked. Investigate the failure in the logs at your leisure.

### 3. Manual rollback

If the service is down and auto-rollback did not run (or failed):

```bash
sudo cidrella-rollback --yes
```

This works even if `cidrella.service` is completely broken — the script does not depend on CIDRella code.

### 4. Manual surgery — symlink swap only (no DB restore)

If you need to swap the symlink manually without restoring the database (for example, the database is fine and only the code is broken):

```bash
# Determine the previous slot
ls -la /opt/cidrella

# If /opt/cidrella -> /opt/cidrella-b, swap to A (or vice versa)
sudo ln -sfn /opt/cidrella-a /opt/cidrella
sudo systemctl daemon-reload
sudo systemctl restart cidrella
```

### 5. Manual surgery — restore database only

If the code is fine but the database got migrated and you want to roll back just the DB:

```bash
sudo systemctl stop cidrella
sudo cp -a /var/lib/cidrella/snapshots/pre-update/cidrella.db /var/lib/cidrella/cidrella.db
sudo cp -a /var/lib/cidrella/snapshots/pre-update/cidrella.db-wal /var/lib/cidrella/cidrella.db-wal 2>/dev/null || sudo rm -f /var/lib/cidrella/cidrella.db-wal
sudo cp -a /var/lib/cidrella/snapshots/pre-update/cidrella.db-shm /var/lib/cidrella/cidrella.db-shm 2>/dev/null || sudo rm -f /var/lib/cidrella/cidrella.db-shm
sudo cp -a /var/lib/cidrella/snapshots/pre-update/analytics.duckdb /var/lib/cidrella/analytics.duckdb
sudo chown -R cidrella:cidrella /var/lib/cidrella/cidrella.db* /var/lib/cidrella/analytics.duckdb
sudo systemctl start cidrella
```

### 6. Fresh reinstall from tarball

If both slots are broken and you do not have a rollback snapshot:

```bash
# Download the version you want
TAG=v0.5.0
curl -fsSL "https://github.com/fatcat/cidrella/releases/download/${TAG}/cidrella-${TAG}-linux-x64.tar.gz" -o /tmp/cidrella.tar.gz

# Verify signature
curl -fsSL "https://github.com/fatcat/cidrella/releases/download/${TAG}/cidrella-${TAG}-linux-x64.tar.gz.minisig" -o /tmp/cidrella.tar.gz.minisig
minisign -Vm /tmp/cidrella.tar.gz -p /opt/cidrella/scripts/cidrella.pub

# Extract over slot A (preserves slot B if you want to compare)
sudo systemctl stop cidrella
sudo rm -rf /opt/cidrella-a
sudo mkdir -p /opt/cidrella-a
sudo tar -xzf /tmp/cidrella.tar.gz -C /tmp/
sudo rsync -a /tmp/cidrella-${TAG}-linux-x64/ /opt/cidrella-a/
sudo chown -R cidrella:cidrella /opt/cidrella-a
sudo ln -sfn /opt/cidrella-a /opt/cidrella
sudo systemctl daemon-reload
sudo systemctl start cidrella
```

Your data in `/var/lib/cidrella/` is untouched by this procedure.

---

## Backup and Restore

CIDRella has a **separate** backup mechanism that complements the rollback system. The two cover different situations:

| | Rollback snapshot | Backup archive |
|---|---|---|
| **Scope** | Last pre-update DB + analytics | DB + dnsmasq config + TLS certs |
| **Retention** | Always exactly one (overwritten by next update) | Configurable count (default 7) |
| **Trigger** | Automatic — every update | Scheduled (daily) + manual |
| **Use when** | Bad update needs reverting | Disaster recovery, restoring to a new host |
| **Restores DuckDB analytics** | Yes | No |
| **Location** | `/var/lib/cidrella/snapshots/pre-update/` | `/var/lib/cidrella/backups/` |

### What's in a backup

A backup archive is a gzipped tar of:

- `cidrella-backup-manifest.json` — metadata: CIDRella version, schema version, creation time, included files
- `cidrella.db` — main SQLite database (settings, subnets, DNS/DHCP records, users, audit log)
- `dnsmasq/` — dnsmasq config, hosts files, dhcp-hosts files, lease file
- `certs/` — TLS certificates (the self-signed or imported cert that the web UI serves)

It does **not** include:

- `analytics.duckdb` — the DNS query analytics database. Analytics is explicitly non-critical — losing it does not affect DNS/DHCP operation. If you need analytics history across a restore, snapshot it manually (see below).
- `geoip/` — GeoIP database. Regenerated on next scheduled update.
- `backups/` — obviously. Avoids recursive backup-of-backups.
- `snapshots/pre-update/` — the rollback snapshots, tied to a specific slot.
- `snapshots/pre-restore/` — the pre-restore safety snapshot, tied to the host.

**Backups from before v0.5.0 (legacy backups)** have no manifest. Restore still works, but CIDRella cannot verify version compatibility — you get a warning and the restore proceeds at your own risk.

### Creating a backup

From the UI: **System → Backups** tab, click **Create Backup**.

From the API:

```bash
TOKEN=$(curl -sk https://SERVER:8443/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"..."}' | jq -r .token)
curl -sk -X POST -H "Authorization: Bearer $TOKEN" https://SERVER:8443/api/operations/backup
```

From the command line (on the host, as root):

```bash
sudo -u cidrella bash -c '
  cd /var/lib/cidrella
  # Checkpoint WAL first so the .db file is current
  node -e "
    const Database = require(\"/opt/cidrella/server/node_modules/better-sqlite3\");
    const db = new Database(\"cidrella.db\");
    db.pragma(\"wal_checkpoint(TRUNCATE)\");
    db.close();
  "
  ts=$(date +%Y-%m-%d_%H-%M-%S)
  tar -czf "backups/cidrella-backup-${ts}.tar.gz" cidrella.db dnsmasq certs
  echo "backups/cidrella-backup-${ts}.tar.gz"
'
```

### Automatic backups

Backups run on a schedule controlled by the `backup_schedule` setting (default: daily). Retention is controlled by `backup_retention_count` (default: 7). Both are editable in **System → Settings**.

Retention enforcement deletes the oldest backups first. The scheduled runner uses the same `createBackup()` code as manual backups — including the WAL checkpoint — so a scheduled backup is always consistent.

### Downloading a backup off the host

From the UI, the backup list has a download button that streams the archive.

Via API:

```bash
curl -sk -H "Authorization: Bearer $TOKEN" \
  "https://SERVER:8443/api/operations/backups/${BACKUP_ID}/download" \
  -o cidrella-backup.tar.gz
```

Via shell:

```bash
scp root@SERVER:/var/lib/cidrella/backups/cidrella-backup-*.tar.gz ./
```

Keep backups off-host. If the server disk dies, the backups die with it.

### Restoring a backup

**Safety net**: Before any restore (via API or CLI), CIDRella takes a **pre-restore snapshot** of your current state to `/var/lib/cidrella/snapshots/pre-restore/`. If the restore brings in a bad or wrong backup, you can recover by restoring that snapshot manually. Unlike rollback snapshots, this one is not managed by `cidrella-rollback` — see [Recovering from a bad restore](#recovering-from-a-bad-restore).

**Version safety**: The restore path checks the backup's manifest and refuses to restore a backup from a **newer** version of CIDRella than the one currently running. The old code cannot handle a newer schema; it would just fail to start after the restore. Upgrade CIDRella first, then restore.

**Over an existing install** (same host, roll back to an earlier state):

Via UI: **System → Backups** → select a backup → **Restore**. The server takes a pre-restore snapshot, swaps files, and exits. systemd restarts it automatically.

Via API:

```bash
# Inspect first (no changes made)
curl -sk -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/gzip" \
  --data-binary @/path/to/cidrella-backup.tar.gz \
  "https://SERVER:8443/api/operations/restore?inspect=1"

# If compatible, restore (server will restart mid-response)
curl -sk -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/gzip" \
  --data-binary @/path/to/cidrella-backup.tar.gz \
  "https://SERVER:8443/api/operations/restore"

# Force restore of a newer backup (NOT recommended — will cause schema
# version incompatibility and the service will refuse to start):
curl -sk -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/gzip" \
  --data-binary @/path/to/cidrella-backup.tar.gz \
  "https://SERVER:8443/api/operations/restore?allowIncompatible=1"
```

Via command line (for when the UI or API is unreachable):

```bash
sudo systemctl stop cidrella
cd /var/lib/cidrella
# Extract — this overwrites cidrella.db, certs/, dnsmasq/
sudo tar -xzf /path/to/cidrella-backup.tar.gz
sudo rm -f cidrella.db-wal cidrella.db-shm  # stale WAL would confuse SQLite
sudo chown -R cidrella:cidrella cidrella.db* dnsmasq certs
sudo systemctl start cidrella
```

After a restore, the database may not match the schema your currently running code expects:

- If the backup is **older** than the current schema version, startup migrations will run forward to bring it up to the current schema.
- If the backup is **newer** than what your current code supports (e.g., you installed an older version and restored a backup from a newer one), the schema version compatibility check will refuse to start. Install a version equal to or newer than what created the backup.

### Recovering from a bad restore

Every restore (via API or UI) takes a snapshot of the pre-restore state to `/var/lib/cidrella/snapshots/pre-restore/`. If the restored backup was wrong, corrupted, or from the wrong host, you can undo it:

```bash
sudo systemctl stop cidrella
cd /var/lib/cidrella
# Restore the pre-restore snapshot
sudo cp -a snapshots/pre-restore/cidrella.db cidrella.db
sudo cp -a snapshots/pre-restore/cidrella.db-wal cidrella.db-wal 2>/dev/null || sudo rm -f cidrella.db-wal
sudo cp -a snapshots/pre-restore/cidrella.db-shm cidrella.db-shm 2>/dev/null || sudo rm -f cidrella.db-shm
sudo cp -a snapshots/pre-restore/analytics.duckdb analytics.duckdb
sudo rm -rf certs dnsmasq
sudo cp -a snapshots/pre-restore/certs certs
sudo cp -a snapshots/pre-restore/dnsmasq dnsmasq
sudo chown -R cidrella:cidrella cidrella.db* analytics.duckdb certs dnsmasq
sudo systemctl start cidrella
```

The pre-restore snapshot is overwritten by the next restore operation. If you take a second restore before recovering, the first pre-restore state is gone. `cidrella-rollback` does **not** touch pre-restore snapshots — they're a separate recovery mechanism from the pre-update rollback system.

**On a new host** (disaster recovery — server died, setting up a replacement):

1. Fresh-install CIDRella at the same or newer version than the backup was taken from:
   ```bash
   curl -sSL https://raw.githubusercontent.com/fatcat/cidrella/main/scripts/install.sh | sudo bash
   ```
2. Let the install complete and verify the service starts (you will have the "default admin" password from the fresh install output — ignore it, you will use your backup's credentials)
3. Stop the service and restore:
   ```bash
   sudo systemctl stop cidrella
   sudo tar -xzf /path/to/cidrella-backup.tar.gz -C /var/lib/cidrella/
   sudo chown -R cidrella:cidrella /var/lib/cidrella/cidrella.db* /var/lib/cidrella/dnsmasq /var/lib/cidrella/certs
   sudo systemctl start cidrella
   ```
4. Log in with the credentials from your backup. The fresh-install admin is overwritten by the backup's users table.

### Snapshotting analytics manually

If you need to preserve analytics data across a restore (for trending, audit, compliance):

```bash
# Before restoring
sudo cp /var/lib/cidrella/analytics.duckdb /tmp/analytics-preserved.duckdb
# Restore as usual
sudo tar -xzf /path/to/backup.tar.gz -C /var/lib/cidrella/
# Put analytics back
sudo cp /tmp/analytics-preserved.duckdb /var/lib/cidrella/analytics.duckdb
sudo chown cidrella:cidrella /var/lib/cidrella/analytics.duckdb
```

This works as long as the DuckDB version matches. If you restored on a different version of CIDRella with a different DuckDB major version, the file may not load.

### Backup-before-upgrade discipline

The rollback snapshot covers routine update failures. For larger risks — major version jumps, schema-heavy releases, one-off experiments — take a full backup first:

```bash
# From the UI: System → Backups → Create Backup
# Or via API / command line as above
```

Download it off-host before you start the upgrade. The rollback snapshot is stored on the same disk as the live data, so it will not help with a disk failure during the upgrade.

---

## DNS chicken-and-egg

Many CIDRella deployments use CIDRella itself as the host's DNS resolver via `/etc/resolv.conf` pointing at `127.0.0.1` or the host's own IP. This creates a problem during updates: if CIDRella is stopped, the host cannot resolve names — including `registry.npmjs.org`, `api.github.com`, or `npm.duckdb.org`.

The new update system handles this in three layers:

1. **Bundled node_modules** — the update never needs to download npm packages.
2. **dnsmasq stays up** — `cidrella-dnsmasq.service` is a separate systemd unit that the update script never touches. DNS answers continue throughout.
3. **Fallback DNS injection** — if the update script does need DNS (tarball download from GitHub, which runs while the old version is still up anyway), and `/etc/resolv.conf` points at localhost, it temporarily injects `8.8.8.8` and `1.1.1.1`. It restores the original resolv.conf on exit via a trap, including on failure.

If you ever need to run npm or apt commands manually while CIDRella is down:

```bash
# Temporarily use public DNS
echo 'nameserver 8.8.8.8' | sudo tee /etc/resolv.conf.cidrella-manual >/dev/null
sudo mv /etc/resolv.conf /etc/resolv.conf.pre-recovery
sudo mv /etc/resolv.conf.cidrella-manual /etc/resolv.conf

# Do whatever you need
# ...

# Restore
sudo mv /etc/resolv.conf.pre-recovery /etc/resolv.conf
```

---

## Troubleshooting

### "Update available" banner keeps showing after I updated

The server cross-checks the stored target version against the running version on every `/api/version` request and clears stale entries on startup. If you still see the banner after an update:

1. Refresh the browser (clear the frontend store cache)
2. Check the DB directly:
   ```bash
   sudo sqlite3 /var/lib/cidrella/cidrella.db "SELECT key, value FROM settings WHERE key LIKE 'update_%';"
   ```
   `update_available_version` should be empty. If it is not, restart `cidrella.service` — `clearStaleUpdateFlag()` runs on boot.

### `cidrella-update` says "Refusing to downgrade"

Use `cidrella-rollback` instead. The update path refuses downgrades because old code plus a newer database schema is a corruption hazard. Rollback restores both the code and the database snapshot together.

### `cidrella-rollback` says "DB snapshot: NOT FOUND"

The pre-update snapshot in `/var/lib/cidrella/snapshots/pre-update/` has been overwritten by a subsequent update, or the last update was done by a pre-A/B version of `update.sh` that did not take a snapshot. You can still roll back the code, but the database will not be reverted. If the new version ran schema migrations, this will cause the old code to fail on startup with a schema compatibility error. In that case:

- Either update to a newer version that is compatible with the current database
- Or restore the database from a CIDRella backup (`server/src/utils/backup.js` runs daily backups to `/var/lib/cidrella/backups/`)

### "Insufficient disk space on /opt"

The update script requires 400 MB of free space on `/opt`. Bundled tarballs are ~45 MB but the script needs room for the tarball download, the extracted tarball in `/tmp`, and the populated target slot. Free up space and retry:

```bash
df -BM /opt
sudo rm -rf /opt/cidrella.bak-*   # old backup directories from pre-A/B installs
```

### Node version mismatch after host upgrade

If you upgrade Node.js on the host (for example, from Node 20 to Node 22 via `apt upgrade`), the native binaries in both slots will fail to load because they were built against the old ABI. Recovery:

```bash
cd /opt/cidrella/server
sudo -u cidrella npm rebuild
sudo systemctl restart cidrella
```

Then also rebuild the inactive slot so rollback remains an option:

```bash
# Figure out the inactive slot
ACTIVE=$(readlink -f /opt/cidrella)
INACTIVE=/opt/cidrella-a
[ "$ACTIVE" = "/opt/cidrella-a" ] && INACTIVE=/opt/cidrella-b

cd "$INACTIVE/server"
sudo -u cidrella npm rebuild
```

The long-term fix is to update via `cidrella-update`, which will bring in a fresh bundled `node_modules` matching the current Node version.

### Update hangs or the scope dies partway through

If an update started via the UI gets interrupted (browser closed, systemd-run scope killed), check:

```bash
systemctl status cidrella-update.scope
cat /var/lib/cidrella/update-status.json
```

If the scope is gone but `update-status.json` still says "in progress", the update either finished or died. The A/B design means your running version is unchanged unless the symlink was swapped — check:

```bash
readlink /opt/cidrella
systemctl status cidrella
```

If the symlink is swapped and cidrella is running, the update succeeded. If the symlink is still pointing at the old slot and cidrella is running, you can just retry:

```bash
sudo cidrella-update
```

Clear the stale status file to dismiss the UI indicator:

```bash
sudo rm /var/lib/cidrella/update-status.json
```

### Signature verification failed

The minisign signature on the downloaded tarball does not match the public key at `/opt/cidrella/scripts/cidrella.pub`. This can mean:

- The download is corrupted — retry
- The release was not signed (older releases)
- You are running an unofficial fork that uses a different signing key
- The signing key has been compromised — **stop and investigate**

---

## Files and locations reference

| Path | Purpose |
|---|---|
| `/opt/cidrella` | Symlink to the active slot |
| `/opt/cidrella-a/`, `/opt/cidrella-b/` | A/B slots (code only) |
| `/var/lib/cidrella/cidrella.db` | Main SQLite database |
| `/var/lib/cidrella/cidrella.db-wal` | SQLite write-ahead log |
| `/var/lib/cidrella/analytics.duckdb` | DuckDB analytics database (DNS queries, metrics) |
| `/var/lib/cidrella/snapshots/pre-update/` | Database snapshot taken by last update (restored by `cidrella-rollback`) |
| `/var/lib/cidrella/snapshots/pre-restore/` | Safety snapshot taken before last backup restore (manual recovery only) |
| `/var/lib/cidrella/backups/` | Daily full backups |
| `/var/lib/cidrella/dnsmasq/` | dnsmasq config, hosts files, lease file |
| `/var/lib/cidrella/update-status.json` | Current update progress (read by UI) |
| `/etc/systemd/system/cidrella.service` | Main service unit |
| `/etc/systemd/system/cidrella-dnsmasq.service` | DNS/DHCP unit (NOT restarted during updates) |
| `/etc/systemd/system/cidrella-anomaly.service` | Python anomaly detector |
| `/usr/local/bin/cidrella-update` | Symlink to active slot's `update.sh` |
| `/usr/local/bin/cidrella-rollback` | **Copied** (not symlinked) from the previous version before each update |
