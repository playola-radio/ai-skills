import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { main, makeEvidenceTemporaryDirectory, type CliCommands } from "./cli.ts";
import type { VerificationReport } from "./commands/verify.ts";

const currentReport: VerificationReport = {
  current: true, missingEvidenceForClientChanges: false, cases: [{ caseId: "c", current: true, reason: "recorded at current HEAD" }],
};
const staleReport: VerificationReport = {
  current: false, missingEvidenceForClientChanges: true, cases: [{ caseId: "c", current: false, reason: "result.json is missing" }],
};

let printed: string[];
let commands: { [K in keyof CliCommands]: ReturnType<typeof vi.fn> } & CliCommands;
const print = (line: string) => { printed.push(line); };

beforeEach(() => {
  printed = [];
  commands = {
    record: vi.fn(async () => {}),
    verify: vi.fn(async () => currentReport),
    publish: vi.fn(async () => {}),
    create: vi.fn(async () => {}),
  } as typeof commands;
});

describe("main", () => {
  it("routes record --case", async () => {
    expect(await main(["record", "--case", "c"], commands, print)).toBe(0);
    expect(commands.record).toHaveBeenCalledWith("c", { allowIdentical: false });
  });

  it("routes record --case --allow-identical in either order", async () => {
    expect(await main(["record", "--case", "c", "--allow-identical"], commands, print)).toBe(0);
    expect(await main(["record", "--allow-identical", "--case", "d"], commands, print)).toBe(0);
    expect(commands.record).toHaveBeenNthCalledWith(1, "c", { allowIdentical: true });
    expect(commands.record).toHaveBeenNthCalledWith(2, "d", { allowIdentical: true });
  });

  it("routes publish --pr 123", async () => {
    expect(await main(["publish", "--pr", "123"], commands, print)).toBe(0);
    expect(commands.publish).toHaveBeenCalledWith("123");
  });

  it("prints a line per case and exits 0 when verify is current", async () => {
    expect(await main(["verify"], commands, print)).toBe(0);
    expect(printed).toEqual(["c: current — recorded at current HEAD"]);
  });

  it("exits 1 when verify is not current and explains missing evidence", async () => {
    commands.verify = vi.fn(async () => staleReport);
    expect(await main(["verify"], commands, print)).toBe(1);
    expect(printed).toEqual([
      "c: stale — result.json is missing",
      'client code changed but no evidence case was added (add a case under qa/ux/, or put "UX evidence: none — <reason>" in the PR body)',
    ]);
  });

  it.each([
    ["record", ["record", "--case", "../client"]],
    ["record with uppercase", ["record", "--case", "Bad"]],
    ["new", ["new", "--case", "a/b", "--classification", "visual", "--before", "required", "--start-path", "/x"]],
  ])("rejects an unsafe --case before running %s", async (_label, argv) => {
    expect(await main(argv, commands, print)).toBe(1);
    expect(printed).toEqual(["error: case id must be lowercase letters, digits and hyphens"]);
    expect(commands.record).not.toHaveBeenCalled();
    expect(commands.create).not.toHaveBeenCalled();
  });

  it("exits 2 and prints usage when --case is missing", async () => {
    expect(await main(["record"], commands, print)).toBe(2);
    expect(printed[0]).toContain("usage:");
  });

  it("exits 2 for an unknown command", async () => {
    expect(await main(["bogus"], commands, print)).toBe(2);
    expect(printed[0]).toContain("usage:");
  });

  it("routes new with all flags", async () => {
    const argv = ["new", "--case", "c", "--classification", "visual", "--before", "not-applicable", "--start-path", "/x", "--reason", "new page"];
    expect(await main(argv, commands, print)).toBe(0);
    expect(commands.create).toHaveBeenCalledWith({
      id: "c", classification: "visual", beforePolicy: "not-applicable", reason: "new page", startPath: "/x",
    });
  });

  it("exits 2 when new is missing a required flag or has an invalid value", async () => {
    expect(await main(["new", "--case", "c"], commands, print)).toBe(2);
    const bad = ["new", "--case", "c", "--classification", "loud", "--before", "required", "--start-path", "/x"];
    expect(await main(bad, commands, print)).toBe(2);
    expect(commands.create).not.toHaveBeenCalled();
  });

  it("prints the error and uses its exit code when a command rejects", async () => {
    commands.record = vi.fn(async () => { throw Object.assign(new Error("interrupted by SIGINT"), { exitCode: 130 }); });
    expect(await main(["record", "--case", "c"], commands, print)).toBe(130);
    expect(printed).toEqual(["error: interrupted by SIGINT"]);
  });

  it("exits 1 for a plain error", async () => {
    commands.publish = vi.fn(async () => { throw new Error("nope"); });
    expect(await main(["publish", "--pr", "1"], commands, print)).toBe(1);
  });
});

describe("makeEvidenceTemporaryDirectory", () => {
  it("creates unique directories under <home>/.cache/playola-ux", async () => {
    const home = await mkdtemp(join(tmpdir(), "cli-test-home-"));
    try {
      const first = await makeEvidenceTemporaryDirectory("rev-", home);
      const second = await makeEvidenceTemporaryDirectory("rev-", home);
      expect((await stat(first)).isDirectory()).toBe(true);
      expect(dirname(first)).toBe(join(home, ".cache", "playola-ux"));
      expect(basename(first).startsWith("rev-")).toBe(true);
      expect(second).not.toBe(first);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
