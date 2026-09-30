---
name: design-feature
description: Use when starting a new feature or changing an existing one, BEFORE any implementation code — drives scope agreement, visual design in pen.dev, data-layer contracts, adversarial review, and produces a design/features/{slug}/ folder (spec, screens.md / endpoints.md / models.md deliverables, implementation plan, exports) shipped as its own PR. Works for Claude and Codex (both have the pencil MCP), from the playola monorepo or playola-radio-ios.
---

# Design Feature

Design-only replacement for the old `build-feature`. The output is a `design/features/{slug}/` folder containing everything a FRESH session needs to implement the feature: an approved spec, the three design deliverables, an implementation plan, and visual exports. No application code is written here — implementation happens later via `superpowers:executing-plans` (single PR) or `orchestrate-feature` (multi-PR / multi-repo).

**Required deliverables.** Whenever the feature changes screens, endpoints, or models, the folder MUST contain the matching file — `screens.md` (pen.dev mockup of every new/changed screen in every agreed state, its address, and how it is navigated to/from), `endpoints.md`, and `models.md` — in the exact formats in [`deliverables.md`](deliverables.md). Read that file before Phase 3. Those files are the source of truth for their contracts; spec.md links to them and never restates them.

Run this skill from the repo the feature is FOR (the playola monorepo, or playola-radio-ios for iOS features). **The data-layer phases are never skipped, whatever the surface:** every feature's models and endpoints are designed against the playola backend, because thinking through how the feature sits with — and limits, and is limited by — the existing data models is what makes the plan genuinely useful. For iOS features the backend lives in a different repo; the phases below say how to reach it.

## Phase 0 — Prerequisites

**a. Primary branch.** Detect it — never assume: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`, falling back to `git symbolic-ref refs/remotes/origin/HEAD`. (Both Playola repos use `develop`; in the monorepo, merging `main` deploys prod.)

**b. Fresh base.** `git fetch origin`, then require BOTH:
- Working tree clean.
- Current branch is the primary branch itself or freshly cut from up-to-date primary: `git merge-base HEAD origin/<primary>` equals `git rev-parse origin/<primary>`.

If behind: stop and tell the user. Never auto-reset, auto-merge, or switch branches. If on the primary branch itself, create a feature branch (`<author>/design-<slug>`) before writing any files — artifacts land via PR, never direct pushes to primary.

**c. Backend repo.** If the current repo is not the playola monorepo, locate the local checkout that holds the server (the sibling `../playola`, i.e. `/Users/brian/playola/playola`); ask the user if it isn't there. Record its path and its current `develop` SHA — the data-layer phases read models and endpoints from it, and proposed backend changes are changes to THAT repo.

**d. Pencil capability.** Call the pencil MCP `get_app_state`. Both Claude and Codex have this MCP configured; it works from any workspace (Conductor included) as long as the Pen.app desktop app is running. If it fails: tell the user to launch Pen.app and retry. Only if pencil is genuinely unavailable, continue with the non-visual phases and record a "Visual phases pending — needs a pencil-capable session" blocker in the spec; never silently skip visuals.

Record the inspected commit SHA (`git rev-parse HEAD`) — it goes in the spec.

## Phase 1 — Scope

Ask what the user wants to build; they describe it in general terms. Push back, question assumptions, and propose alternatives until you agree on what is being built and — equally important — what is NOT. (Claude: invoke `superpowers:brainstorming` for this conversation. Codex: emulate it — one question at a time, explore alternatives before settling.)

On agreement: pick a short human-readable `{slug}` and create `design/features/{slug}/spec.md` with: Scope, Non-goals, Open questions, Base commit SHA(s) (this repo, and the backend repo if different), Target surface(s) (`website` / `client` / `ios` / backend-only), and a `## Design deliverables` section (one line each for Screens / Endpoints / Models — a link once the file exists, or `none — <reason>`; see `deliverables.md`). This file is the durable record — every later phase appends to it, and every chat approval is logged into it (what was approved + which revision it covers). Chat history alone is NOT the record.

## Phase 2 — Existing state

Survey only what this feature touches:
- **Designs:** existing screens/components in the current repo's `design/*.pen` (screenshot relevant frames with `TakeScreenshot`).
- **Models:** `server/src/db/models/*/MODEL.md` in the backend repo for related tables.
- **Endpoints:** the backend repo's `.claude/API_ENDPOINTS.md` → `api/[module]/ENDPOINTS.md` for related routes.

Append an "Existing contracts" section to spec.md: compact model field tables, endpoint req/res bodies, screenshots of current screens (write images to `design/features/{slug}/exports/existing/`). Relevant items only — exhaustive dumps become stale doc debt.

## Phase 3 — Visual design

Visuals come first; the data layer follows and visuals get revised afterward if the data review forces it.

