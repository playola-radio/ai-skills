---
name: create-endpoint
description: Step-by-step workflow for creating REST API endpoints with integration tests and OpenAPI docs
---

# Endpoint Development

## Development Workflow

1. Write integration tests first (in `[module].api.test.ts`)
2. See them fail (red): `make test-server-file FILE=src/api/[module]/[module].api.test.ts`
3. Implement the endpoint (controller, routing)
4. See them pass (green): `make test-server-file FILE=src/api/[module]/[module].api.test.ts`
5. Add/update documentation (see **API Documentation** section below):
   - `ENDPOINTS.md` — human-readable reference
   - `[module].api.docs.yaml` — OpenAPI spec
   - Tag in `server/src/docs/index.js`
   - Row in `.claude/API_ENDPOINTS.md`
6. Verify: `make build-server`, then confirm endpoints appear in `http://localhost:10020/swagger.json`
7. Consistency check: `ENDPOINTS.md`, `index.ts`, and `.api.docs.yaml` all describe the same endpoints
8. When complete: `make prettier-all && make lint-server && make build-server && make test-server`

## Integration Testing

### Philosophy

These are **integration tests** that test all functionality through the full stack. The goal is to test real behavior without mocking anything internally.

### Mocking Rules

**Only mock at borders** - calls to outside services:
- External APIs (Spotify, AWS S3, etc.)
- Email services
- Push notification services
- Third-party webhooks

**Never mock** internal services, database calls, or library functions.

### Time Mocking with Timekeeper

Use `timekeeper` for mocking time:

```typescript
import tk from "timekeeper";
```

**Always freeze to a specific time** - never use `new Date()`:

```typescript
// Good
tk.freeze(new Date("2026-01-26T10:00:00Z"));

// Bad - non-deterministic
tk.freeze(new Date());
```

Always reset timekeeper after the test:

```typescript
try {
  tk.freeze(new Date("2026-01-26T10:00:00Z"));
  // ... test code
} finally {
  tk.reset();
}
```

Or use `beforeEach`/`afterEach`:

```typescript
beforeEach(function () {
  tk.freeze(new Date("2026-01-26T10:00:00Z"));
});

afterEach(function () {
  tk.reset();
});
```

### Enforcing Creation Order

When you need to enforce database record ordering (e.g., for sorting by `createdAt`), advance timekeeper between creations:

```typescript
tk.freeze(new Date("2026-01-26T10:00:00Z"));
const firstItem = await createItem(db, { name: "First" });

tk.freeze(new Date("2026-01-26T10:00:01Z")); // Advance 1 second
const secondItem = await createItem(db, { name: "Second" });

tk.freeze(new Date("2026-01-26T10:00:02Z")); // Advance another second
const thirdItem = await createItem(db, { name: "Third" });
```

### Test Data Generation

Always use `server/src/test/testDataGenerator.js` for generating test models:

```typescript
import {
  createUser,
  createStation,
  createAudioBlock,
  createSong,
  createVoicetrack,
  createCategories,
  createClocks,
  createSpins,
  createPrizeTier,
  createPrize,
  createListenerQuestion,
  // ... and more
} from "../../test/testDataGenerator";
```

**DO NOT manually create users with hardcoded emails:**

```typescript
// BAD - can cause duplicate email conflicts between tests
const adminUser = await db.models.User.create({
  email: "admin@example.com",
  role: "admin",
});

// GOOD - let testDataGenerator handle unique emails
const adminUser = await createUser(db, { role: "admin" });
```

### Generating Tokens

```typescript
import { generateToken } from "../../utils/jwt";

const user = await createUser(db);
const token = await generateToken(user);
```

### Test File Location

`server/src/api/[module]/[module].api.test.ts` (co-located with controller)

## REST Conventions

### URL Structure

**Base Path:**
- All endpoints are prefixed with `/v1/`
- Routes are mounted in `server/src/api/routes.ts`

**Naming Conventions:**
- **Preferred:** kebab-case for all new endpoints (e.g., `/listening-sessions`, `/user-devices`)
- **Deprecated:** camelCase endpoints still supported for backward compatibility
- Use plural nouns: `/users`, `/stations`, `/songs`
- Use lowercase: `/audio-blocks`, not `/AudioBlocks`

