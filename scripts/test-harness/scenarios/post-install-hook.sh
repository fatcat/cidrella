#!/bin/bash
# Scenario: post-install-hook
#
# Validates the v0.4.9 post-install hook convention. The hook is defined
# at scripts/post-install.sh inside each release tarball, invoked by
# install.sh after service start and by update.sh after health-check pass.
# The scenario verifies:
#   (a) the hook file ships in the release and is executable
#   (b) install.sh actually runs it during a fresh install
#   (c) the hook receives the expected environment contract
#
# This is the anchor scenario that prevents v0.4.9+ releases from silently
# dropping the hook (whether by install.sh forgetting to invoke it or by
# .buildignore excluding post-install.sh).

SCENARIO_NAME="post-install-hook"
SCENARIO_DESCRIPTION="Post-install hook convention: shipped, executable, invoked on fresh install"

scenario_setup() {
  return 0
}

scenario_run() {
  # Replace the release's post-install.sh with a sentinel copy that writes
  # proof-of-execution + environment snapshot to /tmp before running the
  # real hook. This lets the assertion phase verify the invoker actually
  # called the file the install.sh expected, with the env vars contracted.
  #
  # We do this by arranging a wrapper: download install.sh, let it extract
  # the release, THEN sneak our sentinel into the slot before install.sh
  # reaches the post-install phase. Can't do that trivially without racing.
  #
  # Simpler: let install.sh run to completion (it invokes the release's
  # real post-install.sh, which is a no-op stub that echoes a marker).
  # After install, verify the marker is in the captured install output
  # AND manually re-run the hook with a sentinel to prove the env contract.
  install_latest_release

  # Manually re-run the hook with a sentinel wrapper to observe the env.
  # The wrapper logs the full env at invocation time.
  cat > /tmp/hook-sentinel-env.sh <<'ENVCAP'
#!/bin/bash
echo "HOOK_INVOKED=1" > /tmp/hook-sentinel-result
echo "TARGET_SLOT=${TARGET_SLOT:-unset}" >> /tmp/hook-sentinel-result
echo "PREV_SLOT=${PREV_SLOT:-unset}" >> /tmp/hook-sentinel-result
echo "DATA_DIR=${DATA_DIR:-unset}" >> /tmp/hook-sentinel-result
echo "NEW_VERSION=${NEW_VERSION:-unset}" >> /tmp/hook-sentinel-result
echo "OLD_VERSION=${OLD_VERSION:-unset}" >> /tmp/hook-sentinel-result
echo "IS_FRESH_INSTALL=${IS_FRESH_INSTALL:-unset}" >> /tmp/hook-sentinel-result
exit 0
ENVCAP
  chmod +x /tmp/hook-sentinel-env.sh
  TARGET_SLOT=/opt/cidrella-a PREV_SLOT="" DATA_DIR=/var/lib/cidrella \
  NEW_VERSION=0.4.9 OLD_VERSION="" IS_FRESH_INSTALL=1 \
    bash /tmp/hook-sentinel-env.sh
}

scenario_assert() {
  # ─── The hook script itself shipped ────────────────────
  assert_file_exists /opt/cidrella/scripts/post-install.sh
  assert_command_ok "[ -x /opt/cidrella/scripts/post-install.sh ]"

  # ─── install.sh invoked the hook during fresh install ─
  # install.sh's invoker prints "Running post-install hook..." followed by
  # "Post-install hook completed" on success. The release's stub hook itself
  # echoes "post-install.sh: v<VERSION> (no version-specific setup)".
  assert_file_contains /tmp/install-output.log "Running post-install hook"
  assert_file_contains /tmp/install-output.log "post-install.sh"

  # ─── Sentinel wrapper plumbing works ─────────────────────
  # These assertions verify that the sentinel-wrapper pattern is functional
  # (env vars propagate, the wrapper runs, output lands where expected).
  # They do NOT prove install.sh itself exports the documented env contract —
  # the scenario sets the env vars explicitly before invoking the sentinel.
  # True contract verification would need to intercept install.sh's real
  # invocation; see manifest.json `does_not_catch` for the gap.
  assert_file_contains /tmp/hook-sentinel-result "HOOK_INVOKED=1"
  assert_file_contains /tmp/hook-sentinel-result "TARGET_SLOT=/opt/cidrella-a"
  assert_file_contains /tmp/hook-sentinel-result "DATA_DIR=/var/lib/cidrella"
  assert_file_contains /tmp/hook-sentinel-result "IS_FRESH_INSTALL=1"
}

scenario_capture() {
  capture_file "post_install_script" /opt/cidrella/scripts/post-install.sh
  capture_file "hook_sentinel_result" /tmp/hook-sentinel-result
  capture_command "install_output_hook_section" "grep -A2 -B2 'post-install' /tmp/install-output.log"
}

scenario_main
