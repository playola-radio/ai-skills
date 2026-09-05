---
name: finish-design-pr
description: Use in the repo agent when the Pen audit is clean and the design needs its written contract — "write it up", "finish the design PR", "generate DESIGN.md", "the audit is clean, what's next", "produce the design doc". Runs in the repo agent (Conductor / Claude Code / Codex CLI), never inside Pen.app.
---

# finish-design-pr (repo agent)

Turns a clean audit into the design contract, `DESIGN.md`, runs the hard
checks and a Codex artifact review, and opens the file for the owner. PR
creation stays manual. Flow reference:
`~/playola/playola-skills/design-pr-flow.md`.

## Guard

1. `git rev-parse --show-toplevel` succeeds; never call pencil tools.
2. `design/features/<slug>/REVIEW.md` exists with `audit_status: clean`
   (if there is more than one feature folder, ask which slug).
   Otherwise print the status and "run `audit-pen-designs` in Pen first", stop.

## Steps

1. **Provenance.** Take `commit` and `sources` from the `REVIEW.md` header:

   ```bash
   git diff --stat <commit>..HEAD -- <each source path>
   ```

   Any changed source → stop: "the audit is stale, re-run `audit-pen-designs`."
2. **Read** `brief.md`, `REVIEW.md`, `decisions.md`, `pen-nodes.json`, every
   PNG under `exports/` (view them), and the `MODEL.md` / `ENDPOINTS.md` files
   in `sources`. Use only decisions with `Status: active`. Run
   `python3 ~/playola/playola-skills/design-pr-tools/design_pr.py check design/features/<slug>`
   once now to see overlapping active decisions and existing gaps; then read
   every overlapping pair. Two active decisions that disagree about the same
   model, screen, or endpoint is a hard stop: ask the owner which supersedes.
3. **Write `DESIGN.md`** in the flow-reference skeleton. Rules:
   - `Slice ledger` is carried from `brief.md` (refined by anything the audit
     deferred): all four buckets — `In slice`, `Deferred`, `Rejected`,
     `Trigger to split` — each as a labelled line. It is the source the next
     two bullets derive from.
   - `Out of scope` and `Rejected alternatives` are derived views of the
     ledger: deferred frames/flows → `Out of scope` (name deferred frames in
     backticks); dropped slices/approaches and `decisions.md` losers →
     `Rejected alternatives`.
   - Every field in Model changes and New models has exactly one `Kind` and a
     `Source` (`stored` → the row; `populated` → the path, e.g. `Station.name`).
   - `Omitted properties` records the fields the audit considered and left out
     (from `REVIEW.md`'s Data-complexity notes), one row each with why. When
     the design adds any field, this table must have at least one real row;
     when it adds none, say so.
   - Every endpoint gets a `### METHOD path` block with real request and
     response JSON copied from the shapes in the cited `ENDPOINTS.md` where
     the endpoint exists, or `no body` on the line when that is the truth.
   - Every frame in `pen-nodes.json` is a "Design frames" row or is named in
     backticks under "Out of scope".
   - "Last exported" = the date part of `pen-nodes.json` `exportedAt`.
   - "Open questions" stays empty; anything unresolved becomes a `decisions.md`
     question for the owner now, not a note.
4. **Hard checks:**

   ```bash
   python3 ~/playola/playola-skills/design-pr-tools/design_pr.py check design/features/<slug>
   ```

   Any `FAIL:` line → fix the doc (or re-export in Pen if exports are stale)
   and re-run. Do not open the file until it prints `OK`.
5. **Adversarial artifact review.** Commit the artifacts first, then run the
   gstack `codex` skill in review mode against `develop` (the diff is the
   design folder). Codex is confined to the repo, so this is a diff review,
   not a canvas review. For each finding: fix the doc, or record an owner
   decision, then re-run step 4. Skip only if the owner said to skip Codex.
6. **Context map.** If the feature is a durable capability (it will have its
   own row in `docs/context/features/INDEX.md`), add or update
   `docs/context/features/<id>.md` with frontmatter pointing at the design
   folder and the cited backend docs, and set `Feature ID` in `DESIGN.md`.
   Then `python3 scripts/check-context-links.py` must pass.
7. **Open the file:** `code design/features/<slug>/DESIGN.md` if `code` is on
   PATH, else `open`.
8. Print: "Review `DESIGN.md`. When approved, run `/ship`, then `/fix-review`.
   The PR targets `develop`."

Re-running this skill after `decisions.md` or exports change regenerates
`DESIGN.md`; it is derived, never hand-maintained.

## Never

- Open a PR. Merge. Touch the canvas.
- Pass a hard check by weakening the doc (marking a real frame "Out of scope"
  to dodge coverage, writing `no body` for an endpoint that has one).

## Next step

`/ship` (targets `develop`), then `/fix-review`. Cross-repo features need the
other repo's design PR too. For "next"/"move on", run the router from the flow
reference.
