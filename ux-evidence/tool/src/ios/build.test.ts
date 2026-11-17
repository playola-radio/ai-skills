import { describe, expect, it, vi } from "vitest";
import { createCleanupRegistry } from "../core/cleanup.ts";
import type { EvidenceManifest } from "../core/domain.ts";
import type { Exec, ExecResult } from "../core/effects.ts";
import type { RecordContext } from "../core/platform.ts";
import { IOS_CONFIG } from "../core/test-fixtures.ts";
import { buildIOSRevisions, xcodebuildArguments, type BuildDependencies } from "./build.ts";

const manifest: EvidenceManifest = { version: 1, id: "c", classification: "visual", before: { policy: "required", reason: null } };

function context(overrides: Partial<RecordContext> = {}): RecordContext {
  return {
    repoRoot: "/repo", config: IOS_CONFIG, manifest, commits: { base: "basesha", head: "headsha" },
    caseDirectory: "/repo/qa/ux/c", artifactDirectory: "/repo/.qa-artifacts/c",
    runDirectory: "/home/u/.cache/playola-ux/ios/run-1", cleanup: createCleanupRegistry(),
    ...overrides,
  };
}

const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

function harness(options: { failBuildIn?: string } = {}) {
  const events: string[] = [];
  const exec = vi.fn<Exec>(async (command, args, execOptions) => {
    if (command === "git") events.push(`worktree-add ${args[4]}`);
    if (command === "xcodebuild") {
      events.push(`xcodebuild ${execOptions?.cwd}`);
      if (execOptions?.cwd?.includes(options.failBuildIn ?? "<none>")) return { exitCode: 65, stdout: "a\nfoo.swift:1: error: boom\n", stderr: "" };
    }
    return ok;
  });
  const teardownExec = vi.fn<Exec>(async (_command, args) => { events.push(`worktree-remove ${args[3]}`); return ok; });
  const dependencies: BuildDependencies = {
    exec,
    teardownExec,
    stopChildren: vi.fn(async () => { events.push("stop-children"); }),
    fileExists: vi.fn(async () => true),
    copyFile: vi.fn(async (_source: string, destination: string) => { events.push(`copy ${destination}`); }),
    writeTextFile: vi.fn(async (path: string) => { events.push(`write ${path}`); }),
    homeDirectory: "/home/u",
  };
  return { events, exec, dependencies };
}

describe("buildIOSRevisions", () => {
  it("builds base then head in their own worktrees and returns each .app", async () => {
    const { events, dependencies } = harness();
    const apps = await buildIOSRevisions(context(), dependencies);
    expect(apps).toEqual(new Map([
      ["base", "/home/u/.cache/playola-ux/ios/run-1/base/DerivedData/Build/Products/Debug-iphonesimulator/PlayolaRadio Staging.app"],
      ["head", "/home/u/.cache/playola-ux/ios/run-1/head/DerivedData/Build/Products/Debug-iphonesimulator/PlayolaRadio Staging.app"],
    ]));
    expect(events.filter((event) => !event.startsWith("copy"))).toEqual([
      "worktree-add basesha", "xcodebuild /home/u/.cache/playola-ux/ios/run-1/base/wt",
      "worktree-add headsha", "xcodebuild /home/u/.cache/playola-ux/ios/run-1/head/wt",
    ]);
    expect(events.filter((event) => event.startsWith("copy"))).toContain(
      "copy /home/u/.cache/playola-ux/ios/run-1/base/wt/PlayolaRadio/Config/Secrets-Staging.xcconfig",
    );
  });

  it("a failed base build stops the run, keeps its log and never builds head", async () => {
    const { events, dependencies } = harness({ failBuildIn: "/base/" });
    await expect(buildIOSRevisions(context(), dependencies))
      .rejects.toThrow("base build failed (exit 65); log kept at /repo/.qa-artifacts/c/build-before.log\nfoo.swift:1: error: boom");
    expect(events.some((event) => event.includes("headsha") || event.includes("/head/"))).toBe(false);
    expect(events).toContain("write /repo/.qa-artifacts/c/build-before.log");
  });

  it("skips the base build when before is not applicable", async () => {
    const { events, dependencies } = harness();
    const apps = await buildIOSRevisions(
      context({ manifest: { ...manifest, before: { policy: "not-applicable", reason: "new screen" } } }),
      dependencies,
    );
    expect([...apps.keys()]).toEqual(["head"]);
    expect(events.some((event) => event.includes("basesha"))).toBe(false);
  });

  it("registers worktree removal that first stops running children", async () => {
    const { events, dependencies } = harness();
    const cleanup = createCleanupRegistry();
    await buildIOSRevisions(context({ cleanup }), dependencies);
    events.length = 0;
    await cleanup.run();
    expect(events).toEqual([
      "stop-children", "worktree-remove /home/u/.cache/playola-ux/ios/run-1/head/wt",
      "stop-children", "worktree-remove /home/u/.cache/playola-ux/ios/run-1/base/wt",
    ]);
  });
});

describe("xcodebuildArguments", () => {
  it("never passes -sdk, which breaks macro plugins, and keeps signing off", () => {
    const args = xcodebuildArguments(IOS_CONFIG.ios, "/dd", "/spm");
    expect(args).not.toContain("-sdk");
    expect(args).toEqual(expect.arrayContaining([
      "-destination", "generic/platform=iOS Simulator", "-clonedSourcePackagesDirPath", "/spm",
      "-skipMacroValidation", "-skipPackagePluginValidation", "CODE_SIGNING_ALLOWED=NO", "build",
    ]));
  });
});
