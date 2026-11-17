import { describe, expect, it } from "vitest";
import {
  blockingDirtyPaths,
  changedCaseIds,
  decideEvidenceFreshness,
  hasChangeRequiringEvidence,
} from "./freshness.ts";
import { WEB_CONFIG } from "./test-fixtures.ts";

function decide(changedSinceRecordedHead: readonly string[], recordedHead: string | null = "h1") {
  return decideEvidenceFreshness({
    recordedHead: recordedHead ?? undefined, currentHead: "h2", changedSinceRecordedHead, caseId: "c", config: WEB_CONFIG,
  });
}

describe("decideEvidenceFreshness", () => {
  it("is current when recorded head equals HEAD", () => {
    expect(decideEvidenceFreshness({ recordedHead: "h2", currentHead: "h2",
      changedSinceRecordedHead: ["client/src/App.tsx"], caseId: "c", config: WEB_CONFIG }))
      .toEqual({ current: true, reason: "recorded at current HEAD" });
  });
  it("is stale after non-test client code changes", () => {
    expect(decide(["client/src/App.tsx"])).toEqual({ current: false, reason: "client/src/App.tsx changed after recording" });
  });
  it("is stale after server code changes", () => {
    expect(decide(["server/src/api/foo.api.docs.yaml"]).current).toBe(false);
  });
  it("is stale after its own flow changes", () => {
    expect(decide(["qa/ux/c/flow.ts"]).current).toBe(false);
  });
  it("configChangeInvalidates: is stale after the settings file changes", () => {
    expect(decide(["qa/ux/config.yaml"])).toEqual({ current: false, reason: "qa/ux/config.yaml changed after recording" });
  });
  it.each(["client/src/App.test.tsx", "server/src/api/foo.spec.ts", "client/src/__tests__/App.tsx",
    "client/README.md", "qa/ux/c/notes.md"])("stays current when only %s changed", (path) => {
    expect(decide([path]).current).toBe(true);
  });
  it("stays current when only tests, docs or other cases changed", () => {
    expect(decide(["docs/x.md", "client/src/A.test.tsx", "qa/ux/other/flow.ts", "Makefile"]))
      .toEqual({ current: true, reason: "no relevant changes since recording" });
  });
  it("treats a missing result as stale", () => {
    expect(decide([], null)).toEqual({ current: false, reason: "result.json is missing" });
  });
});

describe("changedCaseIds", () => {
  it("extracts unique case ids in first-seen order", () => {
    expect(changedCaseIds(["qa/ux/a/flow.ts", "qa/ux/a/evidence.yaml", "qa/ux/README.md", "qa/ux/b/flow.ts"]))
      .toEqual(["a", "b"]);
  });
});

describe("hasChangeRequiringEvidence", () => {
  it("is false for client tests and server code", () => {
    expect(hasChangeRequiringEvidence(["client/src/A.test.tsx", "client/README.md", "server/src/x.ts"], WEB_CONFIG))
      .toBe(false);
  });
  it("is true for non-test client code", () => {
    expect(hasChangeRequiringEvidence(["client/src/A.tsx"], WEB_CONFIG)).toBe(true);
  });
});

describe("blockingDirtyPaths", () => {
  it("blocks dirty client, server, settings and current-case paths", () => {
    expect(blockingDirtyPaths(["client/src/App.tsx", "server/src/s.ts", "qa/ux/c/flow.ts", "qa/ux/config.yaml",
      "qa/ux/other/flow.ts", "docs/n.md"], "c", WEB_CONFIG))
      .toEqual(["client/src/App.tsx", "server/src/s.ts", "qa/ux/c/flow.ts", "qa/ux/config.yaml"]);
  });
  it("does not block ignored paths", () => {
    expect(blockingDirtyPaths(["client/src/App.test.tsx", "client/README.md"], "c", WEB_CONFIG)).toEqual([]);
  });
});
