# Break-Glass Minisign Key Ceremony

**Status**: Runbook — to be executed offline by the project owner before v0.4.8 (Phase 3) can ship. This document describes what you do, why each step exists, and what to verify after each step. Claude cannot execute this ceremony on your behalf — it involves an air-gapped machine, physical media, and a safe.

## Background

CIDRella's release tarballs are signed with a single **primary** minisign key (`~/.minisign/cidrella.key`). The public half is embedded in `install.sh` and in each release tarball as `scripts/cidrella.pub`. Every `cidrella-update` / fresh `install.sh` run verifies the new tarball against that public key before touching the filesystem.

A single key is a single point of failure. If the primary key is ever compromised — build machine break-in, accidental public commit, laptop theft — there is no way to revoke it and no way to distribute a replacement over the existing signed channel (because any "please trust this new key" message would itself need a signature from a trusted key).

The **break-glass** key exists to solve this. Its purpose is narrow:

1. It never signs releases.
2. It lives offline, in physical storage, rotated rarely (every 5+ years or on emergency).
3. Its sole job is to sign a small JSON file — `rotation-announcement-N.json` — that tells existing installs "the primary key has rotated to this new pubkey; trust this one going forward."
4. The break-glass **public** key is embedded in `install.sh` and in every release tarball from v0.4.8 onward, so existing installs already know how to verify a rotation announcement.

The failure modes it protects against:

- Primary key leaked or lost → sign a rotation announcement with break-glass → existing installs pick it up on next update → new primary key takes over.
- Build machine compromised → same path, but the rotation announcement is also how you signal installs to invalidate any already-published releases signed with the compromised key.
- Scheduled rotation every 2-5 years as hygiene → same mechanism, just not triggered by an incident.

The break-glass key will *not* recover:

