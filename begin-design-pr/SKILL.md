---
name: begin-design-pr
description: Use when starting a new feature that has UX, before any canvas work or code — "start a design PR", "begin the design for X", "new feature X, let's design it first", "kick off the design". Runs in the repo agent (Conductor / Claude Code / Codex CLI), never inside Pen.app.
---

# begin-design-pr (repo agent)

Creates the design branch and the feature brief. Nothing else. The canvas work
happens next, in Pen.app. Flow reference: `~/playola/playola-skills/design-pr-flow.md`.

## Guard

1. You are in a git worktree: `git rev-parse --show-toplevel` succeeds. If not, stop.
2. Exactly one `design/*.pen` exists. If more than one: stop and ask the
   owner which file is the canvas. If none:
   stop and print the one-time move for this repo:

   ```bash
   mkdir -p design && mv ~/Documents/playola.pen design/playola.pen
   # then re-open design/playola.pen in Pen.app with the workspace at the worktree root
   ```
3. Never call pencil MCP tools from this skill, even if they are available.

## Steps

1. Collect, from the invocation or by asking in one message:
   - **slug** (kebab-case, becomes the folder and branch name)
   - **intent** (two sentences)
   - **repos** in scope: `playola`, `ios`, or `both`
   - **audience** (who uses it)
   - in scope / out of scope / known constraints (bullets; ask only if not obvious from the description)
2. Confirm `develop` is current and create the branch:

   ```bash
   git fetch origin develop
   git checkout -b <author>/design-<slug> origin/develop
   ```

   `<author>` is the prefix used by existing branches (`git branch -r | head`).
3. Write `design/features/<slug>/brief.md` in the `brief.md` format from the
   flow reference. Every field filled; no placeholders.
4. Commit:

   ```bash
   git add design/features/<slug>/brief.md
   git commit -m "design(<slug>): brief"
   ```
5. Print, exactly:
   - the absolute path of `design/<name>.pen` in this worktree
   - "Open Pen.app with the workspace at `<worktree root>` (not `design/`, not the main checkout), open the pen file, then run `begin-pen-session`."
6. Do not create a PR. Do not run any pen operation. If `repos` is `both`,
   remind the owner to run this skill in the other repo with the same slug.

## Next step

Pen agent: `begin-pen-session`. If the owner says "next", "move on", or
"continue", run the router from the flow reference and follow its answer.
