import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearArtifactDirectory } from "./artifacts.ts";

let repoRoot: string;
beforeEach(async () => { repoRoot = await mkdtemp(join(tmpdir(), "artifacts-test-")); });
afterEach(async () => { await rm(repoRoot, { recursive: true, force: true }); });

describe("clearArtifactDirectory", () => {
  it("empties and recreates a directory inside .qa-artifacts", async () => {
    const target = join(repoRoot, ".qa-artifacts", "c");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.png"), "x");
    await clearArtifactDirectory(repoRoot, target);
    expect(await readdir(target)).toEqual([]);
  });

  it.each([
    ["the repo's client folder", "client"],
    ["the artifacts root itself", ".qa-artifacts"],
    ["a traversal out of the artifacts root", join(".qa-artifacts", "..", "client")],
    ["a sibling that only shares the prefix", ".qa-artifacts-evil"],
  ])("refuses %s and leaves it untouched", async (_label, relative) => {
    const target = join(repoRoot, relative);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "x");
    await expect(clearArtifactDirectory(repoRoot, target)).rejects.toThrow("refusing to clear");
    expect(await readdir(target)).toEqual(["keep.txt"]);
  });
});
