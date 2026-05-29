#!/bin/bash
set -euo pipefail

# Build a release tarball for CIDRella and publish to GitHub
# Usage:
#   ./scripts/build-release.sh              # build + tag + push + create release
#   ./scripts/build-release.sh --build-only # just build the tarball
#   ./scripts/build-release.sh --dry-run    # show what would happen
#   ./scripts/build-release.sh --pre        # pre-release (0.4.15 → 0.4.15-pre)
#   ./scripts/build-release.sh --pre pre.1  # pre-release iteration 1 → 0.4.15-pre.1
#   ./scripts/build-release.sh --pre rc.1   # release candidate → 0.4.15-rc.1
#
# Pre-release behavior:
#   - Appends the given suffix to the version (default "pre"): 0.4.15-pre
#   - Tarball filename + RELEASE.json + package.json inside the tarball all
#     carry the -suffix, so the running server reports 0.4.15-pre. This is
#     distinct from the final 0.4.15 so monitoring / the UI footer / audit
#     logs don't blur the two.
#   - GitHub release is flagged --prerelease, so /releases/latest skips it —
#     other hosts' auto-update checks won't see it.
#   - releases.json manifest is NOT uploaded, so hosts using the signed
#     manifest path also won't see it. Only an explicit `cidrella-update
#     --version 0.4.15-pre` pulls it.
#   - No git tag is created locally; gh creates the remote tag when it
#     publishes the release, so `gh release delete --cleanup-tag` is a
#     one-command rollback.
#   - For multi-iteration pre-releases, use dotted-numeric identifiers
#     (pre.1, pre.2, pre.10) — per semver 2.0 they sort numerically.
#     Plain "pre2" vs "pre10" compares lexically and orders wrong.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

BUILD_ONLY=false
DRY_RUN=false
PRE_RELEASE=false
PRE_SUFFIX=""

show_help() {
  cat <<'HELP'
Build + publish a CIDRella release tarball.

USAGE
    ./scripts/build-release.sh [OPTIONS]

OPTIONS
    --build-only       Build the tarball + signature locally, skip tag/push/
                       GitHub release creation. Prints the exact commands to
                       publish manually.

    --dry-run          Walk through every step printing what WOULD happen
                       without making network requests, writing files, or
                       creating the GitHub release. Useful for sanity-checking
                       version bumps and release-notes lookups.

    --pre [SUFFIX]     Build a PRE-RELEASE. Takes an optional semver
                       prerelease identifier (default "pre"). The version is
                       spliced as <base>-<suffix>, e.g. 0.4.15-pre.1.

                       Behavior:
                         - Rewrites the staged package.json version so the
                           running server reports the suffixed string in
                           /api/health, the UI footer, and audit logs.
                         - Tarball name + RELEASE.json + git-less GitHub tag
                           all use the suffixed version.
                         - RELEASE-NOTES.md lookup strips the suffix — same
                           notes as the eventual real release.
                         - Skips releases.json manifest generation + upload.
                         - GitHub release is flagged --prerelease, so
                           /releases/latest on other hosts skips it.
                         - Skips local git tag creation. `gh release delete
                           $TAG --cleanup-tag` cleans both release + tag.

                       Reaching a pre-release requires an explicit
                       `cidrella-update --version <base>-<suffix>` on each
                       host. UI auto-update checks never surface it.

                       Suffix must match [0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*
                       per semver 2.0. For multi-iteration pre-releases,
                       use dotted-numeric (pre.1, pre.2, pre.10) — these
                       sort numerically. Plain pre2 vs pre10 sorts
                       lexically and orders wrong.

    --help, -h         Show this help and exit.

EXAMPLES
    # Build + publish the real release from the version in package.json
    ./scripts/build-release.sh

    # Preview what a release WOULD do without touching anything
    ./scripts/build-release.sh --dry-run

    # Build the tarball but skip publishing — handy before committing
    ./scripts/build-release.sh --build-only

    # Pre-release for testerella validation (becomes e.g. v0.4.15-pre)
    ./scripts/build-release.sh --pre

    # Multi-iteration pre-releases, keeping each on GitHub
    ./scripts/build-release.sh --pre pre.1
    ./scripts/build-release.sh --pre pre.2

    # Iterate-in-place (one live pre-release at a time)
    gh release delete v0.4.15-pre --cleanup-tag --yes
    ./scripts/build-release.sh --pre

    # After pre-release validation passes, promote to real:
    ./scripts/build-release.sh

ENVIRONMENT
    BUILD_ARCH              Defaults to linux-x64. Change for other arches.
    BUNDLED_NODE_VERSION    Pinned Node runtime version shipped in tarball.
    MINISIGN_KEY            Path to the minisign private key used for signing.
                            Defaults to ~/.minisign/cidrella.key.

REQUIREMENTS
    minisign, node, npm, gcc/g++, make, python3-setuptools; gh (for non-build-only).
    Network access to nodejs.org, raw.githubusercontent.com, and npm registry
    is required for the release health check.

SEE ALSO
    RELEASE-NOTES.md, scripts/lib/slots.sh (semver helpers),
    scripts/build-releases-manifest.js (manifest generator).
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-only) BUILD_ONLY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) show_help; exit 0 ;;
    --pre)
      PRE_RELEASE=true
      # Accept an optional suffix as the next argument. If the next arg is
      # missing or looks like another flag, fall back to the default "pre".
      if [ $# -ge 2 ] && [[ "$2" != --* ]]; then
        PRE_SUFFIX="$2"; shift 2
      else
        PRE_SUFFIX="pre"; shift
      fi
      # Sanity check — semver prerelease identifiers are [0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*
      if ! [[ "$PRE_SUFFIX" =~ ^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$ ]]; then
        echo "Error: --pre suffix '$PRE_SUFFIX' is not a valid semver prerelease identifier."
        echo "  Allowed: [0-9A-Za-z-] separated by dots. Examples: pre, pre.1, rc.2, beta"
        exit 1
      fi
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Run './scripts/build-release.sh --help' for usage."
      exit 1
      ;;
  esac
done

# Read version from package.json. For pre-releases, splice the suffix onto the
# version for the duration of this build. The source package.json stays at
# the base version; only the staged copy inside the tarball is rewritten.
BASE_VERSION=$(node -e "console.log(require('./package.json').version)")
if [ "$PRE_RELEASE" = true ]; then
  VERSION="${BASE_VERSION}-${PRE_SUFFIX}"
else
  VERSION="${BASE_VERSION}"
fi
TAG="v${VERSION}"
# Architecture suffix — bundled native binaries are tied to the build arch
BUILD_ARCH="${BUILD_ARCH:-linux-x64}"
TARBALL="cidrella-${TAG}-${BUILD_ARCH}.tar.gz"
DIST_DIR="$PROJECT_DIR/dist"
STAGING_DIR="$DIST_DIR/cidrella-${TAG}-${BUILD_ARCH}"
NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$DIST_DIR/.npm-cache}"
NODE_GYP_DEVDIR="${NODE_GYP_DEVDIR:-$DIST_DIR/.node-gyp}"
export NPM_CONFIG_CACHE

