import { basename, join } from "node:path";
import { exactIOSConfig, type IOSSettings } from "../core/config.ts";
import type { RevisionName } from "../core/domain.ts";
import type { Exec } from "../core/effects.ts";
import type { RecordContext } from "../core/platform.ts";

function tail(text: string, lineCount: number): string {
  return text.trimEnd().split("\n").slice(-lineCount).join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function developerEnvironment(settings: Pick<IOSSettings, "xcodePath">): NodeJS.ProcessEnv {
  return { ...process.env, DEVELOPER_DIR: join(settings.xcodePath, "Contents", "Developer") };
}

export async function simctl(settings: Pick<IOSSettings, "xcodePath">, exec: Exec, args: readonly string[]): Promise<string> {
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
  stopTeardownChildren(): Promise<void>;
  stopChildren(): Promise<void>;
  writeSession(containerPath: string, sessionJson: string): Promise<void>;
  teardownTimeoutMs?: number;
  warn?(message: string): void;
}

const TEARDOWN_TIMEOUT_MS = 5000;

class TeardownTimeoutError extends Error {}

function iosSettings(context: RecordContext): IOSSettings {
  if (context.config.platform !== "ios") throw new Error(`the iOS adapter cannot record ${context.config.platform} cases`);
  return exactIOSConfig(context.config).ios;
}

// Every simctl call names the device this function created; nothing here addresses "booted" or "all".
export async function withIOSSimulator<T>(
  input: { context: RecordContext; revision: RevisionName; appPath: string; sessionJson: string },
  dependencies: SimulatorDependencies,
  use: (udid: string) => Promise<T>,
): Promise<T> {
  const { context, revision, appPath, sessionJson } = input;
  const settings = iosSettings(context);
  const teardownTimeoutMs = dependencies.teardownTimeoutMs ?? TEARDOWN_TIMEOUT_MS;
  const warn = dependencies.warn ?? ((message: string) => { process.stderr.write(`${message}\n`); });
  const run = (args: readonly string[]) => {
    if (context.cleanup.signal.aborted) throw new Error(`interrupted before finishing the ${revision} simulator`);
    return simctl(settings, dependencies.exec, args);
  };

  const name = `playola-ux-${basename(context.runDirectory)}-${revision}`;
  if (context.cleanup.signal.aborted) throw new Error(`interrupted before creating the ${revision} simulator`);
  // Created without the cancellable runner, and its deletion registered first and waiting on it, so an
  // interrupt mid-create still deletes the device once it exists.
  const created = simctl(settings, dependencies.teardownExec, ["create", name, settings.deviceType, settings.runtime])
    .then((stdout) => stdout.trim());
  const boundedTeardown = async (args: readonly string[], device: string): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        simctl(settings, dependencies.teardownExec, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TeardownTimeoutError()), teardownTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (!(error instanceof TeardownTimeoutError)) throw error;
      await dependencies.stopTeardownChildren();
      warn(`warning: simctl ${args[0]} timed out for device ${device}; continuing cleanup`);
    } finally {
      clearTimeout(timer);
    }
  };
  let teardown: Promise<void> | undefined;
  const removeSimulator = () => (teardown ??= (async () => {
    let createTimer: ReturnType<typeof setTimeout> | undefined;
    const udid = await Promise.race([
      created.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        createTimer = setTimeout(() => resolve(undefined), teardownTimeoutMs);
      }),
    ]);
    clearTimeout(createTimer);
    if (udid === undefined) {
      await dependencies.stopTeardownChildren();
      warn(`warning: simctl create did not return a device id during cleanup for ${name}; continuing cleanup`);
      return;
    }
    if (!UDID.test(udid)) return;
    await dependencies.stopChildren();
    await boundedTeardown(["terminate", udid, settings.bundleId], udid).catch(() => undefined);
    await boundedTeardown(["shutdown", udid], udid).catch(() => undefined);
    await boundedTeardown(["delete", udid], udid);
  })());
  context.cleanup.add(removeSimulator);

  const udid = await created;
  if (!UDID.test(udid)) throw new Error(`simctl create returned an unexpected device id: ${udid}`);

  let value: T | undefined;
  let captureError: unknown;
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
    value = await use(udid);
  } catch (error) {
    captureError = error;
  }
  try {
    await removeSimulator();
  } catch (removalError) {
    if (captureError !== undefined) {
      throw new AggregateError(
        [captureError, removalError],
        `${messageOf(captureError)}; simulator ${udid} cleanup also failed: ${messageOf(removalError)}`,
      );
    }
    throw removalError;
  }
  if (captureError !== undefined) throw captureError;
  return value as T;
}
