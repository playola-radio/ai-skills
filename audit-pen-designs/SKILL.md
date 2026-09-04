---
name: audit-pen-designs
description: Use inside Pen.app when the owner has finished (or paused) designing and wants the canvas checked against the codebase — "audit this", "audit the designs", "review the designs", "check it against the codebase", "I'm done designing", "is this complete?". Runs in the Pen agent only. Never edits the canvas.
---

# audit-pen-designs (Pen agent)

Audits the proposal frames on five dimensions against the real codebase,
writes `REVIEW.md` and `decisions.md`, then exports. It **never edits the
canvas**: findings are proposed, the owner applies them, the audit re-runs.
Flow reference: `~/playola/playola-skills/design-pr-flow.md`.

## Guard

Same as `begin-pen-session`: pencil tools present, active canvas is
`<root>/design/<name>.pen` with `<root>/.git`, and
`<root>/design/features/<slug>/brief.md` exists. Also require the proposal
zone for `<slug>` in `design/DESIGN_STATUS.md`; if missing, stop: "run
`begin-pen-session` first."

## Steps

1. Read `brief.md` and, if present, `decisions.md`. Active decisions are
   binding: never re-open one; a superseded one is history.
2. Find the proposal's frames: every top-level frame whose bounds fall inside
   the proposal zone rect:

   ```js
   const z = Get("<zoneId>", {depth: 0})
   Get(document, (n, c) => c.depth === 1 && n.type === "frame" && c.bounds.y >= z.y && c.bounds.y < z.y + z.height && c.bounds.x >= z.x && c.bounds.x < z.x + z.width && Print(n.id, "|", n.name), {depth: 1})
   ```

   Screenshot each frame once, in one `TakeScreenshot([...])` call. Record the
   IDs; they become `reviewed_nodes`.
3. Retrieve context in this order and stop early: `docs/context/README.md` →
   `features/INDEX.md` → the 1–3 matching feature docs → their linked surface
   docs → the `MODEL.md` and `ENDPOINTS.md` they link. Open code entry points
   last and only when the docs do not answer. Never spelunk from the repo
   root. Keep a list of every doc path read; it becomes `sources`.
4. Audit every frame on the five dimensions. For each, write down what you
   checked even when it passes:
   1. **Consistency** — matches codebase patterns and current UI (navigation,
      naming, existing components, existing endpoints' shapes).
   2. **Completeness** — everything created can be edited and deleted or
      archived; every vital property can be changed; no dead end in a
      multi-step flow; empty, loading, and error states exist.
   3. **UX complexity** — fewer screens, fewer inputs; anything the system
      already knows is prefilled, never asked.
   4. **Database consistency** — one source of truth for anything mutable.
      Warehousing immutable history is fine; copying mutable rows is not.
   5. **Data complexity** — fewest properties, single responsibility; reach
      through tables as little as possible but prefer that over a second
      source of truth; flag what will hurt when the model is extended.
5. Classify each finding. **Obvious** only when all three hold: codebase
   precedent answers it, the single-source-of-truth rule answers it, and the
   user-facing consequence is low or reversible. Everything else is an
   **owner tradeoff**. Any of these forces owner: two plausible flows serve
   different users; the schema choice changes future capability; a migration
   or backfill is implied; it changes what users can delete, recover, publish,
   or audit; it changes cross-repo scope; you cannot prove the source of truth.
6. Write `design/features/<slug>/REVIEW.md` in the flow-reference format.
   Header: `repo_root`, `branch` (`git rev-parse --abbrev-ref HEAD` from
   `<root>`), `commit` (`git rev-parse HEAD`), `audited_at` (UTC ISO),
   `reviewed_nodes`, `sources`. Obvious findings each carry a proposed fix and
   are **not** applied to the canvas.
7. Walk owner tradeoffs one at a time, in one message each: option A, option
   B, your recommendation, and the consequence if wrong. Never "what do you
   think?". Append each answer to `decisions.md` as it is given (`D<n>`, next
   free number). A reversal of an earlier decision is a new entry with
   `Supersedes: D<old>`; flip the old entry's `Status` to `superseded`.
8. Set the header: `blocking_findings` = obvious findings not yet fixed on the
   canvas; `tradeoffs_open` = owner tradeoffs without a decision;
   `audit_status` = `clean` when both are 0, `owner_decisions_needed` when
   tradeoffs remain, else `blocked`.
9. Run `export-pen-designs` so exports match the canvas this audit reviewed.
10. Print the next step:
    - `blocked` or `owner_decisions_needed`: the list of findings to apply on
      the canvas (the owner applies them through normal Pen interaction), then
      "re-run `audit-pen-designs`".
    - `clean`: "Switch to the repo agent and run `finish-design-pr`."

## Never

- Insert, Update, Move, Delete, Replace, or Generate any node, or
  SetVariables. Reading (`Get`, `TakeScreenshot`, `Export` via the export
  skill) only.
- Ask an open-ended question. Every owner question is A/B + recommendation.
- Mark `clean` while a proposed fix is unapplied.

## Next step

Findings open → owner edits the canvas → `audit-pen-designs` again.
`clean` → repo agent: `finish-design-pr`. For "next"/"move on", run the router
from the flow reference.
