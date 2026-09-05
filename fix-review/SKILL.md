---
name: fix-review
description: Fetch Claude review comments from the current branch's GitHub PR and fix all reported issues
---

# Fix PR Review Issues

## Step 1: Find the PR for the current branch

```bash
gh pr view --json number,comments --jq '{number, comments}'
```

This automatically finds the PR associated with the current branch. If no PR exists, tell the user and stop.

## Step 2: Check for unresolved review feedback

Greptile/Claude review bots post feedback in TWO places, and you MUST check BOTH. The most common failure mode of this skill is checking only (A), seeing nothing, and exiting while a P1/P2 sits unread in (B).

**(A) Unresolved inline review threads** (comments attached to specific diff lines):

```bash
gh api graphql -f query='
  query {
    repository(owner: "{owner}", name: "{repo}") {
      pullRequest(number: {number}) {
        reviewThreads(last: 100) {
          nodes {
            isResolved
            comments(first: 1) {
              nodes { body, author { login } }
            }
          }
        }
      }
    }
  }
' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'
```

**(B) Review-summary issue comments** — Greptile posts the summary, the `Confidence Score`, AND a `Comments Outside Diff` section as a regular issue comment on the PR (author `greptile-apps[bot]`). Items in that section never appear in `reviewThreads`, so (A) above will not surface them:

```bash
# Latest Greptile review summary on the PR
gh api repos/{owner}/{repo}/issues/{number}/comments \
  --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last | .body'
```

> **CRITICAL — Greptile edits the summary comment IN-PLACE.** There is only ever **one** `greptile-apps[bot]` summary comment per PR. On every re-review Greptile **rewrites that same comment** rather than posting a new one. Consequences:
> - **`created_at` never changes** — do NOT use it to judge freshness. A "stale-looking" `created_at` does NOT mean the review is old.
> - To tell whether the summary reflects your latest push, compare its `updated_at` against your last commit/push time, **and** check which commit SHA the body links to (`blob/<sha>`) against `git rev-parse HEAD`:
>   ```bash
>   gh api repos/{owner}/{repo}/issues/{number}/comments \
>     --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last | {updated: .updated_at}'
>   # Commit the current summary was generated against (compare to git rev-parse HEAD):
>   gh api repos/{owner}/{repo}/issues/{number}/comments \
>     --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last | .body' \
>     | grep -oE 'blob/[a-f0-9]{40}' | sort -u
>   ```
>   If the linked SHA ≠ current HEAD (or `updated_at` predates your push), the re-review has **not** landed yet — keep polling; do NOT conclude "Greptile isn't re-reviewing." If the linked SHA == HEAD, this body is authoritative for your latest code: act on whatever it still flags, and treat findings that reference an older SHA as already-addressed.

Get the `Confidence Score: N/5` line (used in the re-review step):

```bash
gh api repos/{owner}/{repo}/issues/{number}/comments \
  --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last | .body' \
  | grep -o 'Confidence Score: [0-9]/5'
```

Then **extract the `Comments Outside Diff` section mechanically — do NOT eyeball it.** It renders inside a *collapsed* `<details>` block buried in a long HTML body, so a visual scan misses it almost every time. This is the single most common way this skill fails. Run:

```bash
gh api repos/{owner}/{repo}/issues/{number}/comments \
  --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last | .body' \
  | sed -n '/Comments Outside Diff/,/<\/details>/p' \
  | sed 's/<[^>]*>//g' | grep -v '^[[:space:]]*$'
```

The first line printed is `Comments Outside Diff (N)`. If `N` > 0, every numbered item below it is a real issue (P1/P2/P3 badge, file path, line range) that **never** appears in `reviewThreads` — treat each exactly like an inline review comment and fix it. Run both commands again for `claude[bot]` (`select(.user.login == "claude[bot]")`).

**Stop ONLY if (A) is empty AND the extraction command above prints `Comments Outside Diff (0)` or no section at all.** If you have not actually run that command this pass, you are NOT done — never stop on a visual scan. If either (A) or (B) has items, proceed.

> Note: items from (B) have no individual comment ID and no review thread — the reaction/reply/resolve dance in Step 4 does not apply to them. Just fix them, mention them in the commit message, and push.

## Step 3: Fetch review comments

Fetch the inline review comments from the PR:

```bash
# Get all reviews
gh api repos/{owner}/{repo}/pulls/{number}/reviews --jq '.[] | {id, state, user: .user.login}'

# For each review by claude[bot], get the comments
gh api repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}/comments --jq '.[] | {id, path, line, body}'
```

