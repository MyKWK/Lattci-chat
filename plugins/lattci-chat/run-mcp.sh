#!/bin/sh
set -eu
find_node() {
  for candidate in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] &&
      "$candidate" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22 || (major===22 && minor>=13) ? 0 : 1)' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  printf '%s\n' 'Lattice requires Node.js 22.13 or later.' >&2
  return 1
}
runtime="$(find_node)"
exec "$runtime" "$(dirname "$0")/lattice.cjs" mcp