# Bundled Node runtime — pinned LTS version shipped inside every release.
# The tarball extracts to $SLOT/runtime/node/{bin,include,lib,share}/ and the
# cidrella-node wrapper resolves to $SLOT/runtime/node/bin/node before falling
# through to /usr/bin/node. Bumping this version requires a release + testerella
# validation, not a hot swap.
BUNDLED_NODE_VERSION="${BUNDLED_NODE_VERSION:-24.16.0}"
NODE_TARBALL="node-v${BUNDLED_NODE_VERSION}-${BUILD_ARCH}.tar.xz"
NODE_DOWNLOAD_URL="https://nodejs.org/dist/v${BUNDLED_NODE_VERSION}/${NODE_TARBALL}"
NODE_SHASUMS_URL="https://nodejs.org/dist/v${BUNDLED_NODE_VERSION}/SHASUMS256.txt"
NODE_CACHE_DIR="$DIST_DIR/.node-cache"
RELEASE_HEALTH_JSON="$DIST_DIR/release-health-check.json"

duckdb_binding_package_for_arch() {
  case "$1" in
    linux-x64) printf '%s\n' "@duckdb/node-bindings-linux-x64" ;;
    linux-arm64) printf '%s\n' "@duckdb/node-bindings-linux-arm64" ;;
    *)
      echo "Unsupported build arch for DuckDB native binding: $1" >&2
      exit 1
      ;;
  esac
}

confirm_yn() {
  local prompt="$1"
  local default="${2:-n}"
  local answer
  if [ ! -t 0 ]; then
    echo "$prompt [non-interactive: no]"
    return 1
  fi
  if [ "$default" = "y" ]; then
    read -rp "$prompt [Y/n]: " answer
    answer="${answer:-y}"
  else
    read -rp "$prompt [y/N]: " answer
    answer="${answer:-n}"
  fi
  case "$answer" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

health_json() {
  local expr="$1"
  node -e "const r=require(process.argv[1]); const v=(${expr}); if (typeof v === 'boolean') process.stdout.write(v ? 'true' : 'false'); else process.stdout.write(String(v ?? ''));" "$RELEASE_HEALTH_JSON"
}

print_dependency_override_note() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const pkgPath = path.join(process.argv[1], "server", "package.json");
    if (!fs.existsSync(pkgPath)) process.exit(0);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const overrides = pkg.overrides || {};
    if (!overrides["node-gyp"] && !overrides.tar) process.exit(0);
    console.log("");
    console.log("Dependency override reminder:");
    console.log("  server/package.json currently overrides node-gyp/tar.");
    console.log("  Revisit this periodically and remove the override when npm audit stays clean without it.");
  ' "$PROJECT_DIR"
}

update_bundled_node_default() {
  local target_version="$1"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const target = process.argv[2];
    const before = fs.readFileSync(file, "utf8");
    const after = before.replace(
      /BUNDLED_NODE_VERSION="\$\{BUNDLED_NODE_VERSION:-[^}]+}"/,
      `BUNDLED_NODE_VERSION="\${BUNDLED_NODE_VERSION:-${target}}"`
    );
    if (after === before) {
      console.error("Could not update BUNDLED_NODE_VERSION default in build-release.sh");
      process.exit(1);
    }
    fs.writeFileSync(file, after);
  ' "$PROJECT_DIR/scripts/build-release.sh" "$target_version"
}

apply_npm_updates() {
  local mode="$1"
  local dirs=("client" "server")
  local dir
  for dir in "${dirs[@]}"; do
    if [ -f "$PROJECT_DIR/$dir/package.json" ]; then
      echo "  Updating npm packages in $dir..."
      if [ "$mode" = "security" ]; then
        (cd "$PROJECT_DIR/$dir" && npm audit fix --omit=dev)
      else
        (cd "$PROJECT_DIR/$dir" && npm update --omit=dev)
      fi
      # The release health check intentionally updates only production
      # dependencies, but npm may prune dev dependencies from node_modules
      # while doing so. Restore the local development install so commit hooks
      # and follow-up tests continue to use the project's pinned Vitest/Vite
      # toolchain instead of npx fetching a temporary copy.
      (cd "$PROJECT_DIR/$dir" && npm install)
    fi
  done
}

apply_npm_major_updates() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const { spawnSync } = require("child_process");

    const projectDir = process.argv[1];
    const reportFile = process.argv[2];
    const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));

    for (const project of report.npmProjects || []) {
      const updates = project.majorUpdates || [];
      if (updates.length === 0) continue;

      const cwd = path.join(projectDir, project.dir);
      const specs = updates.map((pkg) => `${pkg.name}@${pkg.latest}`);
      console.log(`  Checking major package updates in ${project.dir}: ${specs.join(", ")}`);

      let result = spawnSync(
        "npm",
        ["install", "--save", "--package-lock-only", "--dry-run", "--ignore-scripts", ...specs],
        {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        }
      );
      if (result.status !== 0) {
        console.log("");
        console.log(`  Major package updates in ${project.dir} cannot be applied automatically.`);
        console.log("  npm could not resolve the requested latest versions against the current project.");
        console.log("  No package files were changed by this preflight check.");
        console.log("");
        console.log((result.stderr || result.stdout || "").trim());
        process.exit(2);
      }

      console.log(`  Applying major package updates in ${project.dir}: ${specs.join(", ")}`);
      result = spawnSync("npm", ["install", "--save", ...specs], {
        cwd,
        stdio: "inherit",
        env: process.env,
      });
      if (result.status !== 0) process.exit(result.status || 1);

      result = spawnSync("npm", ["install"], {
        cwd,
        stdio: "inherit",
        env: process.env,
      });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  ' "$PROJECT_DIR" "$RELEASE_HEALTH_JSON"
}

update_docker_node_tags() {
  local target_tag="$1"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const targetTag = process.argv[2];
    const before = fs.readFileSync(file, "utf8");
    const after = before.replace(/^FROM node:[^\s]+/gm, `FROM node:${targetTag}`);
    if (after === before) {
      console.error("Could not update Dockerfile node FROM tags");
      process.exit(1);
    }
    fs.writeFileSync(file, after);
  ' "$PROJECT_DIR/Dockerfile" "$target_tag"
}

update_s6_overlay_version() {
  local target_version="$1"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const target = process.argv[2];
    const before = fs.readFileSync(file, "utf8");
    const after = before.replace(/^ARG S6_OVERLAY_VERSION=.*/m, `ARG S6_OVERLAY_VERSION=${target}`);
    if (after === before) {
      console.error("Could not update ARG S6_OVERLAY_VERSION in Dockerfile");
      process.exit(1);
    }
    fs.writeFileSync(file, after);
  ' "$PROJECT_DIR/Dockerfile" "$target_version"
}

