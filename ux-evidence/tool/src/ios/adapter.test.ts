import { describe, expect, it, vi } from "vitest";
import { createCleanupRegistry } from "../core/cleanup.ts";
import type { EvidenceManifest, RevisionName } from "../core/domain.ts";
import type { RecordContext } from "../core/platform.ts";
import { IOS_CONFIG } from "../core/test-fixtures.ts";
import { createIOSAdapter, type IOSAdapterDependencies } from "./adapter.ts";
import type { LockFiles } from "./preflight.ts";

const manifest: EvidenceManifest = { version: 1, id: "c", classification: "visual", before: { policy: "required", reason: null } };
const FLOW = "appId: fm.app\n---\n- takeScreenshot: stations-list\n";

function context(overrides: Partial<RecordContext> = {}): RecordContext {
  return {
    repoRoot: "/repo", config: IOS_CONFIG, manifest, commits: { base: "basesha", head: "headsha" },
    caseDirectory: "/repo/qa/ux/c", artifactDirectory: "/repo/.qa-artifacts/c",
    runDirectory: "/home/u/.cache/playola-ux/ios/run-1", cleanup: createCleanupRegistry(),
    ...overrides,
  };
}

function harness(options: { failBuild?: boolean; sessionStatus?: number; missing?: string } = {}) {
  const events: string[] = [];
  let lock: string | undefined;
  const lockFiles: LockFiles = {
    makeDirectory: async () => {},
    createExclusive: async (_path, text) => { if (lock !== undefined) return false; lock = text; return true; },
    readText: async () => lock,
    remove: async () => { events.push("unlock"); lock = undefined; },
  };
  const deps: IOSAdapterDependencies = {
    homeDirectory: "/home/u",
    pid: 42,
    ownProcesses: () => ({ exec: vi.fn(), stopAll: vi.fn(async () => {}) }),
    teardownExec: vi.fn(),
    lockFiles,
    isProcessAlive: () => true,
    session: {
      files: { readTextFile: async () => JSON.stringify({ currentUser: { id: "u" }, jwt: "h.e30.s" }), makePrivateDirectory: vi.fn(), writePrivateFileAtomically: vi.fn() },
      get: async () => ({ status: options.sessionStatus ?? 200 }),
      now: () => new Date("2030-01-01T00:00:00Z"),
    },
    checkTools: async () => ({
      environment: { deviceType: "d", runtime: "r", xcodeVersion: "27.1", apiHost: "https://h" },
      tools: { xcode: "Xcode 27.1" },
    }),
    fileExists: async (path) => !(options.missing !== undefined && path.endsWith(options.missing)),
    readTextFile: async () => FLOW,
    writeTextFile: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
    moveFile: vi.fn(async (_source: string, destination: string) => { events.push(`move ${destination}`); }),
    writeSession: vi.fn(async () => {}),
    screenshotFiles: { listFilesRecursively: async () => [] },
    buildIOSRevisions: vi.fn(async (buildContext: RecordContext) => {
      events.push("build-base", "build-head");
      buildContext.cleanup.add(async () => { events.push("remove-worktrees"); });
      if (options.failBuild) throw new Error("base build failed");
      return new Map<RevisionName, string>([["base", "/dd/base.app"], ["head", "/dd/head.app"]]);
    }),
    withIOSSimulator: vi.fn(async (input: { revision: RevisionName; sessionJson: string }, _deps: unknown, use: (udid: string) => Promise<unknown>) => {
      events.push(`capture-${input.revision}`);
      return use(`udid-${input.revision}`);
    }) as unknown as IOSAdapterDependencies["withIOSSimulator"],
    runMaestro: vi.fn(async () => {}),
    collectScreenshots: vi.fn(async (outputDirectory: string) => new Map([["stations-list", `${outputDirectory}/stations-list.png`]])),
  };
  return { deps, events, adapter: createIOSAdapter(deps), locked: () => lock };
}

