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

## Step 2: Check for unresolved review comments

First check if there are any unresolved review threads:

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

**If there are no unresolved review threads, stop here.** Say "No unresolved review comments" and exit. Do not proceed to the next steps.

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

## Step 6: Request re-review if needed

Check the original Greptile review for a score (e.g., "4/5", "3/5"). If the score was 4/5 or lower, comment on the PR to trigger a re-review:

```bash
gh pr comment {number} --body "@greptile review this"
```

If the score was 5/5, skip this step.