run_release_health_check() {
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would run release dependency/runtime health check."
    return 0
  fi

  echo "Running release dependency/runtime health check..."
  mkdir -p "$DIST_DIR"
  node "$PROJECT_DIR/scripts/release-health-check.js" \
    --bundled-node-version "$BUNDLED_NODE_VERSION" \
    --json-out "$RELEASE_HEALTH_JSON"

  local node_security package_security docker_security node_routine node_lts package_routine package_major docker_routine check_failures
  node_security=$(health_json 'r.summary.nodeSecurity')
  package_security=$(health_json 'r.summary.packageSecurity')
  docker_security=$(health_json 'r.summary.dockerSecurity')
  node_routine=$(health_json 'r.summary.nodeRoutine')
  node_lts=$(health_json 'r.summary.nodeLts')
  package_routine=$(health_json 'r.summary.packageRoutine')
  package_major=$(health_json 'r.summary.packageMajor')
  docker_routine=$(health_json 'r.summary.dockerRoutine')
  check_failures=$(health_json 'r.summary.checkFailures')

  if [ "$check_failures" = "true" ]; then
    echo ""
    echo "WARNING: one or more package health checks failed. Review the warnings above."
    if ! confirm_yn "Proceed without complete package health data?" "n"; then
      echo "Build stopped so package health checks can be corrected."
      exit 1
    fi
  fi

  if [ "$node_security" = "true" ] || [ "$package_security" = "true" ] || [ "$docker_security" = "true" ]; then
    echo ""
    echo "SECURITY UPDATE REQUIRED"
    echo "The release health check found Node, package, or Docker security updates."
    echo "CIDRella will not build a release with known security updates declined."
    if confirm_yn "Apply available security updates now?" "y"; then
      if [ "$node_security" = "true" ]; then
        local node_target
        node_target=$(health_json 'r.node.recommendedVersion')
        echo "  Updating bundled Node default to v${node_target}..."
        update_bundled_node_default "$node_target"
      fi
      if [ "$package_security" = "true" ]; then
        apply_npm_updates security
      fi
      if [ "$docker_security" = "true" ]; then
        local docker_security_tag
        docker_security_tag=$(health_json '((r.docker.nodeImages.find(i => i.securityUpdateRequired) || {}).tag || "").replace(/^\\d+(?:\\.\\d+\\.\\d+)?/, (r.docker.nodeImages.find(i => i.securityUpdateRequired) || {}).latestSameMajor || "")')
        if [ -n "$docker_security_tag" ]; then
          echo "  Updating Dockerfile Node base tags to ${docker_security_tag}..."
          update_docker_node_tags "$docker_security_tag"
        fi
      fi
      echo ""
      echo "Security updates were applied. Review and commit the changes, then rerun the release build."
      exit 1
    fi
    echo "Build stopped because security updates were declined."
    exit 1
  fi

  if [ "$node_routine" = "true" ] || [ "$node_lts" = "true" ] || [ "$package_routine" = "true" ] || [ "$docker_routine" = "true" ]; then
    echo ""
    echo "Routine updates are available."
    echo "These are not blocking security findings. You may update now or continue this build."
    if confirm_yn "Apply routine Node/package updates now?" "n"; then
      if [ "$node_lts" = "true" ]; then
        local lts_target
        lts_target=$(health_json 'r.node.latestLtsVersion')
        echo "  Updating bundled Node default to active LTS v${lts_target}..."
        update_bundled_node_default "$lts_target"
      elif [ "$node_routine" = "true" ]; then
        local patch_target
        patch_target=$(health_json 'r.node.latestSameMajor')
        echo "  Updating bundled Node default to v${patch_target}..."
        update_bundled_node_default "$patch_target"
      fi
      if [ "$package_routine" = "true" ]; then
        apply_npm_updates routine
      fi
      if [ "$docker_routine" = "true" ]; then
        local docker_target_tag s6_target
        docker_target_tag=$(health_json '(r.docker.nodeImages.find(i => i.nodeLtsUpdateAvailable) || {}).fixTargetTag || ""')
        if [ -n "$docker_target_tag" ]; then
          echo "  Updating Dockerfile Node base tags to ${docker_target_tag}..."
          update_docker_node_tags "$docker_target_tag"
        fi
        s6_target=$(health_json 'r.docker.s6Overlay.updateAvailable ? r.docker.s6Overlay.latest : ""')
        if [ -n "$s6_target" ]; then
          echo "  Updating Dockerfile s6-overlay to v${s6_target}..."
          update_s6_overlay_version "$s6_target"
        fi
      fi
      echo ""
      echo "Routine updates were applied. Review and commit the changes, then rerun the release build."
      exit 1
    fi
    echo "Continuing with current Node/package versions by developer choice."
  fi

  if [ "$package_major" = "true" ]; then
    echo ""
    echo "Major package updates are available."
    echo "These require changing package.json version ranges and may include breaking changes."
    echo "They are not applied by routine npm update."
    if confirm_yn "Apply major package updates now?" "n"; then
      set +e
      apply_npm_major_updates
      local major_rc=$?
      set -e
      if [ "$major_rc" -eq 2 ]; then
        echo ""
        echo "Major package updates could not be applied cleanly."
        echo "Build stopped so the dependency plan can be resolved instead of silently skipping requested updates."
        exit 1
      fi
      if [ "$major_rc" -ne 0 ]; then
        echo ""
        echo "Major package update failed unexpectedly."
        exit "$major_rc"
      fi
      echo ""
      echo "Major package updates were applied. Review and commit the changes, then rerun the release build."
      exit 1
    fi
    echo "Continuing with current major package versions by developer choice."
  fi
}

refresh_ntp_defaults() {
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would check baked DHCP NTP defaults and refresh stale values from pool.ntp.org."
    return 0
  fi

  echo "Checking baked DHCP NTP defaults..."
  set +e
  node "$PROJECT_DIR/scripts/refresh-ntp-defaults.js"
  local rc=$?
  set -e
  if [ "$rc" -eq 2 ]; then
    echo ""
    echo "DHCP NTP defaults were stale or invalid and were updated."
    echo "Review and commit the changed files, then rerun the release build."
    exit 1
  fi
  if [ "$rc" -ne 0 ]; then
    echo ""
    echo "WARNING: Could not refresh DHCP NTP defaults from pool.ntp.org."
    if ! confirm_yn "Proceed with the existing baked NTP defaults?" "n"; then
      echo "Build stopped so DHCP NTP defaults can be refreshed."
      exit 1
    fi
  fi
}

echo "=== CIDRella Release Builder ==="
echo "Version: $VERSION"
echo "Tag:     $TAG"
echo "Arch:    $BUILD_ARCH"
if [ "$PRE_RELEASE" = true ]; then
  echo "Mode:    PRE-RELEASE (suffix=${PRE_SUFFIX}, base=${BASE_VERSION})"
  echo ""
  echo "If the build fails mid-run or you need to withdraw this pre-release:"
  echo "  gh release delete $TAG --cleanup-tag --yes"
fi
echo ""

