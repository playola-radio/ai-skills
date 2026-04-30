---
name: create-release-pr
description: Analyze PRs merged to develop since last release, determine version bump, and create a release PR from develop into main
---

# Create Release PR

Create a release PR from `develop` into `main` by analyzing merged PRs, determining the version bump type, and creating the PR directly.

## Step 1: Fetch and identify PRs in this release

Run these commands to gather the release contents:

```bash
git fetch origin main develop --quiet
```

Find the last release merge commit (develop merged into main):

```bash
LAST_RELEASE=$(git log origin/main --merges --pretty=format:"%H %s" 2>/dev/null \
  | grep "from .*/develop$" \
  | head -1 \
  | awk '{print $1}')

if [ -z "$LAST_RELEASE" ]; then
  BASE="origin/main"
else
  BASE="$LAST_RELEASE"
fi
```

Extract PR numbers from both merge commits and squash-merged commits:

```bash
# Merge commits: "Merge pull request #123 ..."
git log "$BASE"..origin/develop --merges --pretty=format:"%s" 2>/dev/null | grep "^Merge pull request" | grep -oE '#[0-9]+'

# Squash-merged commits: "feat: some feature (#123)"
git log "$BASE"..origin/develop --no-merges --pretty=format:"%s" 2>/dev/null | grep -oE '\(#[0-9]+\)' | grep -oE '#[0-9]+'
```

For each PR number, fetch the title and labels using `gh pr view <num> --json title,labels,body`.

## Step 2: Determine the version bump type

Read the current version from `server/package.json`.

Analyze the PRs to determine the bump type:

- **major** — Any PR introduces a breaking change (look for "BREAKING" in title/body, or a `breaking` label)
- **minor** — Any PR adds new features (title starts with `feat:`, or has `feature`/`enhancement` label)
- **patch** — All PRs are bug fixes, chores, refactors, docs, or other non-feature work

Default to **patch** if uncertain. Present your reasoning to the user and ask them to confirm the bump type before proceeding.

Calculate the new version:
- patch: increment the third number (e.g., 1.2.3 → 1.2.4)
- minor: increment the second number, reset third (e.g., 1.2.3 → 1.3.0)
- major: increment the first number, reset second and third (e.g., 1.2.3 → 2.0.0)

## Step 3: Generate the release title

Create a short, descriptive title (under 60 characters) that summarizes the theme of the release based on the PR titles. Examples:
- "Station Analytics & Voicetrack Improvements"
- "Invite Code System & Bug Fixes"
- "SQL Injection Protection"

Present the proposed title to the user and ask them to confirm or suggest an alternative.

## Step 4: Bump version and create the PR

Once the user confirms the bump type and title, do everything locally:

1. Update `server/package.json` with the new version
2. Commit and push the version bump to develop:

```bash
git add server/package.json
git commit -m "chore: bump version to <new_version>"
git push origin develop
```

3. Generate the commit list for the PR body:

```bash
COMMITS=$(git log origin/main..origin/develop --pretty=format:"- %s" --no-merges | head -50)
```

4. Create the PR directly:

```bash
gh pr create \
  --base main \
  --head develop \
  --title "<new_version> - <release_title>" \
  --body "<pr_body>"
```

The PR body should include:
- A "Changes" section with the commit list
- A "Version Bump" section showing previous version, new version, and bump type

## Step 5: Report

Find and display the created PR:

```bash
gh pr list --base main --head develop --json number,title,url
```

Report the PR URL to the user.

## Output Format

Present the release summary as:

```
## Release Summary

**Version:** {old_version} → {new_version} ({bump_type})
**Title:** {new_version} - {release_title}

### PRs included:
- #{number}: {title}
- #{number}: {title}
...

**PR created:** {url}
```
