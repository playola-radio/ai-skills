# Shared UX evidence tool and iOS recording — implementation plan

**Spec:** `docs/superpowers/specs/2026-11-16-ux-evidence-shared-ios-design.md` (binding).

**How this is executed:** five hand-offs, each to a fresh context, in this order.
A hand-off that spans two repos opens two PRs.

| Hand-off | PRs | Proves |
|---|---|---|
| 1 | A (this repo) + B (monorepo) | web recording works from the new home |
| 2 | C (this repo) | web still works after the shared/web split |
| 3 | D (this repo) + E (iOS repo) | a real before/after screenshot on a real iOS PR |
| 4 | F (this repo) | a real before/after video on an iOS PR |
| 5 | G (this repo) | the skill text matches the tool |

While A is unmerged, B is developed and proven with `UX_EVIDENCE_HOME` pointing
at A's worktree; the same applies to E against D. Merge order stays A, B, C, D,
E, F, G.

## Amendments to the PR sections below (these win where they differ)

1. **Two path lists, not one, so web behaviour does not change.** `config.yaml`
   has `relevant` (a change here makes existing evidence stale, and blocks
   recording when uncommitted) and `requiresEvidence` (a change here with no
   case fails `verify` unless the PR body carries the waiver line). Web:
   `relevant: ["client/**", "server/**"]`, `requiresEvidence: ["client/**"]`.
   iOS: both lists are `["PlayolaRadio/**", "PlayolaRadio.xcodeproj/**"]`.
   `ignored` applies to both. Wherever a section below says "one-list policy" or
   that server-only changes need a waiver, this replaces it; the test
   `onePathPolicy` becomes: `server/src/a.ts` is relevant but does not require
   evidence; `client/src/a.tsx` does both; `client/a.test.ts` does neither.
2. **Review focus item 5 is dropped** (no test that changes the tool's commit
   mid-run). `toolCommit` is recorded once at the start of a run.
3. **Review focus item 3 is reduced** to: recording takes an exclusive lock file
   under `~/.cache/playola-ux/ios/` and a second concurrent iOS recording fails
   at once with a one-line message. No two-process test harness.
4. **Video boundaries in F are the worker's call.** The localhost-callback
   approach below is one option; running `setup.yaml` and `flow.yaml` as two
   Maestro invocations with the recorder started between them, then trimming the
   measured Maestro start-up, is the simpler one. Pick whichever gives a video
   that starts within a second of the first action, and say which in the PR.
5. **D's native proof uses E's branch** (same hand-off). D's PR body must say the
   mocked tests do not prove native capture and link E's published evidence.

---


The approved design is binding despite its “draft” header. This plan makes no product changes and requires no Swift changes.

Keep A–G: they separate relocation, consumer migration, shared behavior, native capture, repo adoption, video and documentation into reviewable changes.

```text
A ──► B ──► C ──► D ──► E
      ▲     ▲           └──► F ──► G
      └─────┘
```

**Development:** B and C can overlap after A; E and F can overlap after D.  
**Merge:** A, B, C, D, E, F, G. C waits for B’s config migration; F’s real acceptance uses E’s integration.

All commands below are instructions for implementers, not commands executed during this consult. Each engineer reads the design and this entire plan. Shared interfaces are defined once under **Cross-PR contracts**.

## A. Relocate without restructuring

**Title:** `chore: share the existing proof-recording tool`  
**Repo/base:** `playola-radio/ai-skills`, `main`  
**Branch:** `chore/share-ux-evidence-tool`  
**Depends on:** none  
**Goal:** Run the existing web tool against an explicitly selected repository.

**Scope:** relocation, repository selection, portable flow-type entry point. No config-driven behavior, schema changes or iOS.

**Files:**

