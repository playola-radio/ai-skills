import { posix } from "node:path";
import type { CleanupRegistry } from "../core/cleanup.ts";
import type { Exec, ExecOptions, ExecResult, HttpGet } from "../core/effects.ts";
import type { RevisionName } from "../core/domain.ts";
import { CANDIDATE_OFFSETS, findFreePortOffset, type IsPortAvailable } from "./ports.ts";

export interface RevisionStack {
  clientUrl: string; warnings: readonly string[];
}

export interface StackDependencies {
  exec: Exec; httpGet: HttpGet; isPortAvailable: IsPortAvailable;
  makeTemporaryDirectory(prefix: string): Promise<string>;
  removeDirectory(path: string): Promise<void>;
  listMigrationFiles(worktreePath: string): Promise<readonly string[]>;
  cleanup: CleanupRegistry;
  warn?: (line: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

const POLL_INTERVAL_MS = 1000;
const POSTGRES_TIMEOUT_S = 120;
const APP_TIMEOUT_S = 300;
const DUMP_PATH_IN_CONTAINER = "/tmp/db.dump";

function tail(text: string, lineCount: number): string {
  return text.trimEnd().split("\n").slice(-lineCount).join("\n");
}

function memoized(step: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => (running ??= step());
}

function isServerHealthy(response: { status: number; body: string }): boolean {
  if (response.status !== 200) return false;
  try {
    const parsed = JSON.parse(response.body) as { healthy?: boolean; db?: boolean };
    return parsed.healthy === true && parsed.db === true;
  } catch {
    return false;
  }
}

function isClientReady(response: { status: number; contentType: string; body: string }): boolean {
  return response.status === 200 && response.contentType.includes("html") && response.body.includes('id="root"');
}

export async function withRevisionStack<T>(
  input: { repoRoot: string; revision: RevisionName; commit: string; dumpPath: string; runId: string },
  dependencies: StackDependencies,
  useStack: (stack: RevisionStack) => Promise<T>,
): Promise<T> {
  const { repoRoot, revision, commit, dumpPath, runId } = input;
  const { exec, httpGet, cleanup } = dependencies;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;
  const warn = dependencies.warn ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const projectName = `playola-ux-${runId}-${revision}`;
  const teardownSteps: Array<{ name: string; run: () => Promise<void> }> = [];

  function registerTeardown(name: string, step: () => Promise<void>): void {
    const run = memoized(async () => {
      try { await step(); } catch (error) {
        throw new Error(`${name} (${revision}): ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    teardownSteps.push({ name, run });
    cleanup.add(run);
  }

  async function runStep(step: string, command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    const result = await exec(command, args, options);
    if (result.exitCode !== 0) {
      throw new Error(`${step} failed for ${revision} (exit ${result.exitCode}): ${tail(result.stderr, 20)}`);
    }
    return result;
  }

  function checkNotInterrupted(): void {
    if (cleanup.signal.aborted) throw new Error(`interrupted before finishing the ${revision} stack`);
  }

  async function lifecycleStep(step: string, command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    checkNotInterrupted();
    return runStep(step, command, args, options);
  }

  async function pollUntil(label: string, timeoutSeconds: number, isReady: () => Promise<boolean>): Promise<void> {
    const deadline = now() + timeoutSeconds * 1000;
    while (true) {
      checkNotInterrupted();
      if (await isReady()) return;
      if (now() >= deadline) throw new Error(`${label} not ready after ${timeoutSeconds}s (${revision})`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  async function pollHttp(label: string, url: string, isReady: (response: Awaited<ReturnType<HttpGet>>) => boolean): Promise<void> {
    await pollUntil(label, APP_TIMEOUT_S, async () => {
      try { return isReady(await httpGet(url)); } catch { return false; }
    });
  }

  let failed = false;
  let worktreePath = "(not created)";
  try {
    checkNotInterrupted();
    const offset = await findFreePortOffset({ candidateOffsets: CANDIDATE_OFFSETS, isPortAvailable: dependencies.isPortAvailable });
    checkNotInterrupted();
    const temporaryDirectory = await dependencies.makeTemporaryDirectory(`playola-ux-${revision}-`);
    registerTeardown("temp:remove", () => dependencies.removeDirectory(temporaryDirectory));

    worktreePath = posix.join(temporaryDirectory, "wt");
    registerTeardown("worktree:remove", async () => {
      await runStep("worktree:remove", "git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
    });
    await lifecycleStep("worktree:add", "git", ["worktree", "add", "--detach", worktreePath, commit], { cwd: repoRoot });
    await lifecycleStep("setup-instance", "bash", ["scripts/setup-instance.sh", String(offset)], { cwd: worktreePath });

    const composeOptions: ExecOptions = { cwd: worktreePath, env: { ...process.env, COMPOSE_PROJECT_NAME: projectName } };
    const compose = (step: string, args: readonly string[]) => lifecycleStep(step, "docker", ["compose", ...args], composeOptions);

    registerTeardown("compose:down", async () => {
      await runStep("compose:down", "docker", ["compose", "down", "--volumes", "--rmi", "local", "--remove-orphans"], composeOptions);
    });
    await compose("compose:up postgres redis", ["up", "-d", "--build", "postgres", "redis"]);

    await pollUntil("postgres", POSTGRES_TIMEOUT_S, async () =>
      (await exec("docker", ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "postgres", "-d", "serverdev"], composeOptions)).exitCode === 0);

    const containerId = (await compose("postgres:container", ["ps", "-q", "postgres"])).stdout.trim();
    await lifecycleStep("dump:copy", "docker", ["cp", dumpPath, `${containerId}:${DUMP_PATH_IN_CONTAINER}`], composeOptions);
    await compose("dump:chown", ["exec", "-T", "-u", "root", "postgres", "chown", "postgres:postgres", DUMP_PATH_IN_CONTAINER]);
    const postgresExec = (step: string, command: string, args: readonly string[]) =>
      compose(step, ["exec", "-T", "postgres", command, "--username=postgres", ...args]);
    await postgresExec("db:drop", "dropdb", ["--force", "--if-exists", "serverdev"]);
    await postgresExec("db:create", "createdb", ["serverdev"]);
    await postgresExec("db:restore", "pg_restore", ["--dbname=serverdev", "--no-owner", "--no-acl", "--single-transaction", DUMP_PATH_IN_CONTAINER]);

    const applied = await postgresExec("migrations:compare", "psql",
      ["--dbname=serverdev", "--tuples-only", "--no-align", "--command", 'SELECT name FROM "SequelizeMeta"']);
    const known = new Set(await dependencies.listMigrationFiles(worktreePath));
    const missing = applied.stdout.split("\n").map((name) => name.trim()).filter((name) => name && !known.has(name));
    const warnings = missing.length > 0 ? [`dump has migrations this revision lacks: ${missing.join(", ")}`] : [];
    for (const warning of warnings) warn(`warning (${revision}): ${warning}`);

    await compose("compose:run migrate", ["run", "--rm", "migrate"]);
    await compose("compose:up --no-deps server client", ["up", "-d", "--build", "--no-deps", "server", "client"]);

    const serverUrl = `http://localhost:${10020 + offset}`;
    const clientUrl = `http://localhost:${3000 + offset}`;
    await pollHttp("server", `${serverUrl}/v1/health-check`, isServerHealthy);
    await pollHttp("client", `${clientUrl}/dev-user`, isClientReady);

    checkNotInterrupted();
    return await useStack({ clientUrl, warnings });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const teardownErrors: string[] = [];
    for (const step of [...teardownSteps].reverse()) {
      try { await step.run(); } catch (error) {
        teardownErrors.push(`${step.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (teardownErrors.length > 0) {
      if (!failed) throw new Error(`teardown failed for ${revision}: ${teardownErrors.join("; ")}`);
      warn(`warning: teardown failed for ${revision}; compose project ${projectName} and worktree ${worktreePath} may be left behind: ${teardownErrors.join("; ")}`);
    }
  }
}
