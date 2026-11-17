import { posix } from "node:path";
import { createCleanupRegistry } from "../core/cleanup.ts";
import type { EvidenceConfig, IOSConfig } from "../core/config.ts";
import type { RevisionName } from "../core/domain.ts";
import type { Exec, OwnedProcesses } from "../core/effects.ts";
import type { Capture, PlatformAdapter, RecordContext } from "../core/platform.ts";
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
import { renderIOSCase } from "./templates.ts";
import { readFrameSeconds, renderMarkScript, type recordIOSVideo, type serveFlowMarks } from "./video.ts";
import { acquireRunLock, runLockDirectory, type LockFiles } from "./preflight.ts";
import { loadSavedSession, type SessionDependencies } from "./session.ts";
import { developerEnvironment, type SimulatorDependencies, type withIOSSimulator } from "./simulator.ts";

export interface IOSAdapterDependencies {
  homeDirectory: string;
  pid: number;
  ownProcesses(signal: AbortSignal): OwnedProcesses;
  teardownExec: Exec;
  stopTeardownChildren(): Promise<void>;
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
  recordIOSVideo: typeof recordIOSVideo;
  serveFlowMarks: typeof serveFlowMarks;
  now(): number;
}

function asIOSConfig(config: EvidenceConfig): IOSConfig {
  if (config.platform !== "ios") throw new Error(`the iOS adapter cannot handle ${config.platform} cases`);
  return config;
}


const OUTPUT_PREFIX: Record<RevisionName, string> = { base: "before", head: "after" };

export function createIOSAdapter(dependencies: IOSAdapterDependencies): PlatformAdapter {
  let run: { processes: OwnedProcesses; owned: ReturnType<typeof createCleanupRegistry>; dispose(): Promise<void>; sessionJson: string } | undefined;

  return {
    async preflight(context) {
      const config = asIOSConfig(context.config);
      // dispose, a failed prepare and an interrupt all share this one teardown, run once.
      const owned = createCleanupRegistry(context.cleanup.signal);
      let teardown: Promise<void> | undefined;
      const dispose = () => (teardown ??= owned.run());
      const release = await acquireRunLock(runLockDirectory(dependencies.homeDirectory), dependencies.pid, {
        files: dependencies.lockFiles,
        isProcessAlive: dependencies.isProcessAlive,
      });
      let unlocking: Promise<void> | undefined;
      const unlock = () => (unlocking ??= release());
      context.cleanup.add(unlock);
      context.cleanup.add(dispose);
      try {
        const processes = dependencies.ownProcesses(context.cleanup.signal);
        owned.add(processes.stopAll);
        const checked = await dependencies.checkTools(config, processes.exec);
        await assertSecretsPresent(config.ios, dependencies.fileExists);
        const session = await loadSavedSession(config.ios, { ...dependencies.session, homeDirectory: dependencies.homeDirectory });
        run = { processes, owned, dispose, sessionJson: session.json };
        return checked;
      } catch (error) {
        await dispose();
        await unlock();
        throw error;
      }
    },

    async prepare(context) {
      const config = asIOSConfig(context.config);
      if (run === undefined) throw new Error("the iOS adapter must run preflight before prepare");
      const { processes, owned, dispose, sessionJson } = run;
      const ownedContext: RecordContext = { ...context, cleanup: owned };
      try {
        const setupPath = posix.join(context.caseDirectory, "setup.yaml");
        const flowPath = posix.join(context.caseDirectory, "flow.yaml");
        const names = declaredScreenshotNames(await dependencies.readTextFile(flowPath), flowPath);
        const functional = context.manifest.classification === "functional";
        if (functional && names.length > 0) {
          throw new Error(`${flowPath} records a video (functional case); remove its takeScreenshot steps or make the case visual`);
        }
        if (!functional && names.length === 0) throw new Error(`${flowPath} must take at least one screenshot (takeScreenshot: <name>)`);
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
          stopTeardownChildren: dependencies.stopTeardownChildren,
          stopChildren: processes.stopAll,
          writeSession: dependencies.writeSession,
        };

        // The recorder starts when flow.yaml begins (after launch and setup) and its output is trimmed to the
        // measured begin/end marks; setup never appears in the video.
        async function captureVideo(revision: RevisionName, appPath: string, revisionDirectory: string): Promise<Capture> {
          const wrapperPath = posix.join(revisionDirectory, "wrapper.yaml");
          const outputDirectory = posix.join(revisionDirectory, "maestro");
          const scripts = { begin: posix.join(revisionDirectory, "begin.js"), end: posix.join(revisionDirectory, "end.js") };
          const video = await dependencies.withIOSSimulator(
            { context: ownedContext, revision, appPath, sessionJson },
            simulatorDependencies,
            (udid) => dependencies.recordIOSVideo(
              { udid, rawPath: posix.join(revisionDirectory, "recording.mov"), environment: developerEnvironment(config.ios) },
              async (marks) => {
                const server = await dependencies.serveFlowMarks(marks);
                try {
                  await dependencies.writeTextFile(scripts.begin, renderMarkScript(server.beginUrl));
                  await dependencies.writeTextFile(scripts.end, renderMarkScript(server.endUrl));
                  await dependencies.writeTextFile(wrapperPath, renderMaestroWrapper(config.ios.bundleId, setup, flowPath, scripts));
                  await dependencies.runMaestro({ settings: config.ios, udid, wrapperPath, outputDirectory }, processes.exec);
                } finally {
                  await server.close();
                }
              },
              { start: processes.start, frameSeconds: (path) => readFrameSeconds(path, processes.exec), now: dependencies.now },
            ),
          );
          return { screenshots: new Map(), videoPath: video.path, videoTrim: video.trim, warnings: [] };
        }

        return {
          async capture(revision) {
            const appPath = apps.get(revision);
            if (appPath === undefined) throw new Error(`${revision} was not built`);
            const revisionDirectory = posix.join(context.runDirectory, revision);
            if (functional) return captureVideo(revision, appPath, revisionDirectory);
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

    renderCase(input, config) {
      return renderIOSCase(input, asIOSConfig(config).ios.bundleId);
    },
  };
}
