import { describe, expect, it, vi } from "vitest";
import { createCleanupRegistry } from "../core/cleanup.ts";
import type { Exec } from "../core/effects.ts";
import type { RecordContext } from "../core/platform.ts";
import { IOS_CONFIG } from "../core/test-fixtures.ts";
import { withIOSSimulator, type SimulatorDependencies } from "./simulator.ts";

const CREATED = "11111111-2222-3333-4444-555555555555";
const OTHER = "OTHER";

function context(cleanup = createCleanupRegistry()): RecordContext {
  return {
    repoRoot: "/repo", config: IOS_CONFIG,
    manifest: { version: 1, id: "c", classification: "visual", before: { policy: "required", reason: null } },
    commits: { base: "b", head: "h" }, caseDirectory: "/repo/qa/ux/c", artifactDirectory: "/repo/.qa-artifacts/c",
    runDirectory: "/home/u/.cache/playola-ux/ios/run-1", cleanup,
  };
}

function harness() {
  const calls: string[][] = [];
  const exec = vi.fn<Exec>(async (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === "create") return { exitCode: 0, stdout: `${CREATED}\n`, stderr: "" };
    if (args[1] === "get_app_container") return { exitCode: 0, stdout: "/data/container\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const dependencies: SimulatorDependencies = {
    exec,
    teardownExec: exec,
    stopTeardownChildren: vi.fn(async () => {}),
    stopChildren: vi.fn(async () => { calls.push(["stop-children"]); }),
    writeSession: vi.fn(async (container: string) => { calls.push(["write-session", container]); }),
  };
  return { calls, dependencies };
}

const input = (cleanup?: ReturnType<typeof createCleanupRegistry>) =>
  ({ context: context(cleanup), revision: "head" as const, appPath: "/dd/App.app", sessionJson: "{}" });

describe("withIOSSimulator", () => {
  it("ownedDevicesOnly: every command after create names the created device, never booted, all or another device", async () => {
    const { calls, dependencies } = harness();
    await withIOSSimulator(input(), dependencies, async (udid) => {
      expect(udid).toBe(CREATED);
    });
    const simctl = calls.filter((call) => call[0] === "xcrun");
    expect(simctl[0]).toEqual(["xcrun", "simctl", "create", "playola-ux-run-1-head", IOS_CONFIG.ios.deviceType, IOS_CONFIG.ios.runtime]);
    for (const call of simctl.slice(1)) {
      expect(call[3] === CREATED || call[2] === CREATED).toBe(true);
      expect(call).not.toContain("booted");
      expect(call).not.toContain("all");
      expect(call).not.toContain(OTHER);
    }
    expect(simctl.map((call) => call[2])).toEqual([
      "create", "boot", "bootstatus", "ui", "status_bar", "install", "get_app_container", "terminate", "shutdown", "delete",
    ]);
    expect(calls).toContainEqual(["write-session", "/data/container"]);
  });

  it("deletes the device when the capture fails", async () => {
    const { calls, dependencies } = harness();
    await expect(withIOSSimulator(input(), dependencies, async () => { throw new Error("flow failed"); })).rejects.toThrow("flow failed");
    expect(calls.at(-1)).toEqual(["xcrun", "simctl", "delete", CREATED]);
  });

  it("bounds stalled teardown commands, warns with the device id and continues", async () => {
    vi.useFakeTimers();
    try {
      const { calls, dependencies } = harness();
      const warnings: string[] = [];
      dependencies.teardownTimeoutMs = 20;
      dependencies.warn = (message) => { warnings.push(message); };
      dependencies.teardownExec = vi.fn<Exec>(async (command, args, options) => {
        if (args[1] === "create") return { exitCode: 0, stdout: `${CREATED}\n`, stderr: "" };
        if (args[1] === "terminate") return new Promise(() => undefined);
        return dependencies.exec(command, args, options);
      });
      const recording = withIOSSimulator(input(), dependencies, async () => undefined);
      await vi.advanceTimersByTimeAsync(20);
      await recording;
      expect(warnings).toContain(`warning: simctl terminate timed out for device ${CREATED}; continuing cleanup`);
      expect(calls.at(-1)).toEqual(["xcrun", "simctl", "delete", CREATED]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the capture error when simulator deletion also fails", async () => {
    const { dependencies } = harness();
    const teardown = dependencies.teardownExec;
    dependencies.teardownExec = vi.fn<Exec>(async (command, args, options) => {
      if (args[1] === "delete") throw new Error("delete failed");
      return teardown(command, args, options);
    });
    await expect(withIOSSimulator(input(), dependencies, async () => { throw new Error("capture failed"); }))
      .rejects.toSatisfy((error: unknown) => error instanceof AggregateError
        && error.message === `capture failed; simulator ${CREATED} cleanup also failed: delete failed`
        && error.errors.some((item) => item instanceof Error && item.message === "capture failed")
        && error.errors.some((item) => item instanceof Error && item.message === "delete failed"));
  });

  it("registers the deletion as soon as the device exists, and runs it once", async () => {
    const { calls, dependencies } = harness();
    const cleanup = createCleanupRegistry();
    let interrupt: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => { interrupt = resolve; });
    const running = withIOSSimulator(input(cleanup), dependencies, async () => {
      interrupt();
      await new Promise(() => undefined);
    });
    await waiting;
    await cleanup.run();
    expect(calls.filter((call) => call[2] === "delete")).toEqual([["xcrun", "simctl", "delete", CREATED]]);
    expect(calls.findIndex((call) => call[0] === "stop-children")).toBeLessThan(calls.findIndex((call) => call[2] === "delete"));
    void running;
  });

  it("deletes a device whose creation finished after an interrupt", async () => {
    const controller = new AbortController();
    const cleanup = createCleanupRegistry(controller.signal);
    const { calls, dependencies } = harness();
    const create = dependencies.teardownExec;
    dependencies.exec = vi.fn<Exec>(async () => { throw new Error("interrupted"); });
    dependencies.teardownExec = vi.fn<Exec>(async (command, args, options) => {
      if (args[1] === "create") controller.abort();
      return create(command, args, options);
    });
    await expect(withIOSSimulator(input(cleanup), dependencies, async () => undefined)).rejects.toThrow("interrupted");
    expect(calls.at(-1)).toEqual(["xcrun", "simctl", "delete", CREATED]);
  });

  it("an interrupt while create is still running deletes the device once create finishes", async () => {
    const cleanup = createCleanupRegistry();
    const { calls, dependencies } = harness();
    const create = dependencies.teardownExec;
    let finishCreate: () => void = () => undefined;
    const createStarted = new Promise<void>((started) => {
      dependencies.teardownExec = vi.fn<Exec>(async (command, args, options) => {
        if (args[1] === "create") {
          started();
          await new Promise<void>((resolve) => { finishCreate = resolve; });
        }
        return create(command, args, options);
      });
    });
    const running = withIOSSimulator(input(cleanup), dependencies, async () => undefined);
    running.catch(() => undefined);
    await createStarted;
    const cleaning = cleanup.run();
    finishCreate();
    await cleaning;
    expect(calls.filter((call) => call[2] === "delete")).toEqual([["xcrun", "simctl", "delete", CREATED]]);
  });
});