**a. Canvas file.** Use the canonical file for the target surface, in the repo whose UI is being designed: `design/website.pen` / `design/client.pen` in the monorepo, the existing `design/playola-ios.pen` in playola-radio-ios. Create it if missing. One shared file per surface so components accumulate into a design system — not one file per feature. Ask the user to open it in Pen.app to watch and edit live (it's multiplayer; re-read nodes rather than assuming your state is current). New feature frames go in a labeled zone; reuse existing components where they fit.

**b. Layout exploration.** Ask how many layout directions to explore before starting: suggest 3–4 for a substantial feature, 1–2 for a small one. Build them side by side; the user picks one or blends.

**c. Finalize ONE screen at a time.** Never batch approvals. For each screen, agree with the user which states it needs (loading, empty, error, forbidden, plus any feature-specific ones) and its address and entry/exit points, then iterate until the user explicitly approves it. Every agreed state is its own frame — annotations don't produce a mockup. On approval: export that screen's state frames as PNGs, write its section in `screens.md` (per `deliverables.md`), log the approval in spec.md, and move to the next screen. A new link or button on an existing screen makes that screen Changed — it gets a section too.

## Phase 4 — Data layer

Mandatory for every feature, including iOS-only UI: this is where the feature gets forced through the existing schema and its neighbors. Write the results into `models.md` and `endpoints.md` in the formats in `deliverables.md` — not into spec.md. Present each for explicit chat approval:

- **a. Model changes** (`models.md`) — changed and new models: columns + types, indexes, constraints, associations, enums, migration/backfill and deploy compatibility, MODEL.md sketch for new models.
- **b. Endpoint changes** (`endpoints.md`) — new, changed, and removed endpoints: auth, params, request/response JSON, errors, compatibility notes for changed/removed ones, consumers.

If the feature has no model or no endpoint changes, don't create that file; record `none — <reason>` in spec.md's `## Design deliverables` instead. Link each file there once written.

All of this targets the playola backend regardless of where the skill runs. Follow its conventions: REST resources (no aggregation endpoints), `PUT` never `PATCH`, model-enum pattern, user-station authorization levels.

## Phase 5 — Adversarial review (opposite provider)

Claude runs `/codex` consult; Codex runs `claude -p "<prompt>"`. Embed the full content of spec.md, models.md, endpoints.md, and screens.md in the prompt (don't make the reviewer hunt for files) and ask:

1. Duplicated model data — is every datum's single source of truth clear? Any duplication (snapshot, cache, denormalization) must be deliberate, with its authority and consistency story stated.
2. Derive vs store — for each derived-on-the-fly property, what is the query cost (N+1, indexes) and does history need it stored?
3. Must-design-now vs deferrable — what other screens/models MUST be settled now to avoid painting us into a corner? Everything deferrable stays deferred.
4. Fit — does the design fit the existing schema, REST conventions, and authorization model?
5. Extraneous properties — what can be dropped?
6. Integrity — constraints, uniqueness, nullability, deletion behavior, ownership.
7. Migration/backfill feasibility on the live schema.
8. Contract completeness — validation, error shapes, pagination.
9. UI completeness — loading/empty/error/forbidden states covered for each approved screen? Does every screen have an address (web) and a reachable entry point, and does every endpoint have a consumer screen or job?
10. Acceptance criteria — concrete and testable?

Every finding gets one of three dispositions, recorded in spec.md: **resolved** (spec or deliverable updated), **accepted with rationale**, or **blocking**. Merely having asked is worth nothing. If a finding changes the data design in a way that invalidates approved visuals, loop back to Phase 3 for the affected screens. If the opposite provider is unreachable, record "adversarial review NOT run" as a blocker — never claim a review that didn't happen.

## Phase 6 — Implementation plan

Claude: invoke `superpowers:writing-plans`; Codex: produce the same shape. Write to `design/features/{slug}/implementation-plan.md` — override the superpowers default output path; nothing goes to `docs/superpowers/` for this workflow.

The plan must let a fresh session implement without this session's context: scope + acceptance criteria; base commit SHA(s); target repo(s), surface(s), and code paths; ordered tasks with per-task verification; migration/auth requirements; links to `screens.md`, `endpoints.md`, and `models.md` as the contracts to implement (point at them, don't copy them into the plan); unresolved questions. Task references per repo:

- **Backend (playola):** the step-skills `create-model`, `create-lib`, `create-endpoint`.
- **Web frontend (playola):** the `build-frontend` skill.
- **iOS (playola-radio-ios):** the repo's `.claude/` guides (`PAGE_CREATION.md`, `VIEWS.md`, `API_CLIENT.md`, `TESTING.md`) and its branch/tracker rules (`LONG_RUNNING.md` for multi-PR efforts).

State the consumer explicitly at the top: `superpowers:executing-plans` for a single PR, or `orchestrate-feature` when it spans multiple PRs. When the feature spans BOTH repos, group tasks by repo, order backend contracts before the clients that consume them, and note that each repo gets its own implementation session and PR — include the design folder's location so the other repo's session can find the spec.

## Phase 7 — Simplicity gate (subtraction, both providers)

Runs on the finished plan (and the spec it rests on), AFTER Phase 6 and BEFORE ship. Phase 5 was adversarial about correctness and completeness — it pushes toward MORE (defenses, constraints, states). This gate is its counterweight: it is adversarial about **simplicity**, and pushes toward LESS. Over-engineering is a defect class, not a style note, and the Phase-5 reviewers (and the plan author) reliably err toward adding. Keep the two passes separate — never fold simplicity into the Phase-5 prompt; asked to hunt bugs and excess at once, bug-hunting wins and the cuts vanish.

Fire **both providers in parallel**, each read-only and grounded in the REAL target-repo code (not just the plan text): Claude runs `/codex` consult (or `codex exec -m gpt-6-astra --sandbox read-only`) AND a Claude Opus subagent; Codex runs `claude -p` AND its own analysis. Hand each the full implementation-plan.md, models.md, and endpoints.md content plus the approved product intent, and point them at the actual files the plan names. Ask exactly two questions, most impactful finding first:

1. **Is the WHOLE feature simpler?** Is there a materially simpler overall approach that still meets the approved intent? Could it reuse an existing mechanism the plan builds fresh? Which whole subsystems / tables / background jobs / rollout stages could be dropped for v1 without breaking approved behavior?
2. **Is any INDIVIDUAL piece simpler?** Go item by item — every new/changed column, table, index, constraint, enum, endpoint, param, config value, and each new function/module. For each: does it map to a named requirement, and is there a smaller way to get the same behavior? Which are derivable from existing data, dead, or duplicated across layers?

Rules for the reviewers: ground every claim in real code; a simplification the code proves unsafe is not a simplification — say why in one line and drop it. For each surviving finding: the item (file:line or plan section), what to DELETE or SIMPLIFY, the simpler form, and exactly what breaks — "nothing breaks" is the answer that makes a cut real. An empty report claims every line is load-bearing.

Adjudicate the two reports **together**: where both providers independently flag the same cut, that is high-signal — bank it. Where they conflict, surface the tradeoff to the user with a recommendation. Apply ONE wave of simplifications to the plan (and to models.md / endpoints.md if a data contract changes). Record each disposition (adopted / rejected-with-reason). If a simplification **reverses an earlier user decision** (e.g. a store-vs-derive call), surface that explicitly and get the user's confirmation — do not silently overturn a logged approval. If a cut invalidates approved visuals, loop back to Phase 3 for the affected screens.

## Phase 8 — Export & ship

**a. Exports** into `design/features/{slug}/exports/` (one `execute` call can do all of it):
- PNG of every approved screen-state frame (`Export(ids, "png", dir)`), renamed to the `<screen-slug>--<state-slug>.png` paths `screens.md` embeds. Re-export all of them here even if exported at approval time, so the PNGs match the final canvas.
- Both HTML flavors: `Export(ids, "html-tailwind", …)` AND `Export(ids, "html-css", …)` — cheap to produce; Tailwind maps directly to `website/`, plain CSS to the MUI `client/`, and both remain useful reference even for iOS.
- `design-tokens.json` (`GetVariables()` dump) and per-screen JSON (`Get(frame, {resolveVariables: true})`) for fonts and measurements — the primary machine-readable source for SwiftUI.

**b. Verify artifacts** (no app-code lint/test — nothing but design files changed): every approved screen has its approval logged in spec.md; spec.md's `## Design deliverables` has a line for each of Screens / Endpoints / Models, and each linked file exists and follows `deliverables.md`; every `screens.md` section has an address (web), navigated-from/to entries, and an on-disk PNG for every state; every `endpoints.md` summary row has a matching section whose JSON bodies parse; the plan is consistent with the spec and deliverables; exports correspond to the approved frames; JSON is valid; zero blocking findings. Any failure: stop and fix or surface it.

**c. Ship:** commit `design/features/{slug}/` + `design/{surface}.pen` in the repo the skill ran from, push, PR to `<primary>` (never `main` unless main IS the primary). Claude: run `/fix-review` — bot review of the committed spec is a free extra design review. Codex: report the PR URL and ask the user to run `/fix-review` in Claude.

## Rules

- Approval happens in chat but is persisted in spec.md with the revision it covers — an unlogged approval doesn't exist.
- One feature per branch and per folder.
- Bounded retries for transient tool failures; missing capabilities and unresolved product decisions escalate to the user immediately — don't grind.
- If the user asks to skip a phase (visuals, adversarial review): push back once with the tradeoff and offer a lighter version instead (one layout direction, terser spec, single combined review pass). If they still want it skipped, comply — the user outranks this skill — but record the waiver in spec.md (what was skipped, at whose direction) so the implementation session inherits the risk knowingly. Never skip silently, and never refuse outright.
- An unreviewed or blocked design must never be handed off as implementation-ready.
- A design that changes screens, endpoints, or models without the matching deliverable file is incomplete. Waiving a deliverable follows the skip rule above: recorded in spec.md's `## Design deliverables`, never silent.
