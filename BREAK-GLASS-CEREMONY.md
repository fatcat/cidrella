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
- [ ] A physical safe or safety deposit box for final storage.
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
4. Test the QR code before trusting it: on a different offline machine, scan it back and `diff` against the original:
   ```bash
   zbarimg privkey.png > recovered.key
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
4. Edit `scripts/build-release.sh` to ensure both pubkeys are staged into every release tarball at known canonical paths:
   - `scripts/cidrella.pub` (primary, already exists)
   - `scripts/cidrella-break-glass.pub` (new)
5. Commit both additions. The break-glass **private** key NEVER leaves the air-gapped machine and the physical backups.

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

When the primary key is compromised or due for scheduled rotation:

1. On the air-gapped machine, draft `rotation-announcement-N.json`:
   ```json
   {
     "type": "cidrella-key-rotation",
     "version": 1,
     "sequence_number": 1,
     "issued_at": "2026-08-01T00:00:00Z",
     "not_before": "2026-08-01T00:00:00Z",
     "not_after": "2027-08-01T00:00:00Z",
     "new_primary_pubkey": "RWR<new pubkey contents>",
     "revoked_primary_pubkey": "RWT6J/NrAcT9LsHz9fQG8sAbcsfp58uRxiYx3YbZUpm28lFwjaVi4wQe",
     "reason": "planned rotation"
   }
   ```
2. Restore the break-glass private key from backup onto the air-gapped machine.
3. Sign the announcement: `minisign -S -s cidrella-break-glass.key -m rotation-announcement-1.json`.
4. Copy `rotation-announcement-1.json` + `.minisig` off the air-gapped machine.
5. Upload both as release assets on the next signed release.
6. Destroy the restored private key copy on the air-gapped machine (it lives only in the physical backups from then on).
7. Every installed CIDRella picks up the announcement on next `cidrella-update`, verifies it with the embedded break-glass pubkey, applies the primary-pubkey replacement, and persists the new state in `/var/lib/cidrella/.key-state.json`. No user action required on the CIDRella hosts themselves.

This rotation code path will be built in v0.4.8 after the ceremony is complete.