- Copy from monorepo `origin/develop`, using `git show`, all tracked `qa/src/**` into `ux-evidence/tool/src/**`, preserving flat layout and colocated tests.
- Copy `qa/{package.json,package-lock.json,tsconfig.json,vitest.config.ts}` into `ux-evidence/tool/`.
- Modify destination `src/{main,cli}.ts`, `src/commands/new.ts` and corresponding tests.
- Create `ux-evidence/SKILL.md`: valid frontmatter, a short “web tooling relocation; platform instructions follow” placeholder linking the design.
- Modify root `.gitignore`: add `node_modules/`.
- Do not change `install.sh`: its existing root-folder/SKILL.md discovery already handles this folder.

**Interfaces:** produce repository-selection CLI and stable type path defined below. Change:

```ts
wireCommands(repoRoot: string): CliCommands;
parseInvocation(
  argv: readonly string[],
  cwd: string
): { repoRoot: string; args: string[] };
```

`main.ts` resolves repository selection before wiring commands. Every Git/gh invocation and artifact path uses that root; tool dependency lookup still uses the tool directory.

Change the web `new` template to the portable type import contract. Existing imports remain runtime-compatible because they are type-only.

**Tests:**

- `repoFlagRoutesOutsideTool`: `--repo "/tmp/app repo" verify` operates on `/tmp/app repo`.
- `shortRepoFlagMatchesLong`: `-C /tmp/app` yields the same root.
- `missingRepoUsesCwd`: `/tmp/app` remains the default, never the tool parent.
- `conflictingRepoFlagsFail`: different `--repo` and `-C` values produce usage exit.
- `newFlowUsesPortableTypeImport`: exact import matches the contract.

**Regression:** all copied Vitest suites and `tsc`; no application suites.

**Manual proof:**

```sh
npm --prefix ux-evidence/tool ci
npm --prefix ux-evidence/tool test
npm --prefix ux-evidence/tool run typecheck
npm --prefix ux-evidence/tool run --silent ux-evidence -- \
  --repo ~/playola/playola record --case example-stations --allow-identical
```

Success: web artifacts appear only in the monorepo.

**Tier:** mechanical; watch tool-root versus target-root resolution.

## B. Migrate the web consumer

**Title:** `chore: use the shared tool for web change recordings`  
**Repo/base:** `playola`, `develop`  
**Branch:** `chore/use-shared-ux-evidence`  
**Depends on:** A  
**Goal:** Remove the duplicated package without breaking existing Make commands.

**Files:**

- Create `qa/ux/config.yaml` using the web contract.
- Modify `Makefile`, `.gitignore`, `qa/ux/README.md`, root `CLAUDE.md`, root `AGENTS.md`.
- Modify `qa/ux/example-stations/flow.ts` and `qa/ux/example-station-navigation/flow.ts`.
- Delete `qa/src/**`, `qa/package.json`, `qa/package-lock.json`, `qa/tsconfig.json`, `qa/vitest.config.ts`.
- Preserve both case manifests and `scripts/qa.sh`.

**Interfaces:** consume A’s CLI; produce config for C. Setup installs dependencies/browser in the shared tool and creates the ignored type-link described below. All five existing Make targets retain their names.

Update docs for external installation/types. Explain C’s upcoming one-list policy: both `client/**` and `server/**` count; server-only invisible changes use the waiver.

**Changelog:** none required: developer tooling only, no user-facing or deployment impact. State this in the PR body, as permitted by `changelog.d/README.md`.

**Checks:**

- `missingToolExplainsInstallation`: nonexistent home prints the prescribed diagnostic.
- `quotedHomeAndRepo`: Make dry-run preserves paths containing spaces.
- `flowTypesResolveAfterSetup`: both flows resolve `DemoContext` without repo-local npm installation.
- `oldPackageGone`: no tracked `qa/src/` or package/config files remain.

These can be shell/manual checks; do not introduce a second testing package.

**Regression:** complete shared-tool suite and typecheck; existing web visual and functional example recordings. No client/server production code changed.

**Manual proof:**

