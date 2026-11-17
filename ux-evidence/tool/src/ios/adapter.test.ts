import { describe, expect, it, vi } from "vitest";
import { createCleanupRegistry } from "../core/cleanup.ts";
import type { EvidenceManifest, RevisionName } from "../core/domain.ts";
import type { RecordContext } from "../core/platform.ts";
import { IOS_CONFIG } from "../core/test-fixtures.ts";
import type { FlowMarks } from "./video.ts";
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
  const entries = new Set<string>();
  const lockFiles: LockFiles = {
    makeDirectory: async () => {},
    writeFile: async (path) => { entries.add(path.split("/").at(-1)!); },
    list: async () => [...entries],
    remove: async (path) => { events.push("unlock"); entries.delete(path.split("/").at(-1)!); },
  };
  const deps: IOSAdapterDependencies = {
    homeDirectory: "/home/u",
    pid: 42,
    ownProcesses: () => ({ exec: vi.fn(), start: vi.fn(), stopAll: vi.fn(async () => {}) }),
    teardownExec: vi.fn(),
    stopTeardownChildren: vi.fn(async () => {}),
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
    recordIOSVideo: vi.fn(async (input: { rawPath: string }, runFlow: (marks: FlowMarks) => Promise<void>) => {
      events.push("recorder-ready");
      await runFlow({ begin: async () => {}, end: () => undefined });
      events.push("recorder-stopped");
      return { path: input.rawPath, trim: { startSeconds: 0.25, durationSeconds: 2 } };
    }) as unknown as IOSAdapterDependencies["recordIOSVideo"],
    serveFlowMarks: vi.fn(async () => ({
      beginUrl: "http://127.0.0.1:1/t/begin",
      endUrl: "http://127.0.0.1:1/t/end",
      close: async () => { events.push("marks-closed"); },
    })),
    now: () => 0,
  };
  return { deps, events, adapter: createIOSAdapter(deps), locked: () => [...entries].join(",") || undefined };
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

  it("keeps the lock after dispose until run-level cleanup finishes", async () => {
    const { adapter, events, locked } = harness();
    const cleanup = createCleanupRegistry();
    const recordContext = context({ cleanup });
    await adapter.preflight(recordContext);
    expect(locked()).toBe("record-42.lock");
    const prepared = await adapter.prepare(recordContext);
    await prepared.dispose();
    expect(events.at(-1)).toBe("remove-worktrees");
    expect(locked()).toBe("record-42.lock");
    await cleanup.run();
    expect(events.at(-1)).toBe("unlock");
    expect(locked()).toBeUndefined();
  });

  it("waits for interrupted preflight children before releasing the lock", async () => {
    const { adapter, deps, events, locked } = harness();
    const cleanup = createCleanupRegistry();
    let finishStop: () => void = () => undefined;
    const stopping = new Promise<void>((resolve) => { finishStop = resolve; });
    deps.ownProcesses = () => ({
      exec: vi.fn(),
      start: vi.fn(),
      stopAll: vi.fn(async () => { events.push("stop-children"); await stopping; events.push("children-stopped"); }),
    });
    deps.checkTools = async () => new Promise(() => undefined);

    void adapter.preflight(context({ cleanup }));
    await vi.waitFor(() => expect(locked()).toBe("record-42.lock"));
    const cleaning = cleanup.run();
    await vi.waitFor(() => expect(events).toContain("stop-children"));
    expect(events).not.toContain("unlock");
    finishStop();
    await cleaning;
    expect(events.slice(-2)).toEqual(["children-stopped", "unlock"]);
  });

  it("a failed build cleans up and run-level cleanup releases the lock", async () => {
    const { adapter, events, locked } = harness({ failBuild: true });
    const cleanup = createCleanupRegistry();
    const recordContext = context({ cleanup });
    await adapter.preflight(recordContext);
    await expect(adapter.prepare(recordContext)).rejects.toThrow("base build failed");
    expect(locked()).toBe("record-42.lock");
    await cleanup.run();
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

  it("records a functional case as a video of flow.yaml alone, trimmed to its measured window", async () => {
    const { adapter, deps, events } = harness();
    deps.readTextFile = async () => "appId: fm.app\n---\n- tapOn: All\n";
    deps.runMaestro = vi.fn(async () => { events.push("maestro"); });
    const recordContext = context({ manifest: { ...manifest, classification: "functional" } });
    await adapter.preflight(recordContext);
    const prepared = await adapter.prepare(recordContext);
    const head = await prepared.capture("head");
    expect(head).toEqual({
      screenshots: new Map(),
      videoPath: "/home/u/.cache/playola-ux/ios/run-1/head/recording.mov",
      videoTrim: { startSeconds: 0.25, durationSeconds: 2 },
      warnings: [],
    });
    expect(events.slice(-5)).toEqual(["capture-head", "recorder-ready", "maestro", "marks-closed", "recorder-stopped"]);
    expect(deps.recordIOSVideo).toHaveBeenCalledWith(
      expect.objectContaining({ udid: "udid-head", environment: expect.objectContaining({ DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" }) }),
      expect.any(Function), expect.anything(),
    );
    expect(deps.writeTextFile).toHaveBeenCalledWith(
      "/home/u/.cache/playola-ux/ios/run-1/head/begin.js", expect.stringContaining('http.post("http://127.0.0.1:1/t/begin"'),
    );
    expect(deps.writeTextFile).toHaveBeenCalledWith(
      "/home/u/.cache/playola-ux/ios/run-1/head/wrapper.yaml",
      expect.stringMatching(/runScript: \/home\/u\/.cache\/playola-ux\/ios\/run-1\/head\/begin.js\n- runFlow: \/repo\/qa\/ux\/c\/flow.yaml\n- runScript: .*end.js/),
    );
  });

  it("a failed flow closes the mark server and publishes no video", async () => {
    const { adapter, deps, events } = harness();
    deps.readTextFile = async () => "appId: fm.app\n---\n- tapOn: All\n";
    deps.runMaestro = vi.fn(async () => { throw new Error("the Maestro flow failed (exit 1)"); });
    const recordContext = context({ manifest: { ...manifest, classification: "functional" } });
    await adapter.preflight(recordContext);
    const prepared = await adapter.prepare(recordContext);
    await expect(prepared.capture("head")).rejects.toThrow("the Maestro flow failed (exit 1)");
    expect(events).toContain("marks-closed");
  });

  it("refuses screenshots in a functional flow, which records only a video", async () => {
    const { adapter, deps } = harness();
    const recordContext = context({ manifest: { ...manifest, classification: "functional" } });
    await adapter.preflight(recordContext);
    await expect(adapter.prepare(recordContext)).rejects.toThrow("remove its takeScreenshot steps or make the case visual");
    expect(deps.buildIOSRevisions).not.toHaveBeenCalled();
  });

  it("creates iOS cases from the templates, using the configured app id", () => {
    const { adapter } = harness();
    const files = adapter.renderCase({ id: "c", classification: "functional", beforePolicy: "required", reason: null }, IOS_CONFIG);
    expect(files.get("flow.yaml")).toContain("appId: fm.playola.playolaradio.staging");
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
