import { basename, join } from "node:path";
import type { IOSConfig, IOSSettings } from "../core/config.ts";
import type { RevisionName } from "../core/domain.ts";
import type { Exec } from "../core/effects.ts";
import type { RecordContext } from "../core/platform.ts";

function tail(text: string, lineCount: number): string {
  return text.trimEnd().split("\n").slice(-lineCount).join("\n");
}

export function developerEnvironment(settings: IOSSettings, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, DEVELOPER_DIR: join(settings.xcodePath, "Contents", "Developer") };
}

export async function simctl(settings: IOSSettings, exec: Exec, args: readonly string[]): Promise<string> {
  const result = await exec("xcrun", ["simctl", ...args], { env: developerEnvironment(settings) });
  if (result.exitCode !== 0) {
    throw new Error(`simctl ${args[0]} failed (exit ${result.exitCode}): ${tail(result.stderr || result.stdout, 10)}`);
  }
  return result.stdout;
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

export interface SimulatorDependencies {
  exec: Exec;
  teardownExec: Exec;
  stopChildren(): Promise<void>;
  writeSession(containerPath: string, sessionJson: string): Promise<void>;
}

function iosSettings(context: RecordContext): IOSSettings {
  if (context.config.platform !== "ios") throw new Error(`the iOS adapter cannot record ${context.config.platform} cases`);
  return (context.config as IOSConfig).ios;
}

// Every simctl call names the device this function created; nothing here addresses "booted" or "all".
export async function withIOSSimulator<T>(
  input: { context: RecordContext; revision: RevisionName; appPath: string; sessionJson: string },
  dependencies: SimulatorDependencies,
  use: (udid: string) => Promise<T>,
): Promise<T> {
  const { context, revision, appPath, sessionJson } = input;
  const settings = iosSettings(context);
  const run = (args: readonly string[]) => {
    if (context.cleanup.signal.aborted) throw new Error(`interrupted before finishing the ${revision} simulator`);
    return simctl(settings, dependencies.exec, args);
  };

  const name = `playola-ux-${basename(context.runDirectory)}-${revision}`;
  if (context.cleanup.signal.aborted) throw new Error(`interrupted before creating the ${revision} simulator`);
  // Created without the cancellable runner: an interrupt mid-create must not lose the new device's id.
  const udid = (await simctl(settings, dependencies.teardownExec, ["create", name, settings.deviceType, settings.runtime])).trim();
  if (!UDID.test(udid)) throw new Error(`simctl create returned an unexpected device id: ${udid}`);

  let teardown: Promise<void> | undefined;
  const removeSimulator = () => (teardown ??= (async () => {
    await dependencies.stopChildren();
    await simctl(settings, dependencies.teardownExec, ["terminate", udid, settings.bundleId]).catch(() => undefined);
    await simctl(settings, dependencies.teardownExec, ["shutdown", udid]).catch(() => undefined);
    await simctl(settings, dependencies.teardownExec, ["delete", udid]);
  })());
  context.cleanup.add(removeSimulator);

  try {
    await run(["boot", udid]);
    await run(["bootstatus", udid, "-b"]);
    await run(["ui", udid, "appearance", "light"]);
    await run([
      "status_bar", udid, "override", "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100",
      "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4",
    ]);
    await run(["install", udid, appPath]);
    const container = (await run(["get_app_container", udid, settings.bundleId, "data"])).trim();
    await dependencies.writeSession(container, sessionJson);
    return await use(udid);
  } finally {
    await removeSimulator();
  }
}