# Print the cleanup hint again on ANY exit for pre-releases — banner-at-start
# may have scrolled off screen by the time a mid-run failure surfaces, and
# the end-of-run success path's own "To withdraw" line only fires if we got
# that far. This trap covers both cases so the operator never has to dig the
# command out of help text.
if [ "$PRE_RELEASE" = true ]; then
  _print_pre_cleanup() {
    local rc=$?
    if [ "$rc" -ne 0 ]; then
      echo ""
      echo "!! Build exited with code $rc. If a GitHub release was partially"
      echo "!! created, remove it before retrying:"
      echo "!!   gh release delete $TAG --cleanup-tag --yes"
    fi
    return $rc
  }
  trap _print_pre_cleanup EXIT
fi

# ─── Pre-preflight: RELEASE-NOTES.md has an entry for $VERSION ───
#
# The signed releases.json manifest published alongside each release is
# derived from RELEASE-NOTES.md. If the current VERSION (from package.json)
# has no entry in the file, the generator emits a manifest that DOES NOT
# contain the version being built — and then the server-side update checker
# on any host running a prior version will see the manifest as "latest =
# previous release" and silently fail to surface the new release. This is
# exactly the class of bug that shipped v0.4.12's initial manifest blank
# about v0.4.12.
#
# Hard-fail early. The error names the exact file to edit so a human can
# fix it in one minute without spelunking. This runs before anything else,
# before preflight, before staging, before the expensive Node download — no
# wasted work if the author forgot to update the notes.
if [ -f "$PROJECT_DIR/RELEASE-NOTES.md" ]; then
  # For pre-releases we look up the BASE version's header (0.4.15), not the
  # full 0.4.15-pre — the pre-release ships the same notes as the version
  # it's a preview of, and requiring a separate header per pre-release
  # iteration would force duplicate notes.
  NOTES_VERSION="${BASE_VERSION}"
  if ! grep -q "^## v${NOTES_VERSION} " "$PROJECT_DIR/RELEASE-NOTES.md"; then
    echo "ERROR: RELEASE-NOTES.md has no entry for v${NOTES_VERSION}."
    echo ""
    echo "  The release manifest is derived from RELEASE-NOTES.md. Building"
    echo "  without a matching entry would publish a releases.json that does"
    echo "  not list the version being built, silently breaking skip-upgrade"
    echo "  for every host running a prior release."
    echo ""
    echo "  Fix: add a section to RELEASE-NOTES.md with this exact header:"
    echo ""
    echo "    ## v${NOTES_VERSION} — $(date +%Y-%m-%d)"
    echo ""
    echo "  followed by a YAML metadata block and the usual New / Fixed /"
    echo "  Known issues subsections. Then run the build again."
    exit 1
  fi
  echo "  RELEASE-NOTES.md has v${NOTES_VERSION} entry — OK"
else
  echo "WARNING: RELEASE-NOTES.md not found at $PROJECT_DIR/RELEASE-NOTES.md"
  echo "  The v0.4.12+ skip-upgrade machinery requires this file. Build will"
  echo "  continue but the resulting releases.json will be empty."
fi

# ─── Preflight checks ────────────────────────────────────

if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] Would build tarball, create tag $TAG, and publish GitHub release."
  echo ""
fi

run_release_health_check
refresh_ntp_defaults

# Check minisign is installed (needed for all modes)
if ! command -v minisign &>/dev/null; then
  echo "Error: 'minisign' is required for signing. Install: apt install minisign"
  exit 1
fi

# Check Python has setuptools (node-gyp needs distutils, removed in Python 3.12+)
# If this is missing, native module compilation during npm ci will fail.
if ! python3 -c "import setuptools" &>/dev/null; then
  echo "Error: python3-setuptools is required for node-gyp to compile native modules."
  echo "  Install: sudo apt-get install python3-setuptools"
  echo "  (Python 3.12+ removed distutils; setuptools provides it.)"
  exit 1
fi

# Check build tools exist
for tool in gcc g++ make; do
  if ! command -v "$tool" &>/dev/null; then
    echo "Error: '$tool' is required for native module compilation."
    echo "  Install: sudo apt-get install build-essential"
    exit 1
  fi
done

if [ "$BUILD_ONLY" = false ] && [ "$DRY_RUN" = false ]; then
  # Check gh is installed
  if ! command -v gh &>/dev/null; then
    echo "Error: 'gh' (GitHub CLI) is required. Install: https://cli.github.com"
    exit 1
  fi

  # Check gh is authenticated
  if ! gh auth status &>/dev/null 2>&1; then
    echo "Error: gh is not authenticated. Run: gh auth login"
    exit 1
  fi

  # Check for uncommitted changes
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Error: You have uncommitted changes. Commit or stash them first."
    echo ""
    git status --short
    exit 1
  fi

  # Pre-releases don't create a local git tag — the remote tag gets created
  # by gh at release-create time and `gh release delete --cleanup-tag`
  # removes both in one step. Only guard against a local tag collision for
  # real releases.
  if [ "$PRE_RELEASE" = false ]; then
    if git rev-parse "$TAG" &>/dev/null 2>&1; then
      echo "Error: Tag $TAG already exists."
      echo "  To delete it: git tag -d $TAG && git push origin :refs/tags/$TAG"
      exit 1
    fi
  fi

  # Check for existing GitHub release (applies to both real and pre).
  # For pre-releases, the user explicitly deletes + re-uploads between
  # iterations — this guard catches the forgotten-delete case.
  if gh release view "$TAG" &>/dev/null 2>&1; then
    echo "Error: GitHub release $TAG already exists."
    echo "  To delete it: gh release delete $TAG --cleanup-tag --yes"
    exit 1
  fi
fi

# ─── Step 1: Build client ────────────────────────────────

echo "[1/7] Building client..."
if [ "$DRY_RUN" = false ]; then
  cd "$PROJECT_DIR/client"
  npm ci --silent
  npx vite build
  echo "  Client built successfully."
else
  echo "  [DRY RUN] Would run: npm ci && npx vite build"
fi

# ─── Step 2: Stage files ─────────────────────────────────

