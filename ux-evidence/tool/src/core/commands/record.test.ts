import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCleanupRegistry } from "../cleanup.ts";
import type { EvidenceManifest, RevisionName } from "../domain.ts";
import type { ExecResult } from "../effects.ts";
import type { Capture, RecordContext } from "../platform.ts";
import type { EvidenceEnvironment } from "../results.ts";
import { WEB_CONFIG } from "../test-fixtures.ts";
import { recordEvidenceCase, type RecordDependencies } from "./record.ts";

const input = { repoRoot: "/repo", caseId: "c", config: WEB_CONFIG };
const RUN_ID = `20261116102030000-${process.pid}`;
const DUMP = { path: "/cache/production.dump", sizeBytes: 500, modifiedAt: "2026-01-02T03:04:05.000Z" };

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

function shots(revision: RevisionName, names: string[], video = true): Capture {
  const prefix = revision === "base" ? "before" : "after";
  return {
    ...(video ? { videoPath: `/repo/.qa-artifacts/c/raw-${revision}.webm` } : {}),
    screenshots: new Map(names.map((name) => [name, `/repo/.qa-artifacts/c/${prefix}-${name}.png`])),
    warnings: revision === "base" ? ["base warning"] : [],
  };
}

function build(options: { manifest?: EvidenceManifest; dirty?: string[]; functionalShots?: string[] } = {}) {
  const manifest = options.manifest ?? functionalManifest;
  const events: string[] = [];
  const writtenPaths: string[] = [];
  const written = new Map<string, string>();
  const exec = vi.fn(async (_command: string, args: readonly string[]): Promise<ExecResult> => {
    const key = args.join(" ");
    const stdout = key === "rev-parse HEAD" ? "headsha\n"
      : key === "merge-base HEAD origin/develop" ? "basesha\n"
      : key === "status --porcelain -z" ? (options.dirty ?? []).map((path) => ` M ${path}\0`).join("")
      : "";
    return { exitCode: 0, stdout, stderr: "" };
  });
  const capture = vi.fn(async (revision: RevisionName) => {
    events.push(revision);
    return shots(revision, manifest.classification === "visual" ? ["stations"] : (options.functionalShots ?? []));
  });
  const dispose = vi.fn(async () => { events.push("dispose"); });
  const adapter = {
    preflight: vi.fn(async (_context: RecordContext) => {
      events.push("preflight");
      return { environment: { dump: DUMP } as EvidenceEnvironment, tools: { ffmpeg: "7" } as Record<string, string> };
    }),
    prepare: vi.fn(async (_context: RecordContext) => { events.push("prepare"); return { capture, dispose }; }),
    renderCase: vi.fn(),
  };
  const deps = {
    exec,
    stat: vi.fn(async (_path: string) => ({ size: 500, mtime: new Date("2026-01-02T03:04:05Z") })),
    readTextFile: vi.fn(async () => manifestYaml(manifest)),
    adapter,
    cleanup: createCleanupRegistry(),
    encodeVideo: vi.fn(async (_request: { destinationPath: string }) => {}),
    composeComparisonPng: vi.fn(async () => {}),
    writeTextFile: vi.fn(async (path: string, content: string) => { writtenPaths.push(path); written.set(path, content); }),
    removeFile: vi.fn(async () => {}),
    clearDirectory: vi.fn(async (_path: string) => { events.push("clear"); }),
    makeRunDirectory: vi.fn(async (platform: string, runId: string) => `/home/u/.cache/playola-ux/${platform}/${runId}`),
    removeDirectory: vi.fn(async (_path: string) => { events.push("remove-run"); }),
    imagesIdentical: vi.fn(async (_left: string, _right: string) => false),
    checksumFile: vi.fn(async (path: string) => `sum:${path}`),
    toolCommit: vi.fn(async () => "toolsha"),
    now: () => new Date("2026-11-16T10:20:30.000Z"),
  };
  return { deps: deps as unknown as RecordDependencies & typeof deps, events, capture, dispose, writtenPaths, written };
}

