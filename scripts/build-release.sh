#!/bin/bash
set -euo pipefail

# Build a release tarball for CIDRella and publish to GitHub
# Usage:
#   ./scripts/build-release.sh              # build + tag + push + create release
#   ./scripts/build-release.sh --build-only # just build the tarball
#   ./scripts/build-release.sh --dry-run    # show what would happen

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

BUILD_ONLY=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-only) BUILD_ONLY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# Read version from package.json
VERSION=$(node -e "console.log(require('./package.json').version)")
TAG="v${VERSION}"
# Architecture suffix — bundled native binaries are tied to the build arch
BUILD_ARCH="${BUILD_ARCH:-linux-x64}"
TARBALL="cidrella-${TAG}-${BUILD_ARCH}.tar.gz"
DIST_DIR="$PROJECT_DIR/dist"
STAGING_DIR="$DIST_DIR/cidrella-${TAG}-${BUILD_ARCH}"

echo "=== CIDRella Release Builder ==="
echo "Version: $VERSION"
echo "Tag:     $TAG"
echo "Arch:    $BUILD_ARCH"
echo ""

# ─── Preflight checks ────────────────────────────────────

if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] Would build tarball, create tag $TAG, and publish GitHub release."
  echo ""
fi

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

  # Check tag doesn't already exist
  if git rev-parse "$TAG" &>/dev/null 2>&1; then
    echo "Error: Tag $TAG already exists."
    echo "  To delete it: git tag -d $TAG && git push origin :refs/tags/$TAG"
    exit 1
  fi

  # Check for existing GitHub release
  if gh release view "$TAG" &>/dev/null 2>&1; then
    echo "Error: GitHub release $TAG already exists."
    echo "  To delete it: gh release delete $TAG --yes"
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

  # Server source (node_modules added in step 3)
  rsync -a --exclude='node_modules' "$PROJECT_DIR/server/" "$STAGING_DIR/server/"

  # Built client (dist only)
  mkdir -p "$STAGING_DIR/client"
  cp -a "$PROJECT_DIR/client/dist" "$STAGING_DIR/client/dist"

  # dnsmasq config templates
  cp -a "$PROJECT_DIR/dnsmasq" "$STAGING_DIR/dnsmasq"

  # Scripts (install, systemd, sudoers)
  cp -a "$PROJECT_DIR/scripts" "$STAGING_DIR/scripts"

  # Update script (root level for visibility)
  cp "$PROJECT_DIR/update.sh" "$STAGING_DIR/update.sh"

  # Note: scripts/rollback.sh is already included via the scripts/ rsync above.
  # update.sh and install.sh look for it at scripts/rollback.sh.

  # Root package.json (version source)
  cp "$PROJECT_DIR/package.json" "$STAGING_DIR/package.json"

  # Documentation
  cp "$PROJECT_DIR/README.md" "$STAGING_DIR/README.md" 2>/dev/null || true
else
  echo "  [DRY RUN] Would stage server/, client/dist/, dnsmasq/, scripts/, package.json, README.md"
fi

# ─── Step 3: Bundle server node_modules (production) ─────

echo "[3/7] Bundling server node_modules for $BUILD_ARCH..."
if [ "$DRY_RUN" = false ]; then
  # Run npm ci in the staging dir so we get a clean production install
  # that's independent of whatever's in the dev server/node_modules
  cp "$PROJECT_DIR/server/package.json" "$STAGING_DIR/server/package.json"
  cp "$PROJECT_DIR/server/package-lock.json" "$STAGING_DIR/server/package-lock.json" 2>/dev/null || true

  cd "$STAGING_DIR/server"
  npm ci --omit=dev --silent 2>&1 | tail -3

  # Verify native bindings exist — we don't want to ship a tarball that
  # will fail at runtime because a native binary is missing.
  MISSING=""
  [ ! -f "$STAGING_DIR/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ] && MISSING="$MISSING better-sqlite3"
  [ ! -f "$STAGING_DIR/server/node_modules/duckdb/lib/binding/duckdb.node" ] && MISSING="$MISSING duckdb"
  [ -z "$(find "$STAGING_DIR/server/node_modules/bcrypt/lib/binding" -name '*.node' 2>/dev/null | head -1)" ] && MISSING="$MISSING bcrypt"
  [ ! -f "$STAGING_DIR/server/node_modules/raw-socket/build/Release/raw.node" ] && MISSING="$MISSING raw-socket"

  if [ -n "$MISSING" ]; then
    echo "  ERROR: missing native bindings:$MISSING"
    echo "  These native modules must be present in the release tarball."
    echo "  Check that build tools are installed and npm install succeeded."
    exit 1
  fi

  NODE_MODULES_SIZE=$(du -sh "$STAGING_DIR/server/node_modules" | cut -f1)
  echo "  Bundled node_modules: $NODE_MODULES_SIZE"
  cd "$PROJECT_DIR"
else
  echo "  [DRY RUN] Would run: npm ci --omit=dev in staging dir and verify native bindings"
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
else
  echo "  [DRY RUN] Would run: minisign -Sm dist/$TARBALL"
fi

if [ "$BUILD_ONLY" = true ]; then
  echo ""
  echo "=== Build complete (--build-only) ==="
  echo "  Tarball:   dist/$TARBALL"
  echo "  Signature: dist/${TARBALL}.minisig"
  echo ""
  echo "To publish manually:"
  echo "  git tag -a $TAG -m 'Release $TAG'"
  echo "  git push origin $TAG"
  echo "  gh release create $TAG dist/$TARBALL dist/${TARBALL}.minisig --title 'CIDRella $TAG' --generate-notes"
  exit 0
fi

# ─── Step 6: Create and push git tag ─────────────────────

echo "[6/7] Creating git tag $TAG..."
if [ "$DRY_RUN" = false ]; then
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
  gh release create "$TAG" \
    "$DIST_DIR/$TARBALL" \
    "$DIST_DIR/${TARBALL}.minisig" \
    --title "CIDRella $TAG" \
    --generate-notes

  RELEASE_URL=$(gh release view "$TAG" --json url -q '.url')
  echo ""
  echo "=== Release published ==="
  echo "  Tag:       $TAG"
  echo "  Tarball:   dist/$TARBALL"
  echo "  Signature: dist/${TARBALL}.minisig"
  echo "  URL:       $RELEASE_URL"
else
  echo "  [DRY RUN] Would run: gh release create $TAG dist/$TARBALL dist/${TARBALL}.minisig --title 'CIDRella $TAG' --generate-notes"
  echo ""
  echo "=== Dry run complete ==="
fi

echo ""
