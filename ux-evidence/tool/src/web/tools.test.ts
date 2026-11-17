import { describe, expect, it } from "vitest";
import type { Exec } from "../core/effects.ts";
import { collectToolVersions, resolveDumpMetadata } from "./tools.ts";
import { nodeVersionError } from "../core/node-version.ts";

function build(options: { ffmpeg?: "ok" | "missing" | "fails"; docker?: "ok" | "missing"; chromiumInstalled?: boolean } = {}) {
  const exec: Exec = async (command) => {
    const mode = command === "ffmpeg" ? options.ffmpeg : options.docker;
    if (mode === "missing") throw new Error(`spawn ${command} ENOENT`);
    if (mode === "fails") return { exitCode: 1, stdout: "", stderr: "broken" };
    return { exitCode: 0, stdout: command === "ffmpeg" ? "ffmpeg version 7.1\nmore" : "Docker version 27\n", stderr: "" };
  };
  return {
    exec,
    playwrightVersion: async () => "1.65.1",
    chromiumExecutablePath: () => "/pw/chromium",
    fileExists: async (path: string) => path === "/pw/chromium" && (options.chromiumInstalled ?? true),
    nodeVersion: "v24.1.0",
  };
}

describe("collectToolVersions", () => {
  it("returns the versions of every tool", async () => {
    await expect(collectToolVersions(build())).resolves.toEqual({
      node: "v24.1.0", playwright: "1.65.1", ffmpeg: "ffmpeg version 7.1", docker: "Docker version 27",
    });
  });

  it.each([["missing"], ["fails"]] as const)("names the fix when ffmpeg is %s", async (ffmpeg) => {
    await expect(collectToolVersions(build({ ffmpeg }))).rejects.toThrow(/ffmpeg.*make ux-evidence-setup/);
  });

  it("names the fix when Playwright's Chromium is not installed", async () => {
    await expect(collectToolVersions(build({ chromiumInstalled: false })))
      .rejects.toThrow("Playwright Chromium is not installed (expected at /pw/chromium); run `make ux-evidence-setup`");
  });

  it("names the fix when docker is missing", async () => {
    await expect(collectToolVersions(build({ docker: "missing" }))).rejects.toThrow(/docker.*make ux-evidence-setup/);
  });
});

describe("nodeVersionError", () => {
  it.each(["24.0.0", "24.11.1", "25.2.0"])("accepts Node %s", (version) => {
    expect(nodeVersionError(version)).toBeUndefined();
  });

  it.each(["22.23.4", "23.9.0", "20.11.0"])("rejects Node %s with a clear message", (version) => {
    expect(nodeVersionError(version)).toBe(`UX evidence needs Node 24 or newer (found ${version})`);
  });
});

describe("resolveDumpMetadata", () => {
  it("prefers CENTRAL_DB_CACHE for the dump", async () => {
    await expect(resolveDumpMetadata({ environment: { CENTRAL_DB_CACHE: "/cache" }, homeDirectory: "/Users/brian",
      stat: async () => ({ size: 5, mtime: new Date("2026-11-11T14:21:00Z") }) }))
      .resolves.toEqual({ path: "/cache/production.dump", sizeBytes: 5, modifiedAt: "2026-11-11T14:21:00.000Z" });
  });

  it("falls back to the home directory cache", async () => {
    await expect(resolveDumpMetadata({ environment: {}, homeDirectory: "/Users/brian",
      stat: async () => ({ size: 1, mtime: new Date("2026-11-11T14:21:00Z") }) }))
      .resolves.toMatchObject({ path: "/Users/brian/playola/.db-cache/production.dump" });
  });

  it("fails clearly when the dump is missing", async () => {
    await expect(resolveDumpMetadata({ environment: {}, homeDirectory: "/Users/brian",
      stat: async () => { throw new Error("ENOENT"); } }))
      .rejects.toThrow("production dump not found at /Users/brian/playola/.db-cache/production.dump; run `make db-download-production`");
  });
});
