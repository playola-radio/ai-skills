import { describe, expect, it, vi } from "vitest";
import type { Exec, ExecResult } from "../core/effects.ts";
import { IOS_CONFIG } from "../core/test-fixtures.ts";
import { acquireRunLock, checkIOSTools, runLockPath, type LockFiles } from "./preflight.ts";

function memoryLock(initial?: string) {
  let content = initial;
  const files: LockFiles = {
    makeDirectory: vi.fn(async () => {}),
    createExclusive: vi.fn(async (_path: string, text: string) => {
      if (content !== undefined) return false;
      content = text;
      return true;
    }),
    readText: vi.fn(async () => content),
    remove: vi.fn(async () => { content = undefined; }),
  };
  return { files, current: () => content };
}

describe("acquireRunLock", () => {
  const path = runLockPath("/home/u");

  it("lives under ~/.cache/playola-ux/ios", () => {
    expect(path).toBe("/home/u/.cache/playola-ux/ios/record.lock");
  });

  it("a second recording fails at once while the first is running", async () => {
    const lock = memoryLock();
    const release = await acquireRunLock(path, 100, { files: lock.files, isProcessAlive: () => true });
    await expect(acquireRunLock(path, 200, { files: lock.files, isProcessAlive: () => true }))
      .rejects.toThrow("another iOS recording is running (pid 100); wait for it to finish");
    await release();
    await expect(acquireRunLock(path, 200, { files: lock.files, isProcessAlive: () => true })).resolves.toBeTypeOf("function");
  });

  it("takes over a lock left by a process that has exited", async () => {
    const lock = memoryLock("100\n");
    await acquireRunLock(path, 200, { files: lock.files, isProcessAlive: (pid) => pid !== 100 });
    expect(lock.current()).toBe("200\n");
  });

  it("release leaves a lock another run has since taken", async () => {
    const lock = memoryLock();
    const release = await acquireRunLock(path, 100, { files: lock.files, isProcessAlive: () => false });
    await lock.files.remove(path);
    await acquireRunLock(path, 200, { files: lock.files, isProcessAlive: () => true });
    await release();
    expect(lock.current()).toBe("200\n");
  });
});

function ok(stdout: string, stderr = ""): ExecResult { return { exitCode: 0, stdout, stderr }; }

function tools(runtimes: unknown[]) {
  return vi.fn<Exec>(async (command, args) => {
    if (command === "xcodebuild") return ok("Xcode 27.1\nBuild version 27B5\n");
    if (command.endsWith("maestro")) return ok("2.12.1\n");
    if (command.endsWith("/bin/java")) return ok("", 'openjdk version "17.0.17"\n');
    if (command === "ffmpeg") return ok("ffmpeg version 8.0\n");
    if (args[1] === "list") return ok(JSON.stringify({ runtimes }));
    throw new Error(`unexpected ${command}`);
  });
}

const pinnedRuntime = {
  identifier: IOS_CONFIG.ios.runtime, isAvailable: true,
  supportedDeviceTypes: [{ identifier: IOS_CONFIG.ios.deviceType }],
};

describe("checkIOSTools", () => {
  it("reports the environment and tool versions", async () => {
    const checked = await checkIOSTools(IOS_CONFIG.ios, tools([pinnedRuntime]));
    expect(checked.environment).toEqual({
      deviceType: IOS_CONFIG.ios.deviceType, runtime: IOS_CONFIG.ios.runtime, xcodeVersion: "27.1", apiHost: IOS_CONFIG.ios.apiHost,
    });
    expect(checked.tools).toMatchObject({ xcode: "Xcode 27.1", maestro: "2.12.1", java: 'openjdk version "17.0.17"', ffmpeg: "ffmpeg version 8.0" });
  });

  it("fails when the runtime cannot run the pinned device", async () => {
    await expect(checkIOSTools(IOS_CONFIG.ios, tools([{ ...pinnedRuntime, supportedDeviceTypes: [{ identifier: "iPhone-Duo" }] }])))
      .rejects.toThrow(`simulator runtime ${IOS_CONFIG.ios.runtime} cannot run ${IOS_CONFIG.ios.deviceType}`);
    await expect(checkIOSTools(IOS_CONFIG.ios, tools([]))).rejects.toThrow("is not installed");
  });

  it("names a missing tool", async () => {
    const exec = vi.fn<Exec>(async (command) => {
      if (command.endsWith("maestro")) throw new Error("spawn ENOENT");
      return ok("Xcode 27.1\n");
    });
    await expect(checkIOSTools(IOS_CONFIG.ios, exec)).rejects.toThrow("/home/u/.maestro/bin/maestro is not runnable (spawn ENOENT)");
  });
});
