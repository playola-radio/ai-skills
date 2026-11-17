import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";

export interface ExecOptions { cwd?: string; env?: NodeJS.ProcessEnv }
export interface ExecResult { exitCode: number; stdout: string; stderr: string }
export type Exec = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
export type HttpGet = (url: string) => Promise<{ status: number; contentType: string; body: string }>;
export type PathStat = (path: string) => Promise<{ size: number; mtime: Date }>;

export const realExec: Exec = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options?.cwd, env: options?.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });

export interface StartedProcess {
  finished: Promise<ExecResult>;
  interrupt(): void;
}

export interface OwnedProcesses {
  exec: Exec;
  // For a child that runs until told to stop: output arrives as it is written, and interrupt sends SIGINT.
  start(command: string, args: readonly string[], options?: ExecOptions & { onOutput?(text: string): void }): StartedProcess;
  stopAll(): Promise<void>;
}

type SpawnChild = (command: string, args: readonly string[], options: ExecOptions) => ChildProcess;

const spawnInOwnGroup: SpawnChild = (command, args, options) =>
  spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });

const STOP_GRACE_MS = 5000;
const AFTER_KILL_MS = 3000;
const GROUP_POLL_MS = 50;

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Children run in their own process group so a terminal Ctrl-C reaches only this process; the abort
// signal (or stopAll) then stops each group and waits for it to exit before any cleanup touches its files.
export function createOwnedProcesses(
  signal: AbortSignal,
  options: {
    spawnChild?: SpawnChild;
    graceMs?: number;
    afterKillMs?: number;
    isGroupAlive?: (pid: number) => boolean;
    warn?: (line: string) => void;
  } = {},
): OwnedProcesses {
  const spawnChild = options.spawnChild ?? spawnInOwnGroup;
  const graceMs = options.graceMs ?? STOP_GRACE_MS;
  const afterKillMs = options.afterKillMs ?? AFTER_KILL_MS;
  const isGroupAlive = options.isGroupAlive ?? groupAlive;
  const warn = options.warn ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const running = new Map<ChildProcess, Promise<void>>();

  // Stops the child's whole process group and resolves once no member is left, escalating to SIGKILL after
  // the grace period. Waiting on the group (not the leader's exit) catches descendants that ignore SIGTERM,
  // whether or not they still hold the output pipes. A group that survives SIGKILL is reported, not awaited.
  async function stop(child: ChildProcess, exited: Promise<void>): Promise<void> {
    const pid = child.pid;
    if (pid === undefined) return exited;
    const send = (name: NodeJS.Signals) => {
      try { process.kill(-pid, name); } catch { /* group already gone */ }
    };
    const killAt = Date.now() + graceMs;
    let giveUpAt: number | undefined;
    send("SIGTERM");
    while (isGroupAlive(pid)) {
      if (giveUpAt === undefined && Date.now() >= killAt) {
        send("SIGKILL");
        giveUpAt = Date.now() + afterKillMs;
      }
      if (giveUpAt !== undefined && Date.now() >= giveUpAt) {
        warn(`warning: process ${pid} and its children did not exit after SIGKILL; continuing without them`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
    }
    await exited;
  }

  // A group's shutdown outlives its leader's exit, so it is kept until it settles; every stopAll, including
  // one made after an interrupt began stopping, awaits the same in-flight shutdowns.
  const stopping = new Map<ChildProcess, Promise<void>>();
  const stopAll = async () => {
    for (const [child, exited] of running) {
      if (!stopping.has(child)) stopping.set(child, stop(child, exited).finally(() => stopping.delete(child)));
    }
    await Promise.all([...stopping.values()]);
  };
  signal.addEventListener("abort", () => { void stopAll(); }, { once: true });

  const start: OwnedProcesses["start"] = (command, args, startOptions = {}) => {
    if (signal.aborted) throw new Error(`interrupted before running ${command}`);
    const { onOutput, ...execOptions } = startOptions;
    const child = spawnChild(command, args, execOptions);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); onOutput?.(chunk.toString()); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); onOutput?.(chunk.toString()); });
    const finished = new Promise<ExecResult>((resolve, reject) => {
      running.set(child, new Promise<void>((exited) => {
        child.on("error", (error) => { running.delete(child); exited(); reject(error); });
        child.on("close", (code) => {
          running.delete(child);
          exited();
          if (signal.aborted) reject(new Error(`interrupted while running ${command}`));
          else resolve({ exitCode: code ?? 1, stdout, stderr });
        });
      }));
    });
    const interrupt = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGINT"); } catch { /* group already gone */ }
    };
    return { finished, interrupt };
  };

  const exec: Exec = async (command, args, execOptions = {}) => start(command, args, execOptions).finished;

  return { exec, start, stopAll };
}

const REQUEST_TIMEOUT_MS = 5000;

export function makeHttpGet(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): HttpGet {
  return async (url) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: await response.text(),
    };
  };
}

export const realHttpGet: HttpGet = makeHttpGet();

export const realIsPortAvailable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

export const realStat: PathStat = async (path) => {
  const { size, mtime } = await stat(path);
  return { size, mtime };
};
