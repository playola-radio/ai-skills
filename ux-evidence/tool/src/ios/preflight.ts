import { join } from "node:path";
import type { IOSSettings } from "../core/config.ts";
import type { Exec } from "../core/effects.ts";
import type { IOSEnvironment } from "../core/results.ts";
import { maestroEnvironment } from "./maestro.ts";
import { developerEnvironment, simctl } from "./simulator.ts";

const SETUP_HINT = "see qa/ux/README.md";

export function runLockPath(homeDirectory: string): string {
  return join(homeDirectory, ".cache", "playola-ux", "ios", "record.lock");
}

export interface LockFiles {
  makeDirectory(path: string): Promise<void>;
  // Resolves false when the file already exists.
  createExclusive(path: string, content: string): Promise<boolean>;
  readText(path: string): Promise<string | undefined>;
  remove(path: string): Promise<void>;
}

// One iOS recording at a time: runs share the SPM cache and the simulator service. A lock left by a
// process that no longer exists is taken over.
export async function acquireRunLock(
  path: string,
  pid: number,
  dependencies: { files: LockFiles; isProcessAlive(pid: number): boolean },
): Promise<() => Promise<void>> {
  const { files } = dependencies;
  await files.makeDirectory(join(path, ".."));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await files.createExclusive(path, `${pid}\n`)) {
      let released: Promise<void> | undefined;
      return () => (released ??= (async () => {
        if ((await files.readText(path))?.trim() === String(pid)) await files.remove(path);
      })());
    }
    const holder = Number.parseInt((await files.readText(path)) ?? "", 10);
    if (Number.isInteger(holder) && holder > 0 && dependencies.isProcessAlive(holder)) {
      throw new Error(`another iOS recording is running (pid ${holder}); wait for it to finish`);
    }
    await files.remove(path);
  }
  throw new Error(`could not take the iOS recording lock at ${path}`);
}

async function firstLine(exec: Exec, command: string, args: readonly string[], env: NodeJS.ProcessEnv, fix: string): Promise<string> {
  let result;
  try {
    result = await exec(command, args, { env });
  } catch (error) {
    throw new Error(`${command} is not runnable (${error instanceof Error ? error.message : String(error)}); ${fix}`);
  }
  if (result.exitCode !== 0) throw new Error(`${command} is not runnable (exit ${result.exitCode}); ${fix}`);
  return (result.stdout.trim() || result.stderr.trim()).split("\n")[0]!.trim();
}

interface SimctlRuntime { identifier: string; isAvailable: boolean; supportedDeviceTypes?: Array<{ identifier: string }> }

async function assertDevicePinAvailable(settings: IOSSettings, exec: Exec): Promise<void> {
  const { runtimes } = JSON.parse(await simctl(settings, exec, ["list", "runtimes", "-j"])) as { runtimes: SimctlRuntime[] };
  const matching = runtimes.filter((runtime) => runtime.identifier === settings.runtime && runtime.isAvailable);
  if (matching.length === 0) {
    throw new Error(`simulator runtime ${settings.runtime} is not installed in ${settings.xcodePath}; install it from Xcode > Settings > Components`);
  }
  const supported = matching.some((runtime) =>
    (runtime.supportedDeviceTypes ?? []).some((deviceType) => deviceType.identifier === settings.deviceType));
  if (!supported) throw new Error(`simulator runtime ${settings.runtime} cannot run ${settings.deviceType}; change ios.deviceType or ios.runtime`);
}

export async function checkIOSTools(
  settings: IOSSettings,
  exec: Exec,
): Promise<{ environment: IOSEnvironment; tools: Record<string, string> }> {
  const xcode = await firstLine(exec, "xcodebuild", ["-version"], developerEnvironment(settings), `install Xcode at ${settings.xcodePath}`);
  const xcodeVersion = xcode.replace(/^Xcode\s+/, "");
  const maestro = await firstLine(exec, settings.maestroPath, ["--version"], maestroEnvironment(settings), `install Maestro at ${settings.maestroPath}; ${SETUP_HINT}`);
  const java = await firstLine(exec, join(settings.javaHome, "bin", "java"), ["-version"], process.env, `install Java 17 at ${settings.javaHome}; ${SETUP_HINT}`);
  const ffmpeg = await firstLine(exec, "ffmpeg", ["-version"], process.env, `install ffmpeg; ${SETUP_HINT}`);
  await assertDevicePinAvailable(settings, exec);
  return {
    environment: { deviceType: settings.deviceType, runtime: settings.runtime, xcodeVersion, apiHost: settings.apiHost },
    tools: { node: process.version, xcode, maestro, java, ffmpeg },
  };
}
