---
name: diagnose-flaky
description: Step-by-step procedure for diagnosing and fixing flaky server tests
---

# Diagnosing Flaky Tests

## Quick Reference

```bash
# Run a test multiple times until it fails
./server/scripts/run-flaky-test.sh -n 100 -g "test name or pattern"

# Example
./server/scripts/run-flaky-test.sh -n 50 -g "returns a date 2 days later"
```

## Procedure

**CRITICAL: You MUST follow every step in order. Do NOT skip to a fix based on code reading alone. Even if you are confident you know the root cause from reading the code, you MUST still reproduce the failure and confirm with logging. Static analysis alone has led to wrong fixes in the past.**

### 1. Read the test and form a hypothesis

Read the failing test and the code under test. Form a hypothesis about the root cause, but do NOT make any code changes yet.

### 2. Add debug logging

Add `console.log` statements to capture state when the failure occurs. This saves time for rare failures — otherwise you might wait through 100 runs, catch a failure, then need another 100+ runs to catch it again with logging.

Add conditional logging that only prints on failure:

```typescript
// Add before the failing assertion
if (actualValue !== expectedValue) {
  console.log("DEBUG flaky test - failure state:", {
    actualValue,
    expectedValue,
    relevantState: someVariable,
    timestamp: new Date().toISOString(),
  });
}
```

### 3. Reproduce the failure

**STOP — do not proceed until you have seen the failure output with your own eyes.**

Use the `run-flaky-test.sh` script to run the test repeatedly until it fails:

```bash
./server/scripts/run-flaky-test.sh -n 100 -g "exact test name"
```

- `-n`: Number of iterations (default: 10)
- `-g`: Grep pattern to match test name (required)

The script stops on first failure and shows the debug output.

### 4. Confirm the hypothesis with logging output

**STOP — do not proceed until the logging output confirms your hypothesis.**

Read the debug output from the failure. Does it match your hypothesis? If not, revise your hypothesis, update the logging, and reproduce again.

### 5. Common Causes of Flaky Tests

#### Timezone Issues
Tests that check dates/times may fail intermittently when:
- Using `getUTCDate()` / `getUTCHours()` but logic works in a specific timezone
- Late evening hours in one timezone cross into the next day in UTC

**Fix:** Use timezone-aware assertions:
```typescript
// Instead of: result.getUTCDate()
const resultDay = parseInt(
  result.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    day: "numeric",
  }),
  10,
);
```

#### Random Selection
Tests involving random choices may not always hit the expected branch.

**Fix:** Run assertions in a loop or seed the random number generator.

#### Database State
Tests may pollute shared database state or run in unexpected order.

**Fix:** Ensure proper cleanup in `beforeEach`/`afterEach` hooks.

#### Timekeeper/Time Mocking
`toLocaleDateString` and similar methods may not respect timekeeper's freeze.

**Fix:** Use `moment-timezone` which properly respects frozen time:
```typescript
import moment from "moment-timezone";
const nowInChicago = moment.tz(new Date(), "America/Chicago");
```

#### Race Conditions
Async operations completing in different orders.

**Fix:** Use proper `await` and ensure deterministic ordering.

### 6. Implement the fix

Now — and only now — make the code change to fix the flaky test.

### 7. Verify the fix

Run the flaky test script again with a high iteration count:

```bash
./server/scripts/run-flaky-test.sh -n 50 -g "test name"
```

All iterations should pass consistently.

### 8. Clean up

Remove all debug logging before committing.
