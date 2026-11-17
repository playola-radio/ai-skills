import { basename, join } from "node:path";
import type { WebConfig } from "../core/config.ts";
import { renderManifestYaml, type NewCaseInput } from "../core/commands/new.ts";
import type { PathStat } from "../core/effects.ts";
import type { PlatformAdapter, RecordContext } from "../core/platform.ts";
import type { captureRevision } from "./browser.ts";
import { selectFlowPath, type loadEvidenceFlow } from "./flows.ts";
import type { StackDependencies, withRevisionStack } from "./stack.ts";
import { resolveDumpMetadata } from "./tools.ts";

export interface WebAdapterDependencies {
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  stat: PathStat;
  fileExists(path: string): Promise<boolean>;
  toolVersions(): Promise<Record<string, string>>;
  withRevisionStack: typeof withRevisionStack;
  stackDependencies: Omit<StackDependencies, "cleanup" | "makeTemporaryDirectory">;
  makeTemporaryDirectory(parent: string, prefix: string): Promise<string>;
  captureRevision: typeof captureRevision;
  loadEvidenceFlow: typeof loadEvidenceFlow;
}

function webConfig(context: RecordContext): WebConfig {
  if (context.config.platform !== "web") throw new Error(`the web adapter cannot record ${context.config.platform} cases`);
  return context.config;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderWebFlow(input: NewCaseInput): string {
  const visual = input.classification === "visual";
  return [
    'import type { DemoContext } from "../.tool/src/flow-api.ts";',
    "",
    `export async function demo(${visual ? "{ page, shot }" : "{ page }"}: DemoContext): Promise<void> {`,
    ...(visual ? ['  await shot("main");'] : []),
    '  throw new Error("flow not written yet");',
    "}",
    "",
  ].join("\n");
}

export function createWebAdapter(dependencies: WebAdapterDependencies): PlatformAdapter {
  let dumpPath: string | undefined;

  return {
    async preflight(context) {
      webConfig(context);
      const dump = await resolveDumpMetadata({
        environment: dependencies.environment,
        homeDirectory: dependencies.homeDirectory,
        stat: dependencies.stat,
      });
      dumpPath = dump.path;
      return { environment: { dump }, tools: await dependencies.toolVersions() };
    },

    async prepare(context) {
      const config = webConfig(context);
      const { repoRoot, manifest, caseDirectory, artifactDirectory, runDirectory, cleanup } = context;
      const startPath = manifest.startPath;
      if (startPath === undefined) throw new Error(`${manifest.id}: web cases need a startPath`);
      if (dumpPath === undefined) throw new Error("the web adapter must run preflight before prepare");
      const preparedDumpPath = dumpPath;
      const stackDependencies: StackDependencies = {
        ...dependencies.stackDependencies,
        makeTemporaryDirectory: (prefix) => dependencies.makeTemporaryDirectory(runDirectory, prefix),
        cleanup,
      };

      return {
        async capture(revision) {
          const baseOverrideExists = revision === "base"
            && await dependencies.fileExists(join(caseDirectory, "flow.base.ts"));
          const flow = await dependencies.loadEvidenceFlow(selectFlowPath({ caseDirectory, revision, baseOverrideExists }));
          return dependencies.withRevisionStack(
            { repoRoot, revision, commit: context.commits[revision], dumpPath: preparedDumpPath, runId: basename(runDirectory) },
            stackDependencies,
            async (stack) => {
              const capture = await dependencies.captureRevision({
                revision,
                classification: manifest.classification,
                clientUrl: stack.clientUrl,
                startPath,
                flow,
                outputDirectory: artifactDirectory,
                settings: config.web,
              }).catch((error: unknown) => {
                throw new Error(`${manifest.id}: ${revision} capture failed: ${messageOf(error)}`);
              });
              return { ...capture, warnings: stack.warnings };
            },
          );
        },
        async dispose() {},
      };
    },

    renderCase(input) {
      return new Map([
        ["evidence.yaml", renderManifestYaml(input, "web")],
        ["flow.ts", renderWebFlow(input)],
      ]);
    },
  };
}
