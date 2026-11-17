import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createCleanupRegistry } from "../core/cleanup.ts";
import { createOwnedProcesses, type Exec } from "../core/effects.ts";
import type { RecordContext } from "../core/platform.ts";
import { IOS_CONFIG } from "../core/test-fixtures.ts";
import { buildIOSRevisions } from "./build.ts";

describe("interrupting a build", () => {
  it("interruptStopsChildrenBeforeRemoval: worktree removal waits until a stubborn build has exited", async () => {
    const controller = new AbortController();
    const cleanup = createCleanupRegistry(controller.signal);
    let build: ChildProcess | undefined;
    let buildStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { buildStarted = resolve; });
    const owned = createOwnedProcesses(controller.signal, {
      graceMs: 300,
      spawnChild: (command) => {
        if (command !== "xcodebuild") return spawn("true", [], { stdio: ["ignore", "pipe", "pipe"], detached: true });
        // Ignores SIGTERM, so only the SIGKILL after the grace period stops it.
        build = spawn("sh", ["-c", 'trap "" TERM; echo ready; sleep 30'], { stdio: ["ignore", "pipe", "pipe"], detached: true });
        build.stdout!.once("data", () => buildStarted());
        return build;
      },
    });
    const buildAliveAtRemoval: boolean[] = [];
    const teardownExec: Exec = async () => {
      buildAliveAtRemoval.push(build!.exitCode === null && build!.signalCode === null);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const context: RecordContext = {
      repoRoot: "/repo", config: IOS_CONFIG,
      manifest: { version: 1, id: "c", classification: "visual", before: { policy: "required", reason: null } },
      commits: { base: "b", head: "h" }, caseDirectory: "/repo/qa/ux/c", artifactDirectory: "/repo/.qa-artifacts/c",
      runDirectory: "/tmp/run-1", cleanup,
    };

    const building = buildIOSRevisions(context, {
      exec: owned.exec, teardownExec, stopChildren: owned.stopAll,
      fileExists: async () => true, copyFile: async () => {}, writeTextFile: async () => {}, homeDirectory: "/home/u",
    });
    const outcome = building.then(() => "finished", (error: Error) => error.message);
    await started;
    controller.abort();
    await cleanup.run();

    expect(buildAliveAtRemoval).toEqual([false]);
    expect(build!.signalCode).toBe("SIGKILL");
    expect(await outcome).toBe("interrupted while running xcodebuild");
  });
});