```sh
make ux-evidence-setup
make ux-evidence CASE=example-stations ALLOW_IDENTICAL=1
make ux-evidence CASE=example-station-navigation
```

Success: comparison PNG and both navigation videos are generated using A’s tool.

**Tier:** mechanical; protect unrelated Make targets and mirror both repo instruction sections.

## C. Separate shared behavior from web capture

**Title:** `chore: support separate settings for web and phone recordings`  
**Repo/base:** `ai-skills`, `main`  
**Branch:** `chore/platform-ux-evidence`  
**Depends on:** A; merge after B  
**Goal:** Establish the platform contract while preserving web recording.

**Files under `ux-evidence/tool/`:**

- Move into `src/core/`: `artifacts`, `case-id`, `cleanup`, `domain`, `effects`, `freshness`, `git`, `manifest`, `media`, `node-version`, `render`, `results`, and `commands/{new,publish,record,verify}`; move matching tests alongside.
- Move into `src/web/`: `browser`, `flows`, `ports`, `stack`, `tools`, `flow-api`; move matching tests.
- Create `src/core/{config,platform}.ts`, `src/web/adapter.ts`, and their tests.
- Keep `src/{main,cli}.ts`; retain `src/flow-api.ts` as a type-only re-export.
- Modify `package.json`, lockfile only if necessary, and `tsconfig.json`.
- Keep colocated tests; no gratuitous conversion to `test/`.

Split dump resolution from `core/git.ts` into `web/tools.ts`. Replace web-specific record dependencies with the adapter contract. Lazy-load platform tooling: verify/publish must not probe Docker, Xcode or saved sessions.

**Exports:**

```ts
parseConfigYaml(text: string): EvidenceConfig;
loadConfig(repoRoot: string): Promise<EvidenceConfig>;
isRelevantPath(path: string, config: EvidenceConfig): boolean;
pixelsIdentical(left: string, right: string, exec: Exec): Promise<boolean>;
```

Produce the complete config, adapter and result contracts below. Decode images through ffmpeg to canonical RGBA; compare dimensions and pixels. Do not compare PNG bytes.

**Tests:**

- `configSelectsWeb`: complete web fixture parses.
- `iosNeedsNativeSettings`: absent `ios.bundleId` fails.
- `onePathPolicy`: `server/src/a.ts` relevant; `client/a.test.ts` ignored.
- `configChangeInvalidates`: changed `qa/ux/config.yaml` makes evidence stale.
- `v1IsStale`: version `1` reports re-record, without crashing.
- `differentEncodingSamePixels`: differently encoded 2×2 red PNGs compare equal.
- `onePixelChanged`: one blue pixel compares unequal.
- `wrongDimensionsDiffer`: 1×4 and 2×2 images differ.
- `adapterLifecycle`: preflight → prepare → base → head → dispose.
- `failedBaseStopsHead`: base rejection never invokes head.
- `verifyNeedsNoCaptureTools`: absent Docker/Xcode does not prevent verification.

**Regression:** entire package suite/typecheck, especially all existing browser, stack, cleanup, record, verify, publish, manifest, results and render tests.

**Manual proof:** rerun B’s three commands; `result.json.version` is `2`, web metadata survives, old v1 evidence is stale.

**Tier:** needs judgment; preserve web lifecycle, type imports, artifact checks and waiver semantics.

## D. Implement iOS visual capture

**Title:** `feature: record before and after iPhone screenshots`  
**Repo/base:** `ai-skills`, `main`  
**Branch:** `feature/ios-ux-screenshots`  
**Depends on:** C  
**Goal:** Complete the native visual pipeline before adding video.

**Create under `ux-evidence/tool/src/ios/`:**

`adapter.ts`, `session.ts`, `preflight.ts`, `build.ts`, `simulator.ts`, `maestro.ts`, and matching `.test.ts` files.

**Modify:** `src/{cli,main}.ts`, `src/core/effects.ts`, corresponding tests. Add cancellable owned-child handling; retain existing `Exec` compatibility. Functional iOS recording and iOS `new` fail explicitly until F.