Extract all FAIL and WARN items — each will reference:
- The comment ID (needed for acknowledging fixes)
- The check that failed
- Specific files and line numbers
- A description of the issue

## Step 4: Fix issues

Work through each issue, starting with FAILs:

1. Read the referenced file to understand the full context
2. Apply the fix following project conventions (reference the relevant skill if needed — e.g., the create-endpoint or create-lib skill for convention details)
3. Verify the fix compiles: `make build-server`
4. If tests were changed, verify they pass: `make test-server-file FILE=<changed_test_file>`
5. After fixing, acknowledge the review comment and resolve the thread:
   ```bash
   # Add a 👍 reaction
   gh api repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions -f content="+1"

   # Reply to the comment thread — see reply guidelines below
   gh api repos/{owner}/{repo}/pulls/{number}/comments/{comment_id}/replies -f body="Fixed"
   ```

   **Reply guidelines:**
   - If the fix was straightforward, reply "Fixed".
   - If there were multiple valid approaches (e.g., document vs. change behavior), briefly explain the choice: "Fixed — chose to document rather than change behavior because this is admin-only and hasVoted has no consumer."
   - If you chose NOT to fix something, reply explaining why: "Won't fix — this is intentional because [reason]." Do not resolve the thread in this case; leave it for the user to decide.

   **Note:** items from Step 2 (B) "Comments Outside Diff" have no comment ID and no review thread. Skip the reaction/reply/resolve calls for those — the fix itself plus the commit message is the acknowledgement.

6. After all comments are replied to, resolve the review threads:
   ```bash
   # Get all review thread IDs and their associated comment IDs
   gh api graphql -f query='
     query {
       repository(owner: "{owner}", name: "{repo}") {
         pullRequest(number: {number}) {
           reviewThreads(last: 100) {
             nodes {
               id
               isResolved
               comments(first: 1) {
                 nodes { databaseId }
               }
             }
           }
         }
       }
     }
   ' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | {id, commentId: .comments.nodes[0].databaseId}'

   # For each unresolved thread that matches a fixed comment, resolve it:
   gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "{thread_id}"}) { thread { isResolved } } }'
   ```

## Step 5: Verify

After all fixes are applied, run linters and tests for **all changed codebases** (not just server):

1. Check which codebases have changes: `git diff --name-only HEAD~1` (or the relevant commit range)
2. For each changed codebase, run the appropriate checks:
   - **server**: `make prettier-all && make lint-server && make build-server && make test-server`
   - **client**: `make lint-client && make test-client`
   - **website**: `make lint-website && make test-website`
3. Fix any lint or test failures before proceeding.

## Step 6: Commit and push

1. Commit the fixes with a clear message (e.g., `fix: address PR review comments`)
2. Push to the remote branch
3. List what was fixed and what (if anything) was left for the user to decide.

## Step 7: Request re-review, then RE-CHECK (do not stop here)

Check the Greptile score (e.g., "4/5", "3/5"). **Only trigger a re-review if the score is BELOW 4/5** (i.e. 3/5 or lower):

```bash
gh pr comment {number} --body "@greptile review this"
```

If the score is **4/5 or higher, do NOT trigger a re-review** — a 4/5 or 5/5 is good enough; stop after fixing/replying to the outstanding comments. (Still address any P1/P2 comments the 4/5 review raised before stopping; just don't ask Greptile to re-review afterward.)

**If you triggered a re-review, the skill is NOT complete.** The re-review will **not** appear as a new comment — Greptile **edits the existing summary comment in-place** (see the CRITICAL note in Step 2(B)). So "when the new review lands" means: poll until the summary's linked commit SHA (`blob/<sha>` in the body) equals `git rev-parse HEAD`, **or** its `updated_at` advances past the time you pushed your fixes. Do not wait for a second comment — one will never come — and do not mistake an unchanged `created_at` for "no re-review."

Once the summary's SHA matches HEAD, **return to Step 2 and re-run BOTH (A) and (B) against that updated summary** — including the mechanical `Comments Outside Diff` extraction. Re-reviews routinely introduce NEW `Comments Outside Diff` items and inline threads that did not exist in the first review; a clean first pass does NOT imply a clean re-review. Keep looping (fix → re-review → re-check Step 2) until a re-review whose SHA matches HEAD returns with (A) empty AND `Comments Outside Diff (0)` (or 5/5). Only then is the skill done.

If the summary's linked SHA still lags HEAD after a reasonable wait, the re-review is simply queued/in-progress — keep polling on the loop; this is NOT evidence that Greptile has stopped reviewing.
