import { describe, expect, it } from "vitest";
import {
  blockingDirtyPaths,
  changedCaseIds,
  decideEvidenceFreshness,
  hasRelevantClientChange,
  isFreshnessIgnoredPath,
} from "./freshness.ts";

describe("isFreshnessIgnoredPath", () => {
  it.each(["client/src/App.test.tsx", "server/src/api/foo.spec.ts",
    "client/src/__tests__/App.tsx", "client/README.md"])("ignores %s", (p) => {
    expect(isFreshnessIgnoredPath(p)).toBe(true);
  });
  it.each(["client/src/App.tsx", "client/src/App.scss", "server/src/api/foo.api.docs.yaml"])(
    "does not ignore %s", (p) => { expect(isFreshnessIgnoredPath(p)).toBe(false); });
});

describe("decideEvidenceFreshness", () => {
  it("is current when recorded head equals HEAD", () => {
    expect(decideEvidenceFreshness({ recordedHead: "h2", currentHead: "h2",
      changedSinceRecordedHead: ["client/src/App.tsx"], caseId: "c" }))
      .toEqual({ current: true, reason: "recorded at current HEAD" });
  });
  it("is stale after non-test client code changes", () => {
    expect(decideEvidenceFreshness({ recordedHead: "h1", currentHead: "h2",
      changedSinceRecordedHead: ["client/src/App.tsx"], caseId: "c" }))
      .toEqual({ current: false, reason: "client/src/App.tsx changed after recording" });
  });
  it("is stale after its own flow changes", () => {
    expect(decideEvidenceFreshness({ recordedHead: "h1", currentHead: "h2",
      changedSinceRecordedHead: ["qa/ux/c/flow.ts"], caseId: "c" }).current).toBe(false);
  });
  it("stays current when only tests, docs or other cases changed", () => {
    expect(decideEvidenceFreshness({ recordedHead: "h1", currentHead: "h2",
      changedSinceRecordedHead: ["docs/x.md", "client/src/A.test.tsx", "qa/ux/other/flow.ts", "Makefile"],
      caseId: "c" })).toEqual({ current: true, reason: "no relevant changes since recording" });
  });
  it("treats a missing result as stale", () => {
    expect(decideEvidenceFreshness({ recordedHead: undefined, currentHead: "h2",
      changedSinceRecordedHead: [], caseId: "c" }))
      .toEqual({ current: false, reason: "result.json is missing" });
  });
});

describe("changedCaseIds", () => {
  it("extracts unique case ids in first-seen order", () => {
    expect(changedCaseIds(["qa/ux/a/flow.ts", "qa/ux/a/evidence.yaml", "qa/ux/README.md", "qa/ux/b/flow.ts"]))
      .toEqual(["a", "b"]);
  });
});

describe("hasRelevantClientChange", () => {
  it("detects a relevant client change", () => {
    expect(hasRelevantClientChange(["client/src/A.test.tsx", "server/src/x.ts"])).toBe(false);
    expect(hasRelevantClientChange(["client/src/A.tsx"])).toBe(true);
  });
});

describe("blockingDirtyPaths", () => {
  it("blocks only dirty client, server and current-case paths", () => {
    expect(blockingDirtyPaths(["client/src/App.tsx", "server/src/s.ts", "qa/ux/c/flow.ts",
      "qa/ux/other/flow.ts", "docs/n.md"], "c"))
      .toEqual(["client/src/App.tsx", "server/src/s.ts", "qa/ux/c/flow.ts"]);
  });
  it("does not apply the ignore patterns", () => {
    expect(blockingDirtyPaths(["client/src/App.test.tsx"], "c")).toEqual(["client/src/App.test.tsx"]);
  });
});
