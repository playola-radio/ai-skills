import { describe, expect, it } from "vitest";
import { makeHttpGet } from "./effects.ts";

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
