# playola-skills

Shared workflow skills for the Playola monorepos. Used by Claude Code and OpenAI Codex CLI.

## Install

```bash
git clone <repo-url> ~/playola/playola-skills
cd ~/playola/playola-skills
./install.sh
```

Symlinks every skill in this repo into `~/.claude/skills/` and `~/.codex/skills/`, so both tools see them globally — across every project and worktree on this machine.

To pick up updates: `git pull` in this repo. Symlinks already point here, so no re-install needed unless new skills were added.

## Uninstall

```bash
./uninstall.sh
```

Removes only symlinks pointing into this repo; leaves your other skills alone.

## Skills

| Skill | What it does |
|---|---|
| `create-endpoint` | REST endpoint with integration tests + OpenAPI docs |
| `create-lib` | Server library functions with TDD, one function at a time |
| `create-model` | Sequelize model with migration, types, associations, tests |
| `create-release-pr` | Analyze PRs merged to develop and create the release PR into main |
| `diagnose-flaky` | Diagnose and fix flaky server tests |
| `fix-review` | Fetch and address Claude review comments on the current branch's PR |
| `review-pr` | Review the current branch against the PR review checklist |

## Adding a skill

1. Create a new directory at the repo root with a `SKILL.md` (frontmatter: `name`, `description`).
2. `./install.sh` to symlink it into both tool locations.
3. Commit and push.
