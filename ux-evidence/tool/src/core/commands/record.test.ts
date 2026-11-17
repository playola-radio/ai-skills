import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserCapture } from "../../web/browser.ts";
import { createCleanupRegistry } from "../cleanup.ts";
import type { EvidenceManifest, RevisionName } from "../domain.ts";
import type { ExecResult } from "../effects.ts";
import type { EvidenceFlow } from "../../web/flow-api.ts";
import type { RevisionStack } from "../../web/stack.ts";
import { recordEvidenceCase, type RecordDependencies } from "./record.ts";

const input = { repoRoot: "/repo", caseId: "c", environment: { CENTRAL_DB_CACHE: "/cache" } as NodeJS.ProcessEnv, homeDirectory: "/home/u" };
const flow: EvidenceFlow = { demo: async () => {} };

const functionalManifest: EvidenceManifest = {
  version: 1, id: "c", classification: "functional", before: { policy: "required", reason: null }, startPath: "/stations",
};
const visualManifest: EvidenceManifest = { ...functionalManifest, classification: "visual" };
const afterOnlyManifest: EvidenceManifest = {
  ...functionalManifest, before: { policy: "not-applicable", reason: "this flow does not exist on the base branch" },
};

function manifestYaml(manifest: EvidenceManifest): string {
  const reason = manifest.before.reason ? `\n  reason: ${manifest.before.reason}` : "";
  return `version: 1\nid: c\nclassification: ${manifest.classification}\nstartPath: ${manifest.startPath}\nbefore:\n  policy: ${manifest.before.policy}${reason}\n`;
}

function shots(revision: RevisionName, names: string[], video = true): BrowserCapture {
  const prefix = revision === "base" ? "before" : "after";
  return {
    ...(video ? { videoPath: `/repo/.qa-artifacts/c/raw-${revision}.webm` } : {}),
    screenshots: new Map(names.map((name) => [name, `/repo/.qa-artifacts/c/${prefix}-${name}.png`])),
  };
}

function build(options: { manifest?: EvidenceManifest; dirty?: string[]; dumpMissing?: boolean; baseOverride?: boolean; functionalShots?: string[] } = {}) {
  const manifest = options.manifest ?? functionalManifest;
  const stackRevisions: string[] = [];
  const writtenPaths: string[] = [];
  const written = new Map<string, string>();
  const loadedFlowPaths: string[] = [];
  const exec = vi.fn(async (_command: string, args: readonly string[]): Promise<ExecResult> => {
    const key = args.join(" ");
    const stdout = key === "rev-parse HEAD" ? "headsha\n"
      : key === "merge-base HEAD origin/develop" ? "basesha\n"
      : key === "status --porcelain -z" ? (options.dirty ?? []).map((path) => ` M ${path}\0`).join("")
      : "";
    return { exitCode: 0, stdout, stderr: "" };
  });
  const stat = vi.fn(async (path: string) => {
    if (options.dumpMissing && path.endsWith("production.dump")) throw new Error("ENOENT");
    return { size: 500, mtime: new Date("2026-01-02T03:04:05Z") };
  });
  const deps = {
    exec, stat,
    readTextFile: vi.fn(async () => manifestYaml(manifest)),
    fileExists: vi.fn(async () => options.baseOverride ?? false),
    withRevisionStack: vi.fn(async (request: { revision: RevisionName }, _d: unknown, use: (stack: RevisionStack) => Promise<unknown>) => {
      stackRevisions.push(request.revision);
      return use({
        clientUrl: `http://client-${request.revision}`, warnings: request.revision === "base" ? ["base warning"] : [],
      });
    }),
    stackDependencies: { cleanup: createCleanupRegistry() },
    captureRevision: vi.fn(async (request: { revision: RevisionName }) =>
      shots(request.revision, manifest.classification === "visual" ? ["stations"] : (options.functionalShots ?? []))),
    loadEvidenceFlow: vi.fn(async (path: string) => { loadedFlowPaths.push(path); return flow; }),
    encodeVideo: vi.fn(async (_request: { destinationPath: string }) => {}),
    composeComparisonPng: vi.fn(async () => {}),
    writeTextFile: vi.fn(async (path: string, content: string) => { writtenPaths.push(path); written.set(path, content); }),
    removeFile: vi.fn(async () => {}),
    clearDirectory: vi.fn(async (_path: string) => {}),
    filesIdentical: vi.fn(async (_left: string, _right: string) => false),
    checksumFile: vi.fn(async (path: string) => `sum:${path}`),
    toolVersions: vi.fn(async () => ({ ffmpeg: "7" })),
    now: () => new Date("2026-11-16T10:20:30.000Z"),
  };
  return { deps: deps as unknown as RecordDependencies & typeof deps, stackRevisions, writtenPaths, written, loadedFlowPaths };
}

