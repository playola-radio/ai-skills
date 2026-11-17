import { describe, expect, it } from "vitest";
import type { ExecResult } from "../effects.ts";
import type { EvidenceResult } from "../results.ts";
import { renderEvidenceComment } from "../render.ts";
import { verifyEvidence, type VerifyDependencies } from "./verify.ts";

const HEAD = "h2";
const BASE = "b0";

function result(caseId: string, headCommit: string): EvidenceResult {
  return {
    version: 1, caseId, classification: "visual", baseCommit: BASE, headCommit,
    dump: { path: "/d", modifiedAt: "2026-11-01T00:00:00.000Z", sizeBytes: 1 },
    revisions: { base: { status: "passed", warnings: [] }, head: { status: "passed", warnings: [] } },
    artifacts: [{ kind: "comparison", shotName: "screen", path: `.qa-artifacts/${caseId}/comparison-screen.png`, sizeBytes: 1, sha256: "good" }],
    tools: {}, capturedAt: "2026-11-16T00:00:00.000Z",
  };
}

interface BuildOptions {
  branchChanges: string[];
  results?: Record<string, EvidenceResult>;
  sinceRecorded?: string[];
  deletedCases?: string[];
  missingFiles?: string[];
  checksums?: Record<string, string>;
  comments?: Record<string, string>;
  currentBase?: string;
}