echo "[2/7] Staging release files..."
if [ "$DRY_RUN" = false ]; then
  rm -rf "$STAGING_DIR"
  mkdir -p "$STAGING_DIR"

  # .buildignore holds the shared exclude list for anything we rsync into
  # staging. This is how we keep dev databases (server/data/), tests,
  # vitest config, and dev-only scripts out of the release tarball.
  BUILDIGNORE="$PROJECT_DIR/.buildignore"
  if [ ! -f "$BUILDIGNORE" ]; then
    echo "Error: $BUILDIGNORE missing — release would ship dev data. Aborting."
    exit 1
  fi

  # Server source (node_modules added fresh in step 3 via `npm ci --omit=dev`)
  rsync -a --exclude-from="$BUILDIGNORE" "$PROJECT_DIR/server/" "$STAGING_DIR/server/"

  # Built client (dist only — we never ship client/src or client/node_modules)
  mkdir -p "$STAGING_DIR/client"
  cp -a "$PROJECT_DIR/client/dist" "$STAGING_DIR/client/dist"

  # dnsmasq config templates (no dev cruft in this dir, cp -a is fine)
  cp -a "$PROJECT_DIR/dnsmasq" "$STAGING_DIR/dnsmasq"

  # Scripts (install, systemd, sudoers, lib, cidrella-node wrapper, pubkey).
  # Switched from `cp -a` to rsync so we can apply .buildignore and strip
  # dev-only helpers like build-release.sh, deploy-lxc.sh, test-dns-blocking.sh.
  rsync -a --exclude-from="$BUILDIGNORE" "$PROJECT_DIR/scripts/" "$STAGING_DIR/scripts/"

  # ─── Pubkey staging assertion ────────────────────────
  #
  # Per BREAK-GLASS-CEREMONY.md step 5, both minisign public keys must ship
  # inside every release tarball at fixed canonical paths so update.sh can
  # verify the next release's signature AND apply rotation announcements
  # signed by the break-glass key. The rsync above already copies both
  # files along with the rest of scripts/ — this block is an explicit
  # post-staging assertion so a future change (e.g. someone adds *.pub to
  # .buildignore, or someone deletes the committed file) hard-fails the
  # build instead of silently producing a tarball that can't verify itself
  # or accept a key rotation.
  for pubkey in cidrella.pub cidrella-break-glass.pub; do
    if [ ! -f "$STAGING_DIR/scripts/$pubkey" ]; then
      echo "  ERROR: required pubkey not staged: scripts/$pubkey"
      echo "  Every release tarball must ship both the primary pubkey"
      echo "  (scripts/cidrella.pub) and the break-glass pubkey"
      echo "  (scripts/cidrella-break-glass.pub). Check that the file"
      echo "  exists in the source tree and isn't excluded by .buildignore."
      exit 1
    fi
  done

  # Verify the embedded pubkey strings in install.sh match the staged pub
  # files. These two sources of truth must never drift — if they do, new
  # installs verify correctly against install.sh's constant but the running
  # service's scripts/cidrella.pub disagrees, breaking the next update.
  #
  # Compare the base64 line from each .pub file (second line — first line
  # is the minisign `untrusted comment: ...` header) against the constant
  # in install.sh. Hard-fail on mismatch.
  #
  # Hardening notes (from code-quality review of v0.4.8):
  # - Anchor the regex with `="` so `MINISIGN_PUBKEY_OLD=...` (a plausible
  #   future historical comment) doesn't match.
  # - Refuse ambiguous matches: if two lines in install.sh start with the
  #   same constant name, abort. Prevents a stray copy-paste from silently
  #   picking one of two conflicting values.
  # - Strip CR and all whitespace from both sides of the comparison so a
  #   Windows line ending anywhere in the pipeline doesn't produce a false
  #   mismatch.
  # - Use `grep -m 1` as belt-and-suspenders even though ambiguous-match is
  #   already guarded above.
  check_pubkey_constant() {
    local constant_name="$1" pub_file="$2"
    local match_count embedded file_key

    match_count=$(grep -c "^${constant_name}=\"" "$STAGING_DIR/scripts/install.sh")
    if [ "$match_count" -eq 0 ]; then
      echo "  ERROR: $constant_name constant not found in install.sh"
      exit 1
    fi
    if [ "$match_count" -gt 1 ]; then
      echo "  ERROR: $constant_name defined more than once in install.sh ($match_count matches)"
      echo "  Ambiguous constant — refusing to guess which is authoritative."
      exit 1
    fi

    embedded=$(grep -m 1 "^${constant_name}=\"" "$STAGING_DIR/scripts/install.sh" \
      | sed -E 's/^[^=]+="([^"]*)".*/\1/' \
      | tr -d '\r' | tr -d '[:space:]')
    file_key=$(sed -n '2p' "$STAGING_DIR/scripts/$pub_file" \
      | tr -d '\r' | tr -d '[:space:]')

    if [ -z "$embedded" ]; then
      echo "  ERROR: $constant_name value empty after parse (install.sh formatting changed?)"
      exit 1
    fi
    if [ -z "$file_key" ]; then
      echo "  ERROR: $pub_file has no base64 line (line 2 empty after whitespace strip)"
      exit 1
    fi
    if [ "$embedded" != "$file_key" ]; then
      echo "  ERROR: $constant_name in install.sh does not match scripts/$pub_file"
      echo "    install.sh: $embedded"
      echo "    $pub_file:  $file_key"
      exit 1
    fi
  }
  check_pubkey_constant MINISIGN_PUBKEY cidrella.pub
  check_pubkey_constant BREAKGLASS_PUBKEY cidrella-break-glass.pub
  echo "  Pubkey consistency verified (primary + break-glass)"

  # Update script (root level for visibility)
  cp "$PROJECT_DIR/update.sh" "$STAGING_DIR/update.sh"

  # Note: scripts/rollback.sh is already included via the scripts/ rsync above.
  # update.sh and install.sh look for it at scripts/rollback.sh.

  # Root package.json (version source). For pre-releases, rewrite the
  # staged copy's version field so the running server reports the full
  # suffixed version (e.g. 0.4.15-pre) — the source tree stays at the
  # base version untouched. `APP_VERSION` is imported from here at
  # runtime, so this is what shows up in /api/health and the UI footer.
  cp "$PROJECT_DIR/package.json" "$STAGING_DIR/package.json"
  if [ "$PRE_RELEASE" = true ]; then
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('$STAGING_DIR/package.json','utf8'));
      p.version = '$VERSION';
      fs.writeFileSync('$STAGING_DIR/package.json', JSON.stringify(p, null, 2) + '\n');
    "
    echo "  Rewrote staged package.json version → ${VERSION}"
  fi

  # requirements.json — single source of truth for minimum host requirements.
  # Consumed by scripts/lib/preflight.sh at install/update time.
  cp "$PROJECT_DIR/requirements.json" "$STAGING_DIR/requirements.json"

  # Documentation
  cp "$PROJECT_DIR/README.md" "$STAGING_DIR/README.md" 2>/dev/null || true

  # RELEASE.json — signed-payload source of truth for the version, commit,
  # bundled node version, and (as of v0.4.12) the min_from gate. update.sh
  # uses these fields AFTER minisign verification: version as the
  # authoritative downgrade-guard input (not the GitHub API's tag_name,
  # which is on the attacker's side of the trust boundary), and min_from
  # as the skip-upgrade floor.
  BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  COMMIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

  # Extract this release's min_from from RELEASE-NOTES.md. The linter has
  # already validated the file, so we can afford a lightweight grep — but
  # we still route it through build-releases-manifest.js to avoid two
  # parsers in the project. If extraction fails, fall back to empty string
  # (equivalent to "any predecessor may jump here") and emit a warning —
  # build proceeds so that missing metadata doesn't block an emergency
  # release, but the warning is loud enough for a human to notice.
  MIN_FROM=$(node "$PROJECT_DIR/scripts/build-releases-manifest.js" 2>/dev/null \
    | node -e '
        let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{
          try {
            const m=JSON.parse(s);
            const r=m.releases.find(r=>r.version==="'"${VERSION}"'");
            if (r && r.min_from) process.stdout.write(r.min_from);
          } catch(e){}
        });
      ' 2>/dev/null || echo "")
  if [ -z "$MIN_FROM" ]; then
    MIN_FROM_JSON="null"
  else
    MIN_FROM_JSON="\"${MIN_FROM}\""
  fi

  cat > "$STAGING_DIR/RELEASE.json" <<RELEASE_JSON
{
  "version": "${VERSION}",
  "built_at": "${BUILT_AT}",
  "commit_sha": "${COMMIT_SHA}",
  "bundled_node_version": "${BUNDLED_NODE_VERSION}",
  "min_from": ${MIN_FROM_JSON}
}
RELEASE_JSON
  echo "  Wrote RELEASE.json (version=${VERSION}, commit=${COMMIT_SHA:0:12}, node=${BUNDLED_NODE_VERSION}, min_from=${MIN_FROM:-<none>})"
