import type { Browser, BrowserContextOptions } from "playwright";
import { describe, expect, it } from "vitest";
import { captureRevision, type CaptureRevisionInput } from "./browser.ts";
import type { EvidenceFlow } from "./flow-api.ts";

interface FakeOptions { loginFails?: boolean; noVideo?: boolean }

function setup(options: FakeOptions = {}) {
  const events: string[] = [];
  const contextOptions: BrowserContextOptions[] = [];
  const page = (recording: boolean) => ({
    goto: async (url: string) => { events.push(`goto:${new URL(url).pathname}`); },
    waitForURL: async (predicate: (url: URL) => boolean) => {
      if (options.loginFails || !predicate(new URL("http://c/stations"))) throw new Error("timeout");
      events.push("wait:/stations");
    },
    screenshot: async ({ path }: { path: string }) => { events.push(`screenshot:${path}`); },
    video: () => (recording && !options.noVideo ? { path: async () => "/out/raw.webm" } : null),
  });
  const browser = {
    newContext: async (opts: BrowserContextOptions = {}) => {
      events.push("context:create");
      contextOptions.push(opts);
      return {
        newPage: async () => page(Boolean(opts.recordVideo)),
        storageState: async () => { events.push("state:save"); return { cookies: [], origins: [] }; },
        close: async () => { events.push("context:close"); },
      };
    },
    close: async () => { events.push("browser:close"); },
  } as unknown as Browser;
  const launch = async () => browser;
  const flow: EvidenceFlow = {
    setup: async () => { events.push("flow:setup"); },
    demo: async () => { events.push("flow:demo"); },
  };
  const input: CaptureRevisionInput = {
    revision: "base", classification: "functional", clientUrl: "http://localhost:5173",
    startPath: "/stations", flow, outputDirectory: "/out",
  };
  return { events, contextOptions, launch, input };
}

const shotFlow = (...names: string[]): EvidenceFlow => ({
  demo: async ({ shot }) => { for (const name of names) await shot(name); },
});

describe("captureRevision", () => {
  it("logs in and runs setup before the recorded context exists", async () => {
    const { events, launch, input } = setup();
    await captureRevision(input, launch);
    expect(events).toEqual(["context:create", "goto:/dev-user", "wait:/stations", "flow:setup", "state:save",
      "context:close", "context:create", "goto:/stations", "flow:demo", "context:close", "browser:close"]);
  });

  it("records functional cases at exactly 1440x900 with fixed locale and timezone", async () => {
    const { contextOptions, launch, input } = setup();
    const capture = await captureRevision(input, launch);
    expect(contextOptions[1]).toMatchObject({ viewport: { width: 1440, height: 900 }, locale: "en-US",
      timezoneId: "America/Chicago", recordVideo: { dir: "/out", size: { width: 1440, height: 900 } } });
    expect(contextOptions[0]).toMatchObject({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "America/Chicago" });
    expect(contextOptions[0].recordVideo).toBeUndefined();
    expect(capture.videoPath).toBe("/out/raw.webm");
  });

  it("does not record video for visual cases", async () => {
    const { contextOptions, launch, input } = setup();
    const capture = await captureRevision({ ...input, classification: "visual", flow: shotFlow("stations-list") }, launch);
    expect(contextOptions[1].recordVideo).toBeUndefined();
    expect(capture.videoPath).toBeUndefined();
  });

  it("names shots before- for base and after- for head", async () => {
    const { launch, input } = setup();
    const visual = { ...input, classification: "visual" as const, flow: shotFlow("stations-list") };
    const base = await captureRevision({ ...visual, revision: "base" }, launch);
    const head = await captureRevision({ ...visual, revision: "head" }, launch);
    expect(base.screenshots.get("stations-list")).toBe("/out/before-stations-list.png");
    expect(head.screenshots.get("stations-list")).toBe("/out/after-stations-list.png");
  });

  it("rejects a visual capture with no shots", async () => {
    const { launch, input } = setup();
    await expect(captureRevision({ ...input, classification: "visual", flow: { demo: async () => {} } }, launch))
      .rejects.toThrow("visual flow must call shot at least once");
  });

  it("rejects duplicate shot names", async () => {
    const { launch, input } = setup();
    await expect(captureRevision({ ...input, classification: "visual", flow: shotFlow("a", "a") }, launch))
      .rejects.toThrow("duplicate shot name: a");
  });

  it.each(["", "Bad Name", "a_b", "../x"])("rejects invalid shot name %j", async (name) => {
    const { launch, input } = setup();
    await expect(captureRevision({ ...input, classification: "visual", flow: shotFlow(name) }, launch))
      .rejects.toThrow(`invalid shot name: "${name}"`);
  });

  it("closes contexts and the browser when demo throws", async () => {
    const { events, launch, input } = setup();
    const flow: EvidenceFlow = { demo: async () => { throw new Error("demo broke"); } };
    await expect(captureRevision({ ...input, flow }, launch)).rejects.toThrow("demo broke");
    expect(events.slice(-2)).toEqual(["context:close", "browser:close"]);
  });

  it("reports a login that never reaches /stations", async () => {
    const { events, launch, input } = setup({ loginFails: true });
    await expect(captureRevision(input, launch)).rejects.toThrow("dev login did not reach /stations (base)");
    expect(events.at(-1)).toBe("browser:close");
  });

  it("fails a functional capture that recorded no video", async () => {
    const { launch, input } = setup({ noVideo: true });
    await expect(captureRevision({ ...input, revision: "head" }, launch)).rejects.toThrow("no video was recorded (head)");
  });
});
