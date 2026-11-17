import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lockFiles } from "./wire.ts";

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("lockFiles.createExclusive", () => {
  it("creates the lock with its content in place and refuses a second one", async () => {
    directory = await mkdtemp(join(tmpdir(), "ux-lock-"));
    const path = join(directory, "record.lock");
    await expect(lockFiles.createExclusive(path, "1\n")).resolves.toBe(true);
    await expect(lockFiles.createExclusive(path, "2\n")).resolves.toBe(false);
    expect(await readFile(path, "utf8")).toBe("1\n");
    expect(await readdir(directory)).toEqual(["record.lock"]);
  });
});
