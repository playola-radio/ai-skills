import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { clearArtifactDirectory } from "./core/artifacts.ts";
import { assertValidCaseId } from "./core/case-id.ts";
import { runWithSignalCleanup } from "./core/cleanup.ts";
import { createEvidenceCase, type NewCaseInput } from "./core/commands/new.ts";
import { MISSING_EVIDENCE_MESSAGE, publishEvidence } from "./core/commands/publish.ts";
import { recordEvidenceCase } from "./core/commands/record.ts";
import { verifyEvidence, type VerificationReport, type VerifyDependencies } from "./core/commands/verify.ts";
import { loadConfig, type Platform } from "./core/config.ts";
import type { BeforePolicy, EvidenceClassification } from "./core/domain.ts";
import { realExec, realStat, type Exec } from "./core/effects.ts";
import { composeComparisonPng, encodeVideo, pixelsIdentical } from "./core/media.ts";
import type { PlatformAdapter } from "./core/platform.ts";

const TOOL_DIRECTORY = join(import.meta.dirname, "..");

export async function makeRunDirectory(platform: Platform, runId: string, home = homedir()): Promise<string> {
  const path = join(home, ".cache", "playola-ux", platform, runId);
  await mkdir(path, { recursive: true });
  return path;
}

export async function readToolCommit(exec: Exec, toolDirectory = TOOL_DIRECTORY): Promise<string> {
  const result = await exec("git", ["-C", toolDirectory, "rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error(`cannot read the UX evidence tool's commit in ${toolDirectory}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return result.stdout.trim();
}

export async function loadPlatformAdapter(platform: Platform): Promise<PlatformAdapter> {
  if (platform === "ios") {
    const { wireIOSAdapter } = await import("./ios/wire.ts");
    return wireIOSAdapter();
  }
  const { wireWebAdapter } = await import("./web/wire.ts");
  return wireWebAdapter();
}

export interface CliCommands {
  record(caseId: string, options: { allowIdentical: boolean }): Promise<void>;
  verify(): Promise<VerificationReport>;
  publish(pr: string): Promise<void>;
  create(input: NewCaseInput): Promise<void>;
  iosLogin(device: string | undefined): Promise<{ path: string; expiresAt: Date | null }>;
}

const USAGE = [
  "usage: ux-evidence [--repo <path> | -C <path>] <command>",
  "  ux-evidence record --case <id> [--allow-identical]",
  "  ux-evidence verify",
  "  ux-evidence publish --pr <number>",
  "  ux-evidence new --case <id> --classification <visual|functional> --before <required|not-applicable> [--start-path <path>] [--reason <text>]  (--start-path: web only)",
  "  ux-evidence ios-login [--device <udid>]",
];

const CLASSIFICATIONS: readonly string[] = ["visual", "functional"];
const BEFORE_POLICIES: readonly string[] = ["required", "not-applicable"];

function parseFlags(args: readonly string[]): Map<string, string> | undefined {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) return undefined;
    flags.set(name.slice(2), value);
  }
  return flags;
}

function errorExitCode(error: unknown): number {
  const code = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof code === "number" ? code : 1;
}

const REPO_FLAGS: readonly string[] = ["--repo", "-C"];

export function parseInvocation(
  argv: readonly string[],
  cwd: string,
): { repoRoot: string; args: string[] } | undefined {
  let repoRoot: string | undefined;
  let index = 0;
  while (REPO_FLAGS.includes(argv[index] ?? "")) {
    const value = argv[index + 1];
    if (value === undefined) return undefined;
    const selected = resolve(cwd, value);
    if (repoRoot !== undefined && repoRoot !== selected) return undefined;
    repoRoot = selected;
    index += 2;
  }
  return { repoRoot: repoRoot ?? resolve(cwd), args: argv.slice(index) };
}

function printUsage(print: (line: string) => void): number {
  for (const line of USAGE) print(line);
  return 2;
}

export async function run(
  argv: readonly string[],
  cwd: string,
  wire: (repoRoot: string) => CliCommands,
  print: (line: string) => void,
): Promise<number> {
  const invocation = parseInvocation(argv, cwd);
  if (invocation === undefined) return printUsage(print);
  return main(invocation.args, wire(invocation.repoRoot), print);
}

