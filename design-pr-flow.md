# Design-PR flow

Every non-trivial feature with UX starts with a **design PR**, merged before any
implementation PR. Five skills drive it. Two run in the repo agent (Conductor,
Claude Code, Codex CLI). Three run inside the Pen.app agent. They share state
only through files under `design/features/<slug>/` in the design branch's
worktree, which both agents see because the Pen workspace is opened at that
worktree's root.

## Sequence

| Step | Skill | Runs in | Writes |
|---|---|---|---|
| 1 | `begin-design-pr` | repo agent | branch, `brief.md` |
| 2 | `begin-pen-session` | Pen agent | proposal row on the canvas |
| 3 | `audit-pen-designs` | Pen agent | `REVIEW.md`, `decisions.md`, then calls `export-pen-designs` |
| 3a | `export-pen-designs` | Pen agent | `exports/*.png`, `pen-nodes.json`, rows in `design/DESIGN_STATUS.md` |
| 4 | `finish-design-pr` | repo agent | `DESIGN.md`; opens it for review |
| 5 | `/ship` then `/fix-review` | repo agent | the PR, targeting `develop` |

## Routing rule ("next", "move on", "continue", "what's next")

Phrases only select the router. The router reads state and names exactly one
next command:

```bash
python3 ~/playola/playola-skills/design-pr-tools/design_pr.py state design/features/<slug>
```

| STATE | You are at | NEXT | AGENT |
|---|---|---|---|
| `start` | no `brief.md` | `begin-design-pr` | repo |
| `designing` | `brief.md`, no `REVIEW.md` | `begin-pen-session`, then `audit-pen-designs` | pen |
| `fixing` | `audit_status` is `blocked` or `owner_decisions_needed` | edit canvas, `audit-pen-designs` | pen |
| `ready_for_spec` | `audit_status: clean`, no `DESIGN.md` | `finish-design-pr` | repo |
| `spec_stale` | `DESIGN.md` "Last exported" older than `pen-nodes.json` `exportedAt` | `finish-design-pr` | repo |
| `ready_to_ship` | `DESIGN.md` current | `/ship`, then `/fix-review` | repo |

If AGENT is not the agent you are running in, say so and name the agent to
switch to. Do not run a skill in the wrong agent.

When more than one feature folder exists, ask which slug, unless the
conversation already names one.

## Guards

- Pen-side skills need the pencil MCP tools (`get_app_state`, `execute`).
  Missing → stop: "Run this inside Pen.app with the design branch worktree open."
- Repo-side skills need a git worktree. They never call pencil tools.
- Workspace check (all five): `get_app_state` reports the active canvas path.
  It must be `<root>/design/<name>.pen` where `<root>` is the git toplevel of
  the design branch worktree. Mismatch → stop and print the folder to open in
  Pen (the worktree root, not `design/`, not the main checkout).

## Folder layout

```text
design/
  README.md                 how to consume designs
  DESIGN_STATUS.md          index of every frame: node ID + status + zone
  <name>.pen                the canvas (playola.pen / playola-ios.pen)
  images/                   image fills referenced by the .pen
  exports/
    current-app/
    in-progress/<slug>/
    future/<slug>/
  features/<slug>/
    brief.md                begin-design-pr
    REVIEW.md               audit-pen-designs
    decisions.md            audit-pen-designs, one entry per owner answer
    pen-nodes.json          export-pen-designs
    DESIGN.md               finish-design-pr; the contract
    exports/<screen>--<nodeId>.png
```

## File formats

### `brief.md`

```md
# <Feature> — Design brief
Slug: <slug>
Repos: playola | ios | both
Audience: <who uses it>
Intent: <two sentences>
In scope:
- <bullet>
Out of scope:
- <bullet>
Known constraints:
- <bullet, e.g. "categories are versioned; targets are not">
```

### `REVIEW.md`

YAML header first (read by the router and the hard checks), then findings.

