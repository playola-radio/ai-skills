import { describe, expect, it, vi } from "vitest";
import { createCleanupRegistry } from "../core/cleanup.ts";
import type { EvidenceManifest, RevisionName } from "../core/domain.ts";
import type { RecordContext } from "../core/platform.ts";
import { WEB_CONFIG } from "../core/test-fixtures.ts";
import { createWebAdapter, type WebAdapterDependencies } from "./adapter.ts";
import type { EvidenceFlow } from "./flow-api.ts";
import type { RevisionStack, StackDependencies } from "./stack.ts";

const manifest: EvidenceManifest = {
  version: 1, id: "c", classification: "visual", before: { policy: "required", reason: null }, startPath: "/stations",
};
const context: RecordContext = {
  repoRoot: "/repo", config: WEB_CONFIG, manifest, commits: { base: "basesha", head: "headsha" },
  caseDirectory: "/repo/qa/ux/c", artifactDirectory: "/repo/.qa-artifacts/c",
  runDirectory: "/home/u/.cache/playola-ux/web/run-1", cleanup: createCleanupRegistry(),
};
const flow: EvidenceFlow = { demo: async () => {} };

function build(options: { dumpMissing?: boolean; baseOverride?: boolean } = {}) {
  const stackCalls: Array<{ request: Record<string, unknown>; dependencies: StackDependencies }> = [];
  const deps = {
    environment: { CENTRAL_DB_CACHE: "/cache" } as NodeJS.ProcessEnv,
    homeDirectory: "/home/u",
    stat: vi.fn(async () => {
      if (options.dumpMissing) throw new Error("ENOENT");
      return { size: 500, mtime: new Date("2026-01-02T03:04:05Z") };
    }),
    fileExists: vi.fn(async () => options.baseOverride ?? false),
    toolVersions: vi.fn(async () => ({ docker: "Docker 28" })),
    withRevisionStack: vi.fn(async (
      request: { revision: RevisionName },
      dependencies: StackDependencies,
      use: (stack: RevisionStack) => Promise<unknown>,
    ) => {
      stackCalls.push({ request, dependencies });
      return use({ clientUrl: `http://client-${request.revision}`, warnings: [`${request.revision} warning`] });
    }),
    stackDependencies: {},
    makeTemporaryDirectory: vi.fn(async (parent: string, prefix: string) => `${parent}/${prefix}x`),
    captureRevision: vi.fn(async (request: { revision: RevisionName }) => ({
      screenshots: new Map([["main", `/repo/.qa-artifacts/c/${request.revision}-main.png`]]),
    })),
    loadEvidenceFlow: vi.fn(async (_path: string) => flow),
  };
  const adapter = createWebAdapter(deps as unknown as WebAdapterDependencies);
  const prepare = async () => { await adapter.preflight(context); return adapter.prepare(context); };
  return { deps, adapter, prepare, stackCalls };
}

describe("createWebAdapter preflight", () => {
  it("reports the production dump as the environment and the tool versions", async () => {
    const { adapter } = build();
    await expect(adapter.preflight(context)).resolves.toEqual({
      environment: { dump: { path: "/cache/production.dump", sizeBytes: 500, modifiedAt: "2026-01-02T03:04:05.000Z" } },
      tools: { docker: "Docker 28" },
    });
  });

  it("refuses a missing dump before probing tools", async () => {
    const { adapter, deps } = build({ dumpMissing: true });
    await expect(adapter.preflight(context)).rejects.toThrow("production dump not found at /cache/production.dump");
    expect(deps.toolVersions).not.toHaveBeenCalled();
  });

  it("refuses a repository configured for another platform", async () => {
    const { adapter } = build();
    const ios = { ...context, config: { ...WEB_CONFIG, platform: "ios" } } as unknown as RecordContext;
    await expect(adapter.preflight(ios)).rejects.toThrow("the web adapter cannot record ios cases");
  });
});