describe("createIOSAdapter", () => {
  it("buildBeforeCapture: both revisions are built before either is captured", async () => {
    const { adapter, events } = harness();
    const recordContext = context();
    await adapter.preflight(recordContext);
    const prepared = await adapter.prepare(recordContext);
    const base = await prepared.capture("base");
    const head = await prepared.capture("head");
    await prepared.dispose();
    expect(events.filter((event) => /^(build|capture)-/.test(event)))
      .toEqual(["build-base", "build-head", "capture-base", "capture-head"]);
    expect(base.screenshots).toEqual(new Map([["stations-list", "/repo/.qa-artifacts/c/before-stations-list.png"]]));
    expect(head.screenshots).toEqual(new Map([["stations-list", "/repo/.qa-artifacts/c/after-stations-list.png"]]));
  });

  it("passes the saved session to each simulator and runs the case's own flow", async () => {
    const { adapter, deps } = harness();
    const recordContext = context();
    await adapter.preflight(recordContext);
    const prepared = await adapter.prepare(recordContext);
    await prepared.capture("head");
    expect(deps.withIOSSimulator).toHaveBeenCalledWith(
      expect.objectContaining({ revision: "head", appPath: "/dd/head.app", sessionJson: JSON.stringify({ currentUser: { id: "u" }, jwt: "h.e30.s" }) }),
      expect.anything(), expect.any(Function),
    );
    expect(deps.writeTextFile).toHaveBeenCalledWith(
      "/home/u/.cache/playola-ux/ios/run-1/head/wrapper.yaml",
      expect.stringContaining("runFlow: /repo/qa/ux/c/flow.yaml"),
    );
  });

  it("dispose removes what the run created, then releases the lock", async () => {
    const { adapter, events, locked } = harness();
    const recordContext = context();
    await adapter.preflight(recordContext);
    expect(locked()).toBe("42\n");
    const prepared = await adapter.prepare(recordContext);
    await prepared.dispose();
    expect(events.slice(-2)).toEqual(["remove-worktrees", "unlock"]);
    expect(locked()).toBeUndefined();
  });

  it("a failed build cleans up and releases the lock even though core never gets a run to dispose", async () => {
    const { adapter, events, locked } = harness({ failBuild: true });
    const recordContext = context();
    await adapter.preflight(recordContext);
    await expect(adapter.prepare(recordContext)).rejects.toThrow("base build failed");
    expect(events.slice(-2)).toEqual(["remove-worktrees", "unlock"]);
    expect(locked()).toBeUndefined();
  });

  it("missingSecretStopsBeforeBuild: an absent Secrets-Staging.xcconfig fails preflight before any build", async () => {
    const { adapter, deps, locked } = harness({ missing: "Secrets-Staging.xcconfig" });
    await expect(adapter.preflight(context())).rejects.toThrow("missing Secrets-Staging.xcconfig in /home/u/ios/PlayolaRadio/Config");
    expect(deps.buildIOSRevisions).not.toHaveBeenCalled();
    expect(locked()).toBeUndefined();
  });

  it("a rejected session fails preflight and releases the lock", async () => {
    const { adapter, locked } = harness({ sessionStatus: 401 });
    await expect(adapter.preflight(context())).rejects.toThrow("HTTP 401");
    expect(locked()).toBeUndefined();
  });

  it("an interrupt runs the same teardown through the run's cleanup registry", async () => {
    const { adapter, events, locked } = harness();
    const cleanup = createCleanupRegistry();
    const recordContext = context({ cleanup });
    await adapter.preflight(recordContext);
    await adapter.prepare(recordContext);
    await cleanup.run();
    expect(events.slice(-2)).toEqual(["remove-worktrees", "unlock"]);
    expect(locked()).toBeUndefined();
  });

  it("refuses functional cases and case creation until video support ships", async () => {
    const { adapter, locked } = harness();
    await expect(adapter.preflight(context({ manifest: { ...manifest, classification: "functional" } })))
      .rejects.toThrow("iOS functional (video) cases are not yet supported");
    expect(locked()).toBeUndefined();
    expect(() => adapter.renderCase({ id: "c", classification: "visual", beforePolicy: "required", reason: null }))
      .toThrow("not yet supported");
  });

  it("refuses a flow without screenshots before building anything", async () => {
    const { adapter, deps } = harness();
    deps.readTextFile = async () => "appId: fm.app\n---\n- tapOn: All\n";
    const recordContext = context();
    await adapter.preflight(recordContext);
    await expect(adapter.prepare(recordContext)).rejects.toThrow("must take at least one screenshot");
    expect(deps.buildIOSRevisions).not.toHaveBeenCalled();
  });
});