### The `/:userId/` Pattern with `me`

User-related endpoints use `/:userId/` in the path, where `me` is a special value that resolves to the authenticated user's ID.

**Examples:**
```
GET  /v1/users/me                    → Get current user
GET  /v1/users/me/stations           → Get current user's stations
GET  /v1/users/me/likes              → Get current user's likes
GET  /v1/users/abc123/stations       → Get specific user's stations (admin)
```

**Middleware handles `me` automatically** in `server/src/api/middleware/security.ts`:

```typescript
// Controllers can simply use req.params.userId directly
async function getUserListenerQuestionAirings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = req.params;  // Already resolved by middleware
    const airings = await listenerQuestionsLib.getUpcomingAiringsForListener(userId);
    res.status(200).json(airings);
  } catch (error) {
    next(error);
  }
}
```

### Nested Resources

**Parent-Child Pattern:**
```
GET  /v1/stations/:stationId/categories
GET  /v1/stations/:stationId/categories/:categoryId
GET  /v1/stations/:stationId/categories/:categoryId/audioBlocks
```

### HTTP Methods & Status Codes

| Method | Purpose | Example |
|--------|---------|---------|
| GET | Retrieve resource(s) | `GET /v1/users/me` |
| POST | Create resource | `POST /v1/stations` |
| PUT | Update resource | `PUT /v1/users/me` |
| DELETE | Remove resource | `DELETE /v1/users/me/likes/:audioBlockId` |

| Code | Usage |
|------|-------|
| 200 | Successful GET, PUT, DELETE |
| 201 | Successful POST (resource created) |
| 400 | Validation error, bad request |
| 401 | Authentication failure |
| 403 | Permission/authorization failure |
| 404 | Resource not found |
| 409 | Conflict error |

### Authentication & Authorization

**Middleware Stack (in order):**
1. `authenticate` - Validates JWT Bearer token, sets `req.user`
2. `validateUUIDsInParams([...])` - Validates UUID format in URL params
3. Permission middleware (see below)
4. `checkBodyFor([...])` - Validates required fields
5. `checkBodyForNoExtraFields([...])` - Rejects unknown fields
6. `validateUUIDsInBody([...])` - Validates UUID format in body
7. Controller function

**Permission Middleware Options:**

```typescript
// Role-based
requireRoleOfAtLeast("admin")  // Roles: guest < user < admin

// Self-operation
isOperatingOnSelf("userId")  // User can only operate on own data

// Combined (OR logic)
oneOf([
  isOperatingOnSelf("userId"),
  requireRoleOfAtLeast("admin")
])

// Station-specific
checkUserPermissionToEditStation  // User must have edit rights on station
```

### Request Validation

```typescript
// Required fields
checkBodyFor(["stationId", "name"])
checkBodyForAtLeastOneOf(["firstName", "lastName"])

// Field restrictions
checkBodyForNoExtraFields(["firstName", "lastName", "email"])

// UUID validation
validateUUIDsInParams(["userId", "stationId"])
validateUUIDsInBody(["audioBlockId"])

// Type conversion
convertQueryParamToDate(["startTime", "endTime"])
convertQueryParamToNumber(["limit", "offset"])

// Enum validation
checkBodyEnum("status", CONVERSATION_STATUSES)
```

### Error Handling

**Error Classes (in `utils/errors.ts`):**
- `NotFoundError` → 404
- `AuthenticationError` → 401
- `PermissionError` → 403
- `ValidationError` → 400
- `ConflictError` → 409

**Use centralized error messages:**
```typescript
throw new NotFoundError(ErrorMessages.USER_NOT_FOUND);
throw new ValidationError(ErrorMessages.invalidUuidFormat("userId"));
```

**Controller error pattern:**
```typescript
async function handler(req, res, next) {
  try {
    // ... implementation
    res.status(200).json(result);
  } catch (error) {
    next(error);  // Pass to error middleware
  }
}
```

### Response Structure

