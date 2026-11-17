import { access, chmod, copyFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createOwnedProcesses, realExec } from "../core/effects.ts";
import type { PlatformAdapter } from "../core/platform.ts";
import { createIOSAdapter } from "./adapter.ts";
import { buildIOSRevisions } from "./build.ts";
import { collectScreenshots, runMaestro } from "./maestro.ts";
import { checkIOSTools, type LockFiles } from "./preflight.ts";
import { realAuthorizedGet, realSessionFiles } from "./session.ts";
import { withIOSSimulator } from "./simulator.ts";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

export const lockFiles: LockFiles = {
  async makeDirectory(path) { await mkdir(path, { recursive: true }); },
  // The pid is written to a private file first and linked into place, so no other run can ever read a
  // lock that exists but is still empty (which it would take over as stale).
  async createExclusive(path, content) {
    const staged = `${path}.${process.pid}.${Date.now()}`;
    await writeFile(staged, content, { flag: "wx" });
    try {
      await link(staged, path);
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    } finally {
      await rm(staged, { force: true });
    }
  },
  async readText(path) {
    try { return await readFile(path, "utf8"); } catch { return undefined; }
  },
  async remove(path) { await rm(path, { force: true }); },
};

async function moveFile(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    await copyFile(source, destination);
    await rm(source, { force: true });
  }
}

export function wireIOSAdapter(): PlatformAdapter {
  return createIOSAdapter({
    homeDirectory: homedir(),
    pid: process.pid,
    ownProcesses: (signal) => createOwnedProcesses(signal),
    teardownExec: realExec,
    lockFiles,
    isProcessAlive,
    session: { files: realSessionFiles, get: realAuthorizedGet, now: () => new Date() },
    checkTools: (config, exec) => checkIOSTools(config.ios, exec),
    fileExists: exists,
    readTextFile: (path) => readFile(path, "utf8"),
    async writeTextFile(path, content) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    async copyFile(source, destination) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    },
    moveFile,
    async writeSession(containerPath, sessionJson) {
      const documents = join(containerPath, "Documents");
      await mkdir(documents, { recursive: true, mode: 0o700 });
      const path = join(documents, "auth.json");
      await writeFile(path, sessionJson, { mode: 0o600 });
      await chmod(path, 0o600);
    },
    screenshotFiles: {
      async listFilesRecursively(directory) {
        try {
          return (await readdir(directory, { recursive: true })).map((entry) => join(directory, entry));
        } catch (error) {
          if (errorCode(error) === "ENOENT") return [];
          throw error;
        }
      },
    },
    buildIOSRevisions,
    withIOSSimulator,
    runMaestro,
    collectScreenshots,
  });
}