- Installs that have already been rooted (attacker code has already run locally — the integrity of the install itself is compromised, no key rotation helps).
- The contents of the signed releases themselves (the tarballs are cached on GitHub and elsewhere; key rotation changes what installs will *accept in the future*, not what's already been installed).

## Before you start

**Prerequisites:**

- [ ] An air-gapped machine. Options in order of preference:
  - A Raspberry Pi or old laptop with wifi/bluetooth/ethernet physically disabled (ideally, radios removed)
  - A Tails USB boot
  - A fresh ephemeral VM with networking disabled from the host — acceptable for threat model bronze, not gold
- [ ] `minisign` installed on the air-gapped machine. On Debian/Ubuntu: `apt install minisign`. Verify version: `minisign -v`.
- [ ] A USB stick (brand new or wiped — do not reuse). Ideally two of them for redundancy.
- [ ] A physical safe or safe deposit box for final storage.
- [ ] A printer for QR/text backup, and a laminator if you have one.
- [ ] A notebook to record everything — timestamps, fingerprints, passphrase hints, chain of custody.
- [ ] 30-60 minutes of uninterrupted time.

**Mental model before starting**: you are creating a private key that must NEVER touch a networked machine after this ceremony ends. Every step should be reviewed for that constraint. If in doubt, stop.

## Step 1 — Air-gap the ceremony machine

1. Boot the air-gapped machine.
2. Verify air gap: `ip -br link` should show no wifi, no ethernet carrier. `ping 8.8.8.8` should fail. `ss -tlnp` should show nothing listening.
3. Disable swap: `swapoff -a` and verify with `swapon --show` (empty). This prevents the private key material from accidentally landing on disk via a swap partition.
4. Mount a tmpfs as your working directory so everything is in RAM and disappears on reboot:
   ```bash
   mkdir -p /tmp/ceremony
   mount -t tmpfs -o size=64M,mode=0700 tmpfs /tmp/ceremony
   cd /tmp/ceremony
   ```
5. Confirm the mount: `findmnt /tmp/ceremony` should show `tmpfs`.

## Step 2 — Generate the break-glass keypair

1. Pick a strong passphrase. Options (in order of preference):
   - 6-word Diceware phrase generated with real dice and your own Diceware list (the one shipped in the EFF long wordlist is fine: `/usr/share/dict/words` is not).
   - 25+ characters of uniformly random chars from a cryptographic source: `head -c 32 /dev/urandom | base64`.
   - A memorable sentence you come up with on the spot, ≥ 40 characters, including mixed case and a digit.
   - **Do not** reuse any existing passphrase. **Do not** use a passphrase generator that runs on a networked device.
2. Write the passphrase on paper. Do not type it into a password manager yet — that comes later, with the backup.
3. Generate the keypair:
   ```bash
   cd /tmp/ceremony
   minisign -G -p cidrella-break-glass.pub -s cidrella-break-glass.key
   ```
   You will be prompted for the passphrase twice.
4. Verify the files exist and are well-formed:
   ```bash
   ls -la cidrella-break-glass.key cidrella-break-glass.pub
   head -1 cidrella-break-glass.pub
   # Should start with: "untrusted comment: minisign public key"
   ```
5. Record the key's fingerprint (the first two lines of the pub file) in your notebook. You will compare this value against the embedded pubkey in `install.sh` later to confirm you haven't mixed keys.

## Step 3 — Test sign + verify cycle

Before you trust this key for anything real, verify the sign + verify cycle works end-to-end on the air-gapped machine.

1. Create a test payload:
   ```bash
   echo '{"type":"cidrella-ceremony-test","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > test-rotation.json
   ```
2. Sign it with the break-glass key:
   ```bash
   minisign -S -s cidrella-break-glass.key -m test-rotation.json
   # → creates test-rotation.json.minisig
   ```
3. Verify the signature against the public key:
   ```bash
   minisign -V -p cidrella-break-glass.pub -m test-rotation.json
   # Expected output: "Signature and comment signature verified"
   ```
4. **Tamper test**: modify the payload and verify it now fails:
   ```bash
   echo ' ' >> test-rotation.json
   minisign -V -p cidrella-break-glass.pub -m test-rotation.json
   # Expected: "Signature verification failed"
   ```
   Restore the file to its original state so subsequent steps use a known-good payload, or delete the test files entirely — they're just validation.
5. Clean up the test artifacts:
   ```bash
   rm -f test-rotation.json test-rotation.json.minisig
   ```

## Step 4 — Physical backups

This is where the private key gets committed to physical storage. You need **at least two** independent backups, stored in different locations, so that a single fire or theft cannot destroy both.

### Backup medium 1: printed text

1. Print the private key contents:
   ```bash
   cat cidrella-break-glass.key
   ```
   Take a photo or copy by hand onto paper. Print if possible on a printer you trust — preferably a local wired printer, not a network/cloud printer.
2. On the printout, clearly label:
   - `CIDRella Break-Glass Minisign PRIVATE Key`
   - Creation date (UTC)
   - Key fingerprint (first line of the pub file, last 16 chars of the `RWR...` identifier)
   - Passphrase hint (not the passphrase itself — something only you can decode)
3. Fold the printout, put it in a tamper-evident envelope, label the envelope, store in the safe.

### Backup medium 2: QR code printout

1. Install `qrencode` on the air-gapped machine (pre-load it on the USB before booting air-gapped if it isn't already there). On Debian: `apt install qrencode`.
2. Encode the private key as a QR code:
   ```bash
   qrencode -r cidrella-break-glass.key -o privkey.png -s 10
   ```
3. Print the QR code. Label it the same way as the text printout.
4. Test the QR code before trusting it: on a different offline machine, scan it back and `diff` against the original. The `--raw` flag is important — without it, `zbarimg` prefixes the decoded text with the code type (e.g. `QR-Code:...`), which makes the `diff` always show a mismatch even for a valid backup.
   ```bash
   zbarimg --raw privkey.png > recovered.key
   diff cidrella-break-glass.key recovered.key
   # should show no output
   ```
5. If the QR diff passes, put the printed QR code in a second tamper-evident envelope, store in a **different** physical location from backup 1 if at all possible.

### Backup medium 3: encrypted USB (optional, for gold threat model)

1. Format a fresh USB stick with LUKS:
   ```bash
   cryptsetup luksFormat /dev/sdX
   cryptsetup open /dev/sdX breakglass
   mkfs.ext4 /dev/mapper/breakglass
   mount /dev/mapper/breakglass /mnt
   cp cidrella-break-glass.{key,pub} /mnt/
   umount /mnt
   cryptsetup close breakglass
   ```
   Use a *different* passphrase than the key passphrase so the compromise of one doesn't reveal the other.
2. Label the USB and store in a third location.

### Verification after backups

Pick one backup (not the one you're keeping closest), restore from it on the air-gapped machine, and run the sign-test cycle from Step 3 again. If the restored key produces the same signature on the same payload, the backup is valid. **Do not skip this verification.** A backup you haven't verified is a prayer, not a backup.

## Step 5 — Embed the public key in the project

The break-glass **public** key goes into the source tree. This is safe — it's public, by design.

1. Copy `cidrella-break-glass.pub` off the air-gapped machine via the USB stick you used above (or type it in by hand — it's short). The file should look like:
   ```
   untrusted comment: minisign public key RWR...
   RWR.............base64 content.................
   ```
2. On your dev machine, drop the file at:
   ```
   scripts/cidrella-break-glass.pub
   ```
3. Edit `scripts/install.sh` and add a constant next to the existing `MINISIGN_PUBKEY`:
   ```bash
   MINISIGN_PUBKEY="RWT6J/NrAcT9LsHz9fQG8sAbcsfp58uRxiYx3YbZUpm28lFwjaVi4wQe"
   BREAKGLASS_PUBKEY="RWR... (the line from cidrella-break-glass.pub, minus the untrusted comment line)"
   ```
4. `scripts/build-release.sh` does NOT need a hardcoded pubkey constant of its own. It already rsyncs the entire `scripts/` directory into the release tarball staging, which means dropping `scripts/cidrella-break-glass.pub` into the repo automatically causes it to ship at `scripts/cidrella-break-glass.pub` inside every release tarball, at the canonical path `update.sh` expects to find it.

   The build script DOES have an explicit assertion block (added as part of landing the break-glass pubkey in-tree) that hard-fails the build if either `scripts/cidrella.pub` or `scripts/cidrella-break-glass.pub` is missing from the staging directory after the rsync — protection against a future regression where someone accidentally excludes `*.pub` from `.buildignore` or deletes one of the committed files. The assertion also checks that the `MINISIGN_PUBKEY` and `BREAKGLASS_PUBKEY` constants in `install.sh` match the base64 line in the corresponding `.pub` file, catching silent drift between the embedded-string source of truth and the committed-file source of truth. And after signing, it verifies the freshly-signed tarball against `scripts/cidrella.pub` as an end-to-end proof that the private key used for signing matches the public key the release will be verified against.

   You don't need to touch any of that — it's already in place. Just commit `scripts/cidrella-break-glass.pub` and the `BREAKGLASS_PUBKEY` constant in `install.sh` (step 3 above), and the next build will automatically pick up both and pass the checks.

5. Commit the pubkey file (`scripts/cidrella-break-glass.pub`) and the `install.sh` constant. The break-glass **private** key NEVER leaves the air-gapped machine and the physical backups.

## Step 6 — Destroy the working copy

1. Zero out and unmount the tmpfs:
   ```bash
   cd /
   umount /tmp/ceremony
   ```
2. Verify no residual files: `ls /tmp/ceremony` → directory empty, or reboot the machine to fully clear RAM.
3. Eject the USB stick you used to carry the pubkey off the air-gapped machine. Treat that USB as potentially contaminated — reformat or destroy it before reuse.

## Step 7 — Record the ceremony

Update a local (not committed) file, e.g. `~/cidrella-ceremony.log`, with:

- Date and time (UTC) of ceremony
- Your name and the location where it was performed
- Machine used (serial number / hostname if applicable)
- Backup media created (medium, label, storage location — or a cryptic pointer if you don't want the exact location written down)
- Key fingerprint (last 16 chars of the `RWR...` identifier in `cidrella-break-glass.pub`)
- Passphrase hint (not the passphrase)
- A note about when you expect to verify the backups again (annual recommended)

Store this log somewhere that survives the loss of the dev machine — e.g. in a password manager, or printed alongside the key material.

## Step 8 — Schedule the first backup verification

Put a reminder on your calendar for 12 months from now:

> Verify CIDRella break-glass key backups. Boot the air-gapped machine, restore from one of the physical backups, sign a test payload, verify with the project-embedded pubkey. If any backup fails, generate a replacement following this runbook from Step 4.

If backup verification fails at any point, generate a new backup from a still-working one. Do NOT re-generate the whole key unless every single backup has failed AND you have reason to believe the key is compromised.

## After the ceremony

Only after this ceremony is complete can Phase 3 (v0.4.8) move forward. The next work after the ceremony is:

1. Design and land the `rotation-announcement.json` schema
2. Add the rotation-check step to `update.sh` so it fetches and verifies rotation announcements before every update
3. Document the operational procedure for using the break-glass key: when to rotate, how to draft a rotation announcement, how to sign it offline, how to distribute it
4. Test the rotation end-to-end on testerella by simulating a rotation event

None of those steps require the break-glass private key — they only need the public key embedded in the project.

## Checklist summary

Copy this to a notebook page and check off during the ceremony:

```
[ ] Air-gapped machine booted
[ ] Network / radios confirmed off
[ ] Swap disabled
[ ] tmpfs working directory mounted
[ ] Passphrase chosen and written on paper
[ ] minisign -G generated keypair
[ ] Pub key fingerprint recorded
[ ] Sign-verify cycle confirmed with test payload
[ ] Tamper-detection confirmed with modified payload
[ ] Backup 1 (printed text) created + stored in location A
[ ] Backup 2 (printed QR) created + stored in location B
[ ] Backup 3 (encrypted USB, optional) created + stored in location C
[ ] Backup verification — restored one backup, confirmed signing works
[ ] Public key copied off air-gapped machine
[ ] scripts/cidrella-break-glass.pub committed to repo
[ ] install.sh updated with BREAKGLASS_PUBKEY constant
[ ] build-release.sh staging includes both pubkeys
[ ] tmpfs unmounted / machine rebooted
[ ] Ceremony log entry written
[ ] Calendar reminder scheduled for 12-month backup verification
```

## Rotation playbook (for reference — you won't need this on ceremony day)

There are two things that can rotate: the **primary** signing key (the common case, used any time the primary leaks or is due for scheduled hygiene) and the **break-glass** key itself (the rarer and stricter case). Both follow the same JSON schema and the same signing mechanism, distinguished by the `rotation_target` field.

### Unified schema: `rotation-announcement-N.json`

```json
{
  "type": "cidrella-key-rotation",
  "version": 1,
  "sequence_number": 1,
  "issued_at": "2026-08-01T00:00:00Z",
  "not_before": "2026-08-01T00:00:00Z",
  "rotation_target": "primary",
  "new_pubkey": "RWR<new pubkey contents>",
  "revoked_pubkey": "RWT6J/NrAcT9LsHz9fQG8sAbcsfp58uRxiYx3YbZUpm28lFwjaVi4wQe",
  "reason": "planned rotation"
}
```

**Field semantics**:
- `type` — must equal `cidrella-key-rotation`. Fixed string so clients can filter announcements from other signed payloads.
- `version` — schema version. Start at 1. Bump only if the field set changes. Unrelated to sequence_number.
- `sequence_number` — monotonically increasing integer, shared across both primary and break-glass rotations (a single counter, not one per target). Each install persists `max_seen_sequence_number` and refuses any announcement with `sequence_number <= max_seen`. This is the replay defense — an attacker who captures an old announcement cannot re-apply it, and the counter is global so you can't replay a primary rotation by reusing a break-glass rotation's sequence number either.
- `issued_at` — ISO8601 UTC timestamp of when you signed the announcement. Informational; not used for enforcement.
- `not_before` — ISO8601 UTC. Installs reject the announcement if `now < not_before`. Lets you sign today and cut in later (staged rollout) or defend against clock-skew-based early-apply attacks. Typically set equal to `issued_at`.
- `rotation_target` — either `"primary"` or `"break-glass"`. Tells the install which trusted pubkey is being replaced. Everything else in the schema is interpreted in the context of this field.
- `new_pubkey` — the base64 minisign pubkey (single line, no `untrusted comment:` header) that replaces the current trusted pubkey for `rotation_target`. Persisted in `/var/lib/cidrella/.key-state.json`.
- `revoked_pubkey` — the base64 pubkey being retired. Installs verify this matches their currently-trusted pubkey for `rotation_target` before accepting the replacement — prevents an attacker with a leaked break-glass key from swapping in a rogue pubkey on an install whose trusted key has already rotated to something else.
- `reason` — free-text. Goes into the audit log. Values like `planned rotation`, `emergency - key compromised`, `test`.

**Deliberately NOT in this schema**:
- `not_after` / any kind of expiry — a key rotation is a permanent state transition, not a time-limited assertion. Adding an expiry would cause long-offline installs (13+ months without an update) to refuse the rotation and stay stuck on a revoked key. Replay protection comes from `sequence_number`, not from a window.

**Signing rule (for both rotation types)**: any rotation-announcement, regardless of `rotation_target`, is signed with the **currently-trusted break-glass private key**. That is the only key an install will accept a rotation signature from. The primary key never signs rotation announcements, because a compromised primary would then be able to rotate itself away from the legitimate one.

---

### Case A: Rotating the PRIMARY key

This is the routine case — scheduled hygiene or response to a primary-key compromise.

1. On the air-gapped machine, draft `rotation-announcement-N.json` with `rotation_target: "primary"`, `new_pubkey` = the new primary pubkey, `revoked_pubkey` = the current primary pubkey. `sequence_number` = `max_seen_sequence_number + 1` (start at 1 for the first-ever rotation).
2. Restore the break-glass private key from backup onto the air-gapped machine.
3. Sign the announcement: `minisign -S -s cidrella-break-glass.key -m rotation-announcement-N.json`.
4. Copy `rotation-announcement-N.json` + `.minisig` off the air-gapped machine.
5. Upload both as release assets on the next signed release.
6. Destroy the restored break-glass private key copy on the air-gapped machine (it lives only in the physical backups from then on).
7. Update `scripts/cidrella.pub` and `install.sh`'s `MINISIGN_PUBKEY` constant on the dev machine to the new primary pubkey, so FUTURE FRESH INSTALLS land on the new key directly without needing to apply the announcement. Commit and include in the next release.
8. Every already-installed CIDRella picks up the announcement on next `cidrella-update`, verifies it with its embedded break-glass pubkey, applies the primary-pubkey replacement, and persists the new state in `/var/lib/cidrella/.key-state.json`. No user action required on the CIDRella hosts.

The break-glass key is unchanged throughout.

---

### Case B: Rotating the BREAK-GLASS key

This is the stricter case. The break-glass key is effectively rotating *itself*, which means the CURRENT break-glass key must sign its own successor into trust before being retired. Think of it as the last official act of the outgoing break-glass key.

**Why you'd do this**:
- Scheduled hygiene (recommended every 2-5 years as a standing practice)
- Suspected exposure of the private key material (a physical backup goes missing, a safe is compromised, you spot an ink smudge on the printed QR that might indicate a photo was taken)
- Immediately after using the break-glass for a primary rotation, if your threat model considers any use of the key a use-once event (most threat models don't require this — the break-glass is *designed* to be reusable — but some stricter ones do)
- Post-ceremony key-material doubt (you have reason to suspect the key generation itself was observed or the air gap was imperfect)

**Two parts, both required**:

**Part 1 — Ship a release with the new break-glass pubkey baked in.** This is what your question was pointing at. Steps:

1. On the air-gapped machine, perform the Generate-keypair steps from **Step 2** of this same runbook to create a fresh break-glass keypair. Pick a new passphrase. Do NOT reuse the old one.
2. Run the sign/verify test from **Step 3** on the new keypair to confirm it works.
3. Take the new backups (Step 4) — printed text, QR, optional encrypted USB. Label them clearly so they cannot be confused with the old backups during the retention window.
4. Copy the new `cidrella-break-glass.pub` off the air-gapped machine.
5. On the dev machine, replace `scripts/cidrella-break-glass.pub` with the new file.
6. Update `install.sh`'s `BREAKGLASS_PUBKEY` constant to the new base64 value.
7. Commit both changes. The next signed release (call it `vN.N+1`) will now carry the new break-glass pubkey at `scripts/cidrella-break-glass.pub` and in the embedded `install.sh` constant. `build-release.sh`'s pubkey-consistency assertion will catch any drift between the two automatically.
8. At this point, every **future fresh install** will trust the new break-glass key. But **existing installs** still have the OLD break-glass pubkey baked in from the release they originally installed — so Part 2 is needed to propagate the new trust to them.

**Part 2 — Sign a break-glass rotation announcement with the OLD break-glass key.** This is the final use of the outgoing key.

1. On the air-gapped machine, draft a rotation announcement with:
   ```json
   {
     "type": "cidrella-key-rotation",
     "version": 1,
     "sequence_number": N,
     "issued_at": "2028-08-01T00:00:00Z",
     "not_before": "2028-08-01T00:00:00Z",
     "rotation_target": "break-glass",
     "new_pubkey": "RWR<new break-glass pubkey>",
     "revoked_pubkey": "RWR<current/outgoing break-glass pubkey>",
     "reason": "planned break-glass rotation (scheduled 2028)"
   }
   ```
   `sequence_number` uses the SAME counter as primary rotations — it must be higher than any previously-issued announcement.
2. Restore the OUTGOING break-glass private key from backup onto the air-gapped machine.
3. Sign the announcement with the OUTGOING key: `minisign -S -s cidrella-break-glass.key -m rotation-announcement-N.json`.
4. Copy the announcement + signature off the air-gapped machine.
5. Upload as release assets alongside the release built in Part 1 (or on a later signed release — installs will pick it up on their next update regardless).
6. **Destroy the outgoing break-glass private key** on the air-gapped machine. The printed/QR backups of the outgoing key should be kept for a retention window (6 months is a reasonable default) in case something goes wrong with the new key and you need to rollback the rotation, then destroyed too.
7. Every existing install applies the announcement on its next `cidrella-update`, verifies the signature against its currently-embedded break-glass pubkey (which IS the outgoing one — it matches), confirms `revoked_pubkey` equals that currently-trusted value, and replaces its trusted break-glass pubkey with the new one in `/var/lib/cidrella/.key-state.json`.

**After Part 2 completes on a given install**, the install trusts only the new break-glass key. The old break-glass private key cannot be used against it again, even if recovered.

**The uncomfortable truth about break-glass rotation**: there is a transition window during which some installs have already applied the announcement (trust new) and others have not yet (still trust old). During that window, both old and new break-glass keys are valid against some subset of the fleet. If the outgoing key is compromised WHILE the window is open, an attacker could push a rival primary-rotation announcement against the not-yet-updated installs. Mitigations:

- Do Part 2 BEFORE destroying the outgoing private key, and monitor fleet rollout before destroying
- Keep the window short — push Part 1's release and Part 2's announcement together
- Consider also rotating the primary key at the same time, so any rival announcement an attacker could push with the old break-glass also has to include a valid primary that matches (it can't, so the attack becomes implausible)
- For emergency (compromise-response) break-glass rotation, the outgoing key is already assumed compromised, so the "some installs still trust it" window is the actual attack window — not a new risk introduced by the rotation

---

This rotation code path **landed in v0.4.9**. At update time, `update.sh` (via `scripts/lib/rotation.sh`) walks the GitHub release asset list for any file matching `rotation-announcement-*.json`, downloads each with its `.minisig`, verifies the signature against the currently-trusted break-glass pubkey (from `/var/lib/cidrella/.key-state.json` if rotated, or from the shipped `scripts/cidrella-break-glass.pub` otherwise), sorts by `sequence_number` ascending, and applies each in order:

- Replay protection: `sequence_number <= max_seen_sequence_number` is silently skipped.
- Time window: `not_before` in the future defers the announcement to a future update.
- Revoked-pubkey sanity: the announcement's `revoked_pubkey` must match the current trusted pubkey for the `rotation_target` — otherwise the announcement is either stale (replay) or aimed at a different install, and is rejected.
- Signature failure: hard-fail the update with `verify fail reason=bad-signature` and refuse to proceed. This is the canary that would fire on an active supply-chain attack.

The AFTER-rotation tarball signature verify in `update.sh` resolves the primary pubkey via `current_primary_pubkey_file` — which consults `.key-state.json` first and falls back to the shipped file. So the first release that rotates the primary key away from the shipped value will:
1. Be signed by the NEW primary key
2. Carry a `rotation-announcement-N.json` asset declaring the rotation
3. On the install, `update.sh` applies the announcement BEFORE verifying the tarball
4. The tarball verify then succeeds against the newly-trusted primary pubkey
5. `.key-state.json` persists the new primary pubkey so subsequent updates continue working

**Uploading announcements to a release**: during the ceremony (Case A or B above), you `minisign -S -s cidrella-break-glass.key -m rotation-announcement-N.json` on the air-gapped machine, copy both files off, and attach them as release assets on the NEXT signed release (or any later release — they persist as long as the assets stay uploaded). The build-release.sh pipeline doesn't currently know about rotation announcements; you attach them via `gh release upload vX.Y.Z rotation-announcement-N.json rotation-announcement-N.json.minisig` after publishing.

**Carry-forward across releases**: if a long-offline install jumps multiple versions at once, it only sees the announcements attached to the LATEST release it upgrades to. If you need an announcement to be reachable by installs that jump past it, upload it to every subsequent release until the rotation is believed to have propagated. For scheduled hygiene rotations, one release is usually enough; for emergency compromise response, carry forward for several releases to catch any long-offline installs.

**What's NOT implemented yet** (future work, recorded in PLAN.md):
- Fresh `install.sh` does not fetch rotation announcements. If a user installs with an install.sh from a pre-rotation release and the primary has rotated, the fresh install's tarball verify will fail. Mitigation: always fetch install.sh from main branch (which is kept in sync with the current primary pubkey constant) or from a post-rotation release.
- build-release.sh does not automatically carry rotation announcements forward from release to release. Admin responsibility during the ceremony.
- No test harness scenario exercises a real rotation end-to-end.