function build(options: BuildOptions): VerifyDependencies {
  const results = options.results ?? {};
  const out = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
  const nul = (paths: readonly string[]) => paths.map((path) => `${path}\0`).join("");
  const existing = new Set<string>();
  for (const [id, recorded] of Object.entries(results)) {
    existing.add(`/repo/.qa-artifacts/${id}/result.json`);
    existing.add(`/repo/.qa-artifacts/${id}/comment.md`);
    for (const artifact of recorded.artifacts) existing.add(`/repo/${artifact.path}`);
  }
  for (const change of options.branchChanges) {
    const id = change.match(/^qa\/ux\/([^/]+)\//)?.[1];
    if (id !== undefined && !(options.deletedCases ?? []).includes(id)) existing.add(`/repo/qa/ux/${id}/evidence.yaml`);
  }
  for (const missing of options.missingFiles ?? []) existing.delete(missing);
  return {
    exec: async (_command, args) => {
      if (args[0] === "rev-parse") return out(`${HEAD}\n`);
      if (args[0] === "merge-base") return out(`${options.currentBase ?? BASE}\n`);
      if (args[0] === "diff" && args[3] === (options.currentBase ?? BASE)) return out(nul(options.branchChanges));
      if (args[0] === "diff") return out(nul(options.sinceRecorded ?? []));
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    readTextFile: async (path) => {
      const entry = Object.entries(results).find(([id]) => path === `/repo/.qa-artifacts/${id}/result.json`);
      if (entry) return JSON.stringify(entry[1]);
      const comment = Object.entries(results).find(([id]) => path === `/repo/.qa-artifacts/${id}/comment.md`);
      if (comment) return options.comments?.[comment[0]] ?? renderEvidenceComment(comment[1]).markdown;
      throw new Error(`no file ${path}`);
    },
    fileExists: async (path) => existing.has(path),
    checksumFile: async (path) => options.checksums?.[path] ?? "good",
  };
}

const withVideo = (caseId: string, headCommit: string): EvidenceResult => ({
  ...result(caseId, headCommit), classification: "functional",
  artifacts: [
    { kind: "video", revision: "base", path: `.qa-artifacts/${caseId}/before.mp4`, sizeBytes: 1, sha256: "good" },
    { kind: "video", revision: "head", path: `.qa-artifacts/${caseId}/after.mp4`, sizeBytes: 1, sha256: "good" },
  ],
});

const FILES_STALE = { caseId: "c", current: false, reason: "evidence files missing or changed; record again" };

describe("verifyEvidence", () => {
  it("reports missing evidence when client code changed without a case", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({ branchChanges: ["client/src/App.tsx"] }));
    expect(report).toMatchObject({ current: false, missingEvidenceForClientChanges: true, cases: [] });
  });

  it("is current for a branch with no client change and no cases", async () => {
    await expect(verifyEvidence({ repoRoot: "/repo" }, build({ branchChanges: ["server/src/x.ts"] })))
      .resolves.toMatchObject({ current: true, cases: [] });
  });

  it("stays current after a docs-only commit", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({
      branchChanges: ["qa/ux/c/evidence.yaml"], results: { c: result("c", "h1") }, sinceRecorded: ["docs/n.md"],
    }));
    expect(report).toMatchObject({ current: true, cases: [{ caseId: "c", current: true }] });
  });

  it("is stale after a later client commit", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({
      branchChanges: ["qa/ux/c/evidence.yaml"], results: { c: result("c", "h1") }, sinceRecorded: ["client/src/App.tsx"],
    }));
    expect(report.current).toBe(false);
    expect(report.cases[0]).toEqual({ caseId: "c", current: false, reason: "client/src/App.tsx changed after recording" });
  });

  it("is stale when result.json is absent", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({ branchChanges: ["qa/ux/c/evidence.yaml"] }));
    expect(report.cases[0]).toEqual({ caseId: "c", current: false, reason: "result.json is missing" });
  });

  it("does not require evidence for a case whose folder was deleted", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({
      branchChanges: ["qa/ux/old/evidence.yaml", "qa/ux/old/flow.ts", "client/src/App.test.tsx"], deletedCases: ["old"],
    }));
    expect(report).toEqual({ current: true, cases: [], missingEvidenceForClientChanges: false });
  });

  it("still demands evidence when a case was deleted but client code changed", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({
      branchChanges: ["qa/ux/old/evidence.yaml", "client/src/App.tsx"], deletedCases: ["old"],
    }));
    expect(report).toMatchObject({ current: false, missingEvidenceForClientChanges: true, cases: [] });
  });

  it("is current when comment.md and every artifact are present with their recorded checksums", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({
      branchChanges: ["qa/ux/c/evidence.yaml"], results: { c: withVideo("c", HEAD) },
    }));
    expect(report.cases).toEqual([{ caseId: "c", current: true, reason: "recorded at current HEAD" }]);
  });

  it("is stale when comment.md is gone", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({
      branchChanges: ["qa/ux/c/evidence.yaml"], results: { c: withVideo("c", HEAD) },
      missingFiles: ["/repo/.qa-artifacts/c/comment.md"],
    }));
    expect(report).toMatchObject({ current: false, cases: [FILES_STALE] });
  });

  it("is stale when the merge base changed after recording", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({
      branchChanges: ["qa/ux/c/evidence.yaml"], results: { c: withVideo("c", HEAD) }, currentBase: "b1",
    }));
    expect(report).toMatchObject({ current: false, cases: [FILES_STALE] });
  });

  it("is stale when comment.md no longer matches the recorded result", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({
      branchChanges: ["qa/ux/c/evidence.yaml"], results: { c: withVideo("c", HEAD) }, comments: { c: "tampered" },
    }));
    expect(report).toMatchObject({ current: false, cases: [FILES_STALE] });
  });

  it("is stale when a recorded artifact is gone", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({
      branchChanges: ["qa/ux/c/evidence.yaml"], results: { c: withVideo("c", HEAD) },
      missingFiles: ["/repo/.qa-artifacts/c/after.mp4"],
    }));
    expect(report).toMatchObject({ current: false, cases: [FILES_STALE] });
  });

  it("is stale when a recorded artifact's checksum changed", async () => {
    const report = await verifyEvidence({ repoRoot: "/repo" }, build({
      branchChanges: ["qa/ux/c/evidence.yaml"], results: { c: withVideo("c", HEAD) },
      checksums: { "/repo/.qa-artifacts/c/after.mp4": "tampered" },
    }));
    expect(report).toMatchObject({ current: false, cases: [FILES_STALE] });
  });

  it("rejects a changed folder whose name is not a valid case id", async () => {
    await expect(verifyEvidence({ repoRoot: "/repo" }, build({ branchChanges: ["qa/ux/Bad Case/evidence.yaml"] })))
      .rejects.toThrow("case id must be lowercase letters, digits and hyphens");
  });

  it("rejects a result.json whose case id is not valid", async () => {
    const evil = { ...result("c", HEAD), caseId: "../client" };
    await expect(verifyEvidence({ repoRoot: "/repo" }, build({ branchChanges: ["qa/ux/c/evidence.yaml"], results: { c: evil } })))
      .rejects.toThrow("case id must be lowercase letters, digits and hyphens");
  });
});