**Module APIs, in addition to the adapter:**

```ts
parseSession(json: string, now: Date): {
  json: string; jwt: string; expiresAt: Date | null
};
captureSession(
  config: IOSConfig, device: string | undefined
): Promise<{ path: string; expiresAt: Date | null }>;

buildIOSRevisions(context: RecordContext):
  Promise<ReadonlyMap<RevisionName, string>>; // revision → .app path

withIOSSimulator<T>(
  context: RecordContext, appPath: string,
  use: (udid: string) => Promise<T>
): Promise<T>;

renderMaestroWrapper(
  bundleId: string, setupPath: string | undefined, flowPath: string
): string;
collectScreenshots(
  outputDirectory: string, expectedNames: readonly string[]
): Promise<ReadonlyMap<string, string>>;
```

Factories/internal dependency parameters inject filesystem, subprocess, HTTP and clock effects; never put tokens into command arguments.

Build both revisions before capture. Copy the four secret filenames listed in `scripts/setup-secrets.sh`; missing files fail rather than inheriting its “SKIP” behavior. Use the design’s exact xcodebuild arguments, per-revision DerivedData, shared SPM directory and an exclusive run lock.

Create fresh named devices, register cleanup immediately, boot/wait, configure appearance/status bar, install, locate data container and inject auth. Generated wrapper launches with `clearState: false`, permissions denied, then setup and flow. No simulator mutations during login capture.

