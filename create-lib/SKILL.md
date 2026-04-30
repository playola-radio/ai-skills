---
name: create-lib
description: Step-by-step workflow for creating server library functions with TDD one function at a time
---

# Library Development

## Development Workflow

1. Write unit tests for ONE function (in `[module].lib.test.ts`)
2. See them fail (red): `make test-server-file FILE=src/lib/[module]/[module].lib.test.ts`
3. Implement the function (in `[module].lib.ts`)
4. See them pass (green): `make test-server-file FILE=src/lib/[module]/[module].lib.test.ts`
5. Pause for commit
6. Repeat for next function
7. When complete: `make prettier-all && make lint-server && make build-server && make test-server`

## Core Principle: One Function at a Time

Never implement multiple functions in parallel. Complete the full cycle for one function before starting the next.

## Unit Testing

### Test File Location

`server/src/lib/[module]/[module].lib.test.ts` (co-located with implementation)

### Test Structure

- Cover happy path, edge cases, and error conditions
- Use existing test patterns and fixtures from the codebase
- One describe block per function

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

### Non-existent UUIDs in Tests

When testing "not found" error paths, generate real random UUIDs instead of hardcoded ones:

```typescript
import { v4 as UUID } from "uuid";

// GOOD - real random UUID that won't collide
await lib.getUser(UUID());

// BAD - hardcoded zero UUID
await lib.getUser("00000000-0000-0000-0000-000000000000");
```

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
```

## File Organization

```
server/src/lib/[module]/
├── index.ts              # Re-exports from lib file
├── [module].lib.ts       # Implementation
└── [module].lib.test.ts  # Tests
```

## Test Commands

```bash
# Run tests matching a pattern
make test-server-file GREP="functionName"

# Run all tests in a specific file
make test-server-file FILE=src/lib/[module]/[module].lib.test.ts

# Run full server test suite (at the end)
make test-server
```

## Quality Gates

- [ ] Tests pass for the completed function
- [ ] `make prettier-all` passes
- [ ] `make lint-server` passes
- [ ] `make build-server` passes
- [ ] `make test-server` passes
- [ ] Code follows existing patterns in codebase
