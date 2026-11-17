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
});
