import type { Exec } from "../core/effects.ts";

const SETUP_HINT = "run `make ux-evidence-setup`";

export interface ToolProbes {
  exec: Exec;
  playwrightVersion(): Promise<string>;
  chromiumExecutablePath(): string;
  fileExists(path: string): Promise<boolean>;
  nodeVersion: string;
}

async function firstLine(exec: Exec, command: string, args: readonly string[], fix: string): Promise<string> {
  try {
    const result = await exec(command, args);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit ${result.exitCode}`);
    return (result.stdout || result.stderr).split("\n")[0]?.trim() ?? "";
  } catch (error) {
    throw new Error(`${command} is not runnable (${error instanceof Error ? error.message : String(error)}); ${fix}`);
  }
}

export async function collectToolVersions(probes: ToolProbes): Promise<Record<string, string>> {
  const chromiumPath = probes.chromiumExecutablePath();
  if (!(await probes.fileExists(chromiumPath))) {
    throw new Error(`Playwright Chromium is not installed (expected at ${chromiumPath}); ${SETUP_HINT}`);
  }
  return {
    node: probes.nodeVersion,
    playwright: await probes.playwrightVersion(),
    ffmpeg: await firstLine(probes.exec, "ffmpeg", ["-version"], `install ffmpeg, then ${SETUP_HINT}`),
    docker: await firstLine(probes.exec, "docker", ["--version"], `install and start Docker, then ${SETUP_HINT}`),
  };
}
