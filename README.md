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

| Skill | Runs in | What it does |
|---|---|---|
| `begin-design-pr` | repo agent | Start a design PR: branch + `design/features/<slug>/brief.md` |
| `begin-pen-session` | Pen.app | Orient on the brief and create the proposal row on the canvas |
| `audit-pen-designs` | Pen.app | Audit proposal frames against the codebase on five dimensions; writes `REVIEW.md` / `decisions.md`; never edits the canvas |
| `export-pen-designs` | Pen.app | PNGs + `pen-nodes.json` + `DESIGN_STATUS.md` rows; `--status` for transitions |
| `finish-design-pr` | repo agent | Write `DESIGN.md`, run the hard checks and a Codex artifact review, open it |
| `design-feature` | repo agent | Full feature design: scope → pen.dev visuals → data-layer contracts → adversarial review → implementation plan, shipped as a `design/features/{slug}/` PR |
| `create-endpoint` | repo agent | REST endpoint with integration tests + OpenAPI docs |
| `create-lib` | repo agent | Server library functions with TDD, one function at a time |
| `create-model` | repo agent | Sequelize model with migration, types, associations, tests |
| `create-release-pr` | repo agent | Analyze PRs merged to develop and create the release PR into main |
| `diagnose-flaky` | repo agent | Diagnose and fix flaky server tests |
| `fix-review` | repo agent | Fetch and address Claude review comments on the current branch's PR |
| `review-pr` | repo agent | Review the current branch against the PR review checklist |

The five design-pr skills share one flow: see [`design-pr-flow.md`](design-pr-flow.md).
Their mechanical rules live in `design-pr-tools/design_pr.py` (`state` and `check`);
run its tests with `python3 -m unittest discover design-pr-tools`.

## Adding a skill

1. Create a new directory at the repo root with a `SKILL.md` (frontmatter: `name`, `description`).
2. `./install.sh` to symlink it into both tool locations.
3. Commit and push.
