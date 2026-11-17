import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { makeHttpGet, createOwnedProcesses } from "./effects.ts";

describe("makeHttpGet", () => {
  it("returns status, content type and body", async () => {
    const get = makeHttpGet(async () => new Response("<div id=\"root\"></div>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(get("http://x")).resolves.toEqual({ status: 200, contentType: "text/html", body: "<div id=\"root\"></div>" });
  });

  it("aborts a request that never answers", async () => {
    const hanging = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    await expect(makeHttpGet(hanging, 20)("http://x")).rejects.toThrow();
  });

  it("gives each request a 5 second timeout signal by default", async () => {
    let seen: AbortSignal | null | undefined;
    await makeHttpGet(async (_url, init) => { seen = init?.signal; return new Response(""); })("http://x");
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });
});

describe("createOwnedProcesses", () => {
  it("runs a command and returns its output like realExec", async () => {
    const { exec } = createOwnedProcesses(new AbortController().signal);
    await expect(exec("sh", ["-c", "echo out; echo err >&2; exit 3"])).resolves.toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("starts nothing once the run is interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawnChild = vi.fn();
    const { exec } = createOwnedProcesses(controller.signal, { spawnChild });
    await expect(exec("xcodebuild", [])).rejects.toThrow("interrupted before running xcodebuild");
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("kills a descendant that ignores SIGTERM after its parent has exited", async () => {
    let child: ChildProcess | undefined;
    const spawnChild = (command: string, args: readonly string[]) =>
      (child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], detached: true }));
    const { exec, stopAll } = createOwnedProcesses(new AbortController().signal, { spawnChild, graceMs: 200 });
    const running = exec("sh", ["-c", "(trap '' TERM; echo ready; sleep 30) & wait"]);
    await new Promise((resolve) => child!.stdout!.once("data", resolve));
    const started = Date.now();
    await stopAll();
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(running).resolves.toMatchObject({ stdout: "ready\n" });
  }, 10_000);

  it("kills a descendant that ignores SIGTERM and no longer holds the output pipes", async () => {
    let child: ChildProcess | undefined;
    const spawnChild = (command: string, args: readonly string[]) =>
      (child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], detached: true }));
    const { exec, stopAll } = createOwnedProcesses(new AbortController().signal, { spawnChild, graceMs: 200 });
    const running = exec("sh", ["-c", "(trap '' TERM; exec sleep 30 >/dev/null 2>&1) & echo ready; wait"]);
    await new Promise((resolve) => child!.stdout!.once("data", resolve));
    await stopAll();
    expect(() => process.kill(-child!.pid!, 0)).toThrow();
    await running;
  }, 10_000);

  it("gives up with a warning naming the process when its group outlives the forced stop", async () => {
    let child: ChildProcess | undefined;
    const spawnChild = (command: string, args: readonly string[]) =>
      (child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], detached: true }));
    const warn = vi.fn();
    const { exec, stopAll } = createOwnedProcesses(new AbortController().signal, {
      spawnChild, graceMs: 100, afterKillMs: 200, warn, isGroupAlive: () => true,
    });
    const running = exec("sh", ["-c", "echo ready; sleep 30"]).catch(() => undefined);
    await new Promise((resolve) => child!.stdout!.once("data", resolve));
    const started = Date.now();
    await stopAll();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`process ${child!.pid}`));
    await running;
  }, 10_000);
});
