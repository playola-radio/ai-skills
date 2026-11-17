import { describe, expect, it, vi } from "vitest";
import type { Exec, ExecResult } from "../core/effects.ts";
import { IOS_CONFIG } from "../core/test-fixtures.ts";
import { acquireRunLock, checkIOSTools, runLockDirectory, type LockFiles } from "./preflight.ts";

function memoryLock(initial: string[] = []) {
  const entries = new Set(initial);
  const name = (path: string) => path.split("/").at(-1)!;
  const files: LockFiles = {
    makeDirectory: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string) => { entries.add(name(path)); }),
    list: vi.fn(async () => [...entries, "spm"]),
    remove: vi.fn(async (path: string) => { entries.delete(name(path)); }),
  };
  return { files, entries: () => [...entries].sort() };
}

describe("acquireRunLock", () => {
  const directory = runLockDirectory("/home/u");

  it("writes record-<pid>.lock under ~/.cache/playola-ux/ios and removes it on release", async () => {
    const lock = memoryLock();
    const release = await acquireRunLock(directory, 100, { files: lock.files, isProcessAlive: () => true });
    expect(lock.files.writeFile).toHaveBeenCalledWith("/home/u/.cache/playola-ux/ios/record-100.lock");
    await release();
    expect(lock.entries()).toEqual([]);
  });

  it("a second recording fails at once while the first is running, leaving the first's entry", async () => {
    const lock = memoryLock();
    const release = await acquireRunLock(directory, 100, { files: lock.files, isProcessAlive: () => true });
    await expect(acquireRunLock(directory, 200, { files: lock.files, isProcessAlive: () => true }))
      .rejects.toThrow("another iOS recording is running (pid 100); wait for it to finish");
    expect(lock.entries()).toEqual(["record-100.lock"]);
    await release();
    await expect(acquireRunLock(directory, 200, { files: lock.files, isProcessAlive: () => true })).resolves.toBeTypeOf("function");
  });

  it("removes entries left by processes that have exited", async () => {
    const lock = memoryLock(["record-100.lock", "record-101.lock"]);
    await acquireRunLock(directory, 200, { files: lock.files, isProcessAlive: (pid) => pid === 200 });
    expect(lock.entries()).toEqual(["record-200.lock"]);
  });

  it("of two runs starting together, never both proceed", async () => {
    const lock = memoryLock(["record-50.lock"]);
    let wrote = 0;
    let bothWrote: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => { bothWrote = resolve; });
    const write = lock.files.writeFile;
    lock.files.writeFile = async (path) => { await write(path); if (++wrote === 2) bothWrote(); await barrier; };
    const alive = (pid: number) => pid !== 50;
    const results = await Promise.allSettled([
      acquireRunLock(directory, 100, { files: lock.files, isProcessAlive: alive }),
      acquireRunLock(directory, 200, { files: lock.files, isProcessAlive: alive }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeLessThanOrEqual(1);
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