**Single resource:**
```json
{
  "id": "uuid",
  "name": "value",
  "createdAt": "2024-01-26T..."
}
```

**Collection:**
```json
[
  { "id": "uuid1", ... },
  { "id": "uuid2", ... }
]
```

**Error:**
```json
{
  "error": {
    "message": "Error description"
  }
}
```

## File Organization

```
server/src/api/
├── routes.ts                    # Main route mounting
├── middleware/
│   ├── security.ts              # Auth middleware
│   └── routeValidators.ts       # Validation middleware
├── [module]/
│   ├── index.ts                 # Route definitions
│   ├── [module].controller.ts   # Handler functions
│   ├── [module].api.test.ts     # Integration tests
│   └── [module].api.docs.yaml   # OpenAPI documentation
└── ...
```

## API Documentation

Each endpoint module has three documentation/definition surfaces that must stay in sync:

| File | Purpose |
|------|---------|
| `[module]/ENDPOINTS.md` | Human/Claude-readable endpoint reference |
| `[module]/index.ts` | Route definitions (the source of truth for what exists) |
| `[module]/[module].api.docs.yaml` | OpenAPI spec for Swagger/Redoc |

### Creating Documentation

1. **`ENDPOINTS.md`** — Write a concise reference with endpoint table, request/response examples, error cases, and any workflow notes.
2. **`[module].api.docs.yaml`** — OpenAPI 3.0 spec following existing patterns (see `rewards/rewards.api.docs.yaml` for reference). Use the module's tag name, `bearerAuth` security, and `$ref` shared responses where possible.
3. **Tag registration** — Add the module's tag to `server/src/docs/index.js` in the `tags` array.
4. **Index entry** — Add a row to `.claude/API_ENDPOINTS.md` so the module is discoverable.

### Verification Checklist

After adding or updating documentation, run:

```bash
make build-server
```

Then verify:

1. **Swagger JSON is served** — `curl http://localhost:10020/swagger.json | jq '.paths'` should include all the module's paths.
2. **Consistency check** — Confirm that `ENDPOINTS.md`, `index.ts` (route definitions), and `.api.docs.yaml` all describe the same set of endpoints with matching methods, paths, and request/response shapes. If one is updated, check the other two.

## Common Route Patterns

```typescript
// CRUD Operations
router.get("/", authenticate, controller.list);
router.post("/", authenticate, checkBodyFor([...]), controller.create);
router.get("/:id", authenticate, controller.get);
router.put("/:id", authenticate, controller.update);
router.delete("/:id", authenticate, controller.delete);

// Action Endpoints
router.post("/:id/publish", authenticate, controller.publish);
router.post("/:id/answer", authenticate, controller.answer);

// Presigned URL Endpoints
router.post("/presigned-url", authenticate, controller.getPresignedUrl);
```

## Anti-Patterns to Avoid

**DON'T: Use `/mine` or implicit user endpoints**
```typescript
// Bad - not RESTful, breaks caching
router.get("/mine", ...)
router.get("/profile", ...)  // Implicit current user
```

**DO: Use `/:userId/` with `me` support**
```typescript
// Good - explicit, cacheable, supports admin access
router.get("/:userId/profile", ...)
```

**DON'T: Handle errors with res.status().json()**
```typescript
// Bad
if (!user) {
  return res.status(404).json({ error: "Not found" });
}
```

**DO: Throw typed errors**
```typescript
// Good
if (!user) {
  throw new NotFoundError(ErrorMessages.USER_NOT_FOUND);
}
```

## Quality Gates

- [ ] Integration tests written and passing
- [ ] Controller follows try-catch pattern
- [ ] Proper error classes used
- [ ] `make prettier-all` passes
- [ ] `make lint-server` passes
- [ ] `make build-server` passes
- [ ] `make test-server` passes
- [ ] API docs: `ENDPOINTS.md`, `.api.docs.yaml`, and `index.ts` all describe the same endpoints
- [ ] API docs: endpoints appear in `http://localhost:10020/swagger.json`
- [ ] API docs: tag registered in `server/src/docs/index.js`
- [ ] API docs: module listed in `.claude/API_ENDPOINTS.md`
