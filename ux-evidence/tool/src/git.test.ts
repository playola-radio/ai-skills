import { describe, expect, it } from "vitest";
import type { Exec } from "./effects.ts";
import { changedPathsBetween, listBlockingDirtyPaths, resolveDumpMetadata, resolveGitRevisions } from "./git.ts";

function fakeExec(outputs: Record<string, string>): Exec {
  return async (command, args) => {
    const key = args.join(" ");
    if (command !== "git" || !(key in outputs)) return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${key}` };
    return { exitCode: 0, stdout: outputs[key], stderr: "" };
  };
}

describe("resolveGitRevisions", () => {
  it("resolves base as the merge-base of HEAD and origin/develop", async () => {
    const exec = fakeExec({ "rev-parse HEAD": "headsha\n", "merge-base HEAD origin/develop": "basesha\n" });
    await expect(resolveGitRevisions("/repo", exec)).resolves.toEqual({ head: "headsha", base: "basesha" });
  });

  it("fails with the git error when a command fails", async () => {
    await expect(resolveGitRevisions("/repo", fakeExec({}))).rejects.toThrow("git rev-parse HEAD failed");
  });
});

describe("listBlockingDirtyPaths", () => {
  const status = (...entries: string[]) => ({ "status --porcelain -z": entries.map((entry) => `${entry}\0`).join("") });

  it("keeps only app code and the case folder", async () => {
    const exec = fakeExec(status(" M client/src/a.ts", "?? docs/notes.md", " M qa/ux/case-1/evidence.yaml", " M qa/ux/other/x.md"));
    await expect(listBlockingDirtyPaths("/repo", "case-1", exec)).resolves.toEqual([
      "client/src/a.ts", "qa/ux/case-1/evidence.yaml",
    ]);
  });

  it("sees both sides of a rename, which -z emits as two entries", async () => {
    const exec = fakeExec(status("R  server/src/new.ts", "client/src/old.ts", " M docs/x.md"));
    await expect(listBlockingDirtyPaths("/repo", "c", exec)).resolves.toEqual(["server/src/new.ts", "client/src/old.ts"]);
  });

  it("handles paths with spaces and special characters", async () => {
    const exec = fakeExec(status(' M client/src/My Page "v2" é.tsx', "?? client/src/a -> b.ts"));
    await expect(listBlockingDirtyPaths("/repo", "c", exec)).resolves.toEqual([
      'client/src/My Page "v2" é.tsx', "client/src/a -> b.ts",
    ]);
  });
});

describe("changedPathsBetween", () => {
  it("lists paths changed between two revisions", async () => {
    const exec = fakeExec({ "diff --name-only -z base head": "client/a.ts\0server/b.ts\0" });
    await expect(changedPathsBetween("/repo", "base", "head", exec)).resolves.toEqual(["client/a.ts", "server/b.ts"]);
  });

  it("keeps spaces and special characters intact", async () => {
    const exec = fakeExec({ "diff --name-only -z base head": 'client/src/My Page "v2" é.tsx\0' });
    await expect(changedPathsBetween("/repo", "base", "head", exec)).resolves.toEqual(['client/src/My Page "v2" é.tsx']);
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