Collect only declared screenshots from an isolated Maestro output directory; reject duplicate, missing or extra named captures. Maestro supports a dedicated test-output directory; verify the pinned version’s layout with a real run. [Artifact documentation](https://docs.maestro.dev/maestro-flows/workspace-management/test-reports-and-artifacts)

**Tests:**

- `expiryBoundary`: with time `2030-01-01T00:00:00Z`, expiry `00:30:00Z` passes; `00:29:59Z` fails.
- `missingExpUsesServer`: absent `exp` requires successful staging validation.
- `unauthorizedWritesNothing`: HTTP 401 writes no session.
- `ambiguousLoginDevice`: two qualifying devices require `--device`.
- `sessionPermissions`: directory `0700`, file `0600`; logs contain no sentinel token.
- `buildBeforeCapture`: event order `build-base, build-head, capture-base, capture-head`.
- `missingSecretStopsBeforeBuild`: absent `Secrets-Staging.xcconfig` invokes no xcodebuild.
- `ownedDevicesOnly`: unrelated UDID `OTHER` never appears in mutating commands.
- `wrapperPreservesSession`: launch does not clear state or use `SCREENSHOT_PAGE`.
- `duplicateShotRejected`: two `stations-list` commands fail.
- `interruptStopsChildrenBeforeRemoval`: cleanup cannot race a still-running build.

**Regression:** whole shared package suite/typecheck.

**Manual proof:** using E’s prepared branch, run its login and visual commands below. This is cross-PR acceptance; do not claim D’s mocks prove native capture.

**Tier:** needs judgment; ownership, authentication secrecy, cancellation and first-launch behavior.

## E. Adopt iOS recording

**Title:** `chore: add screenshot proof commands to the iPhone app`  
**Repo/base:** `playola-radio-ios`, `develop`  
**Branch:** `chore/ios-ux-evidence`  
**Depends on:** D  
**Goal:** Give the owner one runnable real case.

**Create:** `qa/ux/config.yaml`, `qa/ux/README.md`, `qa/ux/example-stations/{evidence.yaml,setup.yaml,flow.yaml}`.

**Modify:** `Makefile`, `.gitignore`, root `CLAUDE.md`, root `AGENTS.md`. No Swift, secrets or project-file edits. Start from a clean worktree: the inspected main checkout has a conflicted `project.pbxproj`.

**Case:** visual, before required. Setup taps `Radio Stations`; flow waits for `All`, `Search stations`, and `Don't see your artist? Suggest a station`, then captures `stations-list`.

These strings come from `MainContainerModel.swift`, `StationListModel.swift` and their views. The suggestion row appears inside a nonempty artist section, making it stronger readiness evidence than the page title alone. Do not tap a station.

**Checks:**

- `iosConfigParses`: C’s parser accepts the committed config.
- `exampleHasNoStartPath`: manifest omits the web field.
- `exampleUsesVisibleText`: exact selectors above; no playback or fixed sleeps.
- `makeLoginPassesDevice`: `DEVICE=ABC` becomes `--device ABC`.

**Regression:** shared package tests/typecheck; `make lint` and `make format-check`. No Swift test suite is affected.

**Manual proof:**

```sh
make ux-evidence-setup
make ux-evidence-ios-login DEVICE=<signed-in-udid>
make ux-evidence CASE=example-stations ALLOW_IDENTICAL=1
make ux-evidence-verify
make ux-evidence-publish PR=<this-ios-pr>
```

Success: before/after comparison attached to the actual PR; no unrelated simulator changes. Record measured duration in README. `ALLOW_IDENTICAL` is permitted here only because this is a tooling example.

**Tier:** needs judgment; validate accessibility text and real loaded content.

## F. Add iOS video and case creation

**Title:** `feature: record iPhone interactions as videos`  
**Repo/base:** `ai-skills`, `main`  
**Branch:** `feature/ios-ux-video`  
**Depends on:** D; acceptance after E  
**Goal:** Support functional cases without recording setup.

**Create:** `src/ios/{video,templates}.ts` and matching tests under the tool.

**Modify:** `src/ios/{adapter,maestro}.ts`, `src/core/media.ts`, `src/core/commands/new.ts`, `src/cli.ts`, matching tests.

```ts
recordIOSVideo(
  udid: string, rawPath: string,
  runFlow: () => Promise<void>
): Promise<{ path: string; trimStartSeconds: number; durationSeconds: number }>;

renderIOSCase(input: Omit<NewCaseInput, "startPath">):
  ReadonlyMap<string, string>; // relative filename → contents
```

Generate begin/end scripts around the recorded flow. Use localhost callbacks on an ephemeral port to synchronize recorder readiness and flow boundaries, rather than parsing human CLI output. Start after setup, await recorder readiness before acknowledging begin, SIGINT/await at end, trim to measured boundaries. This uses Maestro’s supported script HTTP client. [HTTP scripting](https://docs.maestro.dev/maestro-flows/javascript/make-http-requests)

Templates intentionally fail a named “write your flow” assertion until edited; visual includes a named shot, functional does not require one. No iOS base variant.

**Tests:**

- `setupOutsideVideo`: recorder starts only after setup.
- `beginWaitsForRecorder`: no demo action precedes readiness.
- `trimMeasuredWindow`: recorder-ready `1000ms`, begin `1250ms`, end `3250ms` yields start `0.25`, duration `2`.
- `stopAwaitsFinalization`: encoding starts after recorder exit.
- `failedFlowPublishesNothing`: failure still stops recording.
- `attachmentBoundary`: `10_485_760` bytes passes; `10_485_761` fails.
- `iosTemplateOmitsWebFields`: no `startPath`, `flow.ts` or base override.

**Regression:** entire package, including existing web functional capture/media tests.

**Manual proof:** in a disposable iOS feature branch, create `example-navigation` with `make ux-evidence-new CASE=example-navigation CLASSIFICATION=functional BEFORE=required`; fill a non-playback tab-navigation flow, commit, record, verify and publish to that branch’s PR. Both videos must play inline and exclude setup.

**Tier:** needs judgment; capture timing and subprocess finalization.

## G. Publish agent guidance

**Title:** `chore: document how to record proof of visible changes`  
**Repo/base:** `ai-skills`, `main`  
**Branch:** `chore/ux-evidence-guide`  
**Depends on:** F  
**Goal:** Replace the placeholder with accurate platform instructions.

**Modify:** `ux-evidence/SKILL.md`, root `README.md`.

Document classification, per-platform cases, setup/login, recording, freshness, publication, waiver, failed-base policy, identical override restrictions and live-data limitations. Do not modify global rules or `pr-gate`.

**Checks:** `documentedCommandsExist`, `noIOSBaseVariant`, `noPlaybackExamples`, `readmeLinksExistingSkill`—manual documentation checks against actual CLI/config.

**Regression:** package tests/typecheck once; no new documentation test framework.

**Manual proof:** `test -f ux-evidence/SKILL.md`; check every documented command with CLI usage or Make dry-run. Installation discovery needs no script change.

**Tier:** mechanical; avoid claiming unsupported platform behavior.

## Cross-PR contracts

### Configuration

`qa/ux/config.yaml`, version `1`; reject unknown keys. Paths are repository-relative POSIX globs; ignored wins. Use Node 24 `path.posix.matchesGlob`, including dotfiles. Relevant paths govern both dirty checks and freshness. The selected case folder and config file are additionally relevant.

Web:

```yaml
version: 1
platform: web
baseBranch: develop
relevant: ["client/**", "server/**"]
ignored: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/*.md"]
web:
  viewport: {width: 1440, height: 900}
  locale: en-US
  timezoneId: America/Chicago
```

iOS:

```yaml
version: 1
platform: ios
baseBranch: develop
relevant: ["PlayolaRadio/**", "PlayolaRadio.xcodeproj/**"]
ignored: ["**/*Tests.swift", "PlayolaRadioTests/**", "**/*.md",
          "docs/**", "design/**", "fastlane/**"]
ios:
  project: PlayolaRadio.xcodeproj
  scheme: PlayolaRadio-Staging
  configuration: Debug
  productName: PlayolaRadio Staging.app
  bundleId: fm.playola.playolaradio.staging
  apiHost: https://admin-api-staging.playola.fm
  deviceType: com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro
  runtime: com.apple.CoreSimulator.SimRuntime.iOS-27-1
  xcodePath: /Applications/Xcode-27.1.0.app
  maestroPath: ~/.maestro/bin/maestro
  javaHome: /opt/homebrew/opt/openjdk@17
  secretsSource: ~/playola/playola-radio-ios
```

`EvidenceConfig` is this discriminated union; `IOSConfig` is its `ios` member. Expand `~/` explicitly, never through a shell. No fetch: resolve `origin/<baseBranch>` locally.

### CLI, Make and types

Global `--repo <path>` / `-C <path>` precedes the command; omitted means invocation cwd.

Commands: `record --case ID [--allow-identical]`, `verify`, `publish --pr NUMBER`, `new --case ID --classification visual|functional --before required|not-applicable [--reason TEXT] [--start-path PATH]`, `ios-login [--device UDID]`. Start path is required only for web.

Make variables: `UX_EVIDENCE_HOME`, `CASE`, `PR`, `CLASSIFICATION`, `BEFORE`, `REASON`, `START`, `DEVICE`, `ALLOW_IDENTICAL`. Default tool home is `$(HOME)/playola/playola-skills/ux-evidence/tool`; only value `1` enables the override.

Invocation:

```sh
npm --prefix "$UX_EVIDENCE_HOME" run --silent ux-evidence -- \
  --repo "$REPO_ROOT" <command>
```

Missing-tool diagnostic: `UX evidence tool missing; clone playola-radio/ai-skills to ~/playola/playola-skills or set UX_EVIDENCE_HOME.` Make may additionally emit its normal failure footer.

Web setup creates ignored `qa/ux/.tool` → absolute tool directory, refusing an existing non-symlink. Flows import:

```ts
import type { DemoContext } from "../.tool/src/flow-api.ts";
```

Keep that public shim through C. No consumer npm package.

Use configured Java home only in Maestro child environments; preserve other inherited variables. Pin `DEVELOPER_DIR` from `xcodePath`. Retain web `CENTRAL_DB_CACHE` behavior.

### Adapter

```ts
type RevisionName = "base" | "head";
type Classification = "visual" | "functional";

interface RecordContext {
  repoRoot: string;
  config: EvidenceConfig;
  manifest: EvidenceManifest;
  commits: {base: string; head: string};
  caseDirectory: string; // HEAD case
  artifactDirectory: string;
  runDirectory: string;
  cleanup: CleanupRegistry;
}
interface Capture {
  screenshots: ReadonlyMap<string, string>;
  videoPath?: string;
  warnings: readonly string[];
}
interface PreparedRun {
  capture(revision: RevisionName): Promise<Capture>;
  dispose(): Promise<void>;
}
interface PlatformAdapter {
  preflight(context: RecordContext):
    Promise<{environment: EvidenceEnvironment; tools: Record<string, string>}>;
  prepare(context: RecordContext): Promise<PreparedRun>;
  renderCase(input: NewCaseInput): ReadonlyMap<string, string>;
}
```

`EvidenceManifest` retains existing common fields; web requires `startPath`, iOS forbids it. `NewCaseInput.startPath` becomes optional with platform validation.

Core invokes preflight, prepare, sequential captures, disposal in `finally`, then assembly. iOS preparation builds all applicable revisions; web capture retains per-revision stack isolation. Disposal is idempotent.

### Results and artifacts

Version 2 retains `caseId`, `classification`, `baseCommit`, `headCommit`, `revisions`, `artifacts`, `tools`, `capturedAt`, optional `identical: true`; adds `toolCommit` and this discriminated pair:

```ts
type EvidenceEnvironment =
  | {dump: {path: string; modifiedAt: string; sizeBytes: number}}
  | {deviceType: string; runtime: string; xcodeVersion: string; apiHost: string};

// Result alternatives:
// platform: "web"; environment: {dump: ...}
// platform: "ios"; environment: {deviceType, runtime, xcodeVersion, apiHost}
```

Keep existing artifact/revision record fields unchanged. Tool commit is informational provenance, not automatic invalidation on every skill-repo update. Version 1 is stale.

Names remain `.qa-artifacts/<case>/{before,after}.mp4`, `before-<shot>.png`, `after-<shot>.png`, `compare-<shot>.png`, `result.json`, `comment.md`. Only finalized success writes publishable results. Checksums remain SHA-256.

Exit codes: success `0`, operational/stale `1`, usage `2`, SIGINT `130`, SIGTERM `143`, SIGHUP `129`; Make normally reports failure as `2`. Preserve ten-second interruption settlement.

### Session and ownership

Session path: `~/.config/playola-ux/ios-staging-auth.json`; parent `0700`, file `0600`, atomic replacement. Validate user/token shape, optional finite JWT expiry with ≥1800 seconds remaining, and authenticated staging GET `/v1/users/me/client-config` using a Bearer header. Reject redirects/non-success; never log token or response body. Missing expiry prints `expiry: not supplied`.

Login reads only a uniquely selected booted simulator’s container. Recording copies session directly into newly created simulator data, never a repository; no copy-back.

## Review focus

These remain real-environment gaps beyond mocked tests:

1. **Maestro version-specific permission behavior:** D adds an opt-in native smoke test proving auth survives launch and prompts are dismissed.
2. **SwiftUI accessibility merges/duplicate labels:** E adds a recorded case run proving selectors reach a populated list.
3. **SPM cache contention across separate invocations:** D adds a two-process lock test proving the second run cannot mutate the shared cache concurrently.
4. **Video timestamps versus actual first frame:** F adds a native known-transition capture, checking trimming does not remove the first action.
5. **Shared-tool updates during a recording:** C adds an integration test changing tool HEAD mid-run; fail before publication if provenance changed.
