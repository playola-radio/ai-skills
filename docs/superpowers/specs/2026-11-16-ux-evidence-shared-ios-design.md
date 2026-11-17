# UX evidence: shared tool and iOS recording (stage 2)

Status: approved by Brian on 2026-11-16.

## Intent

Every PR that changes what a user sees or does should carry proof: before/after
screenshots for purely visual changes, before (when appropriate) and after video
for functional changes. Stage 1 delivered this for the web client inside the
monorepo. Stage 2 delivers the same for the iOS app, and moves the tool to a home
that all three platforms can share. Android is stage 3 and is not designed here.

Brian wants to run an iOS recording on a real change as soon as possible.

## Goals

- One tool, in `playola-skills`, used by the monorepo (web) and the iOS repo.
- iOS recordings of the **staging app talking to the staging server**, signed in
  with a saved session.
- Same case concept, classification rules, freshness check, waiver line, PR
  comment and artifact layout on both platforms.
- As much as possible deterministic script, with a skill telling agents when to
  record and how to write a case.

## Non-goals

- Android.
- Running recordings in CI.
- Adding accessibility identifiers across the iOS app.
- Fixture or mocked data (the existing `SCREENSHOT_PAGE` harness is not used).
- Perceptual image scoring, masking of changing regions.
- A second flow file for the "before" build.
- Adding the evidence step to `pr-gate` or the global agent rules (separate
  decision, still open).

## Anti-goals

- The tool must never touch a simulator, worktree, container or checkout it did
  not create.
- The saved session must never be printed, committed, copied into a repo, or
  attached to a PR.
- A "before" that cannot be built or recorded must never be silently replaced or
  skipped.

## Constraints

- `playola-skills` has only a `main` branch, no CI, and today holds only skill
  folders plus `install.sh` / `uninstall.sh`. `install.sh` symlinks every root
  folder that contains a `SKILL.md` into `~/.claude/skills` and `~/.codex/skills`.
- iOS repo: plain `PlayolaRadio.xcodeproj`; scheme `PlayolaRadio-Staging`, Debug
  configuration, product `PlayolaRadio Staging.app`, bundle id
  `fm.playola.playolaradio.staging`; deployment target iOS 18.1; builds need
  `-skipMacroValidation -skipPackagePluginValidation`; four git-ignored
  `Secrets*.xcconfig` files under `PlayolaRadio/Config/` are required and are
  copied from `~/playola/playola-radio-ios` (see `scripts/setup-secrets.sh`).
- The iOS main checkout is often dirty or conflicted. Builds happen only in clean
  detached worktrees.
- Sign-in is Apple or Google only. The app keeps its session in
  `Documents/auth.json` (`{ currentUser, jwt }`).
- The same token is valid on the staging and production servers. Three
  source-tape calls always go to production (`Config.productionBaseUrl`).
- Machine: Xcode 27.1 at `/Applications/Xcode-27.1.0.app`; Maestro 2.12.1 at
  `~/.maestro/bin/maestro`, which only runs with
  `JAVA_HOME=/opt/homebrew/opt/openjdk@17`; ffmpeg present; other simulators are
  usually booted by unrelated work.