describe("recordEvidenceCase", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => { ctx = build(); });

  it("adapterLifecycle: preflight → prepare → base → head → dispose", async () => {
    await recordEvidenceCase(input, ctx.deps);
    expect(ctx.events).toEqual(["preflight", "clear", "prepare", "base", "head", "dispose", "remove-run"]);
  });

  it("failedBaseStopsHead: a base rejection never invokes head, disposes and writes nothing", async () => {
    ctx.capture.mockRejectedValueOnce(new Error("base control not found"));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("base control not found");
    expect(ctx.capture).toHaveBeenCalledTimes(1);
    expect(ctx.dispose).toHaveBeenCalledTimes(1);
    expect(ctx.writtenPaths).toEqual([]);
  });

  it("rejects with the original error when head fails, disposes and writes nothing", async () => {
    ctx.capture.mockResolvedValueOnce(shots("base", [])).mockRejectedValueOnce(new Error("head exploded"));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("head exploded");
    expect(ctx.dispose).toHaveBeenCalledTimes(1);
    expect(ctx.writtenPaths).toEqual([]);
  });

  it("reports both errors when capture and disposal fail", async () => {
    ctx.capture.mockRejectedValueOnce(new Error("base exploded"));
    ctx.dispose.mockRejectedValueOnce(new Error("simulator stuck"));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("base exploded; cleanup also failed: simulator stuck");
  });

  it("fails when disposal fails after a successful capture", async () => {
    ctx.dispose.mockRejectedValueOnce(new Error("simulator stuck"));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow(/^simulator stuck$/);
    expect(ctx.dispose).toHaveBeenCalledTimes(1);
    expect(ctx.writtenPaths).toEqual([]);
  });

  it("refuses a dirty tree before preflight or clearing", async () => {
    ctx = build({ dirty: ["client/src/App.tsx"] });
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("uncommitted changes block recording: client/src/App.tsx");
    expect(ctx.deps.adapter.preflight).not.toHaveBeenCalled();
    expect(ctx.deps.clearDirectory).not.toHaveBeenCalled();
  });

  it("stops before clearing or preparing when preflight fails, and removes the run directory", async () => {
    ctx.deps.adapter.preflight.mockRejectedValueOnce(new Error("ffmpeg is not installed; run `make ux-evidence-setup`"));
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("make ux-evidence-setup");
    expect(ctx.deps.clearDirectory).not.toHaveBeenCalled();
    expect(ctx.deps.adapter.prepare).not.toHaveBeenCalled();
    expect(ctx.deps.removeDirectory).toHaveBeenCalledWith(`/home/u/.cache/playola-ux/web/${RUN_ID}`);
  });

  it("rejects an adapter that reports another platform's environment", async () => {
    ctx.deps.adapter.preflight.mockResolvedValueOnce({
      environment: { deviceType: "iPhone", runtime: "iOS 26", xcodeVersion: "26", apiHost: "x" }, tools: {},
    });
    await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("the web adapter reported an environment for another platform");
    expect(ctx.deps.clearDirectory).not.toHaveBeenCalled();
  });

  it("hands the adapter the commits, case, artifact and run directories", async () => {
    await recordEvidenceCase(input, ctx.deps);
    const context = ctx.deps.adapter.prepare.mock.calls[0]![0];
    expect(context).toMatchObject({
      repoRoot: "/repo", config: WEB_CONFIG, manifest: functionalManifest, commits: { base: "basesha", head: "headsha" },
      caseDirectory: "/repo/qa/ux/c", artifactDirectory: "/repo/.qa-artifacts/c",
      runDirectory: `/home/u/.cache/playola-ux/web/${RUN_ID}`, cleanup: ctx.deps.cleanup,
    });
    expect(ctx.deps.makeRunDirectory).toHaveBeenCalledWith("web", RUN_ID);
  });

  it("removes the run directory once even when cleanup also runs it", async () => {
    await recordEvidenceCase(input, ctx.deps);
    await ctx.deps.cleanup.run();
    expect(ctx.deps.removeDirectory).toHaveBeenCalledTimes(1);
  });

  it("skips base only when policy is not-applicable", async () => {
    ctx = build({ manifest: afterOnlyManifest });
    const result = await recordEvidenceCase(input, ctx.deps);
    expect(ctx.events).toEqual(["preflight", "clear", "prepare", "head", "dispose", "remove-run"]);
    expect(result.revisions.base).toEqual({ status: "not-applicable", reason: "this flow does not exist on the base branch", warnings: [] });
    expect(result.artifacts.map((a) => a.path)).toEqual([".qa-artifacts/c/after.mp4"]);
  });

  it("fails when visual shot names differ", async () => {
    ctx = build({ manifest: visualManifest });
    ctx.capture.mockResolvedValueOnce(shots("base", ["stations-list"], false))
      .mockResolvedValueOnce(shots("head", ["stations"], false));
    await expect(recordEvidenceCase(input, ctx.deps))
      .rejects.toThrow("visual shot names differ: base [stations-list], head [stations]");
    expect(ctx.writtenPaths).toEqual([]);
  });

  it("records version 2 with platform, environment, commits and tool commit in result.json", async () => {
    const result = await recordEvidenceCase(input, ctx.deps);
    expect(result).toMatchObject({
      version: 2, platform: "web", environment: { dump: DUMP }, caseId: "c",
      baseCommit: "basesha", headCommit: "headsha", toolCommit: "toolsha", tools: { ffmpeg: "7" },
      capturedAt: "2026-11-16T10:20:30.000Z",
      revisions: { base: { status: "passed", warnings: ["base warning"] }, head: { status: "passed" } },
    });
    expect(ctx.deps.toolCommit).toHaveBeenCalledTimes(1);
    expect(result.artifacts.map((a) => a.path)).toEqual([".qa-artifacts/c/before.mp4", ".qa-artifacts/c/after.mp4"]);
    expect(result.artifacts[0]).toMatchObject({ kind: "video", revision: "base", sizeBytes: 500, sha256: "sum:/repo/.qa-artifacts/c/before.mp4" });
    expect(ctx.writtenPaths).toEqual(["/repo/.qa-artifacts/c/result.json", "/repo/.qa-artifacts/c/comment.md"]);
    expect(ctx.written.get("/repo/.qa-artifacts/c/result.json")).toBe(`${JSON.stringify(result, null, 2)}\n`);
    expect(ctx.deps.removeFile).toHaveBeenCalledWith("/repo/.qa-artifacts/c/raw-base.webm");
    expect(ctx.deps.removeFile).toHaveBeenCalledWith("/repo/.qa-artifacts/c/raw-head.webm");
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

    it("fails and writes nothing when every pair has identical pixels", async () => {
      ctx.deps.imagesIdentical.mockResolvedValue(true);
      await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow(identicalMessage);
      expect(ctx.writtenPaths).toEqual([]);
      expect(ctx.deps.composeComparisonPng).not.toHaveBeenCalled();
      expect(ctx.deps.imagesIdentical).toHaveBeenCalledWith("/repo/.qa-artifacts/c/before-stations.png", "/repo/.qa-artifacts/c/after-stations.png");
    });

    it("succeeds without an identical marker when one pair differs", async () => {
      ctx.capture.mockResolvedValueOnce(shots("base", ["a", "b"], false)).mockResolvedValueOnce(shots("head", ["a", "b"], false));
      ctx.deps.imagesIdentical.mockImplementation(async (left: string) => left.endsWith("before-a.png"));
      const result = await recordEvidenceCase(input, ctx.deps);
      expect(result).not.toHaveProperty("identical");
    });

    it("skips the gate and marks the result when allowIdentical is set", async () => {
      ctx.deps.imagesIdentical.mockResolvedValue(true);
      const result = await recordEvidenceCase({ ...input, allowIdentical: true }, ctx.deps);
      expect(result.identical).toBe(true);
      expect(ctx.written.get("/repo/.qa-artifacts/c/result.json")).toContain('"identical": true');
    });

    it("does not compare functional cases", async () => {
      ctx = build({ functionalShots: ["panel"] });
      await recordEvidenceCase(input, ctx.deps);
      expect(ctx.deps.imagesIdentical).not.toHaveBeenCalled();
    });

    it("does not compare visual cases without a base", async () => {
      ctx = build({ manifest: { ...visualManifest, before: { policy: "not-applicable", reason: "new" } } });
      await recordEvidenceCase(input, ctx.deps);
      expect(ctx.deps.imagesIdentical).not.toHaveBeenCalled();
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
      expect(ctx.written.get("/repo/.qa-artifacts/c/comment.md")).toContain("![](.qa-artifacts/c/compare-panel.png)");
    });

    it("registers only the after screenshot when the base was skipped", async () => {
      ctx = build({ manifest: afterOnlyManifest, functionalShots: ["panel"] });
      const result = await recordEvidenceCase(input, ctx.deps);
      expect(result.artifacts.map((a) => a.path)).toEqual([".qa-artifacts/c/after.mp4", ".qa-artifacts/c/after-panel.png"]);
      expect(ctx.deps.composeComparisonPng).not.toHaveBeenCalled();
    });

    it("fails when base and head took different shots", async () => {
      ctx.capture.mockResolvedValueOnce(shots("base", ["a"])).mockResolvedValueOnce(shots("head", ["b"]));
      await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("shot names differ: base [a], head [b]");
      expect(ctx.writtenPaths).toEqual([]);
    });

    it("fails when a functional capture has no video", async () => {
      ctx.capture.mockResolvedValueOnce(shots("base", [], false));
      await expect(recordEvidenceCase(input, ctx.deps)).rejects.toThrow("no video was recorded (base)");
    });
  });

  it("refuses an invalid case id before reading or deleting anything", async () => {
    await expect(recordEvidenceCase({ ...input, caseId: "../client" }, ctx.deps))
      .rejects.toThrow("case id must be lowercase letters, digits and hyphens");
    expect(ctx.deps.readTextFile).not.toHaveBeenCalled();
    expect(ctx.deps.clearDirectory).not.toHaveBeenCalled();
  });
});
