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

export interface OwnedProcesses {
  exec: Exec;
  stopAll(): Promise<void>;
}

type SpawnChild = (command: string, args: readonly string[], options: ExecOptions) => ChildProcess;

const spawnInOwnGroup: SpawnChild = (command, args, options) =>
  spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });

const STOP_GRACE_MS = 5000;

// Children run in their own process group so a terminal Ctrl-C reaches only this process; the abort
// signal (or stopAll) then stops each group and waits for it to exit before any cleanup touches its files.
export function createOwnedProcesses(
  signal: AbortSignal,
  options: { spawnChild?: SpawnChild; killGroup?: (pid: number, signal: NodeJS.Signals) => void; graceMs?: number } = {},
): OwnedProcesses {
  const spawnChild = options.spawnChild ?? spawnInOwnGroup;
  const killGroup = options.killGroup ?? ((pid, name) => { process.kill(-pid, name); });
  const graceMs = options.graceMs ?? STOP_GRACE_MS;
  const running = new Map<ChildProcess, Promise<void>>();

  function stop(child: ChildProcess, exited: Promise<void>): Promise<void> {
    const send = (name: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try { killGroup(child.pid, name); } catch { /* already gone */ }
    };
    send("SIGTERM");
    const escalate = setTimeout(() => send("SIGKILL"), graceMs);
    return exited.finally(() => clearTimeout(escalate));
  }

  const stopAll = async () => {
    await Promise.all([...running].map(([child, exited]) => stop(child, exited)));
  };
  signal.addEventListener("abort", () => { void stopAll(); }, { once: true });

  const exec: Exec = (command, args, execOptions = {}) => {
    if (signal.aborted) return Promise.reject(new Error(`interrupted before running ${command}`));
    return new Promise((resolve, reject) => {
      const child = spawnChild(command, args, execOptions);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
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
  };

  return { exec, stopAll };
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
