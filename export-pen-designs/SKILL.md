---
name: export-pen-designs
description: Use inside Pen.app whenever the proposal frames changed and disk must match the canvas — "export the designs", "re-export", "sync exports", "update the PNGs" — or, with --status, when a proposal's status changes ("mark it proposed/implementing/shipped/dropped"). Runs in the Pen agent only.
---

# export-pen-designs (Pen agent)

Makes `design/features/<slug>/` match the canvas: PNG per frame, a JSON spec
sheet, and the proposal's rows in `design/DESIGN_STATUS.md`. Exporting never
changes a status; `--status` does. Flow reference:
`~/playola/playola-skills/design-pr-flow.md`.

## Guard

Same as `begin-pen-session`: pencil tools present, active canvas is
`<root>/design/<name>.pen` with `<root>/.git`, feature folder exists. Pen
`Export` resolves relative paths from the workspace root, so the workspace
must be `<root>`.

## Steps

1. Find the proposal's frames (top-level frames inside the zone rect; the
   visitor from `audit-pen-designs` step 2). If `decisions.md` names frames
   the zone does not contain, print them as missing and continue.
2. Export all frames in one call, then rename:

   ```js
   Export(["<id1>", "<id2>"], "png", "./design/features/<slug>/exports")
   ```

   Rename each `<nodeId>.png` to `<screen-name>--<nodeId>.png` where
   `<screen-name>` is the frame name lower-cased, non-alphanumerics collapsed
   to `-`, trimmed. Delete PNGs in `exports/` whose node ID is no longer a
   frame in the zone.
3. Write `pen-nodes.json`: `exportedAt` (UTC ISO now), `penFile`
   (`design/<name>.pen`), `variables` from `Print(GetVariables())`, and one
   entry per frame with `id`, `name`, `png` (relative to the feature folder),
   and `node` = `Get(id, {depth: 6, resolveVariables: true})`. Read the frames
   one `execute` call at a time; large `Get` results must not be stored in
   globals.
4. Refresh the proposal's table in `design/DESIGN_STATUS.md`: one row per
   frame (`| <name> | \`<id>\` | <status> | <notes> |`). Keep an existing
   row's status and notes; new frames get the proposal's current status
   (`Exploring` for an amber zone, `Proposed` for blue). Remove rows for
   deleted frames. Touch nothing outside this proposal's section.
5. Print the file list (PNGs written, PNGs removed, `pen-nodes.json`,
   `DESIGN_STATUS.md`).

## `--status <proposed|implementing|shipped|dropped>`

Only when invoked with the flag, after the steps above:

- Recolor the zone rect and title per the `DESIGN_STATUS.md` legend: amber =
  exploring, blue = proposed/implementing, green = shipped. Update the title
  text suffix (`— Proposed`, `— Implementing (PR #n)`, `— Shipped`, `— Dropped`).
- Set every row of the proposal to the new status (keep notes).
- `shipped`: `git mv` the feature's PNGs into `design/exports/current-app/`
  and note in the section that the frames should move to the Current App zone.
- `dropped`: leave frames; mark rows `Dropped`.

## Never

- Change a status, move an export folder, or recolor a zone without `--status`.
- Export to a path outside `design/features/<slug>/exports/`.
- Edit frame content. Renames of files only.

## Next step

Return to whichever step called this skill. Standalone: if `REVIEW.md` exists
and is `clean`, the repo agent runs `finish-design-pr`; otherwise
`audit-pen-designs`. For "next"/"move on", run the router from the flow reference.
