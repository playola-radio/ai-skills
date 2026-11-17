import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { loadPlatformAdapter, main, makeRunDirectory, parseInvocation, readToolCommit, run, type CliCommands } from "./cli.ts";
import type { VerificationReport } from "./core/commands/verify.ts";

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
    iosLogin: vi.fn(async () => ({ path: "/home/.config/playola-ux/ios-staging-auth.json", expiresAt: null })),
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

  it("leaves the start path to the platform when --start-path is absent", async () => {
    const argv = ["new", "--case", "c", "--classification", "visual", "--before", "required"];
    expect(await main(argv, commands, print)).toBe(0);
    expect(commands.create).toHaveBeenCalledWith({ id: "c", classification: "visual", beforePolicy: "required", reason: null });
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

describe("repository selection", () => {
  it("repoFlagRoutesOutsideTool: --repo selects the repository the command acts on", async () => {
    const wire = vi.fn((_repoRoot: string) => commands);
    expect(await run(["--repo", "/tmp/app repo", "verify"], "/elsewhere", wire, print)).toBe(0);
    expect(wire).toHaveBeenCalledWith("/tmp/app repo");
    expect(commands.verify).toHaveBeenCalled();
  });

  it("shortRepoFlagMatchesLong: -C yields the same root as --repo", () => {
    expect(parseInvocation(["-C", "/tmp/app", "verify"], "/elsewhere")).toEqual({ repoRoot: "/tmp/app", args: ["verify"] });
    expect(parseInvocation(["--repo", "/tmp/app", "verify"], "/elsewhere")).toEqual({ repoRoot: "/tmp/app", args: ["verify"] });
  });

  it("missingRepoUsesCwd: without a flag the invocation directory is the repository", async () => {
    const wire = vi.fn((_repoRoot: string) => commands);
    expect(await run(["verify"], "/tmp/app", wire, print)).toBe(0);
    expect(wire).toHaveBeenCalledWith("/tmp/app");
  });

  it("conflictingRepoFlagsFail: different --repo and -C values exit 2 with usage", async () => {
    const wire = vi.fn((_repoRoot: string) => commands);
    expect(await run(["--repo", "/tmp/a", "-C", "/tmp/b", "verify"], "/elsewhere", wire, print)).toBe(2);
    expect(printed[0]).toContain("usage:");
    expect(wire).not.toHaveBeenCalled();
  });

  it("resolves a relative path against the invocation directory", () => {
    expect(parseInvocation(["-C", "app", "verify"], "/tmp")).toEqual({ repoRoot: "/tmp/app", args: ["verify"] });
  });

  it("exits 2 when the flag has no value", async () => {
    const wire = vi.fn((_repoRoot: string) => commands);
    expect(await run(["--repo"], "/elsewhere", wire, print)).toBe(2);
    expect(wire).not.toHaveBeenCalled();
  });
});

describe("makeRunDirectory", () => {
  it("creates <home>/.cache/playola-ux/<platform>/<run id>", async () => {
    const home = await mkdtemp(join(tmpdir(), "cli-test-home-"));
    try {
      const path = await makeRunDirectory("web", "20261116-42", home);
      expect(path).toBe(join(home, ".cache", "playola-ux", "web", "20261116-42"));
      expect((await stat(path)).isDirectory()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("readToolCommit", () => {
  it("reads the tool checkout's HEAD", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "toolsha\n", stderr: "" }));
    await expect(readToolCommit(exec, "/tool")).resolves.toBe("toolsha");
    expect(exec).toHaveBeenCalledWith("git", ["-C", "/tool", "rev-parse", "HEAD"]);
  });

  it("explains a tool folder that is not a git checkout", async () => {
    const exec = async () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" });
    await expect(readToolCommit(exec, "/tool")).rejects.toThrow("cannot read the UX evidence tool's commit in /tool: fatal: not a git repository");
  });
});

describe("loadPlatformAdapter", () => {
  it("loads the iOS adapter, which refuses to create cases until video support ships", async () => {
    const adapter = await loadPlatformAdapter("ios");
    expect(() => adapter.renderCase({ id: "c", classification: "visual", beforePolicy: "required", reason: null }))
      .toThrow("not yet supported");
  });
});

describe("ios-login", () => {
  it("passes --device and prints only the path, a missing expiry and the confirmation", async () => {
    expect(await main(["ios-login", "--device", "ABC"], commands, print)).toBe(0);
    expect(commands.iosLogin).toHaveBeenCalledWith("ABC");
    expect(printed).toEqual(["/home/.config/playola-ux/ios-staging-auth.json", "expiry: not supplied", "session validated"]);
  });

  it("prints the expiry when the token has one and works without --device", async () => {
    commands.iosLogin = vi.fn(async () => ({ path: "/p", expiresAt: new Date("2030-01-01T00:30:00Z") }));
    expect(await main(["ios-login"], commands, print)).toBe(0);
    expect(commands.iosLogin).toHaveBeenCalledWith(undefined);
    expect(printed).toEqual(["/p", "expiry: 2030-01-01T00:30:00.000Z", "session validated"]);
  });

  it("rejects other flags", async () => {
    expect(await main(["ios-login", "--udid", "ABC"], commands, print)).toBe(2);
    expect(commands.iosLogin).not.toHaveBeenCalled();
  });
});

function findOnPath(command: string): string {
  const found = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, command)).find((path) => existsSync(path));
  if (found === undefined) throw new Error(`${command} not found on PATH`);
  return found;
}

describe("verify without capture tools", () => {
  it("verifyNeedsNoCaptureTools: verify succeeds with only git on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-verify-"));
    try {
      const repo = join(root, "repo");
      const bin = join(root, "bin");
      await mkdir(join(repo, "qa", "ux"), { recursive: true });
      await mkdir(bin);
      await symlink(findOnPath("git"), join(bin, "git"));
      await writeFile(join(repo, "qa", "ux", "config.yaml"), [
        "version: 1", "platform: web", "baseBranch: develop", "relevant: [\"client/**\"]",
        "requiresEvidence: [\"client/**\"]", "ignored: []",
        "web: { viewport: { width: 1440, height: 900 }, locale: en-US, timezoneId: America/Chicago }", "",
      ].join("\n"));
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
      git("init", "-q");
      git("add", "qa/ux/config.yaml");
      git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
      git("update-ref", "refs/remotes/origin/develop", "HEAD");

      const tsx = join(import.meta.dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");
      const result = spawnSync(process.execPath, [tsx, join(import.meta.dirname, "main.ts"), "--repo", repo, "verify"], {
        env: { PATH: bin, HOME: root }, encoding: "utf8", timeout: 60_000,
      });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
