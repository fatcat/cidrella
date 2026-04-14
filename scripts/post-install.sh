#!/bin/bash
# CIDRella post-install hook.
#
# Authored by the release that ships it. Run by the outgoing update.sh
# (v0.4.9+) at a fixed point during the switchover phase: AFTER the
# symlink swap, AFTER install_systemd_unit, AFTER wrapper installs,
# AFTER the health probe passes, BEFORE the success banner. Also run
# by install.sh at the end of a fresh install after services start.
#
# Available environment variables (set by the caller before sourcing):
#   TARGET_SLOT  — path to the newly-active slot (e.g. /opt/cidrella-a)
#   PREV_SLOT    — path to the previous slot (e.g. /opt/cidrella-b), or
#                  empty string on fresh install (install.sh sets it empty)
#   DATA_DIR     — /var/lib/cidrella
#   NEW_VERSION  — the version being upgraded TO, e.g. 0.4.9
#   OLD_VERSION  — the version being upgraded FROM, or empty on fresh install
#   IS_FRESH_INSTALL — "1" when called from install.sh, "0" when from update.sh
#
# Contract:
#   - This script MUST be idempotent. The caller may re-run it, and an admin
#     may invoke it manually for recovery.
#   - Non-fatal errors should warn and continue. Exit non-zero ONLY for
#     conditions that the admin needs to act on. The outgoing update.sh
#     catches non-zero exits with `warn` and keeps going — the update is
#     already on disk and rollback is already harder at this point.
#   - Reachable commands: standard Debian/Alpine shell utilities, plus
#     /usr/local/bin/cidrella-node if node is needed for anything. Do NOT
#     assume jq, sqlite3, or other dev tools are present.
#
# IMPORTANT for future maintainers:
#   `set -eu` is active below. That means any unhandled non-zero exit or
#   unset variable reference terminates the script immediately, which
#   directly conflicts with the "warn and continue on non-fatal errors"
#   contract above. When adding version-specific steps, you MUST wrap any
#   command that can fail non-fatally with `|| warn "..."` or `|| true`.
#   Unguarded `chmod`, `mkdir`, `install`, etc. will hard-fail the hook.
#   Only commands whose failure is a genuine stop-the-upgrade condition
#   should be left unguarded.
#
# Convention:
#   - Every release's post-install.sh is responsible for ANY one-shot setup
#     the new version needs: new wrapper installs, file permission changes,
#     directory creation, setting-seeding, and so on. This breaks the
#     recurring pattern where new post-install steps in the incoming update.sh
#     were silently skipped because the outgoing update.sh predates them.
#   - If a release has no post-install work, the script is a no-op but still
#     ships so every release has a consistent hook point.

set -eu

# ─── v0.4.9 post-install work ──────────────────────────────
#
# v0.4.9 itself has nothing version-specific to do — the hook convention
# lands AS v0.4.9, so this release's post-install.sh is a no-op that proves
# the plumbing works. Future releases (v0.4.10+) add their one-shot setup
# to their own post-install.sh; none of it lands here retroactively.
#
# Keep the echo as evidence the hook actually ran. events.jsonl is the
# durable record via the caller's emit_event call.

echo "  post-install.sh: v${NEW_VERSION:-unknown} (no version-specific setup)"
exit 0