else
  echo "  [DRY RUN] Would stage server/, client/dist/, dnsmasq/, scripts/, package.json, README.md, RELEASE.json"
fi

# ─── Step 2.5: Stage bundled Node runtime ────────────────
#
# Download node-v${BUNDLED_NODE_VERSION}-${BUILD_ARCH}.tar.xz from nodejs.org,
# verify against the official SHASUMS256.txt, and stage into runtime/node/.
# The tarball is cached under dist/.node-cache so subsequent local builds
# don't re-download — invalidated only on version bump.

echo "[2.5/7] Staging bundled Node ${BUNDLED_NODE_VERSION}..."
if [ "$DRY_RUN" = false ]; then
  mkdir -p "$NODE_CACHE_DIR"
  NODE_CACHED_TARBALL="$NODE_CACHE_DIR/$NODE_TARBALL"

  if [ ! -f "$NODE_CACHED_TARBALL" ]; then
    echo "  Downloading $NODE_TARBALL..."
    curl -fsSL "$NODE_DOWNLOAD_URL" -o "$NODE_CACHED_TARBALL"
  else
    echo "  Using cached $NODE_TARBALL"
  fi

  # Verify SHA-256 against the official checksum file. We intentionally do
  # NOT verify the checksum file's GPG signature — that would need
  # nodejs.org's release keys on the build box. SHA verification against the
  # live file is sufficient against tarball tampering at rest or in transit,
  # which is the threat model here. A stronger defense (GPG sig check against
  # pinned keys) is tracked in PLAN.md.
  echo "  Verifying SHA-256 against nodejs.org SHASUMS256.txt..."
  EXPECTED_SHA=$(curl -fsSL "$NODE_SHASUMS_URL" | awk -v f="$NODE_TARBALL" '$2 == f {print $1}')
  if [ -z "$EXPECTED_SHA" ]; then
    echo "  ERROR: $NODE_TARBALL not found in $NODE_SHASUMS_URL"
    echo "  (Is BUNDLED_NODE_VERSION=$BUNDLED_NODE_VERSION still published?)"
    exit 1
  fi
  ACTUAL_SHA=$(sha256sum "$NODE_CACHED_TARBALL" | awk '{print $1}')
  if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    echo "  ERROR: SHA-256 mismatch for $NODE_TARBALL"
    echo "    expected: $EXPECTED_SHA"
    echo "    actual:   $ACTUAL_SHA"
    echo "  Delete $NODE_CACHED_TARBALL and re-run to re-download."
    exit 1
  fi
  echo "  SHA-256 OK: ${ACTUAL_SHA:0:16}..."

  # Extract to runtime/node/ with --strip-components=1 so the top-level
  # node-vX.Y.Z-linux-x64/ dir is unwrapped. Fail loudly on extract errors
  # (disk full, corrupted archive, truncated download) rather than letting
  # the script continue to the binary-existence check — a partial extract
  # can leave bin/node present while include/ headers are missing, which
  # would break the subsequent npm ci against bundled Node.
  RUNTIME_DIR="$STAGING_DIR/runtime/node"
  rm -rf "$RUNTIME_DIR"
  mkdir -p "$RUNTIME_DIR"
  if ! tar -xJf "$NODE_CACHED_TARBALL" -C "$RUNTIME_DIR" --strip-components=1; then
    echo "  ERROR: tar extraction of $NODE_TARBALL failed"
    echo "  The cached archive at $NODE_CACHED_TARBALL may be corrupt."
    echo "  Delete it and re-run to force a fresh download."
    exit 1
  fi

  BUNDLED_NODE_BIN="$RUNTIME_DIR/bin/node"
  if [ ! -x "$BUNDLED_NODE_BIN" ]; then
    echo "  ERROR: bundled node binary missing or not executable at $BUNDLED_NODE_BIN"
    exit 1
  fi

  # Smoke test: bundled node --version must match the pinned version
  SMOKE_VERSION=$("$BUNDLED_NODE_BIN" --version 2>/dev/null)
  if [ "$SMOKE_VERSION" != "v${BUNDLED_NODE_VERSION}" ]; then
    echo "  ERROR: bundled node reports $SMOKE_VERSION, expected v${BUNDLED_NODE_VERSION}"
    exit 1
  fi
  echo "  Bundled Node $SMOKE_VERSION staged at runtime/node/ ($(du -sh "$RUNTIME_DIR" | cut -f1))"

  # Note: the full runtime (~90MB unpacked, ~25MB compressed) is shipped
  # as-is. Stripping include/, share/, npm, and corepack would shave a few
  # MB but would break install.sh's fallback path that runs `npm install`
  # when bundled node_modules are missing. Backlog item: minimize further
  # once we drop the npm fallback unconditionally. See PLAN.md.
else
  echo "  [DRY RUN] Would download + verify + stage Node ${BUNDLED_NODE_VERSION}"
fi

# ─── Step 3: Bundle server node_modules (production) ─────

