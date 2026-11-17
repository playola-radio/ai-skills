import type { Exec, ExecResult, PathStat } from "./effects.ts";
import { MAX_ATTACHMENT_BYTES } from "./results.ts";

function tail(text: string, lineCount: number): string {
  return text.trimEnd().split("\n").slice(-lineCount).join("\n");
}

function assertSucceeded(result: ExecResult, description: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${description} (exit ${result.exitCode}): ${tail(result.stderr, 20)}`);
  }
}

export async function encodeVideo(input: {
  sourcePath: string;
  destinationPath: string;
  exec: Exec;
  stat: PathStat;
}): Promise<void> {
  const { sourcePath, destinationPath, exec, stat } = input;
  const result = await exec("ffmpeg", [
    "-y", "-i", sourcePath, "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "28",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", destinationPath,
  ], {});
  assertSucceeded(result, `ffmpeg failed encoding ${destinationPath}`);
  const { size } = await stat(destinationPath);
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`encoded video is ${size} bytes, over GitHub's ${MAX_ATTACHMENT_BYTES}-byte limit; shorten the flow`);
  }
}

export async function composeComparisonPng(input: {
  beforePath: string;
  afterPath: string;
  destinationPath: string;
  exec: Exec;
}): Promise<void> {
  const { beforePath, afterPath, destinationPath, exec } = input;
  const result = await exec("ffmpeg", [
    "-y", "-i", beforePath, "-i", afterPath, "-filter_complex", "hstack=inputs=2", destinationPath,
  ], {});
  assertSucceeded(result, `ffmpeg failed composing ${destinationPath}`);
}

async function decodedFingerprint(path: string, exec: Exec): Promise<string> {
  const result = await exec("ffmpeg", [
    "-v", "error", "-i", path, "-map", "0:v:0", "-pix_fmt", "rgba", "-f", "framehash", "-hash", "sha256", "-",
  ], {});
  assertSucceeded(result, `ffmpeg failed decoding ${path}`);
  return result.stdout.split("\n").flatMap((line) => {
    if (line.startsWith("#dimensions")) return [line.trim()];
    if (line.startsWith("#") || line.trim() === "") return [];
    return [line.split(",").slice(-2).map((field) => field.trim()).join(",")];
  }).join("\n");
}

export async function pixelsIdentical(left: string, right: string, exec: Exec): Promise<boolean> {
  return (await decodedFingerprint(left, exec)) === (await decodedFingerprint(right, exec));
}
