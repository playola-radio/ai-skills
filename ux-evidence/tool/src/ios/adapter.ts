import { posix } from "node:path";
import { createCleanupRegistry } from "../core/cleanup.ts";
import type { IOSConfig } from "../core/config.ts";
import type { RevisionName } from "../core/domain.ts";
import type { Exec, OwnedProcesses } from "../core/effects.ts";
import type { PlatformAdapter, RecordContext } from "../core/platform.ts";
import type { IOSEnvironment } from "../core/results.ts";
import type { buildIOSRevisions, BuildDependencies } from "./build.ts";
import { assertSecretsPresent } from "./build.ts";
import {
  declaredScreenshotNames,
  renderMaestroWrapper,
  type collectScreenshots,
  type runMaestro,
  type ScreenshotFiles,
} from "./maestro.ts";
import { acquireRunLock, runLockDirectory, type LockFiles } from "./preflight.ts";
import { loadSavedSession, type SessionDependencies } from "./session.ts";
import type { SimulatorDependencies, withIOSSimulator } from "./simulator.ts";

export interface IOSAdapterDependencies {
  homeDirectory: string;
  pid: number;
  ownProcesses(signal: AbortSignal): OwnedProcesses;
  teardownExec: Exec;
  lockFiles: LockFiles;
  isProcessAlive(pid: number): boolean;
  session: Omit<SessionDependencies, "exec" | "homeDirectory">;
  checkTools(config: IOSConfig, exec: Exec): Promise<{ environment: IOSEnvironment; tools: Record<string, string> }>;
  fileExists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
  moveFile(source: string, destination: string): Promise<void>;
  writeSession: SimulatorDependencies["writeSession"];
  screenshotFiles: ScreenshotFiles;
  buildIOSRevisions: typeof buildIOSRevisions;
  withIOSSimulator: typeof withIOSSimulator;
  runMaestro: typeof runMaestro;
  collectScreenshots: typeof collectScreenshots;
}

const NOT_YET = "iOS functional (video) cases are not yet supported; use a visual case";

function iosConfig(context: RecordContext): IOSConfig {
  if (context.config.platform !== "ios") throw new Error(`the iOS adapter cannot record ${context.config.platform} cases`);
  return context.config;
}

const OUTPUT_PREFIX: Record<RevisionName, string> = { base: "before", head: "after" };

export function createIOSAdapter(dependencies: IOSAdapterDependencies): PlatformAdapter {
  let run: { processes: OwnedProcesses; owned: ReturnType<typeof createCleanupRegistry>; dispose(): Promise<void>; sessionJson: string } | undefined;

  return {
    async preflight(context) {
      const config = iosConfig(context);
      if (context.manifest.classification === "functional") throw new Error(NOT_YET);
      // dispose, a failed prepare and an interrupt all share this one teardown, run once.
      const owned = createCleanupRegistry(context.cleanup.signal);
      let teardown: Promise<void> | undefined;
      const dispose = () => (teardown ??= owned.run());
      context.cleanup.add(dispose);
      const release = await acquireRunLock(runLockDirectory(dependencies.homeDirectory), dependencies.pid, {
        files: dependencies.lockFiles,
        isProcessAlive: dependencies.isProcessAlive,
      });
      owned.add(release);
      try {
        const processes = dependencies.ownProcesses(context.cleanup.signal);
        const checked = await dependencies.checkTools(config, processes.exec);
        await assertSecretsPresent(config.ios, dependencies.fileExists);
        const session = await loadSavedSession(config.ios, { ...dependencies.session, homeDirectory: dependencies.homeDirectory });
        run = { processes, owned, dispose, sessionJson: session.json };
        return checked;
      } catch (error) {
        await dispose();
        throw error;
      }
    },

    async prepare(context) {
      const config = iosConfig(context);
      if (run === undefined) throw new Error("the iOS adapter must run preflight before prepare");
      const { processes, owned, dispose, sessionJson } = run;
      const ownedContext: RecordContext = { ...context, cleanup: owned };
      try {
        const setupPath = posix.join(context.caseDirectory, "setup.yaml");
        const flowPath = posix.join(context.caseDirectory, "flow.yaml");
        const names = declaredScreenshotNames(await dependencies.readTextFile(flowPath), flowPath);
        if (names.length === 0) throw new Error(`${flowPath} must take at least one screenshot (takeScreenshot: <name>)`);
        const setup = (await dependencies.fileExists(setupPath)) ? setupPath : undefined;

        const buildDependencies: BuildDependencies = {
          exec: processes.exec,
          teardownExec: dependencies.teardownExec,
          stopChildren: processes.stopAll,
          fileExists: dependencies.fileExists,
          copyFile: dependencies.copyFile,
          writeTextFile: dependencies.writeTextFile,
          homeDirectory: dependencies.homeDirectory,
        };
        const apps = await dependencies.buildIOSRevisions(ownedContext, buildDependencies);
        const simulatorDependencies: SimulatorDependencies = {
          exec: processes.exec,
          teardownExec: dependencies.teardownExec,
          stopChildren: processes.stopAll,
          writeSession: dependencies.writeSession,
        };

        return {
          async capture(revision) {
            const appPath = apps.get(revision);
            if (appPath === undefined) throw new Error(`${revision} was not built`);
            const revisionDirectory = posix.join(context.runDirectory, revision);
            const wrapperPath = posix.join(revisionDirectory, "wrapper.yaml");
            const outputDirectory = posix.join(revisionDirectory, "maestro");
            await dependencies.writeTextFile(wrapperPath, renderMaestroWrapper(config.ios.bundleId, setup, flowPath));
            const shots = await dependencies.withIOSSimulator(
              { context: ownedContext, revision, appPath, sessionJson },
              simulatorDependencies,
              async (udid) => {
                await dependencies.runMaestro({ settings: config.ios, udid, wrapperPath, outputDirectory }, processes.exec);
                return dependencies.collectScreenshots(outputDirectory, names, dependencies.screenshotFiles);
              },
            );
            const screenshots = new Map<string, string>();
            for (const [name, source] of shots) {
              const destination = posix.join(context.artifactDirectory, `${OUTPUT_PREFIX[revision]}-${name}.png`);
              await dependencies.moveFile(source, destination);
              screenshots.set(name, destination);
            }
            return { screenshots, warnings: [] };
          },
          dispose,
        };
      } catch (error) {
        await dispose();
        throw error;
      }
    },

    renderCase() {
      throw new Error("creating iOS cases with `new` is not yet supported; copy qa/ux/example-stations instead");
    },
  };
}
