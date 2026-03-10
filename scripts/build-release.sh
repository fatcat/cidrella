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
TARBALL="cidrella-${TAG}.tar.gz"
DIST_DIR="$PROJECT_DIR/dist"
STAGING_DIR="$DIST_DIR/cidrella-${TAG}"

echo "=== CIDRella Release Builder ==="
echo "Version: $VERSION"
echo "Tag:     $TAG"
echo ""

# ─── Preflight checks ────────────────────────────────────

if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] Would build tarball, create tag $TAG, and publish GitHub release."
  echo ""
fi

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

echo "[1/5] Building client..."
if [ "$DRY_RUN" = false ]; then
  cd "$PROJECT_DIR/client"
  npm ci --silent
  npx vite build
  echo "  Client built successfully."
else
  echo "  [DRY RUN] Would run: npm ci && npx vite build"
fi

# ─── Step 2: Stage files ─────────────────────────────────

echo "[2/5] Staging release files..."
if [ "$DRY_RUN" = false ]; then
  rm -rf "$STAGING_DIR"
  mkdir -p "$STAGING_DIR"

  # Server source (no node_modules)
  rsync -a --exclude='node_modules' "$PROJECT_DIR/server/" "$STAGING_DIR/server/"

  # Built client (dist only)
  mkdir -p "$STAGING_DIR/client"
  cp -a "$PROJECT_DIR/client/dist" "$STAGING_DIR/client/dist"

  # dnsmasq config templates
  cp -a "$PROJECT_DIR/dnsmasq" "$STAGING_DIR/dnsmasq"

  # Scripts (install, update, systemd, sudoers)
  cp -a "$PROJECT_DIR/scripts" "$STAGING_DIR/scripts"

  # Root package.json (version source)
  cp "$PROJECT_DIR/package.json" "$STAGING_DIR/package.json"

  # Documentation
  cp "$PROJECT_DIR/README.md" "$STAGING_DIR/README.md" 2>/dev/null || true
else
  echo "  [DRY RUN] Would stage server/, client/dist/, dnsmasq/, scripts/, package.json, README.md"
fi

# ─── Step 3: Create tarball ──────────────────────────────

echo "[3/5] Creating tarball..."
if [ "$DRY_RUN" = false ]; then
  mkdir -p "$DIST_DIR"
  cd "$DIST_DIR"
  tar -czf "$TARBALL" "cidrella-${TAG}"
  rm -rf "$STAGING_DIR"

  SIZE=$(du -h "$DIST_DIR/$TARBALL" | cut -f1)
  echo "  Tarball: dist/$TARBALL ($SIZE)"
else
  echo "  [DRY RUN] Would create dist/$TARBALL"
fi

if [ "$BUILD_ONLY" = true ]; then
  echo ""
  echo "=== Build complete (--build-only) ==="
  echo "  Tarball: dist/$TARBALL"
  echo ""
  echo "To publish manually:"
  echo "  git tag -a $TAG -m 'Release $TAG'"
  echo "  git push origin $TAG"
  echo "  gh release create $TAG dist/$TARBALL --title 'CIDRella $TAG' --generate-notes"
  exit 0
fi

# ─── Step 4: Create and push git tag ─────────────────────

echo "[4/5] Creating git tag $TAG..."
if [ "$DRY_RUN" = false ]; then
  git tag -a "$TAG" -m "Release $TAG"
  echo "  Tag $TAG created locally."

  echo "  Pushing tag to origin..."
  git push origin "$TAG"
  echo "  Tag pushed."
else
  echo "  [DRY RUN] Would run: git tag -a $TAG -m 'Release $TAG' && git push origin $TAG"
fi

# ─── Step 5: Create GitHub release ───────────────────────

echo "[5/5] Creating GitHub release..."
if [ "$DRY_RUN" = false ]; then
  gh release create "$TAG" \
    "$DIST_DIR/$TARBALL" \
    --title "CIDRella $TAG" \
    --generate-notes

  RELEASE_URL=$(gh release view "$TAG" --json url -q '.url')
  echo ""
  echo "=== Release published ==="
  echo "  Tag:     $TAG"
  echo "  Tarball: dist/$TARBALL"
  echo "  URL:     $RELEASE_URL"
else
  echo "  [DRY RUN] Would run: gh release create $TAG dist/$TARBALL --title 'CIDRella $TAG' --generate-notes"
  echo ""
  echo "=== Dry run complete ==="
fi

echo ""
