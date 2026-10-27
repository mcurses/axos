#!/usr/bin/env bash
# update-plugin.sh: bring the installed AXOS plugin up to date in every Claude profile on this Mac.
# Run after changing anything under plugin/ (and bumping plugin/.claude-plugin/plugin.json's version).
# Hub changes need none of this: they reach every session at once.
set -euo pipefail

for d in "$HOME/.claude" "$HOME"/.claude-*; do
  [ -f "$d/plugins/installed_plugins.json" ] || continue
  grep -q '"axos@axos"' "$d/plugins/installed_plugins.json" || continue
  printf '%s: ' "$(basename "$d")"
  CLAUDE_CONFIG_DIR="$d" claude plugin marketplace update axos >/dev/null 2>&1 || true
  CLAUDE_CONFIG_DIR="$d" claude plugin update axos@axos 2>&1 | tail -1
done
echo "Sessions pick the new version up at their next start."
