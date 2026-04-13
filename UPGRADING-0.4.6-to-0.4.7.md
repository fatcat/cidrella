# Upgrading from v0.4.6 to v0.4.7 (or later)

If your current install is on **v0.4.6**, `cidrella-update` will fail during preflight with one of these messages:

- `Pre-flight failed: missing native bindings: bcrypt`
- `Pre-flight health probe failed — new version did not come up cleanly` (caused by a raw-socket EPERM deep in the health check)

Both are real blockers. They exist because v0.4.6's `update.sh` was written with two assumptions that v0.4.7 intentionally broke:

1. **v0.4.7 replaced `bcrypt` (native) with `bcryptjs` (pure JS)**, so `server/node_modules/bcrypt/lib/binding/*.node` no longer exists. v0.4.6's hardcoded file-existence check fails.
2. **v0.4.7 bundles the Node runtime** inside the tarball at `runtime/node/bin/node`. v0.4.6's preflight probe spawns that binary directly (bypassing systemd's `AmbientCapabilities`), which means the binary has no file capabilities, and `raw-socket.createSocket()` fails with `EPERM` in the deep health check.

v0.4.7's own `update.sh` has both fixes baked in. Every release from **v0.4.7 onward upgrades cleanly**. But to escape v0.4.6 you need a one-shot hot-patch that removes the bcrypt check and adds a `setcap` between the extract and preflight steps.

## Hot-patch recipe

Copy-paste into an SSH session on the v0.4.6 host:

```bash
# 1. Confirm you're on v0.4.6
curl -sk https://127.0.0.1:8443/api/health
# Expected: {"status":"ok","version":"0.4.6",...}

# 2. Back up update.sh so you can revert if anything goes wrong
cp /opt/cidrella/update.sh /opt/cidrella/update.sh.bak-v046

# 3a. Remove the bcrypt native-binding check
sed -i '/find .*node_modules\/bcrypt\/lib\/binding/d' /opt/cidrella/update.sh

# 3b. Insert setcap on the target slot's bundled Node binary right after
#     the native-bindings check, guarded by `[ -x ]` so it's a no-op on
#     pre-v0.4.7 tarballs that don't ship a bundled runtime.
sed -i '/^ok "Native bindings present"$/a\
\
# Hot-patch: apply file caps to bundled Node binary before preflight probe\
# so raw-socket createSocket() works. Only active in v0.4.7+ tarballs.\
if [ -x "$TARGET_SLOT/runtime/node/bin/node" ]; then\
  setcap cap_net_raw,cap_net_bind_service+ep "$TARGET_SLOT/runtime/node/bin/node" 2>/dev/null || true\
fi' /opt/cidrella/update.sh

# 4. Sanity-check the patch
bash -n /opt/cidrella/update.sh && echo "syntax OK"
grep -c 'bcrypt.*binding' /opt/cidrella/update.sh   # must print 0
grep -A1 'Native bindings present' /opt/cidrella/update.sh | tail -3  # should show setcap

# 5. Run the upgrade
sudo cidrella-update

# 6. Verify v0.4.7 is live
curl -sk https://127.0.0.1:8443/api/health
# Expected: {"status":"ok","version":"0.4.7",...}
getcap /opt/cidrella/runtime/node/bin/node
# Expected: /opt/cidrella/runtime/node/bin/node cap_net_bind_service,cap_net_raw=ep
```

## The hot-patch is a one-shot bridge

After a successful upgrade the new slot's `update.sh` (from v0.4.7's tarball) becomes the active script, and every future `cidrella-update` uses the v0.4.7 version which already has both fixes. You never have to run the hot-patch again.

## If the upgrade fails

Auto-rollback should revert to v0.4.6 automatically. If it doesn't, restore the backup and use the standalone rollback:

```bash
cp /opt/cidrella/update.sh.bak-v046 /opt/cidrella/update.sh
sudo cidrella-rollback --yes
```

## Skipping v0.4.6 entirely

If you're installing fresh (rather than upgrading), you can skip v0.4.6 and install v0.4.7 or later directly:

```bash
curl -sSL https://raw.githubusercontent.com/fatcat/cidrella/main/scripts/install.sh | sudo bash
```

Fresh installs of v0.4.7+ ship with a working `update.sh`, so no hot-patch is ever needed on a fresh v0.4.7+ install.
