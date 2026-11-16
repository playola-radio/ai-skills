import { describe, expect, it } from "vitest";
import { renderEvidenceComment } from "./render.ts";
import type { ArtifactRecord, EvidenceResult } from "./results.ts";

const passed = { status: "passed", warnings: [] } as const;

const artifact = (path: string, fields: Partial<ArtifactRecord>): ArtifactRecord => ({
  kind: "video",
  path,
  sizeBytes: 1000,
  sha256: "x",
  ...fields,
});

const baseResult: EvidenceResult = {
  version: 1,
  caseId: "weekly-play-counts",
  classification: "functional",
  baseCommit: "1234567890abcdef",
  headCommit: "abcdef0123456789",
  dump: { path: "dump.sql", modifiedAt: "2026-11-11T08:30:00.000Z", sizeBytes: 5 },
  revisions: { base: passed, head: passed },
  artifacts: [],
  tools: {},
  capturedAt: "2026-11-16T12:00:00.000Z",
};

const functionalResult: EvidenceResult = {
  ...baseResult,
  artifacts: [
    artifact(".qa-artifacts/weekly-play-counts/before.mp4", { revision: "base" }),
    artifact(".qa-artifacts/weekly-play-counts/after.mp4", { revision: "head" }),
  ],
};

const afterOnlyResult: EvidenceResult = {
  ...functionalResult,
  revisions: {
    base: { status: "not-applicable", reason: "this flow does not exist on the base branch", warnings: [] },
    head: passed,
  },
  artifacts: [artifact(".qa-artifacts/weekly-play-counts/after.mp4", { revision: "head" })],
};

const stationShots: ArtifactRecord[] = [
  artifact(".qa-artifacts/example-stations/before-stations-list.png", {
    kind: "screenshot",
    revision: "base",
    shotName: "stations-list",
  }),
  artifact(".qa-artifacts/example-stations/after-stations-list.png", {
    kind: "screenshot",
    revision: "head",
    shotName: "stations-list",
  }),
];

const visualResult: EvidenceResult = {
  ...baseResult,
  caseId: "example-stations",
  classification: "visual",
  artifacts: [
    ...stationShots,
    artifact(".qa-artifacts/example-stations/compare-stations-list.png", {
      kind: "comparison",
      shotName: "stations-list",
    }),
  ],
};

const visualAfterOnlyResult: EvidenceResult = {
  ...visualResult,
  revisions: {
    base: { status: "not-applicable", reason: "new screen", warnings: [] },
    head: passed,
  },
  artifacts: [stationShots[1]!],
};

const warningResult: EvidenceResult = {
  ...functionalResult,
  revisions: {
    base: { status: "passed", warnings: ["dump has migrations this revision lacks: 20261101-x.js"] },
    head: passed,
  },
};

const failedResult: EvidenceResult = {
  ...functionalResult,
  revisions: { base: passed, head: { status: "failed", reason: "timeout", warnings: [] } },
};

