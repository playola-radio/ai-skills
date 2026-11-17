import { describe, expect, it } from "vitest";
import { assertArtifactsWithinLimit, parseEvidenceResult, type ArtifactRecord } from "./results.ts";

const video = (sizeBytes: number): ArtifactRecord => ({
  kind: "video",
  revision: "head",
  path: ".qa-artifacts/c/after.mp4",
  sizeBytes,
  sha256: "x",
});

const validResult = {
  version: 1,
  caseId: "c",
  baseCommit: "1234567890",
  headCommit: "abcdef0123",
  artifacts: [],
};

describe("assertArtifactsWithinLimit", () => {
  it("rejects a file one byte over the cap", () => {
    expect(() => assertArtifactsWithinLimit([video(10_485_761)])).toThrow(
      "after.mp4 is 10485761 bytes; GitHub limit is 10485760",
    );
  });

  it("accepts a file exactly at the cap", () => {
    expect(() => assertArtifactsWithinLimit([video(10_485_760)])).not.toThrow();
  });
});

describe("parseEvidenceResult", () => {
  it("returns a valid result", () => {
    expect(parseEvidenceResult(JSON.stringify(validResult)).caseId).toBe("c");
  });

  it("rejects a non-object", () => {
    expect(() => parseEvidenceResult("[]")).toThrow("result must be a JSON object");
  });

  it("rejects an unsupported version", () => {
    expect(() => parseEvidenceResult(JSON.stringify({ ...validResult, version: 2 }))).toThrow(
      "unsupported result version: 2",
    );
  });

  it("rejects a missing commit", () => {
    expect(() => parseEvidenceResult(JSON.stringify({ ...validResult, headCommit: 1 }))).toThrow(
      "result.headCommit must be a string",
    );
  });

  it("rejects non-array artifacts", () => {
    expect(() => parseEvidenceResult(JSON.stringify({ ...validResult, artifacts: {} }))).toThrow(
      "result.artifacts must be an array",
    );
  });
});
