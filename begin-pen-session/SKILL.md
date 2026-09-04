---
name: begin-pen-session
description: Use inside Pen.app at the start of designing a feature that already has a brief — "start the pen session", "let's design X", "open the canvas for X", "set up the proposal row". Runs in the Pen agent only; creates the proposal container, not the screens.
---

# begin-pen-session (Pen agent)

Orients the Pen agent on the feature and creates the empty proposal row. It
creates no product screens; the owner drives those afterward. Flow reference:
`~/playola/playola-skills/design-pr-flow.md`.

## Guard

1. `get_app_state` works. If not, stop: "Run this inside Pen.app with the design branch worktree open."
2. The active canvas path is `<root>/design/<name>.pen` and `<root>/.git`
   exists (a file in worktrees, a dir in the main checkout). If the path is
   `~/Documents/...` or `<root>` has no `.git`, stop and print the folder to
   open: the design branch worktree root.
3. `<root>/design/features/<slug>/brief.md` exists. If there is more than one
   feature folder, ask which slug. If none, stop: "run `begin-design-pr` in the repo agent first."

## Steps

1. Read `brief.md`. Read `<root>/docs/context/README.md`, then
   `docs/context/features/INDEX.md`, match 1–3 feature nodes, and read those
   docs in the order the README gives. Stop as soon as the brief's surfaces
   and models are understood. Do not open code.
2. List top-level frames with their zone:

   ```js
   Get(document, (n, c) => c.depth === 1 && Print(n.id, "|", n.name, "|", Math.round(c.bounds.y)), {depth: 1})
   ```

   Cross-reference `design/DESIGN_STATUS.md` for statuses. Screenshot at most
   three current-app frames the feature touches, in one call:
   `TakeScreenshot([id1, id2, id3])`.
3. Create the proposal row below the last row, following the zone
   conventions in `design/DESIGN_STATUS.md` (amber = exploring):

   ```js
   const pos = FindEmptySpace({width: 3200, height: 1400, direction: "bottom", padding: 200})
   zoneId = Insert(document, {type: "rectangle", name: "Zone · <Feature>", x: pos.x, y: pos.y, width: 3200, height: 1400, fill: "#FDF3D8", cornerRadius: 24})
   titleId = Insert(document, {type: "text", name: "Title · <Feature>", x: pos.x + 40, y: pos.y - 120, content: "PROPOSAL · <Feature> — Exploring", fontFamily: "Inter", fontSize: 64, fontWeight: "bold", fill: "#B7791F"})
   noteId = Insert(document, {type: "text", name: "Note · <Feature>", x: pos.x - 620, y: pos.y, textGrowth: "fixed-width", width: 560, content: "<slug> · brief: design/features/<slug>/brief.md · frames go inside the zone", fontFamily: "Inter", fontSize: 24, fill: "#7A5A12"})
   Move(zoneId, document, 0)
   Print(zoneId, titleId, noteId)
   ```

   Match the fill and title colors to whatever the existing amber zone uses if
   one exists (`Get(n => n.name.startsWith("Zone ·") && Print(n.id, n.name, n.fill))`).
4. Append a section to `design/DESIGN_STATUS.md` under "Proposals":

   ```md
   ### Proposal · <Feature> (zone `<zoneId>`, label `<noteId>`)

   Brief: `design/features/<slug>/brief.md`. Exports under `design/features/<slug>/exports/`.

   | Frame | Node ID | Status | Notes |
   |---|---|---|---|
   ```
5. Print a short orientation: the feature in one line, the existing screens it
   touches (frame names + IDs), the surfaces in scope, and the brief's
   constraints verbatim.
6. Hand control back with exactly: "Describe the first screen." Do not design
   unprompted. New screens go inside the zone as top-level frames with
   `placeholder: true` until finished, `clip: true`, and a human-readable name.

## Next step

When the owner is done designing ("I'm done", "review it", "audit this",
"next"): `audit-pen-designs`. For "next"/"move on" at any time, run the router
from the flow reference.
