---
name: review-pr
description: Review the current branch's changes against the Playola PR review checklist
---

# PR Review

Review all changes on the current branch against the base branch. Apply every check in the checklist below and report findings.

## Step 1: Gather the diff

Run `git diff main...HEAD` to get all changes. Run `git log --oneline main..HEAD` to understand the commit history. Read any changed files in full when needed for context.

## Step 2: Apply the review checklist

For each item, report one of:
- **PASS** - No violations found
- **WARN** - Potential issue worth discussing
- **FAIL** - Clear violation that should be fixed
- **N/A** - Not applicable to these changes

---

### Testing

- [ ] **Timekeeper over setTimeout/new Date()**: Tests that need to control time must use `timekeeper` (freeze/travel/reset), never `setTimeout`, `setInterval`, or `new Date()` as "now". Always freeze to a specific date string like `new Date("2026-01-26T10:00:00Z")`, never `new Date()`.
- [ ] **Timekeeper cleanup**: Every `tk.freeze()` has a corresponding `tk.reset()` in `afterEach` or a `try/finally` block.
- [ ] **Test data via testDataGenerator**: Tests use `createUser`, `createStation`, etc. from `test/testDataGenerator.js`. No manually created users with hardcoded emails (`User.create({ email: "foo@bar.com" })`).
- [ ] **Random UUIDs for not-found tests**: "Not found" test paths use `UUID()` from the `uuid` package, not hardcoded zero UUIDs.
- [ ] **Only mock at borders**: Only external services (Spotify, AWS S3, email, push notifications) are mocked with nock/sinon. Internal services, database calls, and library functions are never mocked in integration tests.
- [ ] **Test isolation**: Each test cleans up after itself — `tk.reset()`, `sinon.restore()`, `nock.cleanAll()` in `afterEach` blocks.
- [ ] **Test file co-location**: Test files follow the convention: `*.lib.test.ts` next to lib files, `*.api.test.ts` next to API modules, `*.model.test.ts` next to model files.

### Architecture — Controller / Library Separation

- [ ] **Controllers are thin**: Controller functions only: (1) extract params/body/query from the request, (2) call library functions, (3) format and send the response. No database queries, no business logic, no complex conditionals.
- [ ] **No direct model access in controllers**: Controllers call library functions, never `Model.findAll()`, `Model.create()`, etc. directly.
- [ ] **Business logic lives in lib/**: Any new business logic is in `server/src/lib/[module]/[module].lib.ts`, not in controllers or route files.
- [ ] **Controller error pattern**: Controllers use try/catch with `next(error)`, not `res.status().json({ error })`.

### Middleware

- [ ] **Middleware in route files**: Auth, validation, and permission middleware is applied in `index.ts` route definitions, not inside controller functions.
- [ ] **No duplicated middleware**: Middleware like `checkBodyEnum`, `checkBodyFor`, `validateUUIDsInParams`, or auth checks are not duplicated across routes that could share a common prefix or group.
- [ ] **Use existing middleware**: New validation uses existing middleware from `api/middleware/` (`checkBodyFor`, `checkBodyForNoExtraFields`, `checkBodyEnum`, `validateUUIDsInParams`, `validateUUIDsInBody`, `convertQueryParamToDate`, `convertQueryParamToNumber`, `isOperatingOnSelf`, `requireRoleOfAtLeast`, `oneOf`, `checkUserPermissionToEditStation`) rather than hand-rolling validation in controllers.

### Error Handling

- [ ] **Typed error classes**: Errors use classes from `utils/errors.ts` (`NotFoundError`, `PermissionError`, `AuthenticationError`, `ValidationError`, `ConflictError`), not generic `Error` or raw `res.status()` calls.
- [ ] **Centralized error messages**: Uses `ErrorMessages` constants where available.

### Code Quality

- [ ] **TypeScript for all new files**: No new `.js` files. All new code is `.ts`.
- [ ] **No `any` types**: New code uses proper types. Model types imported from `db/types.ts`.
- [ ] **Enum pattern**: Enums use the `as const` array pattern defined in the model file, not standalone TypeScript enums or scattered string literals.
- [ ] **Model conventions**: New models follow the subdirectory pattern: `db/models/modelName.model/modelName.model.ts` + `index.ts`. Registered in `db/index.ts`, `db/types.ts`, and `db/associations.ts`.
- [ ] **Lib conventions**: New libs follow `lib/[module]/index.ts` + `[module].lib.ts` + `[module].lib.test.ts`.

### API Design

- [ ] **RESTful conventions**: Endpoints represent resources, not actions. No "summary" endpoints combining unrelated data. Plural nouns, kebab-case.
- [ ] **Route versioning**: New routes are under `/v1/`.
- [ ] **The `me` pattern**: User-scoped endpoints use `/:userId/` with `me` support, not `/mine` or implicit current-user paths.
- [ ] **Proper middleware stack order**: authenticate → validateUUIDsInParams → permission middleware → body validators → controller.
- [ ] **Status codes**: POST returns 201, GET/PUT/DELETE return 200.

### Documentation

- [ ] **API docs in sync**: If endpoints were added or changed, all three surfaces are updated: `ENDPOINTS.md`, `[module].api.docs.yaml`, and `index.ts` route definitions match.
- [ ] **Tag registered**: New modules have their tag in `server/src/docs/index.js`.
- [ ] **Index updated**: New modules have a row in `.claude/API_ENDPOINTS.md`.

### Website (if website/ files changed)

- [ ] **No direct axios imports**: All HTTP requests go through service functions in `src/services/`, using the shared `api` instance. No bare `axios` imports in pages, hooks, or slices.

## Step 3: Report

Output a summary table:

```
| Check                          | Status | Notes              |
|--------------------------------|--------|--------------------|
| Timekeeper over setTimeout     | PASS   |                    |
| ...                            | FAIL   | file.ts:42 — ...   |
```

Then list specific action items the author should address before merging, grouped by severity (FAIL first, then WARN).
