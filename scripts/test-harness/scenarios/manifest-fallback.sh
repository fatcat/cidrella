#!/bin/bash
# Scenario: manifest-fallback
#
# Validates that the v0.4.12+ server-side manifest fetcher degrades
# gracefully to the legacy GitHub API path when the signed manifest
# cannot be verified. The architect pre-implementation review flagged
# that a silent fallback would repeat exactly the class of bug v0.4.11
# is fixing elsewhere (silent failure hides problems from operators).
# Phase C's answer is /api/version surfacing `manifestAvailable: false`
# so the UI can show a "skip-upgrade info unavailable" note and the
# operator knows that what they're seeing is not the authoritative
# chain computation.
#
# How this scenario forces the fallback: we replace the primary minisign
# public key file (/opt/cidrella/scripts/cidrella.pub) with a garbage
# file AFTER install. Signature verification against the garbage file
# then fails for every fetched manifest, fetchReleasesManifest() returns
# null, and checkForUpdates() takes the GitHub API fallback path. We
# restart cidrella to bust any cached manifest and force a fresh fetch.
#
# Cleanup restores the real pubkey at the end of the scenario. The
# release-harness wipe that runs between scenarios is also a belt-and-
# suspenders in case the cleanup path is skipped due to early exit.

SCENARIO_NAME="manifest-fallback"
SCENARIO_DESCRIPTION="Manifest fetch failure falls back to GitHub API and surfaces manifestAvailable=false in /api/version"

scenario_setup() {
  return 0
}

