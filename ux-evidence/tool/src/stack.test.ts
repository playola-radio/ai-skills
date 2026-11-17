import { describe, expect, it, vi } from "vitest";
import { createCleanupRegistry, runWithSignalCleanup } from "./cleanup.ts";
import type { ExecOptions, ExecResult } from "./effects.ts";
import { withRevisionStack, type StackDependencies } from "./stack.ts";

const request = { repoRoot: "/repo", revision: "base" as const, commit: "basesha", dumpPath: "/cache/production.dump", runId: "run1" };

interface Call { command: string; args: readonly string[]; options: ExecOptions & { env: NodeJS.ProcessEnv } }

function labelFor(call: Call): string | null {
  const key = call.args.join(" ");
  if (call.command === "git" && key.startsWith("worktree add")) return "worktree:add";
  if (call.command === "git" && key.startsWith("worktree remove")) return "worktree:remove";
  if (call.command === "bash") return "setup-instance";
  if (key === "compose up -d --build postgres redis") return "compose:up postgres redis";
  if (key.includes("pg_isready")) return "postgres:ready";
  if (call.command === "docker" && call.args[0] === "cp") return "dump:copy";
  if (key.includes("chown")) return "dump:chown";
  if (key.includes("dropdb")) return "db:drop";
  if (key.includes("createdb")) return "db:create";
  if (key.includes("pg_restore")) return "db:restore";
  if (key.includes("SequelizeMeta")) return "migrations:compare";
  if (key === "compose run --rm migrate") return "compose:run migrate";
  if (key === "compose up -d --build --no-deps server client") return "compose:up --no-deps server client";
  if (key.startsWith("compose down")) return "compose:down";
  return null;
}