- Node >= 24, TypeScript run with tsx, Vitest, effects injected, pure logic
  unit-tested (the web tool's existing conventions).
- iOS repo rule: PRs target `develop`. No Swift changes are needed for this work.

## Approaches considered (code home)

1. **Keep the tool in the monorepo and point it at the iOS repo.** Least work,
   one copy of the shared logic. Rejected: the iOS repo would depend on a sibling
   checkout of the server repo, on whatever branch it happens to be on, and iOS
   tooling changes would land in the server repo's history.
2. **Copy the tool into the iOS repo.** Fastest first recording. Rejected: two
   copies of the checking and publishing logic, three with Android.
3. **A new dedicated repo.** Clean, but new release and install plumbing.
4. **`playola-skills` (chosen by Brian).** Already the cross-repo home, already
   installed at a known path on every machine that uses these repos, updated by
   `git pull`, and lets a skill sit beside the scripts it drives. Costs: the repo
   gains its first real code package without CI, versions are unpinned, and the
   web tool has to move.

## Design

### Layout in `playola-skills`

```
ux-evidence/
  SKILL.md            when to record, how to classify, how to write a case
  tool/               the Node package (moved from the monorepo's qa/)
    package.json
    src/
      core/           shared: case manifest, git, results, render, media,
                      artifacts, cleanup, verify, publish, new
      web/            Playwright browser, Docker stack, flow loading
      ios/            build, simulator, session, Maestro
                      (tests sit beside the files they test)
```

`.gitignore` gains `node_modules/`. `install.sh` already links `ux-evidence/`
because it contains `SKILL.md`.

### How a repo uses it

Each repo keeps only:

- `qa/ux/config.yaml` — `platform: web | ios`, the base branch, which paths count
  as "UI code changed", which are ignored, and platform settings.
- `qa/ux/<case-id>/` — the cases.
- `make` targets with the same names in every repo: `ux-evidence-setup`,
  `ux-evidence CASE=<id> [ALLOW_IDENTICAL=1]`, `ux-evidence-verify`,
  `ux-evidence-publish PR=<n>`, `ux-evidence-new …`. Each calls the tool at
  `UX_EVIDENCE_HOME` (default `~/playola/playola-skills/ux-evidence/tool`) and
  passes the repo root. A missing tool fails with one line saying how to install.

Output stays `.qa-artifacts/<case-id>/` with the same file names as web.
`result.json` moves to version 2: it gains `platform` and a platform-specific
`environment` block (web: dump identity; iOS: device type, runtime, Xcode
version, API host) and records the tool's git commit. Version 1 results are
treated as stale.

### iOS case

```
qa/ux/<case-id>/
  evidence.yaml   version, id, classification, before.policy (+ reason)
  setup.yaml      optional Maestro flow, not recorded
  flow.yaml       Maestro flow, recorded; the same file runs on both builds
```

No `startPath` on iOS: navigation to the starting screen is `setup.yaml`.
Screenshots are Maestro `takeScreenshot` steps with unique lowercase-hyphen
names; before and after must produce the same set of names. A visual case needs
at least one. Flows select by visible text and wait with assertions
(`extendedWaitUntil`), never fixed sleeps.

### iOS `record`

1. **Pre-flight (seconds):** Node version, Xcode at the pinned path, Maestro and
   Java, ffmpeg, pinned device type and runtime installed, secrets present in the
   source checkout, saved session present, unexpired (30 min margin) and accepted
   by staging (`GET /v1/users/me/client-config`). Uncommitted changes to relevant
   paths or the case folder in the invoking checkout stop the run.
2. **Worktrees:** detached worktrees for the merge base with `origin/develop`
   and for HEAD under `~/.cache/playola-ux/ios/<run-id>/`. Copy the four secrets
   files into each without logging contents. Case files always come from HEAD.
3. **Build both first**, base then head, so the two recordings happen close
   together:
   `xcodebuild -project PlayolaRadio.xcodeproj -scheme PlayolaRadio-Staging
   -configuration Debug -sdk iphonesimulator
   -destination 'generic/platform=iOS Simulator' -derivedDataPath <per-revision>
   -clonedSourcePackagesDirPath ~/.cache/playola-ux/ios/spm
   -skipMacroValidation -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build`
   with `DEVELOPER_DIR` pinned. A failed base build stops the run and keeps the
   log; it is never replaced by head. With `before.policy: not-applicable` the
   base is not built.
4. **Per revision, a fresh simulator:** create (iPhone 17 Pro, iOS 27.1 —
   set in `config.yaml`), boot, light appearance, status bar 9:41 / full battery,
   install, write the saved session to the app's `Documents/auth.json`, then a
   generated Maestro wrapper launches the app without clearing state and with
   permissions denied, and runs `setup.yaml`. Every `simctl` and Maestro command
   names the device id; `booted` is never used.
5. **Capture:** run `flow.yaml`. Functional cases wrap it in
   `simctl io <udid> recordVideo --codec=h264`, stopped with SIGINT and awaited.
   Video is re-encoded to H.264 / yuv420p / no audio / faststart under
   10,485,760 bytes, as on web.
6. **Teardown:** terminate the app, shut down and delete the simulator, remove
   worktrees. Registered as soon as each resource exists; runs on failure and on
   interrupt with the same 10-second rule and exit codes as web.
7. **Assemble:** comparison images, identical-screenshot gate, `result.json`,
   `comment.md` — shared code.

### Identical-screenshot gate

Shared by both platforms, and changed to compare decoded pixels rather than file
bytes. `ALLOW_IDENTICAL=1` keeps its meaning.

### Saved session

`make ux-evidence-ios-login` in the iOS repo:

1. Brian signs in by hand in a simulator running the staging app.
2. The command finds the booted simulator that has the staging app installed
   (or takes `DEVICE=<udid>` when more than one does), reads `auth.json`,
   checks it has a user and token, checks expiry, and checks staging accepts it.
3. Saves it to `~/.config/playola-ux/ios-staging-auth.json` (directory 0700,
   file 0600). Prints only the path, the expiry date and "session validated".

Switching to a non-admin account later is running this again.

### `verify` on iOS

Counts as UI code: everything under `PlayolaRadio/` and
`PlayolaRadio.xcodeproj/` except tests. Ignored: `*Tests.swift`,
`PlayolaRadioTests/`, Markdown, `docs/`, `design/`, `fastlane/`. Listed in the
iOS repo's `qa/ux/config.yaml`, not hard-coded. All other verify, waiver
(`UX evidence: none — <reason>`) and publish behaviour is the shared code,
unchanged.

### Limits of the first version

- Cases that start playback are out: audio would play through the Mac's speakers.
- Cases that change server data need their own reset in `setup.yaml`.
- Source-tape actions are out (they hit production).
- Live data can differ between the two recordings; mitigated only by recording
  back to back with one stable account.

## Delivery order

Each step is its own PR (or pair of PRs) and leaves everything working.

1. **Move.** Tool moves to `playola-skills/ux-evidence/tool` unchanged in
   behaviour; monorepo keeps cases, gains `qa/ux/config.yaml`, re-points its
   `make` targets, deletes `qa/src`. Proof: full test suite passes in the new
   home and `example-stations` records from the monorepo.
2. **Split.** `core/` and `web/` separation, platform chosen from `config.yaml`,
   `result.json` v2, pixel-based identical gate. Proof: same as step 1.
3. **iOS screenshots.** Session capture, pre-flight, build, simulator, Maestro,
   one example case (stations list) in the iOS repo with `make` targets, config
   and a `## UX evidence` section in its `CLAUDE.md` / `AGENTS.md`. Proof: a
   real before/after published to a real iOS PR.
4. **iOS video.** Functional cases. Proof: one published video case.
5. **Skill.** `ux-evidence/SKILL.md` and README row.

Brian can run a live iOS recording after step 3.

## Clarifications (from the builder check; Claude's calls)

- **Step 1 is a plain relocation.** `src/` stays flat and `package.json`,
  `package-lock.json`, `tsconfig.json` and the Vitest config move with it. The
  `core/` / `web/` / `ios/` layout arrives in step 2. `ux-evidence-setup` in each
  repo runs `npm ci` in the tool folder (plus the Playwright browser install on
  web).
- **Web flow types in step 1:** the tool must keep the two existing flows
  loading in step 1; a stopgap is acceptable there and the lasting answer is the
  builder's.
- **Session expiry:** if the token has an `exp` claim, require 30 minutes
  remaining; if it has none, the staging check alone decides.
- **The saved session is read-only input.** Each run copies it into the fresh
  simulator; nothing the app writes there is copied back. The app does not
  refresh its own token outside sign-in and profile edit.
- **Hosts live in the iOS repo's `qa/ux/config.yaml`** (`apiHost`, initially
  `https://admin-api-staging.playola.fm`, matching `Config.swift`), along with
  scheme, configuration, product name, bundle id, device type and runtime. The
  runtime is pinned by identifier
  (`com.apple.CoreSimulator.SimRuntime.iOS-27-1`).