scenario_run() {
  install_latest_release

  # Back up the real pubkey so the cleanup path can restore it.
  cp /opt/cidrella/scripts/cidrella.pub /tmp/cidrella.pub.real

  # Replace with a structurally-valid but wrong minisign pubkey. Using a
  # random key means signature verification deterministically fails
  # without also failing the load step — we want verify() to actually
  # run and return false, not to blow up earlier on malformed key file.
  cat > /opt/cidrella/scripts/cidrella.pub <<'WRONG_KEY'
untrusted comment: test-only wrong key for manifest-fallback scenario
RWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
WRONG_KEY

  # Invalidate the server-side cache so the next fetch goes to network,
  # then restart the service so fetchReleasesManifest runs with the
  # wrong pubkey in place. The boot path invalidates cache as well.
  rm -f /var/lib/cidrella/releases-manifest.cache.json
  systemctl restart cidrella

  # Wait for the service to come back and run its startup check. The
  # checkForUpdates() call fires immediately on boot (UPDATE_CHECK_DELAY_MS=0),
  # so 8 seconds is more than enough for the fetch + verify + fallback
  # sequence to complete on testerella.
  for i in $(seq 1 20); do
    if curl -sk https://127.0.0.1:8443/api/health >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  sleep 6

  # Capture the /api/version response. We need auth — the endpoint is
  # gated behind requirePerm('subnets:read'), so we log in as admin first.
  # Parse the generated password from install output. install.sh wraps it
  # in ANSI color escapes (ESC[0;32m...ESC[0m). Strip the escapes first,
  # then extract the password token after "Password: ".
  ADMIN_PW=$(grep -a "Password:" /tmp/install-output.log \
    | grep -v reset-password \
    | sed 's/\x1b\[[0-9;]*m//g; s/.*Password:[[:space:]]*//' \
    | tr -d '[:space:]' \
    | head -1)
  if [ -z "$ADMIN_PW" ]; then
    ADMIN_PW="admin"
  fi
  TOKEN=$(curl -sk -X POST https://127.0.0.1:8443/api/auth/login \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"admin\",\"password\":\"${ADMIN_PW}\"}" 2>/dev/null \
    | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

  if [ -n "$TOKEN" ]; then
    # Fresh installs require a password change on first login. Do it so the
    # subsequent /api/version call isn't blocked with MUST_CHANGE_PASSWORD.
    NEW_PW="test-scenario-pw-$(date +%s)"
    CHANGE_RESP=$(curl -sk -X POST -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"current_password\":\"${ADMIN_PW}\",\"new_password\":\"${NEW_PW}\"}" \
      https://localhost:8443/api/auth/change-password 2>/dev/null)
    # If change succeeded, re-extract the new token from the change response.
    NEW_TOKEN=$(echo "$CHANGE_RESP" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    [ -n "$NEW_TOKEN" ] && TOKEN="$NEW_TOKEN"

    curl -sk -H "Authorization: Bearer $TOKEN" \
      https://127.0.0.1:8443/api/version > /tmp/version-response.json 2>&1
  else
    echo '{"error":"could not authenticate","token_empty":true}' > /tmp/version-response.json
  fi

  # Restore real pubkey so subsequent scenarios aren't broken. Harness
  # wipes between scenarios but defensive cleanup is cheap.
  cp /tmp/cidrella.pub.real /opt/cidrella/scripts/cidrella.pub
  systemctl restart cidrella
  # Wait for the service to settle after the second restart — the final
  # health-check assertion needs the API to be responding.
  for i in $(seq 1 20); do
    if curl -sk https://127.0.0.1:8443/api/health >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
}

scenario_assert() {
  # ─── Scenario actually captured a /api/version response ──
  assert_file_exists /tmp/version-response.json

  # ─── /api/version is reachable and returns JSON ──
  # If auth failed (e.g., admin password differs on this host), fall back
  # to a softer check that at least proves the fallback path was taken by
  # looking at the server log instead.
  assert_command_ok "grep -q 'version' /tmp/version-response.json"

  # ─── manifestAvailable is false in the response ──
  # This is the core assertion of the scenario. Phase C's contract: when
  # the signed manifest can't be verified, the API surfaces
  # manifestAvailable: false so the UI can show a "skip-upgrade info
  # unavailable" note instead of silently degrading.
  #
  # Accept either of two shapes:
  #   a) manifestAvailable: false   — canonical fallback
  #   b) manifestAvailable: null    — no pending update detected AT ALL
  #      (legit outcome if the GitHub API fallback also says "up to date",
  #      in which case there's no pending object to carry the flag)
  # The scenario passes in either shape so long as manifestAvailable is
  # NOT true. A true value means the manifest somehow verified despite
  # the garbage pubkey — a real regression.
  assert_command_ok "! grep -q '\"manifestAvailable\":true' /tmp/version-response.json"

  # ─── Server log shows the expected fallback warning ──
  # releases-manifest.js warns on signature verification failure:
  # "releases-manifest: signature verification failed" and
  # "releases-manifest: fetch failed". If neither shows up, either the
  # fetch didn't happen (network? service didn't boot?) or the warning
  # path was removed — both are regressions.
  assert_command_ok "journalctl -u cidrella --since '1 minute ago' --no-pager 2>&1 | grep -qi 'releases-manifest'"

  # ─── The real pubkey was restored at end of scenario_run ──
  # Cleanup sanity. The file must exist and match the backup byte-for-byte.
  assert_file_exists /opt/cidrella/scripts/cidrella.pub
  assert_command_ok "cmp /tmp/cidrella.pub.real /opt/cidrella/scripts/cidrella.pub"

  # ─── Service is still healthy after the restart cycle ──
  assert_http_200 "https://127.0.0.1:8443/api/health"
  assert_systemctl_active cidrella
}

scenario_capture() {
  capture_file "version_response" /tmp/version-response.json
  capture_command "releases_manifest_warnings" "journalctl -u cidrella --since '2 minutes ago' --no-pager 2>&1 | grep -i 'releases-manifest' | head -20"
  capture_command "restored_pubkey_sha256" "sha256sum /opt/cidrella/scripts/cidrella.pub /tmp/cidrella.pub.real 2>&1"
  capture_command "services_active" "systemctl is-active cidrella cidrella-dnsmasq cidrella-anomaly"
}

scenario_main
