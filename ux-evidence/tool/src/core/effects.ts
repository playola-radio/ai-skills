import { spawn } from "node:child_process";
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
