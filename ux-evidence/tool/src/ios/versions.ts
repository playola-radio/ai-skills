import { join } from "node:path";
import { exactIOSConfig, type IOSConfig, type WrittenIOSConfig } from "../core/config.ts";
import type { Exec } from "../core/effects.ts";
import { developerEnvironment, simctl } from "./simulator.ts";

const APPLICATIONS = "/Applications";
const IOS_RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+(?:-\d+)*)$/;

export interface VersionDependencies {
  exec: Exec;
  listDirectory(path: string): Promise<readonly string[]>;
}

interface SimctlRuntime { identifier: string; isAvailable: boolean; supportedDeviceTypes?: Array<{ identifier: string }> }

function numbers(version: string): number[] {
  return version.split(/[.-]/).map(Number);
}

function newestFirst(left: string, right: string): number {
  const [a, b] = [numbers(left), numbers(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Asks each Xcode in /Applications for its own version, so the folder's name does not matter.
async function newestXcode(major: string, { exec, listDirectory }: VersionDependencies): Promise<string> {
  const installed: Array<{ path: string; version: string }> = [];
  for (const name of await listDirectory(APPLICATIONS)) {
    if (!/^Xcode.*\.app$/.test(name)) continue;
    const path = join(APPLICATIONS, name);
    const result = await exec("xcodebuild", ["-version"], { env: developerEnvironment({ xcodePath: path }) }).catch(() => undefined);
    const version = result?.exitCode === 0 ? /^Xcode (\d+(?:\.\d+)*)/.exec(result.stdout)?.[1] : undefined;
    if (version !== undefined) installed.push({ path, version });
  }
  const [newest] = installed.filter(({ version }) => numbers(version)[0] === Number(major)).sort((a, b) => newestFirst(a.version, b.version));
  if (newest === undefined) {
    const found = installed.map(({ version }) => version).join(", ") || "none";
    throw new Error(`no Xcode ${major} is installed in ${APPLICATIONS} (found ${found}); install any Xcode ${major}`);
  }
  return newest.path;
}

async function newestRuntime(major: string, deviceType: string, xcodePath: string, exec: Exec): Promise<string> {
  const { runtimes } = JSON.parse(await simctl({ xcodePath }, exec, ["list", "runtimes", "-j"])) as { runtimes: SimctlRuntime[] };
  const [newest] = runtimes
    .filter((runtime) => runtime.isAvailable && (runtime.supportedDeviceTypes ?? []).some(({ identifier }) => identifier === deviceType))
    .map((runtime) => ({ identifier: runtime.identifier, version: IOS_RUNTIME.exec(runtime.identifier)?.[1] }))
    .filter((runtime): runtime is { identifier: string; version: string } => runtime.version !== undefined && numbers(runtime.version)[0] === Number(major))
    .sort((a, b) => newestFirst(a.version, b.version));
  if (newest === undefined) {
    throw new Error(`no iOS ${major} simulator runtime that can run ${deviceType} is installed for ${xcodePath}; install one with: xcodebuild -downloadPlatform iOS`);
  }
  return newest.identifier;
}

// Turns "any Xcode 27" and "any iOS 27" into the newest of each installed here. Exact settings pass through.
export async function findInstalledVersions(config: WrittenIOSConfig, dependencies: VersionDependencies): Promise<IOSConfig> {
  const { xcodeVersion, iosVersion, ...written } = config.ios;
  const xcodePath = written.xcodePath ?? await newestXcode(xcodeVersion!, dependencies);
  const runtime = written.runtime ?? await newestRuntime(iosVersion!, written.deviceType, xcodePath, dependencies.exec);
  return exactIOSConfig({ ...config, ios: { ...written, xcodePath, runtime } });
}
