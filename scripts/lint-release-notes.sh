#!/bin/bash
# lint-release-notes.sh: thin wrapper around build-releases-manifest.js --lint
#
# Exists so CI / pre-commit hooks / release-readiness checks can run a
# stable entry point without caring that the validator is a Node script.
#
# Exits 0 if RELEASE-NOTES.md parses and passes all lint checks.
# Exits 1 with diagnostic output if anything is wrong.

set -e

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

# Prefer the bundled Node binary if this is a deployed install (runtime/
# directory present), otherwise fall back to system node for dev checkouts.
if [ -x "$PROJECT_DIR/runtime/node/bin/node" ]; then
  NODE_BIN="$PROJECT_DIR/runtime/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  echo "lint-release-notes.sh: no Node binary available" >&2
  echo "  Tried: $PROJECT_DIR/runtime/node/bin/node" >&2
  echo "  Tried: \`which node\`" >&2
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/build-releases-manifest.js" --lint "$@"
