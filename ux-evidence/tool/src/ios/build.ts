import { join, posix } from "node:path";
import type { IOSConfig, IOSSettings } from "../core/config.ts";
import type { RevisionName } from "../core/domain.ts";
import type { Exec } from "../core/effects.ts";
import type { RecordContext } from "../core/platform.ts";
import { developerEnvironment } from "./simulator.ts";

// The four files scripts/setup-secrets.sh copies; unlike that script, a missing one is an error.
export const SECRETS_FILES = [
  "Secrets.xcconfig",
  "Secrets-Local.xcconfig",
  "Secrets-Development.xcconfig",
  "Secrets-Staging.xcconfig",
] as const;
const SECRETS_DIRECTORY = join("PlayolaRadio", "Config");

export function sharedPackageCache(homeDirectory: string): string {
  return join(homeDirectory, ".cache", "playola-ux", "ios", "spm");
}

export interface BuildDependencies {
  exec: Exec;
  teardownExec: Exec;
  stopChildren(): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  copyFile(source: string, destination: string): Promise<void>;
  writeTextFile(path: string, content: string): Promise<void>;
  homeDirectory: string;
}

function tail(text: string, lineCount: number): string {
  return text.trimEnd().split("\n").slice(-lineCount).join("\n");
}

export async function assertSecretsPresent(settings: IOSSettings, fileExists: (path: string) => Promise<boolean>): Promise<void> {
  for (const file of SECRETS_FILES) {
    const path = join(settings.secretsSource, SECRETS_DIRECTORY, file);
    if (!(await fileExists(path))) {
      throw new Error(`missing ${file} in ${join(settings.secretsSource, SECRETS_DIRECTORY)}; the iOS build needs all four Secrets*.xcconfig files`);
    }
  }
}

// xcodebuild arguments from the design, minus "-sdk iphonesimulator": with it, Swift macro plugins are
// built for the simulator and cannot run on the Mac, so the build fails. The destination picks the SDK.
export function xcodebuildArguments(settings: IOSSettings, derivedDataPath: string, packageCachePath: string): string[] {
  return [
    "-project", settings.project,
    "-scheme", settings.scheme,
    "-configuration", settings.configuration,
    "-destination", "generic/platform=iOS Simulator",
    "-derivedDataPath", derivedDataPath,
    "-clonedSourcePackagesDirPath", packageCachePath,
    "-skipMacroValidation", "-skipPackagePluginValidation",
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ];
}

function iosConfig(context: RecordContext): IOSConfig {
  if (context.config.platform !== "ios") throw new Error(`the iOS adapter cannot record ${context.config.platform} cases`);
  return context.config;
}

export function revisionsToBuild(context: RecordContext): readonly RevisionName[] {
  return context.manifest.before.policy === "required" ? ["base", "head"] : ["head"];
}

// Builds every applicable revision before anything is captured, base first. A failed base build stops
// the run; head is never built in its place. Worktrees are removed by the cleanup registered here.
export async function buildIOSRevisions(
  context: RecordContext,
  dependencies: BuildDependencies,
): Promise<ReadonlyMap<RevisionName, string>> {
  const settings = iosConfig(context).ios;
  const { repoRoot, runDirectory, cleanup } = context;

  const built = new Map<RevisionName, string>();
  for (const revision of revisionsToBuild(context)) {
    if (cleanup.signal.aborted) throw new Error(`interrupted before building ${revision}`);
    const revisionDirectory = posix.join(runDirectory, revision);
    const worktreePath = posix.join(revisionDirectory, "wt");
    let removal: Promise<void> | undefined;
    cleanup.add(() => (removal ??= (async () => {
      await dependencies.stopChildren();
      const result = await dependencies.teardownExec("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
      if (result.exitCode !== 0 && !result.stderr.includes("is not a working tree")) {
        throw new Error(`git worktree remove ${worktreePath} failed: ${tail(result.stderr, 5)}`);
      }
    })()));

    const added = await dependencies.exec("git", ["worktree", "add", "--detach", worktreePath, context.commits[revision]], { cwd: repoRoot });
    if (added.exitCode !== 0) throw new Error(`git worktree add for ${revision} failed: ${tail(added.stderr, 5)}`);
    for (const file of SECRETS_FILES) {
      await dependencies.copyFile(join(settings.secretsSource, SECRETS_DIRECTORY, file), join(worktreePath, SECRETS_DIRECTORY, file));
    }

    const derivedDataPath = posix.join(revisionDirectory, "DerivedData");
    const result = await dependencies.exec(
      "xcodebuild",
      xcodebuildArguments(settings, derivedDataPath, sharedPackageCache(dependencies.homeDirectory)),
      { cwd: worktreePath, env: developerEnvironment(settings) },
    );
    if (result.exitCode !== 0) {
      const logPath = posix.join(context.artifactDirectory, `build-${revision === "base" ? "before" : "after"}.log`);
      await dependencies.writeTextFile(logPath, `${result.stdout}\n${result.stderr}`);
      const errors = `${result.stdout}\n${result.stderr}`.split("\n").filter((line) => line.includes("error:")).slice(0, 5).join("\n");
      throw new Error(`${revision} build failed (exit ${result.exitCode}); log kept at ${logPath}${errors ? `\n${errors}` : ""}`);
    }
    const appPath = posix.join(derivedDataPath, "Build", "Products", `${settings.configuration}-iphonesimulator`, settings.productName);
    if (!(await dependencies.fileExists(appPath))) throw new Error(`${revision} build succeeded but ${appPath} is missing`);
    built.set(revision, appPath);
  }
  return built;
}
