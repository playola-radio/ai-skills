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
| `create-endpoint` | repo agent | REST endpoint with integration tests + OpenAPI docs |
| `create-lib` | repo agent | Server library functions with TDD, one function at a time |
| `create-model` | repo agent | Sequelize model with migration, types, associations, tests |
| `create-release-pr` | repo agent | Analyze PRs merged to develop and create the release PR into main |
| `diagnose-flaky` | repo agent | Diagnose and fix flaky server tests |
| `fix-review` | repo agent | Fetch and address Claude review comments on the current branch's PR |
| `review-pr` | repo agent | Review the current branch against the PR review checklist |
| [`ux-evidence`](ux-evidence/SKILL.md) | repo agent | Record before/after screenshots or video of a visible change in the web or iPhone app and attach them to the PR |

## The factory and `design-feature`

The `factory` command and the `design-feature` skill moved to their own repo,
[playola-radio/factory](https://github.com/playola-radio/factory), cloned at `~/playola/factory`. Its
`./install.sh` links `factory` into `~/.local/bin` and `design-feature` into both skill folders.

If you installed them from this repo before, pull this repo, then run `./install.sh` in `~/playola/factory`: it
repoints the old links at the factory repo. Designs a repo kept in `designs/ready/` and `designs/done/` now live in
`factory/ready/` and `factory/done/`.

## Adding a skill

1. Create a new directory at the repo root with a `SKILL.md` (frontmatter: `name`, `description`).
2. `./install.sh` to symlink it into both tool locations.
3. Commit and push.
