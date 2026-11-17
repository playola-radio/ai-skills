import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { realExec, realHttpGet, realIsPortAvailable, realStat } from "../core/effects.ts";
import type { PlatformAdapter } from "../core/platform.ts";
import { createWebAdapter } from "./adapter.ts";
import { captureRevision } from "./browser.ts";
import { loadEvidenceFlow } from "./flows.ts";
import { withRevisionStack } from "./stack.ts";
import { collectToolVersions } from "./tools.ts";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export function wireWebAdapter(): PlatformAdapter {
  return createWebAdapter({
    environment: process.env,
    homeDirectory: homedir(),
    stat: realStat,
    fileExists: exists,
    toolVersions: () => collectToolVersions({
      exec: realExec,
      playwrightVersion: async () => (JSON.parse(
        await readFile(join(import.meta.dirname, "..", "..", "node_modules", "playwright", "package.json"), "utf8"),
      ) as { version: string }).version,
      chromiumExecutablePath: () => chromium.executablePath(),
      fileExists: exists,
      nodeVersion: process.version,
    }),
    withRevisionStack,
    stackDependencies: {
      exec: realExec,
      httpGet: realHttpGet,
      isPortAvailable: realIsPortAvailable,
      removeDirectory: (path) => rm(path, { recursive: true, force: true }),
      listMigrationFiles: (worktreePath) => readdir(join(worktreePath, "server", "src", "db", "migrations")),
    },
    makeTemporaryDirectory: (parent, prefix) => mkdtemp(join(parent, prefix)),
    captureRevision,
    loadEvidenceFlow,
  });
}