describe("renderEvidenceComment", () => {
  it("renders functional before and after videos as standalone paragraphs", () => {
    const r = renderEvidenceComment(functionalResult);
    expect(r.markdown).toContain("## UX evidence: weekly-play-counts");
    expect(r.markdown).toContain("Classification: functional");
    expect(r.markdown).toContain("Base: `1234567`");
    expect(r.markdown).toContain("Head: `abcdef0`");
    expect(r.markdown).toContain("\n\n![](.qa-artifacts/weekly-play-counts/before.mp4)\n\n");
    expect(r.markdown).toContain("\n\n![](.qa-artifacts/weekly-play-counts/after.mp4)\n\n");
    expect(r.attachments).toEqual([
      ".qa-artifacts/weekly-play-counts/before.mp4",
      ".qa-artifacts/weekly-play-counts/after.mp4",
    ]);
  });

  it("renders the not-applicable reason instead of a before video", () => {
    const r = renderEvidenceComment(afterOnlyResult);
    expect(r.markdown).toContain("Before: not applicable — this flow does not exist on the base branch");
    expect(r.attachments).toEqual([".qa-artifacts/weekly-play-counts/after.mp4"]);
  });

  it("attaches only comparison images for a visual case", () => {
    expect(renderEvidenceComment(visualResult).attachments).toEqual([
      ".qa-artifacts/example-stations/compare-stations-list.png",
    ]);
  });

  it("attaches after screenshots for a visual case without a before", () => {
    const r = renderEvidenceComment(visualAfterOnlyResult);
    expect(r.attachments).toEqual([".qa-artifacts/example-stations/after-stations-list.png"]);
    expect(r.markdown).toContain("Before: not applicable — new screen");
  });

  it("renders functional screenshots below the videos, comparisons first when the base ran", () => {
    const r = renderEvidenceComment({
      ...functionalResult,
      artifacts: [
        ...functionalResult.artifacts,
        artifact(".qa-artifacts/weekly-play-counts/before-panel.png", { kind: "screenshot", revision: "base", shotName: "panel" }),
        artifact(".qa-artifacts/weekly-play-counts/after-panel.png", { kind: "screenshot", revision: "head", shotName: "panel" }),
        artifact(".qa-artifacts/weekly-play-counts/compare-panel.png", { kind: "comparison", shotName: "panel" }),
      ],
    });
    expect(r.attachments).toEqual([
      ".qa-artifacts/weekly-play-counts/before.mp4",
      ".qa-artifacts/weekly-play-counts/after.mp4",
      ".qa-artifacts/weekly-play-counts/compare-panel.png",
    ]);
    expect(r.markdown.indexOf("after.mp4")).toBeLessThan(r.markdown.indexOf("panel:"));
    expect(r.markdown).toContain("panel:\n\n![](.qa-artifacts/weekly-play-counts/compare-panel.png)");
  });

  it("renders the after screenshot of a functional case without a before", () => {
    const r = renderEvidenceComment({
      ...afterOnlyResult,
      artifacts: [
        ...afterOnlyResult.artifacts,
        artifact(".qa-artifacts/weekly-play-counts/after-panel.png", { kind: "screenshot", revision: "head", shotName: "panel" }),
      ],
    });
    expect(r.attachments).toEqual([
      ".qa-artifacts/weekly-play-counts/after.mp4",
      ".qa-artifacts/weekly-play-counts/after-panel.png",
    ]);
  });

  it("includes the dump date and any revision warnings", () => {
    const md = renderEvidenceComment(warningResult).markdown;
    expect(md).toContain("Data: production dump from 2026-11-11");
    expect(md).toContain("Warning (base): dump has migrations this revision lacks: 20261101-x.js");
  });

  it("refuses to render a result with a failed revision", () => {
    expect(() => renderEvidenceComment(failedResult)).toThrow("cannot publish a failed run");
  });

  it("refuses a functional result whose passed base has no before video", () => {
    const result = { ...functionalResult, artifacts: [functionalResult.artifacts[1]!] };
    expect(() => renderEvidenceComment(result)).toThrow("missing before video for a passed base revision");
  });

  it("refuses a functional result whose passed head has no after video", () => {
    const result = { ...functionalResult, artifacts: [functionalResult.artifacts[0]!] };
    expect(() => renderEvidenceComment(result)).toThrow("missing after video for a passed head revision");
  });

  it("refuses a visual result with a passed base but no comparison", () => {
    const result = { ...visualResult, artifacts: stationShots };
    expect(() => renderEvidenceComment(result)).toThrow("missing comparison for a passed base revision");
  });

  it("refuses a visual result with a skipped base but no after screenshot", () => {
    const result = { ...visualAfterOnlyResult, artifacts: [] };
    expect(() => renderEvidenceComment(result)).toThrow("missing after screenshot for a passed head revision");
  });
});

describe("identical marker", () => {
  const identicalNote = "> Before and after are identical (recorded with ALLOW_IDENTICAL).";

  it("adds one line right under the title when the result is marked identical", () => {
    const { markdown } = renderEvidenceComment({ ...visualResult, identical: true });
    const lines = markdown.split("\n");
    expect(lines[0]).toBe("## UX evidence: example-stations");
    expect(lines[2]).toBe(identicalNote);
    expect(markdown.split(identicalNote)).toHaveLength(2);
  });

  it("adds nothing when the result is not marked", () => {
    expect(renderEvidenceComment(visualResult).markdown).not.toContain("identical");
  });
});

