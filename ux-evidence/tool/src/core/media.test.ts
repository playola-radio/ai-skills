import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { realExec, type Exec } from "./effects.ts";
import { composeComparisonPng, encodeVideo, pixelsIdentical } from "./media.ts";

const ok = { exitCode: 0, stdout: "", stderr: "" };
const smallStat = async () => ({ size: 1000, mtime: new Date() });

describe("encodeVideo", () => {
  it("encodes H.264 without audio, faststart", async () => {
    const exec = vi.fn<Exec>(async () => ok);
    await encodeVideo({ sourcePath: "/t/in.webm", destinationPath: "/o/after.mp4", exec, stat: smallStat });
    expect(exec).toHaveBeenCalledWith("ffmpeg", expect.arrayContaining(
      ["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "/o/after.mp4"]), expect.anything());
  });

  it("fails when the encoded video is over the cap", async () => {
    const exec = vi.fn<Exec>(async () => ok);
    await expect(encodeVideo({ sourcePath: "/t/in.webm", destinationPath: "/o/after.mp4", exec,
      stat: async () => ({ size: 10_485_761, mtime: new Date() }) }))
      .rejects.toThrow("encoded video is 10485761 bytes, over GitHub's 10485760-byte limit; shorten the flow");
  });

  it("accepts a video exactly at the cap", async () => {
    const exec = vi.fn<Exec>(async () => ok);
    await expect(encodeVideo({ sourcePath: "/t/in.webm", destinationPath: "/o/a.mp4", exec,
      stat: async () => ({ size: 10_485_760, mtime: new Date() }) })).resolves.toBeUndefined();
  });

  it("names the step and stderr tail when ffmpeg fails", async () => {
    const exec = vi.fn<Exec>(async () => ({ exitCode: 1, stdout: "", stderr: "boom: bad codec" }));
    await expect(encodeVideo({ sourcePath: "/t/in.webm", destinationPath: "/o/after.mp4", exec, stat: smallStat }))
      .rejects.toThrow("ffmpeg failed encoding /o/after.mp4 (exit 1): boom: bad codec");
  });
});

describe("composeComparisonPng", () => {
  it("stacks before and after side by side", async () => {
    const exec = vi.fn<Exec>(async () => ok);
    await composeComparisonPng({ beforePath: "/o/b.png", afterPath: "/o/a.png", destinationPath: "/o/c.png", exec });
    expect(exec).toHaveBeenCalledWith("ffmpeg",
      ["-y", "-i", "/o/b.png", "-i", "/o/a.png", "-filter_complex", "hstack=inputs=2", "/o/c.png"], expect.anything());
  });

  it("names the step when ffmpeg fails", async () => {
    const exec = vi.fn<Exec>(async () => ({ exitCode: 1, stdout: "", stderr: "bad size" }));
    await expect(composeComparisonPng({ beforePath: "/o/b.png", afterPath: "/o/a.png", destinationPath: "/o/c.png", exec }))
      .rejects.toThrow("ffmpeg failed composing /o/c.png (exit 1): bad size");
  });
});

describe("pixelsIdentical", () => {
  const RED = [255, 0, 0, 255];
  const BLUE = [0, 0, 255, 255];
  let directory: string;

  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "uxe-pixels-")); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  async function png(name: string, size: string, pixels: readonly number[][], outputPixelFormat: string): Promise<string> {
    const raw = join(directory, `${name}.rgba`);
    const path = join(directory, `${name}.png`);
    await writeFile(raw, Buffer.from(pixels.flat()));
    const result = await realExec("ffmpeg", [
      "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", size, "-i", raw, "-pix_fmt", outputPixelFormat, path,
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return path;
  }

  it("differentEncodingSamePixels: differently encoded red images compare equal", async () => {
    const left = await png("red-rgb", "2x2", [RED, RED, RED, RED], "rgb24");
    const right = await png("red-rgba", "2x2", [RED, RED, RED, RED], "rgba");
    expect(Buffer.compare(await readFile(left), await readFile(right))).not.toBe(0);
    await expect(pixelsIdentical(left, right, realExec)).resolves.toBe(true);
  });

  it("onePixelChanged: one blue pixel makes the images differ", async () => {
    const left = await png("all-red", "2x2", [RED, RED, RED, RED], "rgba");
    const right = await png("one-blue", "2x2", [RED, RED, RED, BLUE], "rgba");
    await expect(pixelsIdentical(left, right, realExec)).resolves.toBe(false);
  });

  it("wrongDimensionsDiffer: a 1x4 image differs from a 2x2 image with the same pixels", async () => {
    const left = await png("tall", "1x4", [RED, RED, RED, RED], "rgba");
    const right = await png("square", "2x2", [RED, RED, RED, RED], "rgba");
    await expect(pixelsIdentical(left, right, realExec)).resolves.toBe(false);
  });

  it("names the image ffmpeg could not decode", async () => {
    const exec = vi.fn<Exec>(async () => ({ exitCode: 1, stdout: "", stderr: "Invalid data" }));
    await expect(pixelsIdentical("/o/a.png", "/o/b.png", exec))
      .rejects.toThrow("ffmpeg failed decoding /o/a.png (exit 1): Invalid data");
  });
});
