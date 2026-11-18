import { describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../effects.ts";
import { renderEvidenceComment } from "../render.ts";
import type { EvidenceResult } from "../results.ts";
import { WEB_CONFIG } from "../test-fixtures.ts";
import { publishEvidence, shrinkPhoneShots } from "./publish.ts";
import type { VerifyDependencies } from "./verify.ts";

const recorded: EvidenceResult = {
  version: 2, platform: "web", caseId: "weekly-play-counts", classification: "functional", baseCommit: "b0",
  headCommit: "h2", toolCommit: "t1", environment: { dump: { path: "/d", modifiedAt: "2026-11-01T00:00:00.000Z", sizeBytes: 1 } },
  revisions: { base: { status: "passed", warnings: [] }, head: { status: "passed", warnings: [] } },
  artifacts: [
    { kind: "video", revision: "base", path: ".qa-artifacts/weekly-play-counts/before.mp4", sizeBytes: 1, sha256: "a" },
    { kind: "video", revision: "head", path: ".qa-artifacts/weekly-play-counts/after.mp4", sizeBytes: 1, sha256: "b" },
  ],
  tools: {}, capturedAt: "2026-11-16T00:00:00.000Z",
};

function build(options: { recordedHead: string; sinceRecorded?: string[]; ghExit?: number; checksum?: string; commentMissing?: boolean }) {
  const exec = vi.fn(async (command: string, args: readonly string[]): Promise<ExecResult> => {
    const out = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
    if (command === "gh") return { exitCode: options.ghExit ?? 0, stdout: "", stderr: "boom\n" };
    if (args[0] === "rev-parse") return out("h2\n");
    if (args[0] === "merge-base") return out("b0\n");
    if (args[0] === "diff" && args[3] === "b0") return out("qa/ux/weekly-play-counts/evidence.yaml\0");
    return out((options.sinceRecorded ?? []).map((path) => `${path}\0`).join(""));
  });
  const dependencies: VerifyDependencies = {
    exec,
    readTextFile: async (path) => {
      const result = { ...recorded, headCommit: options.recordedHead };
      return path.endsWith("comment.md") ? renderEvidenceComment(result).markdown : JSON.stringify(result);
    },
    fileExists: async (path) => !(options.commentMissing && path.endsWith("comment.md")),
    checksumFile: async (path) => options.checksum ?? (path.endsWith("before.mp4") ? "a" : "b"),
  };
  return { exec, dependencies };
}

describe("publishEvidence", () => {
  it("refuses to publish stale evidence before calling gh", async () => {
    const { exec, dependencies } = build({ recordedHead: "h1", sinceRecorded: ["client/src/App.tsx"] });
    await expect(publishEvidence({ repoRoot: "/repo", config: WEB_CONFIG, pr: "123" }, dependencies))
      .rejects.toThrow("UX evidence is stale or missing: weekly-play-counts: client/src/App.tsx changed after recording");
    expect(exec.mock.calls.map(([command]) => command)).not.toContain("gh");
  });

  it("posts one comment per case with every attachment", async () => {
    const { exec, dependencies } = build({ recordedHead: "h2" });
    await publishEvidence({ repoRoot: "/repo", config: WEB_CONFIG, pr: "123" }, dependencies);
    expect(renderEvidenceComment(recorded).attachments).toHaveLength(2);
    expect(exec).toHaveBeenCalledWith("gh", ["pr", "comment", "123",
      "--body", renderEvidenceComment(recorded).markdown,
      "--attach", "/repo/.qa-artifacts/weekly-play-counts/before.mp4",
      "--attach", "/repo/.qa-artifacts/weekly-play-counts/after.mp4"], { cwd: "/repo" });
  });

  it("shows an uploaded phone screenshot at a fixed width and leaves other media alone", () => {
    expect(shrinkPhoneShots("a\n\n![phone screenshot](https://x/1)\n\n![](https://x/2)"))
      .toBe('a\n\n<img src="https://x/1" width="300" alt="phone screenshot">\n\n![](https://x/2)');
  });

  it("reports a failing gh call with its stderr", async () => {
    const { dependencies } = build({ recordedHead: "h2", ghExit: 1 });
    await expect(publishEvidence({ repoRoot: "/repo", config: WEB_CONFIG, pr: "123" }, dependencies))
      .rejects.toThrow("gh pr comment failed for weekly-play-counts: boom");
  });

  it("refuses to publish when the evidence files changed after recording, before calling gh", async () => {
    const { exec, dependencies } = build({ recordedHead: "h2", checksum: "tampered" });
    await expect(publishEvidence({ repoRoot: "/repo", config: WEB_CONFIG, pr: "123" }, dependencies))
      .rejects.toThrow("weekly-play-counts: evidence files missing or changed; record again");
    expect(exec.mock.calls.map(([command]) => command)).not.toContain("gh");
  });

  it("refuses to publish when comment.md is gone", async () => {
    const { exec, dependencies } = build({ recordedHead: "h2", commentMissing: true });
    await expect(publishEvidence({ repoRoot: "/repo", config: WEB_CONFIG, pr: "123" }, dependencies))
      .rejects.toThrow("evidence files missing or changed");
    expect(exec.mock.calls.map(([command]) => command)).not.toContain("gh");
  });
});
