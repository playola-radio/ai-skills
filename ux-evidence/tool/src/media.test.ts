import { describe, expect, it, vi } from "vitest";
import type { Exec } from "./effects.ts";
import { composeComparisonPng, encodeVideo } from "./media.ts";

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
