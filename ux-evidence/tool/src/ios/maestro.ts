import { join, posix } from "node:path";
import { parseAllDocuments, stringify } from "yaml";
import type { IOSSettings } from "../core/config.ts";
import type { Exec } from "../core/effects.ts";
import { developerEnvironment } from "./simulator.ts";

const SHOT_NAME = /^[a-z0-9-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The app keeps the injected session only if launch leaves its data alone; permission prompts are denied
// up front so they cannot cover the screen. Setup and flow run as subflows from absolute paths.
export function renderMaestroWrapper(bundleId: string, setupPath: string | undefined, flowPath: string): string {
  const commands = [
    { launchApp: { appId: bundleId, clearState: false, permissions: { all: "deny" } } },
    ...(setupPath === undefined ? [] : [{ runFlow: setupPath }]),
    { runFlow: flowPath },
  ];
  return `${stringify({ appId: bundleId })}---\n${stringify(commands)}`;
}

function screenshotName(value: unknown): string {
  const name = isRecord(value) ? value.path : value;
  if (typeof name !== "string" || !SHOT_NAME.test(name)) {
    throw new Error(`takeScreenshot names must be lowercase letters, digits and hyphens: ${JSON.stringify(name)}`);
  }
  return name;
}

function collectNames(node: unknown, names: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectNames(item, names);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "takeScreenshot") names.push(screenshotName(value));
    else collectNames(value, names);
  }
}

// Names of every takeScreenshot step in flow.yaml, in order. Duplicates would overwrite each other.
export function declaredScreenshotNames(flowYaml: string, flowPath: string): readonly string[] {
  const documents = parseAllDocuments(flowYaml);
  const names: string[] = [];
  for (const document of documents) {
    if (document.errors.length > 0) throw new Error(`${flowPath} is not valid YAML: ${document.errors[0]!.message}`);
    collectNames(document.toJS(), names);
  }
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) throw new Error(`${flowPath} takes the screenshot "${duplicate}" more than once`);
  return names;
}

function tail(text: string, lineCount: number): string {
  return text.trimEnd().split("\n").slice(-lineCount).join("\n");
}

export function maestroEnvironment(settings: IOSSettings, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...developerEnvironment(settings, base), JAVA_HOME: settings.javaHome, MAESTRO_CLI_NO_ANALYTICS: "1" };
}

// Debug output is redirected so Maestro writes nothing under ~/.maestro for this run.
export async function runMaestro(
  input: { settings: IOSSettings; udid: string; wrapperPath: string; outputDirectory: string },
  exec: Exec,
): Promise<void> {
  const { settings, udid, wrapperPath, outputDirectory } = input;
  const result = await exec(settings.maestroPath, [
    "test", "--udid", udid,
    "--test-output-dir", posix.join(outputDirectory, "test-output"),
    "--debug-output", posix.join(outputDirectory, "debug"), "--flatten-debug-output",
    wrapperPath,
  ], { env: maestroEnvironment(settings) });
  if (result.exitCode !== 0) {
    throw new Error(`the Maestro flow failed (exit ${result.exitCode}):\n${tail(`${result.stdout}\n${result.stderr}`, 20)}`);
  }
}

export interface ScreenshotFiles {
  listFilesRecursively(directory: string): Promise<readonly string[]>;
}

// Maestro writes takeScreenshot output to <test-output>/<timestamp>/<flow>/takeScreenshot/<name>.png.
export async function collectScreenshots(
  outputDirectory: string,
  expectedNames: readonly string[],
  files: ScreenshotFiles,
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  for (const path of await files.listFilesRecursively(outputDirectory)) {
    const parts = path.split("/");
    if (parts.at(-2) !== "takeScreenshot" || !path.endsWith(".png")) continue;
    const name = parts.at(-1)!.slice(0, -".png".length);
    if (found.has(name)) throw new Error(`Maestro produced the screenshot "${name}" more than once`);
    found.set(name, path);
  }
  const missing = expectedNames.filter((name) => !found.has(name));
  const extra = [...found.keys()].filter((name) => !expectedNames.includes(name));
  if (missing.length > 0) throw new Error(`Maestro did not produce screenshots: ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`Maestro produced screenshots flow.yaml does not declare: ${extra.join(", ")}`);
  return new Map(expectedNames.map((name) => [name, found.get(name)!]));
}

export function caseFlowPaths(caseDirectory: string): { setupPath: string; flowPath: string } {
  return { setupPath: join(caseDirectory, "setup.yaml"), flowPath: join(caseDirectory, "flow.yaml") };
}