describe("recordEvidenceCase", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => { ctx = build(); });

  it("refuses a dirty tree before touching Docker", async () => {
    ctx = build({ dirty: ["client/src/App.tsx"] });
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("uncommitted changes block recording: client/src/App.tsx");
    expect(ctx.deps.withRevisionStack).not.toHaveBeenCalled();
  });

  it("refuses a missing dump before touching Docker", async () => {
    ctx = build({ dumpMissing: true });
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("production dump not found");
    expect(ctx.deps.withRevisionStack).not.toHaveBeenCalled();
    expect(ctx.deps.loadEvidenceFlow).not.toHaveBeenCalled();
  });

  it("runs base before head", async () => {
    await recordEvidenceCase(input, ctx.deps);
    expect(ctx.stackRevisions).toEqual(["base", "head"]);
  });

  it("never downgrades a required base failure", async () => {
    ctx.deps.captureRevision.mockRejectedValueOnce(new Error("base control not found"));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("base control not found");
    expect(ctx.stackRevisions).toEqual(["base"]);
    expect(ctx.writtenPaths).toEqual([]);
  });

  it("rejects with the original error when head fails and writes nothing", async () => {
    ctx.deps.captureRevision.mockResolvedValueOnce(shots("base", []));
    ctx.deps.captureRevision.mockRejectedValueOnce(new Error("head exploded"));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("head exploded");
    expect(ctx.writtenPaths).toEqual([]);
  });

  it("clears the artifact directory after pre-flight checks and before any capture", async () => {
    ctx.deps.captureRevision.mockRejectedValueOnce(new Error("boom"));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow();
    expect(ctx.deps.clearDirectory).toHaveBeenCalledWith("/repo/.qa-artifacts/c");
    expect(ctx.deps.clearDirectory.mock.invocationCallOrder[0]!)
      .toBeLessThan(ctx.deps.captureRevision.mock.invocationCallOrder[0]!);
  });

  it("does not clear the artifact directory when the tree is dirty or the dump is missing", async () => {
    ctx = build({ dirty: ["client/src/App.tsx"] });
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow();
    expect(ctx.deps.clearDirectory).not.toHaveBeenCalled();
    ctx = build({ dumpMissing: true });
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow();
    expect(ctx.deps.clearDirectory).not.toHaveBeenCalled();
  });

  it("names the case and base revision when base capture fails", async () => {
    ctx.deps.captureRevision.mockRejectedValueOnce(new Error("locator timed out"));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("c: base capture failed: locator timed out");
  });

  it("names the case and head revision when head capture fails", async () => {
    ctx.deps.captureRevision.mockResolvedValueOnce(shots("base", []));
    ctx.deps.captureRevision.mockRejectedValueOnce(new Error("locator timed out"));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("c: head capture failed: locator timed out");
  });

  it("skips base only when policy is not-applicable", async () => {
    ctx = build({ manifest: afterOnlyManifest });
    const result = await recordEvidenceCase(input, ctx.deps);
    expect(ctx.stackRevisions).toEqual(["head"]);
    expect(result.revisions.base).toEqual({ status: "not-applicable", reason: "this flow does not exist on the base branch", warnings: [] });
    expect(result.artifacts.map((a) => a.path)).toEqual([".qa-artifacts/c/after.mp4"]);
  });

  it("fails when visual shot names differ", async () => {
    ctx = build({ manifest: visualManifest });
    ctx.deps.captureRevision.mockResolvedValueOnce(shots("base", ["stations-list"], false))
      .mockResolvedValueOnce(shots("head", ["stations"], false));
    await expect(recordEvidenceCase(input, ctx.deps))
      .rejects.toThrow("visual shot names differ: base [stations-list], head [stations]");
    expect(ctx.writtenPaths).toEqual([]);
  });

  it("loads both flows from the current checkout", async () => {
    await recordEvidenceCase(input, ctx.deps);
    expect(ctx.loadedFlowPaths).toEqual(["/repo/qa/ux/c/flow.ts", "/repo/qa/ux/c/flow.ts"]);
  });

  it("uses flow.base.ts for base when it exists", async () => {
    ctx = build({ baseOverride: true });
    await recordEvidenceCase(input, ctx.deps);
    expect(ctx.loadedFlowPaths).toEqual(["/repo/qa/ux/c/flow.base.ts", "/repo/qa/ux/c/flow.ts"]);
  });

  it("captures into the artifact directory using each stack's client URL", async () => {
    await recordEvidenceCase(input, ctx.deps);
    expect(ctx.deps.captureRevision).toHaveBeenCalledWith(expect.objectContaining({
      revision: "base", clientUrl: "http://client-base", outputDirectory: "/repo/.qa-artifacts/c", startPath: "/stations",
    }));
  });

  it("records commits, dump and artifacts in result.json", async () => {
    const result = await recordEvidenceCase(input, ctx.deps);
    expect(result).toMatchObject({
      version: 1, caseId: "c", baseCommit: "basesha", headCommit: "headsha",
      dump: { path: "/cache/production.dump" },
      revisions: { base: { status: "passed", warnings: ["base warning"] }, head: { status: "passed" } },
    });
    expect(result.artifacts.map((a) => a.path)).toEqual([".qa-artifacts/c/before.mp4", ".qa-artifacts/c/after.mp4"]);
    expect(result.artifacts[0]).toMatchObject({ kind: "video", revision: "base", sizeBytes: 500, sha256: "sum:/repo/.qa-artifacts/c/before.mp4" });
    expect(ctx.writtenPaths).toEqual(["/repo/.qa-artifacts/c/result.json", "/repo/.qa-artifacts/c/comment.md"]);
    expect(ctx.written.get("/repo/.qa-artifacts/c/result.json")).toBe(`${JSON.stringify(result, null, 2)}\n`);
    expect(ctx.deps.removeFile).toHaveBeenCalledWith("/repo/.qa-artifacts/c/raw-base.webm");
    expect(ctx.deps.removeFile).toHaveBeenCalledWith("/repo/.qa-artifacts/c/raw-head.webm");
  });

  it("derives the run id from the capture time and process id", async () => {
    await recordEvidenceCase(input, ctx.deps);
    expect(ctx.deps.withRevisionStack).toHaveBeenCalledWith(
      expect.objectContaining({ runId: `20261116102030000-${process.pid}` }), expect.anything(), expect.anything());
  });

  it("records per-shot screenshots and comparisons for visual cases", async () => {
    ctx = build({ manifest: visualManifest });
    const result = await recordEvidenceCase(input, ctx.deps);
    expect(result.artifacts.map((a) => a.path)).toEqual([
      ".qa-artifacts/c/before-stations.png", ".qa-artifacts/c/after-stations.png", ".qa-artifacts/c/compare-stations.png",
    ]);
    expect(ctx.deps.composeComparisonPng).toHaveBeenCalledWith(expect.objectContaining({
      beforePath: "/repo/.qa-artifacts/c/before-stations.png", destinationPath: "/repo/.qa-artifacts/c/compare-stations.png",
    }));
    expect(ctx.deps.encodeVideo).not.toHaveBeenCalled();
  });

  it("does not write comment.md when a video is over the cap", async () => {
    ctx.deps.encodeVideo.mockRejectedValueOnce(new Error("encoded video is 10485761 bytes"));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("encoded video is");
    expect(ctx.writtenPaths).toEqual([]);
  });

  it("does not write comment.md when an artifact is over the attachment limit", async () => {
    ctx.deps.stat.mockImplementation(async (path: string) => ({ size: path.endsWith(".mp4") ? 10_485_761 : 500, mtime: new Date() }));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("GitHub limit is 10485760");
    expect(ctx.writtenPaths).toEqual([]);
  });

  describe("identical-screenshot gate", () => {
    const identicalMessage = 'no visible difference: every before/after screenshot of c is identical. Either the case does not show the change, or the change has no visible effect (then use "UX evidence: none — <reason>" in the PR body).';

    beforeEach(() => { ctx = build({ manifest: visualManifest }); });

    it("fails and writes nothing when every pair is identical", async () => {
      ctx.deps.filesIdentical.mockResolvedValue(true);
      await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow(identicalMessage);
      expect(ctx.writtenPaths).toEqual([]);
      expect(ctx.deps.composeComparisonPng).not.toHaveBeenCalled();
      expect(ctx.deps.encodeVideo).not.toHaveBeenCalled();
      expect(ctx.deps.filesIdentical).toHaveBeenCalledWith("/repo/.qa-artifacts/c/before-stations.png", "/repo/.qa-artifacts/c/after-stations.png");
    });

    it("succeeds without an identical marker when one pair differs", async () => {
      ctx.deps.captureRevision
        .mockResolvedValueOnce(shots("base", ["a", "b"], false))
        .mockResolvedValueOnce(shots("head", ["a", "b"], false));
      ctx.deps.filesIdentical.mockImplementation(async (left: string) => left.endsWith("before-a.png"));
      const result = await recordEvidenceCase(input, ctx.deps);
      expect(result).not.toHaveProperty("identical");
    });

    it("skips the gate and marks the result when allowIdentical is set", async () => {
      ctx.deps.filesIdentical.mockResolvedValue(true);
      const result = await recordEvidenceCase({ ...input, allowIdentical: true }, ctx.deps);
      expect(result.identical).toBe(true);
      expect(ctx.written.get("/repo/.qa-artifacts/c/result.json")).toContain('"identical": true');
    });

    it("does not mark the result when allowIdentical is set but a pair differs", async () => {
      const result = await recordEvidenceCase({ ...input, allowIdentical: true }, ctx.deps);
      expect(result).not.toHaveProperty("identical");
    });

    it("does not compare functional cases", async () => {
      ctx = build({ functionalShots: ["panel"] });
      await recordEvidenceCase(input, ctx.deps);
      expect(ctx.deps.filesIdentical).not.toHaveBeenCalled();
    });

    it("does not compare visual cases without a base", async () => {
      ctx = build({ manifest: { ...visualManifest, before: { policy: "not-applicable", reason: "new" } } });
      await recordEvidenceCase(input, ctx.deps);
      expect(ctx.deps.filesIdentical).not.toHaveBeenCalled();
    });
  });

  describe("screenshots in functional cases", () => {
    it("registers before, after and comparison screenshots below the videos", async () => {
      ctx = build({ functionalShots: ["panel"] });
      const result = await recordEvidenceCase(input, ctx.deps);
      expect(result.artifacts.map((a) => a.path)).toEqual([
        ".qa-artifacts/c/before.mp4", ".qa-artifacts/c/after.mp4",
        ".qa-artifacts/c/before-panel.png", ".qa-artifacts/c/after-panel.png", ".qa-artifacts/c/compare-panel.png",
      ]);
      expect(result.artifacts.at(-1)).toMatchObject({ kind: "comparison", shotName: "panel" });
      expect(ctx.deps.composeComparisonPng).toHaveBeenCalledWith(expect.objectContaining({
        destinationPath: "/repo/.qa-artifacts/c/compare-panel.png",
      }));
      expect(ctx.written.get("/repo/.qa-artifacts/c/comment.md")).toContain("![](.qa-artifacts/c/compare-panel.png)");
    });

    it("registers only the after screenshot when the base was skipped", async () => {
      ctx = build({ manifest: afterOnlyManifest, functionalShots: ["panel"] });
      const result = await recordEvidenceCase(input, ctx.deps);
      expect(result.artifacts.map((a) => a.path)).toEqual([".qa-artifacts/c/after.mp4", ".qa-artifacts/c/after-panel.png"]);
      expect(ctx.deps.composeComparisonPng).not.toHaveBeenCalled();
    });

    it("fails when base and head took different shots", async () => {
      ctx = build();
      ctx.deps.captureRevision.mockResolvedValueOnce(shots("base", ["a"]))
        .mockResolvedValueOnce(shots("head", ["b"]));
      await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("shot names differ: base [a], head [b]");
      expect(ctx.writtenPaths).toEqual([]);
    });

    it("does not require a shot", async () => {
      await expect(recordEvidenceCase(input, ctx.deps)).resolves.toBeDefined();
    });
  });

  describe("pre-flight", () => {
    it("checks the tools before clearing artifacts or starting any stack", async () => {
      await recordEvidenceCase(input, ctx.deps);
      const toolsCall = ctx.deps.toolVersions.mock.invocationCallOrder[0]!;
      expect(toolsCall).toBeLessThan(ctx.deps.clearDirectory.mock.invocationCallOrder[0]!);
      expect(toolsCall).toBeLessThan(ctx.deps.withRevisionStack.mock.invocationCallOrder[0]!);
    });

    it("stops before clearing or starting anything when a tool is missing", async () => {
      ctx.deps.toolVersions.mockRejectedValueOnce(new Error("ffmpeg is not installed; run `make ux-evidence-setup`"));
      await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("make ux-evidence-setup");
      expect(ctx.deps.clearDirectory).not.toHaveBeenCalled();
      expect(ctx.deps.withRevisionStack).not.toHaveBeenCalled();
    });

    it("records the collected tool versions in result.json", async () => {
      const result = await recordEvidenceCase(input, ctx.deps);
      expect(result.tools).toEqual({ ffmpeg: "7" });
    });
  });

  it("refuses an invalid case id before reading or deleting anything", async () => {
    await expect(recordEvidenceCase({ ...input, caseId: "../client" }, ctx.deps))
      .rejects.toThrow("case id must be lowercase letters, digits and hyphens");
    expect(ctx.deps.readTextFile).not.toHaveBeenCalled();
    expect(ctx.deps.clearDirectory).not.toHaveBeenCalled();
  });
});