describe("createWebAdapter capture", () => {
  it("starts one stack per revision at that revision's commit, named after the run", async () => {
    const { prepare, stackCalls } = build();
    const run = await prepare();
    await run.capture("base");
    await run.capture("head");
    expect(stackCalls.map((call) => call.request)).toEqual([
      { repoRoot: "/repo", revision: "base", commit: "basesha", dumpPath: "/cache/production.dump", runId: "run-1" },
      { repoRoot: "/repo", revision: "head", commit: "headsha", dumpPath: "/cache/production.dump", runId: "run-1" },
    ]);
  });

  it("makes stack temporary folders inside the run directory and registers cleanup with the run", async () => {
    const { prepare, stackCalls } = build();
    await (await prepare()).capture("head");
    const { dependencies } = stackCalls[0]!;
    await expect(dependencies.makeTemporaryDirectory("playola-ux-wt-")).resolves.toBe(`${context.runDirectory}/playola-ux-wt-x`);
    expect(dependencies.cleanup).toBe(context.cleanup);
  });

  it("captures with the stack's client URL, the case start path and the configured browser settings", async () => {
    const { prepare, deps } = build();
    await (await prepare()).capture("base");
    expect(deps.captureRevision).toHaveBeenCalledWith({
      revision: "base", classification: "visual", clientUrl: "http://client-base", startPath: "/stations",
      flow, outputDirectory: "/repo/.qa-artifacts/c", settings: WEB_CONFIG.web,
    });
  });

  it("returns the screenshots with the stack's warnings", async () => {
    const { prepare } = build();
    const capture = await (await prepare()).capture("head");
    expect(capture.warnings).toEqual(["head warning"]);
    expect([...capture.screenshots.keys()]).toEqual(["main"]);
  });

  it("loads both flows from the current checkout", async () => {
    const { prepare, deps } = build();
    const run = await prepare();
    await run.capture("base");
    await run.capture("head");
    expect(deps.loadEvidenceFlow.mock.calls.map(([path]) => path)).toEqual(["/repo/qa/ux/c/flow.ts", "/repo/qa/ux/c/flow.ts"]);
  });

  it("uses flow.base.ts for base when it exists", async () => {
    const { prepare, deps } = build({ baseOverride: true });
    const run = await prepare();
    await run.capture("base");
    await run.capture("head");
    expect(deps.loadEvidenceFlow.mock.calls.map(([path]) => path)).toEqual(["/repo/qa/ux/c/flow.base.ts", "/repo/qa/ux/c/flow.ts"]);
  });

  it.each(["base", "head"] as const)("names the case and %s revision when capture fails", async (revision) => {
    const { prepare, deps } = build();
    deps.captureRevision.mockRejectedValueOnce(new Error("locator timed out"));
    await expect((await prepare()).capture(revision)).rejects.toThrow(`c: ${revision} capture failed: locator timed out`);
  });

  it("refuses to prepare before preflight has found the dump", async () => {
    await expect(build().adapter.prepare(context)).rejects.toThrow("the web adapter must run preflight before prepare");
  });

  it("disposes more than once without error", async () => {
    const { prepare } = build();
    const run = await prepare();
    await run.dispose();
    await expect(run.dispose()).resolves.toBeUndefined();
  });
});

describe("createWebAdapter renderCase", () => {
  const visual = { id: "c", classification: "visual" as const, beforePolicy: "required" as const, reason: null, startPath: "/stations" };

  it("writes a manifest with the start path and a flow that imports the tool through qa/ux/.tool", () => {
    const files = build().adapter.renderCase(visual);
    expect([...files.keys()]).toEqual(["evidence.yaml", "flow.ts"]);
    expect(files.get("evidence.yaml")).toContain("startPath: /stations");
    expect(files.get("flow.ts")).toBe([
      'import type { DemoContext } from "../.tool/src/flow-api.ts";',
      "",
      "export async function demo({ page, shot }: DemoContext): Promise<void> {",
      '  await shot("main");',
      '  throw new Error("flow not written yet");',
      "}",
      "",
    ].join("\n"));
  });

  it("leaves the shot out of functional flows", () => {
    const flowSource = build().adapter.renderCase({ ...visual, classification: "functional" }).get("flow.ts");
    expect(flowSource).toContain("demo({ page }: DemoContext)");
    expect(flowSource).not.toContain("shot(");
  });

  it("refuses a case without a start path", () => {
    expect(() => build().adapter.renderCase({ ...visual, startPath: undefined })).toThrow("startPath must begin with /");
  });
});