```md
---
audit_status: clean | blocked | owner_decisions_needed
blocking_findings: 0
tradeoffs_open: 0
audited_at: 2026-09-04T16:00:00Z
repo_root: /Users/brian/conductor/workspaces/playola/<ws>
branch: briankeane/design-<slug>
commit: <sha of HEAD when audited>
reviewed_nodes: [bi8Au, wPnEc]
sources:
  - docs/context/features/shows.md
  - server/src/db/models/stationCategory.model/MODEL.md
  - server/src/api/station/ENDPOINTS.md
---
## Obvious findings (proposed fixes, not applied)
- <dimension> · <frame> · <finding> → proposed fix: <...>
## Owner tradeoffs (resolved in decisions.md)
- D1 <question>
## Passed dimensions
- <dimension>: <one line on what was checked>
```

`blocking_findings` counts obvious findings not yet fixed on the canvas.
`tradeoffs_open` counts owner tradeoffs without a `decisions.md` entry.
`audit_status` is `clean` only when both are 0.

### `decisions.md`

Append-only. A reversal is a new entry that supersedes the old one. Flipping
the old entry's `Status` to `superseded` is the only edit ever made to an
existing entry.

```md
## D4 — <question in one line>
Status: active
Supersedes: D1
Options: A <...> / B <...>
Chosen: B
Reason: <owner's words>
Affects: <comma-separated models / screens / endpoints>
```

### `pen-nodes.json`

```json
{
  "exportedAt": "2026-09-04T16:20:00Z",
  "penFile": "design/playola.pen",
  "variables": {},
  "frames": [
    {"id": "bi8Au", "name": "Station Setup — Overview",
     "png": "exports/station-setup-overview--bi8Au.png", "node": {}}
  ]
}
```

`node` is `Get(id, {depth: 6, resolveVariables: true})`. `png` is relative to
the feature folder.

### `DESIGN.md`

```md
# <Feature> — Design
Status: Proposed
Feature ID: <docs/context id, or "none">
Repos: playola, ios
Design PR: <url once opened, else "pending">
Last exported: YYYY-MM-DD

## Summary
## User flows
| Flow | Surface | Entry point | Result | Frames |
## Design frames
| Surface | Status | Pen file | Node ID | PNG | Notes |
## Existing models
| Model | Current role | Relevant fields | Change |
## Model changes
| Model | Field | Kind | Type | Nullable | Source | Notes |
## New models
(one table per model, same columns as Model changes, then a YAML block per model)
## Data invariants
| Invariant | Enforced by | Failure if violated |
## Endpoint changes
| Method | Path | Auth | Purpose | Existing/New |
### <METHOD> <path>
Request:
```json
{}
```
Response:
```json
{}
```
## Surfaces
| Repo | Surface | Change | Frames | Notes |
## Implementation handoff
| Area | Required work | Source |
## Out of scope
## Rejected alternatives
## Open questions
(must be empty before the design PR is opened)
```

Style rule (not machine-checked): `Source` names the row for `stored` and the
path (for example `Station.name`) for `populated`.

Rules the hard checks enforce:

- `Kind` is exactly one of `stored`, `populated`, `computed`, `request-only`,
  `response-only`.
- Node IDs are written in backticks. PNG paths are relative to the feature
  folder and must exist.
- Every frame in `pen-nodes.json` appears in "Design frames" or is named in
  backticks under "Out of scope".
- Each `### METHOD path` has `Request:` and `Response:` followed by a
  ```` ```json ```` fence that parses and is not `{}` or `[]`, or the literal
  text `no body` on that line.
- "Open questions" is empty. No `TBD` or `TODO`. No empty section.

Run them yourself before opening the file:

```bash
python3 ~/playola/playola-skills/design-pr-tools/design_pr.py check design/features/<slug>
```

## Cross-repo features

Run `begin-design-pr` in each repo with the same slug; each repo gets its own
design PR and its own `DESIGN.md`. The monorepo `DESIGN.md` owns models and
endpoints. The iOS `DESIGN.md` owns iOS flows, frames, and surfaces, carries no
model or endpoint sections, and links the monorepo contract. Each links the
other PR and references the other repo's frames by node ID and export path in
that repo. Nothing is copied across repos. Implementation needs both merged.

## Skipping the design PR

`build-feature` and `orchestrate-feature` require a merged `DESIGN.md` for
features with UX. `--no-design <reason>` skips it for tiny changes; the reason
is recorded in the implementation PR body.