function setup(options: {
  failLabel?: string; offsetsBusy?: (port: number) => boolean; dumpMigrations?: string[];
  files?: string[]; serverStatus?: number; downFails?: boolean;
  onLabel?: (label: string) => void; downGate?: Promise<void>;
} = {}) {
  const warnings: string[] = [];
  const operations: string[] = [];
  const calls: Call[] = [];
  let clock = 0;
  const exec = async (command: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> => {
    const call = { command, args, options: { ...opts, env: opts.env ?? {} } };
    calls.push(call);
    const label = labelFor(call);
    if (label) operations.push(label);
    if (label) options.onLabel?.(label);
    if (label === "compose:down" && options.downGate) await options.downGate;
    if (label === options.failLabel) return { exitCode: 1, stdout: "", stderr: "line\nit broke" };
    if (label === "compose:down" && options.downFails) return { exitCode: 1, stdout: "", stderr: "down failed" };
    if (label === "migrations:compare") return { exitCode: 0, stdout: (options.dumpMigrations ?? []).join("\n") + "\n", stderr: "" };
    if (call.args.join(" ") === "compose ps -q postgres") return { exitCode: 0, stdout: "container123\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const httpGet = async (url: string) => {
    if (url.includes("/v1/health-check")) {
      operations.push("server:ready");
      const status = options.serverStatus ?? 200;
      return { status, contentType: "application/json", body: JSON.stringify({ healthy: true, db: true }) };
    }
    operations.push("client:ready");
    return { status: 200, contentType: "text/html; charset=utf-8", body: '<div id="root"></div>' };
  };
  const dependencies: StackDependencies = {
    exec, httpGet,
    isPortAvailable: async (port) => !(options.offsetsBusy?.(port) ?? false),
    makeTemporaryDirectory: async () => "/tmp/ux-abc",
    removeDirectory: async () => { operations.push("temp:remove"); },
    listMigrationFiles: async () => options.files ?? [],
    cleanup: createCleanupRegistry(),
    warn: (line) => { warnings.push(line); },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { operations, calls, dependencies, warnings };
}

describe("withRevisionStack", () => {
  it("runs the lifecycle in the approved order", async () => {
    const { operations, dependencies } = setup();
    await withRevisionStack(request, dependencies, async () => undefined);
    expect(operations).toEqual(["worktree:add", "setup-instance", "compose:up postgres redis", "postgres:ready",
      "dump:copy", "dump:chown", "db:drop", "db:create", "db:restore", "migrations:compare", "compose:run migrate",
      "compose:up --no-deps server client", "server:ready", "client:ready",
      "compose:down", "worktree:remove", "temp:remove"]);
  });

  it("makes the copied dump readable by the postgres user before restoring", async () => {
    const { calls, dependencies } = setup();
    await withRevisionStack(request, dependencies, async () => undefined);
    const copyIndex = calls.findIndex((c) => labelFor(c) === "dump:copy");
    expect(calls[copyIndex + 1]).toMatchObject({ command: "docker",
      args: ["compose", "exec", "-T", "-u", "root", "postgres", "chown", "postgres:postgres", "/tmp/db.dump"] });
    expect(labelFor(calls[copyIndex + 2])).toBe("db:drop");
  });

  it("fails naming dump:chown when the ownership change fails, and still tears down", async () => {
    const { operations, dependencies } = setup({ failLabel: "dump:chown" });
    await expect(withRevisionStack(request, dependencies, async () => undefined)).rejects.toThrow(/dump:chown.*base/);
    expect(operations).not.toContain("db:drop");
    expect(operations.slice(-3)).toEqual(["compose:down", "worktree:remove", "temp:remove"]);
  });

  it("checks out the exact commit", async () => {
    const { calls, dependencies } = setup();
    await withRevisionStack({ ...request, commit: "basesha" }, dependencies, async () => undefined);
    expect(calls).toContainEqual(expect.objectContaining({ command: "git",
      args: ["worktree", "add", "--detach", expect.any(String), "basesha"] }));
  });

  it("sets the unique project name on every compose call", async () => {
    const { calls, dependencies } = setup();
    await withRevisionStack({ ...request, runId: "run42", revision: "base" }, dependencies, async () => undefined);
    const composeCalls = calls.filter((c) => c.command === "docker" && c.args[0] === "compose");
    expect(composeCalls.length).toBeGreaterThan(0);
    for (const c of composeCalls) expect(c.options.env.COMPOSE_PROJECT_NAME).toBe("playola-ux-run42-base");
  });

  it("never starts worker or website", async () => {
    const { calls, dependencies } = setup();
    await withRevisionStack(request, dependencies, async () => undefined);
    const args = calls.flatMap((c) => c.args);
    expect(args).not.toContain("worker");
    expect(args).not.toContain("website");
  });

  it("tears down when the callback fails", async () => {
    const { operations, dependencies } = setup();
    await expect(withRevisionStack(request, dependencies, async () => { throw new Error("flow failed"); }))
      .rejects.toThrow("flow failed");
    expect(operations.slice(-3)).toEqual(["compose:down", "worktree:remove", "temp:remove"]);
  });

  it("tears down exactly once even when the registry also runs", async () => {
    const { operations, dependencies } = setup();
    await withRevisionStack(request, dependencies, async () => undefined);
    await dependencies.cleanup.run();
    expect(operations.filter((o) => o === "compose:down")).toHaveLength(1);
    expect(operations.filter((o) => o === "temp:remove")).toHaveLength(1);
  });

  it("tears down when the server never becomes ready", async () => {
    const { operations, dependencies } = setup({ serverStatus: 503 });
    await expect(withRevisionStack(request, dependencies, async () => undefined))
      .rejects.toThrow("server not ready after 300s (base)");
    expect(operations.slice(-3)).toEqual(["compose:down", "worktree:remove", "temp:remove"]);
  });

  it("names the step, revision and stderr tail when a step fails, and still tears down", async () => {
    const { operations, dependencies } = setup({ failLabel: "compose:run migrate" });
    await expect(withRevisionStack(request, dependencies, async () => undefined))
      .rejects.toThrow(/compose:run migrate.*base[\s\S]*it broke/);
    expect(operations.slice(-3)).toEqual(["compose:down", "worktree:remove", "temp:remove"]);
  });

  it("continues teardown past a failing step without masking the original error", async () => {
    const { operations, dependencies } = setup({ downFails: true });
    await expect(withRevisionStack(request, dependencies, async () => { throw new Error("flow failed"); }))
      .rejects.toThrow("flow failed");
    expect(operations.slice(-3)).toEqual(["compose:down", "worktree:remove", "temp:remove"]);
  });

  it("warns on stderr about leftovers when teardown fails after the run already failed", async () => {
    const { dependencies, warnings } = setup({ downFails: true });
    await expect(withRevisionStack({ ...request, runId: "run7" }, dependencies, async () => { throw new Error("flow failed"); }))
      .rejects.toThrow("flow failed");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("playola-ux-run7-base");
    expect(warnings[0]).toContain("/tmp/ux-abc/wt");
    expect(warnings[0]).toContain("compose:down (base): compose:down failed for base (exit 1): down failed");
  });

  it("does not warn when teardown succeeds", async () => {
    const { dependencies, warnings } = setup();
    await expect(withRevisionStack(request, dependencies, async () => { throw new Error("flow failed"); }))
      .rejects.toThrow("flow failed");
    expect(warnings).toEqual([]);
  });

  it("reports a teardown failure when nothing else failed", async () => {
    const { dependencies } = setup({ downFails: true });
    await expect(withRevisionStack(request, dependencies, async () => undefined)).rejects.toThrow(/compose:down/);
  });

  it("reports dump-only migrations as a warning", async () => {
    const { dependencies } = setup({ dumpMigrations: ["a.js", "z.js"], files: ["a.js"] });
    const stack = await withRevisionStack(request, dependencies, async (s) => s);
    expect(stack.warnings).toEqual(["dump has migrations this revision lacks: z.js"]);
  });

  it("prints each revision warning to stderr as it is produced", async () => {
    const { dependencies, warnings } = setup({ dumpMigrations: ["a.js", "z.js"], files: ["a.js"] });
    await withRevisionStack(request, dependencies, async () => undefined);
    expect(warnings).toEqual(["warning (base): dump has migrations this revision lacks: z.js"]);
  });

  it("builds urls from the first free offset", async () => {
    const { dependencies } = setup({ offsetsBusy: (port) => port === 8000 });
    const stack = await withRevisionStack(request, dependencies, async (s) => s);
    expect(stack.clientUrl).toBe("http://localhost:8100");
  });

  it("does not poll with real timers when ready immediately", async () => {
    const sleep = vi.fn(async () => undefined);
    const { dependencies } = setup();
    await withRevisionStack(request, { ...dependencies, sleep }, async () => undefined);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops starting new steps when interrupted mid-lifecycle and tears down in order exactly once", async () => {
    const signals = new Map<string, () => void>();
    const onSignal = (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void) => {
      signals.set(signal, handler);
      return () => undefined;
    };
    const { operations, dependencies } = setup({ onLabel: (label) => {
      if (label === "compose:up postgres redis") signals.get("SIGINT")!();
    } });
    await expect(runWithSignalCleanup((cleanup) =>
      withRevisionStack(request, { ...dependencies, cleanup }, async () => undefined), onSignal))
      .rejects.toMatchObject({ exitCode: 130 });
    expect(operations).toEqual(["worktree:add", "setup-instance", "compose:up postgres redis",
      "compose:down", "worktree:remove", "temp:remove"]);
  });

  it("includes teardown failures in the rejection after an interrupt", async () => {
    const signals = new Map<string, () => void>();
    const onSignal = (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void) => {
      signals.set(signal, handler);
      return () => undefined;
    };
    const { operations, dependencies } = setup({ downFails: true, onLabel: (label) => {
      if (label === "compose:up postgres redis") signals.get("SIGTERM")!();
    } });
    await expect(runWithSignalCleanup((cleanup) =>
      withRevisionStack(request, { ...dependencies, cleanup }, async () => undefined), onSignal))
      .rejects.toMatchObject({ exitCode: 143, message: expect.stringMatching(/cleanup failed: compose:down \(base\)/) });
    expect(operations.slice(-2)).toEqual(["worktree:remove", "temp:remove"]);
  });

  it("makes a second caller wait for a teardown step already running", async () => {
    let release: () => void = () => undefined;
    const downGate = new Promise<void>((resolve) => { release = resolve; });
    const { operations, dependencies } = setup({ downGate });
    await withRevisionStack(request, dependencies, async () => {
      void dependencies.cleanup.run();
      setTimeout(() => { operations.push("down:released"); release(); }, 5);
    });
    expect(operations.slice(-4)).toEqual(["compose:down", "down:released", "worktree:remove", "temp:remove"]);
    expect(operations.filter((o) => o === "compose:down")).toHaveLength(1);
  });
});
