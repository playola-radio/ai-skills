---
name: ux-evidence
description: Use when a branch adds or changes something a user can see or do in the Playola web client (client/) or iPhone app (PlayolaRadio/) — record before/after screenshots or video with `make ux-evidence`, check it is current, and attach it to the PR, or waive it with "UX evidence: none — <reason>".
---

# UX evidence

Proof of a visible change, attached to its PR: before/after screenshots for a visual change, before/after video for a functional one. The tool is `ux-evidence/tool/` in this repo; each app repo drives it through `make ux-evidence*` targets and keeps its cases in `qa/ux/<case-id>/`.

| Platform | Repo | Reference |
|---|---|---|
| Web client | `~/playola/playola` | `qa/ux/README.md` there |
| iPhone app | `~/playola/playola-radio-ios` | `qa/ux/README.md` there |

**Android is not supported yet.** There is nothing to record for it.

Read the repo's `qa/ux/README.md` before writing a case: it has the flow rules, output layout, and troubleshooting. This skill covers the decisions.

## When evidence is needed

If the branch changes a path listed under `requiresEvidence` in `qa/ux/config.yaml` (web: `client/`; iPhone: `PlayolaRadio/` and `PlayolaRadio.xcodeproj/`; test files and `*.md` do not count), then before the PR is opened either:

- `make ux-evidence-verify` passes, or
- the PR body contains `UX evidence: none — <reason>`. Use this only when the change has no visible effect. `verify` cannot see the PR body and keeps failing on a waived branch; skip it and `publish` for that PR.

On web, `server/` changes do not need evidence, but they do make existing evidence stale.

## Visual or functional

- `visual`: same screen, same states, same actions and outcomes; only layout, styling, icons or copy changed. Produces before/after/compare PNGs; the flow must take at least one screenshot.
- `functional`: anything else. Produces `before.mp4` and `after.mp4`; screenshots are optional extras.

When unsure, `functional`.

## Is a "before" needed?

`BEFORE=required` is the default. Use `BEFORE=not-applicable` only when the base commit has nothing to show: the page, screen or feature is new. It needs a `REASON`, which appears in the PR comment. A "before" that fails is never a reason to switch to `not-applicable` (see below).

## One-time setup

Both repos: Node 24+, this repo cloned at `~/playola/playola-skills` (or `UX_EVIDENCE_HOME` set to its `ux-evidence/tool` folder), ffmpeg, `gh` 2.104.0+, then:

```bash
make ux-evidence-setup        # rerun after the tool's packages change
```

- **Web:** Docker running, and the production dump cached (`make db-download-production`).
- **iPhone:** Xcode at `xcodePath` in `qa/ux/config.yaml` with its simulator runtime, Maestro, Java 17, the four `Secrets*.xcconfig` files in the `secretsSource` checkout, and a saved staging session.

### iPhone staging sign-in

A person signs in to the Staging app in a simulator (Apple or Google; an agent cannot do this, so ask the user). With that simulator still booted:

```bash
make ux-evidence-ios-login                 # add DEVICE=<udid> if several booted simulators have the app
```

It saves the session to `~/.config/playola-ux/ios-staging-auth.json` and prints the path, the expiry and `session validated`. **Never read, print, copy, commit or attach that file** — a staging session also works on production. Run the command again when a recording reports the session is missing, rejected, or expires within 30 minutes.

## Recording

1. **Create the case.**

   ```bash
   # web
   make ux-evidence-new CASE=<id> CLASSIFICATION=<visual|functional> BEFORE=<required|not-applicable> START=</path> [REASON="..."]
   # iPhone
   make ux-evidence-new CASE=<id> CLASSIFICATION=<visual|functional> BEFORE=<required|not-applicable> [REASON="..."]
   ```

   Ids are lowercase letters, digits and hyphens. If the iPhone repo's Makefile has no `ux-evidence-new` yet, copy an example case under `qa/ux/` and edit it.

   | File | Platform | Purpose |
   |---|---|---|
   | `evidence.yaml` | both | id (= folder name), classification, `before` policy and reason; web also `startPath` |
   | `flow.ts` | web | `demo({ page, shot })` is recorded, starting logged in at `startPath`; optional `setup({ page })` runs first, unrecorded |
   | `flow.base.ts` | web, optional | runs for the "before" instead of `flow.ts`, only when a control was renamed or navigation changed; same user action |
   | `setup.yaml` | iPhone, optional | Maestro flow, not recorded: reach the starting screen and dismiss first-launch prompts |
   | `flow.yaml` | iPhone | Maestro flow, recorded; the same file runs on both builds (there is no "before" variant) |

   The generated flow fails on purpose until you write it. Screenshots are `shot("<name>")` on web and `takeScreenshot: <name>` on iPhone; before and after must take the same names. Wait on visible content, never fixed sleeps, and never match data that can change (station names).

2. **Commit the change and the case**, then record. A run refuses uncommitted changes to the app code or the case folder. "Before" is the merge base with the local `origin/develop` (the tool does not fetch); "after" is `HEAD`.

   ```bash
   make ux-evidence CASE=<id>
   ```

   Output goes to `.qa-artifacts/<id>/` (git-ignored). Let a run finish; Ctrl-C cleans up but waits for the current step.

3. **Check it is current:** `make ux-evidence-verify` (exit 0 means current; otherwise it names the stale case and why).
4. **After the PR is opened:** `make ux-evidence-publish PR=<number>`. It verifies first, then posts one comment per case.
5. **After every later push:** `make ux-evidence-verify`; if stale, record and publish again. Old comments stay.

## When the "before" fails

A "before" that fails to build or run stops the whole run. The tool never substitutes the "after" for it, and neither may you: do not switch to `not-applicable`, and do not publish evidence without it. Fix the flow so it works on the old UI (on web, add `flow.base.ts` if the old UI differs). An iPhone build failure keeps its log at `.qa-artifacts/<id>/build-before.log`. If the base itself is broken, stop and tell the user.

## `ALLOW_IDENTICAL=1`

A visual case with a "before" fails when every before/after screenshot is pixel-identical: the case does not show the change, or the change has no visible effect. `make ux-evidence CASE=<id> ALLOW_IDENTICAL=1` overrides this and marks the result `identical`.

- **Acceptable:** the repos' example cases (checking setup) and testing the tool.
- **Not acceptable:** any real PR's evidence. Fix the case so it shows the change, or use the waiver line if nothing visible changed.

## Live data limits

- **iPhone** records the Staging app against the staging server, signed in as a real account. Flows must not start playback, must not change server data (follow, like, edit the profile, send anything), must not use source-tape actions (they reach production), and must not show account details (no profile tab, no screen with the account's name or email). Staging data can differ between the two recordings.
- **Web** records against a restored production dump with the real `.env` files: do not write flows around actions that send email, push notifications or upload files.

## Run times

From the repos' READMEs (Apple-silicon Mac):

- Web: about 3½ minutes per case, with the dump cached.
- iPhone: about 9 minutes per case, mostly the two app builds; up to about 13 minutes on a loaded machine. Only one iPhone recording runs at a time per machine.