export async function main(
  argv: readonly string[],
  commands: CliCommands,
  print: (line: string) => void,
): Promise<number> {
  const [command, ...allArgs] = argv;
  const allowIdentical = command === "record" && allArgs.includes("--allow-identical");
  const rest = allowIdentical ? allArgs.filter((arg) => arg !== "--allow-identical") : allArgs;
  const flags = parseFlags(rest);
  const usage = (): number => printUsage(print);
  if (flags === undefined) return usage();

  try {
    switch (command) {
      case "record": {
        const caseId = flags.get("case");
        if (caseId === undefined) return usage();
        assertValidCaseId(caseId);
        await commands.record(caseId, { allowIdentical });
        return 0;
      }
      case "publish": {
        const pr = flags.get("pr");
        if (pr === undefined) return usage();
        await commands.publish(pr);
        return 0;
      }
      case "verify": {
        if (rest.length > 0) return usage();
        const report = await commands.verify();
        for (const c of report.cases) print(`${c.caseId}: ${c.current ? "current" : "stale"} — ${c.reason}`);
        if (report.missingEvidenceForClientChanges) print(MISSING_EVIDENCE_MESSAGE);
        return report.current ? 0 : 1;
      }
      case "new": {
        const id = flags.get("case");
        const classification = flags.get("classification");
        const before = flags.get("before");
        const startPath = flags.get("start-path");
        if (id === undefined) return usage();
        assertValidCaseId(id);
        if (classification === undefined || !CLASSIFICATIONS.includes(classification)) return usage();
        if (before === undefined || !BEFORE_POLICIES.includes(before)) return usage();
        await commands.create({
          id,
          classification: classification as EvidenceClassification,
          beforePolicy: before as BeforePolicy,
          reason: flags.get("reason") ?? null,
          ...(startPath === undefined ? {} : { startPath }),
        });
        return 0;
      }
      case "ios-login": {
        if ([...flags.keys()].some((name) => name !== "device")) return usage();
        const saved = await commands.iosLogin(flags.get("device"));
        print(saved.path);
        print(saved.expiresAt === null ? "expiry: not supplied" : `expiry: ${saved.expiresAt.toISOString()}`);
        print("session validated");
        return 0;
      }
      default:
        return usage();
    }
  } catch (error) {
    print(`error: ${error instanceof Error ? error.message : String(error)}`);
    return errorExitCode(error);
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export function wireCommands(repoRoot: string): CliCommands {
  const readTextFile = (path: string) => readFile(path, "utf8");
  const makeDirectory = async (path: string) => { await mkdir(path, { recursive: true }); };
  const writeTextFile = async (path: string, content: string) => { await makeDirectory(dirname(path)); await writeFile(path, content); };
  const checksumFile = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const verifyDependencies: VerifyDependencies = { exec: realExec, readTextFile, fileExists: exists, checksumFile };
  const config = () => loadConfig(repoRoot, readTextFile);

  return {
    verify: async () => verifyEvidence({ repoRoot, config: await config() }, verifyDependencies),
    publish: async (pr) => publishEvidence({ repoRoot, config: await config(), pr }, verifyDependencies),
    create: async (input) => {
      const loadedConfig = await config();
      const adapter = await loadPlatformAdapter(loadedConfig.platform);
      const created = await createEvidenceCase({ ...input, repoRoot }, {
        fileExists: exists,
        makeDirectory,
        writeTextFile,
        renderCase: (caseInput) => adapter.renderCase(caseInput, loadedConfig),
      });
      for (const path of created) console.log(path);
    },
    iosLogin: async (device) => {
      const loadedConfig = await config();
      if (loadedConfig.platform !== "ios") throw new Error("ios-login needs a repository whose qa/ux/config.yaml has platform: ios");
      const { captureSession, realAuthorizedGet, realSessionFiles } = await import("./ios/session.ts");
      return captureSession(loadedConfig.ios, device, {
        exec: realExec,
        files: realSessionFiles,
        get: realAuthorizedGet,
        now: () => new Date(),
        homeDirectory: homedir(),
      });
    },
    record: async (caseId, { allowIdentical }) => {
      const loadedConfig = await config();
      const adapter = await loadPlatformAdapter(loadedConfig.platform);
      await runWithSignalCleanup(async (cleanup) => {
        await recordEvidenceCase({ repoRoot, caseId, config: loadedConfig, allowIdentical }, {
          exec: realExec,
          stat: realStat,
          readTextFile,
          adapter,
          cleanup,
          encodeVideo,
          composeComparisonPng,
          writeTextFile,
          removeFile: (path) => rm(path, { force: true }),
          clearDirectory: (path) => clearArtifactDirectory(repoRoot, path),
          makeRunDirectory: (platform, runId) => makeRunDirectory(platform, runId),
          removeDirectory: (path) => rm(path, { recursive: true, force: true }),
          imagesIdentical: (leftPath, rightPath) => pixelsIdentical(leftPath, rightPath, realExec),
          checksumFile,
          toolCommit: () => readToolCommit(realExec),
          now: () => new Date(),
        });
        console.log(join(repoRoot, ".qa-artifacts", caseId, "comment.md"));
      });
    },
  };
}
