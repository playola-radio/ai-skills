# Design-phase deliverables

Three files every feature design must ship, in `design/features/{slug}/` next to `spec.md`. Each is
**required whenever the feature has that kind of change**, in any repo:

| File | Required when the feature… | Contents |
|---|---|---|
| `screens.md` | adds or changes any screen (web or native) | pen.dev mockup PNG of every new/changed screen in every agreed state, its address, and how it is navigated to/from |
| `endpoints.md` | adds, changes, or removes any API endpoint | every endpoint change, with request/response bodies and errors |
| `models.md` | adds, changes, or removes any model, column, index, constraint, or enum | every model change, with migration notes |

These files are the source of truth for their contracts. `spec.md` links to them and never restates
their contents — no second copy of a field table or response body anywhere else in the folder.

`spec.md` carries a `## Design deliverables` section with exactly one line per file, either linking it
or saying why it doesn't exist:

```md
## Design deliverables
- Screens: [screens.md](./screens.md)
- Endpoints: none — reuses `GET /v1/stations/:stationId/spins` unchanged
- Models: [models.md](./models.md)
```

A missing file with no `none — <reason>` line means the design is incomplete.

---

## `screens.md`

Every screenshot is a PNG **exported from pen.dev** (`Export([nodeId], "png", dir)`), never a
hand-drawn diagram or a screenshot of the running app. Every agreed state is its own Pen frame, so
it gets its own image. Images are embedded with relative paths so they render on GitHub.

```md
# <Feature> — Screens

Pen file: `design/<surface>.pen`

## Navigation map
| Screen | Surface | Address | Reached from |
|---|---|---|---|
| Play History | website | `/stations/:stationId/play-history` | Station dashboard sidebar → "Play history" |

## <Screen name>
- **Status:** New | Changed
- **Surface:** website | client | ios
- **Address:** `/stations/:stationId/play-history?page=<n>` (web: full route with path and query params)
  — native: `n/a (native)` plus the presentation, e.g. "pushed onto the Station tab's stack"
- **Access:** who can open it (e.g. station owner/contributor; admins)
- **Navigated to from:**
  - Station dashboard → sidebar "Play history" link
  - Email "Your weekly plays" → "See full history" deep link
- **Navigates to:**
  - Row click → Spin detail (`/stations/:stationId/spins/:spinId`)
  - Back → Station dashboard
- **Changed from today** (Changed screens only): what differs from the current screen, and its current
  screenshot from `exports/existing/`

| State | When it shows | Node | Mockup |
|---|---|---|---|
| Default | Spins exist for the range | `abc12` | ![Play History — default](exports/play-history--default.png) |
| Loading | First fetch in flight | `def34` | ![Play History — loading](exports/play-history--loading.png) |
| Empty | No spins in range | `ghi56` | ![Play History — empty](exports/play-history--empty.png) |
| Error | Fetch failed | `jkl78` | ![Play History — error](exports/play-history--error.png) |
| Forbidden | Viewer lacks station access | `mno90` | ![Play History — forbidden](exports/play-history--forbidden.png) |
```

Rules:
- One `##` section per new or changed screen, including modals, sheets, and drawers that have their
  own content. Unchanged screens appear only as navigation endpoints.
- States are the ones agreed with the user. Consider loading, empty, error, forbidden, and any
  feature-specific states (e.g. draft vs. published); each agreed state gets a row and a PNG. A state
  that doesn't apply is omitted, not described in prose.
- Every "navigated to from" entry names the source screen **and** the exact element or trigger. If the
  entry point is on an existing screen that changes (a new link or button), that screen is Changed and
  gets its own section.
- PNG filenames are `exports/<screen-slug>--<state-slug>.png` (lowercase, non-alphanumerics → `-`).

---

## `endpoints.md`

Written against the backend's conventions (in Playola: REST resources, `PUT` never `PATCH`, `/v1/`
prefix, consistent populated-model response shapes).

````md
# <Feature> — Endpoint changes

| Change | Method | Path | Auth | Purpose |
|---|---|---|---|---|
| New | GET | `/v1/stations/:stationId/play-history` | station owner/contributor, admin | List a station's recent plays |
| Changed | PUT | `/v1/stations/:stationId` | station owner, admin | Accept `timezone` |
| Removed | GET | `/v1/legacy/plays` | — | Replaced by the endpoint above |

## GET /v1/stations/:stationId/play-history
- **Change:** New
- **Auth:** station owner/contributor, admin (`checkUserPermissionToViewStation`)
- **Path params:** `stationId` (UUID)
- **Query params:**

  | Param | Type | Required | Default | Notes |
  |---|---|---|---|---|
  | `page` | integer ≥ 1 | no | 1 | |

- **Request body:** none
- **Response `200`:**
  ```json
  { "spins": [{ "id": "…", "airtime": "2026-09-30T14:00:00Z", "audioBlock": { "id": "…", "title": "…" } }], "page": 1 }
  ```
- **Errors:**

  | Status | When |
  |---|---|
  | 400 | `page` is not a positive integer |
  | 403 | caller lacks station access |
  | 404 | station not found |

- **Consumers:** website Play History screen
````

Rules:
- One `##` section per row in the summary table, headed `METHOD path` exactly as in the table.
- Request and response bodies are real JSON examples, or the literal word `none`.
- **Changed** endpoints show the delta, not the whole contract: fields added/removed/renamed in the
  request and response, behavior changes, and which existing clients (web, client, iOS versions in the
  wild) break or keep working.
- **Removed** endpoints name their replacement and the clients still calling them.
- **Consumers** names the screens (from `screens.md`) or jobs that call it.

---

## `models.md`

````md
# <Feature> — Model changes

| Change | Model | Table | Summary |
|---|---|---|---|
| New | `PlayHistoryProjection` | `playHistoryProjections` | Listener-facing read model of recent plays |
| Changed | `Station` | `stations` | Adds `timezone` |

## Station (`stations`) — Changed

| Column | Type | Null | Default | Change | Notes |
|---|---|---|---|---|---|
| `timezone` | STRING(64) | NOT NULL | `'America/Chicago'` | Added | IANA zone name |

- **Indexes / constraints:** none added
- **Associations:** unchanged
- **Enums:** none
- **Migration:** add column with default; no backfill needed (default covers existing rows)
- **Deploy compatibility:** additive — old worker ignores the column

## PlayHistoryProjection (`playHistoryProjections`) — New

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `uuidv4` | PK |
| `stationId` | UUID | NOT NULL | | FK → `stations.id`, `ON DELETE CASCADE` |

- **Indexes / constraints:** `(stationId, airtime DESC)` — serves the play-history list query
- **Associations:** `belongsTo Station`; `Station.hasMany PlayHistoryProjection`
- **Enums:** none
- **Source of truth:** what this table is authoritative for, or what it is derived from and how it stays consistent
- **Migration:** create table; backfill from `spins` for the last 30 days
- **MODEL.md sketch:** one paragraph of domain context
````

Rules:
- Changed models list **only** the columns that change (Added / Changed / Removed), with the old type
  or nullability shown for Changed columns.
- Every index names the query that uses it; every column names what reads it.
- Migration notes cover backfill, deploy/rollback compatibility (expand → contract when a column is
  dropped or renamed), and any data at risk.
- Any stored copy of data that lives elsewhere states its authority and consistency story under
  **Source of truth**.
