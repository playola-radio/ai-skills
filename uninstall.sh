#!/usr/bin/env bash
set -euo pipefail

# Remove symlinks pointing into this repo from ~/.claude/skills/ and
# ~/.codex/skills/. Leaves real files and unrelated symlinks alone.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

removed=0

for target_root in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
  [ -d "$target_root" ] || continue

  for link in "$target_root"/*; do
    [ -L "$link" ] || continue

    target="$(readlink "$link")"
    case "$target" in
      "$REPO_DIR"/*)
        rm "$link"
        echo "  removed: $link"
        removed=$((removed + 1))
        ;;
    esac
  done
done

factory_target="$HOME/.local/bin/factory"
if [ -L "$factory_target" ]; then
  target="$(readlink "$factory_target")"
  case "$target" in
    "$REPO_DIR"/*)
      rm "$factory_target"
      echo "  removed: $factory_target"
      removed=$((removed + 1))
      ;;
  esac
fi

echo ""
echo "Done. $removed symlink(s) removed."
