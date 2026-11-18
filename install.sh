#!/usr/bin/env bash
set -euo pipefail

# Symlink every skill in this repo into ~/.claude/skills/ and ~/.codex/skills/
# so Claude Code and OpenAI Codex CLI see them globally across all repos and
# worktrees. Idempotent — safe to re-run.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLAUDE_SKILLS="$HOME/.claude/skills"
CODEX_SKILLS="$HOME/.codex/skills"

mkdir -p "$CLAUDE_SKILLS" "$CODEX_SKILLS"

linked=0
skipped=0

for skill_dir in "$REPO_DIR"/*/; do
  skill_dir="${skill_dir%/}"
  name="$(basename "$skill_dir")"

  case "$name" in
    .git|node_modules|.github) continue ;;
  esac

  [ -f "$skill_dir/SKILL.md" ] || continue

  for target_root in "$CLAUDE_SKILLS" "$CODEX_SKILLS"; do
    target="$target_root/$name"

    if [ -L "$target" ]; then
      ln -sfn "$skill_dir" "$target"
      echo "  refreshed: $target"
      linked=$((linked + 1))
    elif [ -e "$target" ]; then
      echo "  SKIP (not a symlink): $target — rename or remove it manually"
      skipped=$((skipped + 1))
    else
      ln -s "$skill_dir" "$target"
      echo "  linked:    $target"
      linked=$((linked + 1))
    fi
  done
done

mkdir -p "$HOME/.local/bin"
ln -sfn "$REPO_DIR/factory/bin/factory.ts" "$HOME/.local/bin/factory"
echo "  linked:    $HOME/.local/bin/factory"

echo ""
echo "Done. $linked link(s) created/refreshed, $skipped skipped."
