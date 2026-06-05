#!/bin/bash
# Cephalopod SessionStart hook — install package deps so tests/typecheck work
# in Claude Code on the web sessions (containers start with a fresh clone).
set -euo pipefail

# Only run in remote (web) sessions; local devs manage their own installs.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"

for pkg in brain mcp spike; do
  if [ -f "$ROOT/$pkg/package.json" ]; then
    echo "[session-start] installing deps for $pkg…"
    (cd "$ROOT/$pkg" && npm install --no-audit --no-fund)
  fi
done

echo "[session-start] cephalopod dependencies ready."