echo "[3/7] Bundling server node_modules for $BUILD_ARCH..."
if [ "$DRY_RUN" = false ]; then
  # Run npm ci in the staging dir so we get a clean production install
  # that's independent of whatever's in the dev server/node_modules.
  #
  # CRITICAL: we run npm with the BUNDLED node on PATH, not the system node.
  # Reason: native modules (better-sqlite3, duckdb) compile
  # against whatever node headers node-gyp sees. If we used system node
  # (say, v22.22.0) and then shipped the bundled runtime (v22.22.2), the
  # native bindings would be compiled for the wrong ABI and could fail to
  # load at runtime on any Node version mismatch. Forcing $PATH to prefer
  # the bundled bin/ makes npm → bundled node → node-gyp → bundled headers,
  # so the .node files match the runtime we ship.
  cp "$PROJECT_DIR/server/package.json" "$STAGING_DIR/server/package.json"
  cp "$PROJECT_DIR/server/package-lock.json" "$STAGING_DIR/server/package-lock.json" 2>/dev/null || true

  cd "$STAGING_DIR/server"
  npm_config_devdir="$NODE_GYP_DEVDIR" \
    PATH="$STAGING_DIR/runtime/node/bin:$PATH" \
    npm ci --omit=dev --silent 2>&1 | tail -3
  # Sanity check: which node did npm actually use?
  REBUILD_NODE=$(PATH="$STAGING_DIR/runtime/node/bin:$PATH" node --version)
  if [ "$REBUILD_NODE" != "v${BUNDLED_NODE_VERSION}" ]; then
    echo "  WARNING: node on PATH during npm ci was $REBUILD_NODE, expected v${BUNDLED_NODE_VERSION}"
  else
    echo "  Native modules compiled against bundled $REBUILD_NODE"
  fi

  # Verify native bindings exist — we don't want to ship a tarball that
  # will fail at runtime because a native binary is missing. In v0.4.7 the
  # bcrypt native module was replaced with bcryptjs (pure JS), in v0.4.15
  # net-ping/raw-socket was replaced with system ping, and DuckDB moved to
  # the official @duckdb/node-api package family.
  MISSING=""
  DUCKDB_BINDING_PKG="$(duckdb_binding_package_for_arch "$BUILD_ARCH")"
  [ ! -f "$STAGING_DIR/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ] && MISSING="$MISSING better-sqlite3"
  [ ! -f "$STAGING_DIR/server/node_modules/$DUCKDB_BINDING_PKG/duckdb.node" ] && MISSING="$MISSING $DUCKDB_BINDING_PKG"

  if [ -n "$MISSING" ]; then
    echo "  ERROR: missing native bindings:$MISSING"
    echo "  These native modules must be present in the release tarball."
    echo "  Check that build tools are installed and npm install succeeded."
    exit 1
  fi

  NODE_MODULES_SIZE=$(du -sh "$STAGING_DIR/server/node_modules" | cut -f1)
  echo "  Bundled node_modules: $NODE_MODULES_SIZE"
  cd "$PROJECT_DIR"

  # ─── Step 3.5: Shrink bundled Node runtime ─────────────
  #
  # At this point npm ci has finished and node-gyp has already compiled
  # the native modules against the bundled Node headers under include/.
  # We no longer need the headers, manpages, or docs for runtime execution,
  # so strip them out before the tarball is created. corepack is also dead
  # weight (it's a pnpm/yarn shim the service never calls). npm IS kept
  # because install.sh has a fallback path that runs `npm install` if the
  # bundled server/node_modules is missing (edge case but supported).
  #
  # Savings: ~20 MB unpacked, ~6-8 MB compressed in the gzip tarball.
  RUNTIME_DIR="$STAGING_DIR/runtime/node"
  if [ -d "$RUNTIME_DIR" ]; then
    BEFORE_SIZE=$(du -sh "$RUNTIME_DIR" | cut -f1)
    rm -rf "$RUNTIME_DIR/include"
    rm -rf "$RUNTIME_DIR/share/doc"
    rm -rf "$RUNTIME_DIR/share/man"
    rm -rf "$RUNTIME_DIR/share/systemtap"
    rm -rf "$RUNTIME_DIR/lib/node_modules/corepack"
    # Remove corepack's bin symlinks too
    rm -f "$RUNTIME_DIR/bin/corepack"
    rm -f "$RUNTIME_DIR/bin/pnpm"
    rm -f "$RUNTIME_DIR/bin/yarn"
    AFTER_SIZE=$(du -sh "$RUNTIME_DIR" | cut -f1)
    echo "  Runtime shrunk: $BEFORE_SIZE → $AFTER_SIZE (removed include/, share/doc/, share/man/, corepack)"
    # Smoke test: bundled node must still run after the shrink
    SHRUNK_SMOKE=$("$RUNTIME_DIR/bin/node" --version 2>/dev/null)
    if [ "$SHRUNK_SMOKE" != "v${BUNDLED_NODE_VERSION}" ]; then
      echo "  ERROR: bundled node broken after shrink (reports: '$SHRUNK_SMOKE')"
      exit 1
    fi
  fi
else
  echo "  [DRY RUN] Would run: npm ci --omit=dev in staging dir, verify native bindings, shrink runtime"
fi

# ─── Step 4: Create tarball ──────────────────────────────

echo "[4/7] Creating tarball..."
if [ "$DRY_RUN" = false ]; then
  mkdir -p "$DIST_DIR"
  cd "$DIST_DIR"
  tar -czf "$TARBALL" "cidrella-${TAG}-${BUILD_ARCH}"
  rm -rf "$STAGING_DIR"

  SIZE=$(du -h "$DIST_DIR/$TARBALL" | cut -f1)
  echo "  Tarball: dist/$TARBALL ($SIZE)"
else
  echo "  [DRY RUN] Would create dist/$TARBALL"
fi

# ─── Step 5: Sign tarball ────────────────────────────────

echo "[5/7] Signing tarball..."
if [ "$DRY_RUN" = false ]; then
  MINISIGN_KEY="${MINISIGN_KEY:-$HOME/.minisign/cidrella.key}"
  minisign -Sm "$DIST_DIR/$TARBALL" -s "$MINISIGN_KEY"
  echo "  Signature: dist/${TARBALL}.minisig"

  # Post-sign verification: confirm that the signature we just produced
  # actually verifies against the committed scripts/cidrella.pub. This
  # catches the silent-drift failure mode where the local private key
  # (~/.minisign/cidrella.key) has rotated but scripts/cidrella.pub was
  # not updated — in which case the tarball would be signed but no running
  # CIDRella would be able to verify it. Fail the build here rather than
  # publishing a DOA release.
  if ! minisign -Vm "$DIST_DIR/$TARBALL" -p "$PROJECT_DIR/scripts/cidrella.pub" >/dev/null 2>&1; then
    echo "  ERROR: signature verification against scripts/cidrella.pub FAILED"
    echo "  The signing key ($MINISIGN_KEY) does not match the committed"
    echo "  scripts/cidrella.pub. Either:"
    echo "    - Update scripts/cidrella.pub (and install.sh's MINISIGN_PUBKEY"
    echo "      constant) to match the current signing key, OR"
    echo "    - Point MINISIGN_KEY at the private key that matches the"
    echo "      current scripts/cidrella.pub."
    echo "  Delete dist/$TARBALL and dist/${TARBALL}.minisig before retrying."
    exit 1
  fi
  echo "  Signature verified against scripts/cidrella.pub — build is self-consistent"
else
  echo "  [DRY RUN] Would run: minisign -Sm dist/$TARBALL"
  echo "  [DRY RUN] Would verify signature against scripts/cidrella.pub"
fi

# ─── Step 5.5: Build + sign releases.json manifest ───────
#
# releases.json is the machine-readable view of RELEASE-NOTES.md, consumed
# by the server-side update checker (v0.4.12+) to compute skip-upgrade
# reachability. We sign it with the same primary minisign key as the
# tarball so its authenticity chains from the same trust root. The verifier
# side (server/src/utils/update-checker.js in v0.4.12+) will treat the
# manifest as an advisory index — cryptographically verified but lower
# trust weight than the tarball signature, which is still the authoritative
# install gate. The break-glass composition gap raised by the architect
# review is addressed on the verifier side via a keyring pattern, not here
# on the producer side.
#
# Lint is wired in: a broken RELEASE-NOTES.md fails the build before the
# tarball gets published, catching malformed metadata that would otherwise
# silently break the consumer-side reachability computation.

echo "[5.5/7] Building releases.json manifest..."
if [ "$PRE_RELEASE" = true ]; then
  echo "  SKIPPED for pre-release."
  echo "  (Manifest not generated/uploaded — other hosts' update checker"
  echo "  must not advertise pre-release versions. Only explicit"
  echo "  'cidrella-update --version ${VERSION}' reaches this build.)"
elif [ "$DRY_RUN" = false ]; then
  # Lint first — fails the build on any schema violation
  if ! node "$PROJECT_DIR/scripts/build-releases-manifest.js" --lint; then
    echo "  ERROR: RELEASE-NOTES.md failed lint. Fix the issues above before releasing."
    exit 1
  fi
  node "$PROJECT_DIR/scripts/build-releases-manifest.js" \
    --out "$DIST_DIR/releases.json"
  echo "  Manifest: dist/releases.json"

  # Sign with the primary minisign key (same as the tarball).
  minisign -Sm "$DIST_DIR/releases.json" -s "$MINISIGN_KEY"
  echo "  Signature: dist/releases.json.minisig"

  # Verify against the committed primary pubkey for consistency, matching
  # the tarball's post-sign verify pattern. A failure here catches the
  # same class of drift (local key rotated without updating the pubkey).
  if ! minisign -Vm "$DIST_DIR/releases.json" -p "$PROJECT_DIR/scripts/cidrella.pub" >/dev/null 2>&1; then
    echo "  ERROR: releases.json signature verification against scripts/cidrella.pub FAILED"
    echo "  Delete dist/releases.json and dist/releases.json.minisig and retry."
    exit 1
  fi
  echo "  Manifest signature verified against scripts/cidrella.pub"
else
  echo "  [DRY RUN] Would lint RELEASE-NOTES.md and emit dist/releases.json"
  echo "  [DRY RUN] Would run: minisign -Sm dist/releases.json"
fi

if [ "$BUILD_ONLY" = true ]; then
  echo ""
  echo "=== Build complete (--build-only) ==="
  echo "  Tarball:   dist/$TARBALL"
  echo "  Signature: dist/${TARBALL}.minisig"
  if [ "$PRE_RELEASE" = true ]; then
    echo "  Manifest:  (not generated — pre-release)"
  else
    echo "  Manifest:  dist/releases.json + .minisig"
  fi
  echo ""
  echo "To publish manually:"
  if [ "$PRE_RELEASE" = true ]; then
    echo "  gh release create $TAG \\"
    echo "    dist/$TARBALL dist/${TARBALL}.minisig \\"
    echo "    --title 'CIDRella $TAG (pre-release)' --prerelease \\"
    echo "    --notes 'Pre-release of ${BASE_VERSION} for validation. See RELEASE-NOTES.md.'"
    echo ""
    echo "To withdraw: gh release delete $TAG --cleanup-tag --yes"
    echo "To promote:  rebuild without --pre, then gh release create v${BASE_VERSION} ..."
  else
    echo "  git tag -a $TAG -m 'Release $TAG'"
    echo "  git push origin $TAG"
    echo "  gh release create $TAG \\"
    echo "    dist/$TARBALL dist/${TARBALL}.minisig \\"
    echo "    dist/releases.json dist/releases.json.minisig \\"
    echo "    --title 'CIDRella $TAG' --generate-notes"
  fi
  print_dependency_override_note
  exit 0
fi

# ─── Step 6: Create and push git tag ─────────────────────

echo "[6/7] Creating git tag $TAG..."
if [ "$PRE_RELEASE" = true ]; then
  echo "  SKIPPED for pre-release (gh will create the remote tag at release-create time)."
elif [ "$DRY_RUN" = false ]; then
  git tag -a "$TAG" -m "Release $TAG"
  echo "  Tag $TAG created locally."

  echo "  Pushing tag to origin..."
  git push origin "$TAG"
  echo "  Tag pushed."
else
  echo "  [DRY RUN] Would run: git tag -a $TAG -m 'Release $TAG' && git push origin $TAG"
fi

# ─── Step 7: Create GitHub release ───────────────────────

echo "[7/7] Creating GitHub release..."
if [ "$DRY_RUN" = false ]; then
  if [ "$PRE_RELEASE" = true ]; then
    # Pre-release: flagged --prerelease so /releases/latest skips it, and
    # WITHOUT the releases.json manifest so auto-update on other hosts
    # stays on the last real release. Only explicit --version $TAG reaches
    # this build.
    gh release create "$TAG" \
      "$DIST_DIR/$TARBALL" \
      "$DIST_DIR/${TARBALL}.minisig" \
      --title "CIDRella $TAG (pre-release)" \
      --prerelease \
      --notes "Pre-release of v${BASE_VERSION} for validation. See RELEASE-NOTES.md for the v${BASE_VERSION} entry."

    RELEASE_URL=$(gh release view "$TAG" --json url -q '.url')
    echo ""
    echo "=== Pre-release published ==="
    echo "  Tag:       $TAG"
    echo "  Tarball:   dist/$TARBALL"
    echo "  Signature: dist/${TARBALL}.minisig"
    echo "  Manifest:  (skipped — pre-release)"
    echo "  URL:       $RELEASE_URL"
    echo ""
    echo "To test:     ssh root@<host> cidrella-update --version ${BASE_VERSION}-${PRE_SUFFIX}"
    echo "To withdraw: gh release delete $TAG --cleanup-tag --yes"
    echo "To promote:  rebuild WITHOUT --pre, then publish v${BASE_VERSION} as the real release."
  else
    # Uploading releases.json + .minisig alongside the tarball means a
    # client fetching `/releases/latest/download/releases.json` gets the
    # manifest cut at the moment this tag was published. The manifest file
    # name is stable across releases — every new release re-publishes the
    # latest-known state — so there's no collision issue.
    gh release create "$TAG" \
      "$DIST_DIR/$TARBALL" \
      "$DIST_DIR/${TARBALL}.minisig" \
      "$DIST_DIR/releases.json" \
      "$DIST_DIR/releases.json.minisig" \
      --title "CIDRella $TAG" \
      --generate-notes

    RELEASE_URL=$(gh release view "$TAG" --json url -q '.url')
    echo ""
    echo "=== Release published ==="
    echo "  Tag:       $TAG"
    echo "  Tarball:   dist/$TARBALL"
    echo "  Signature: dist/${TARBALL}.minisig"
    echo "  Manifest:  dist/releases.json + .minisig"
    echo "  URL:       $RELEASE_URL"
  fi
else
  echo "  [DRY RUN] Would run: gh release create $TAG …"
  echo ""
  echo "=== Dry run complete ==="
fi

print_dependency_override_note