- **Base branch** comes from `config.yaml`. As on web, the tool does not fetch;
  it uses the local `origin/<base>`.
- **Two path lists in `config.yaml`, shared by pre-flight and `verify`.**
  `relevant`: a change makes existing evidence stale, and blocks recording when
  uncommitted. `requiresEvidence`: a change with no case fails `verify` unless
  waived. On web these differ (`client/**` + `server/**` versus `client/**`),
  which keeps today's behaviour; on iOS they are the same. `ignored` applies to
  both. All are globs (`**/*Tests.swift`).
- **`flow.yaml` starts with the app already open** in the state `setup.yaml`
  left it; it does not relaunch. Video recording starts after setup finishes and
  stops when `flow.yaml` ends.
- **Pixel comparison** decodes with ffmpeg (already required); no new
  dependency. The whole image is compared, status bar included.

## Left to the builder

- How web `flow.ts` files get their types now that the tool is in another repo
  (they currently import `../../src/flow-api.ts`). Constraint: no per-repo
  `npm install` beyond the tool's own.
- Exact module boundaries inside `core/`.
- Whether SPM package cache sharing between the two builds needs serialising.
- Seeding app preferences (for example the "already asked for notifications"
  flag) if Maestro's permission denial is not enough.
- Trimming Maestro start-up time from the start of videos.

## Calls made by Claude (not decided by Brian)

- Folder name `ux-evidence/` with the tool under `tool/`.
- Per-repo `qa/ux/config.yaml`.
- `result.json` version 2; old web results become stale and get re-recorded.
- Device pin iPhone 17 Pro on iOS 27.1.
- Session file path `~/.config/playola-ux/ios-staging-auth.json`.
- No `flow.base.yaml`; the gate compares pixels.
- PRs in `playola-skills` target `main`, because it has no `develop`.
- Tool tests in `playola-skills` run locally only; no CI is added.
- Design deliverables (`screens.md`, `endpoints.md`, `models.md`): none — this
  is developer tooling and changes no screen, endpoint or model.

## Unmeasured

- Run time. Codex's estimate is 10–25 minutes for a first run (two full Xcode
  builds); to be measured in step 3.
- Whether Maestro's permission denial suppresses every first-launch prompt.
