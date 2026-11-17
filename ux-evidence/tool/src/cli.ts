import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { chromium } from "playwright";
import { dirname, join, resolve } from "node:path";
import { clearArtifactDirectory } from "./core/artifacts.ts";
import { assertValidCaseId } from "./core/case-id.ts";
import type { BeforePolicy, EvidenceClassification } from "./core/domain.ts";
import { captureRevision } from "./web/browser.ts";
import { runWithSignalCleanup } from "./core/cleanup.ts";
import { createEvidenceCase, type NewCaseInput } from "./core/commands/new.ts";
import { MISSING_EVIDENCE_MESSAGE, publishEvidence } from "./core/commands/publish.ts";
import { recordEvidenceCase, type RecordDependencies } from "./core/commands/record.ts";
import { verifyEvidence, type VerificationReport, type VerifyDependencies } from "./core/commands/verify.ts";
import { realExec, realHttpGet, realIsPortAvailable, realStat } from "./core/effects.ts";
import { loadEvidenceFlow } from "./web/flows.ts";
import { composeComparisonPng, encodeVideo } from "./core/media.ts";
import { withRevisionStack } from "./web/stack.ts";
import { collectToolVersions } from "./web/tools.ts";

export async function makeEvidenceTemporaryDirectory(prefix: string, home = homedir()): Promise<string> {
  const root = join(home, ".cache", "playola-ux");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

export interface CliCommands {
  record(caseId: string, options: { allowIdentical: boolean }): Promise<void>;
  verify(): Promise<VerificationReport>;
  publish(pr: string): Promise<void>;
  create(input: NewCaseInput): Promise<void>;
}

const USAGE = [
  "usage: ux-evidence [--repo <path> | -C <path>] <command>",
  "  ux-evidence record --case <id> [--allow-identical]",
  "  ux-evidence verify",
  "  ux-evidence publish --pr <number>",
  "  ux-evidence new --case <id> --classification <visual|functional> --before <required|not-applicable> --start-path <path> [--reason <text>]",
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
        if (id === undefined || startPath === undefined) return usage();
        assertValidCaseId(id);
        if (classification === undefined || !CLASSIFICATIONS.includes(classification)) return usage();
        if (before === undefined || !BEFORE_POLICIES.includes(before)) return usage();
        await commands.create({
          id,
          classification: classification as EvidenceClassification,
          beforePolicy: before as BeforePolicy,
          reason: flags.get("reason") ?? null,
          startPath,
        });
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
  const checksumFile = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const verifyDependencies: VerifyDependencies = { exec: realExec, readTextFile, fileExists: exists, checksumFile };

  return {
    verify: () => verifyEvidence({ repoRoot }, verifyDependencies),
    publish: (pr) => publishEvidence({ repoRoot, pr }, verifyDependencies),
    create: async (input) => {
      const created = await createEvidenceCase({ ...input, repoRoot }, {
        fileExists: exists,
        makeDirectory,
        writeTextFile: async (path, content) => { await makeDirectory(dirname(path)); await writeFile(path, content); },
      });
      console.log(created.manifestPath);
      console.log(created.flowPath);
    },
    record: async (caseId, { allowIdentical }) => {
      await runWithSignalCleanup(async (cleanup) => {
        const dependencies: RecordDependencies = {
          exec: realExec,
          stat: realStat,
          readTextFile,
          fileExists: exists,
          withRevisionStack,
          stackDependencies: {
            exec: realExec,
            httpGet: realHttpGet,
            isPortAvailable: realIsPortAvailable,
            makeTemporaryDirectory: (prefix) => makeEvidenceTemporaryDirectory(prefix),
            removeDirectory: (path) => rm(path, { recursive: true, force: true }),
            listMigrationFiles: (worktreePath) => readdir(join(worktreePath, "server", "src", "db", "migrations")),
            cleanup,
          },
          captureRevision,
          loadEvidenceFlow,
          encodeVideo,
          composeComparisonPng,
          writeTextFile: async (path, content) => { await makeDirectory(dirname(path)); await writeFile(path, content); },
          removeFile: (path) => rm(path, { force: true }),
          clearDirectory: (path) => clearArtifactDirectory(repoRoot, path),
          filesIdentical: async (leftPath, rightPath) => (await readFile(leftPath)).equals(await readFile(rightPath)),
          checksumFile,
          toolVersions: () => collectToolVersions({
            exec: realExec,
            playwrightVersion: async () => (JSON.parse(
              await readFile(join(import.meta.dirname, "..", "node_modules", "playwright", "package.json"), "utf8"),
            ) as { version: string }).version,
            chromiumExecutablePath: () => chromium.executablePath(),
            fileExists: exists,
            nodeVersion: process.version,
          }),
          now: () => new Date(),
        };
        await recordEvidenceCase(
          { repoRoot, caseId, environment: process.env, homeDirectory: homedir(), allowIdentical },
          dependencies,
        );
        console.log(join(repoRoot, ".qa-artifacts", caseId, "comment.md"));
      });
    },
  };
}
