import { describe, expect, it } from "vitest";
import {
  assertArtifactsWithinLimit, isOutdatedResult, pairEnvironment, parseEvidenceResult, type ArtifactRecord,
} from "./results.ts";

const video = (sizeBytes: number): ArtifactRecord => ({
  kind: "video",
  revision: "head",
  path: ".qa-artifacts/c/after.mp4",
  sizeBytes,
  sha256: "x",
});

const webEnvironment = { dump: { path: "/d", modifiedAt: "2026-11-01T00:00:00.000Z", sizeBytes: 1 } };

const validResult = {
  version: 2,
  platform: "web",
  environment: webEnvironment,
  caseId: "c",
  baseCommit: "1234567890",
  headCommit: "abcdef0123",
  toolCommit: "fedcba9876",
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
    expect(() => parseEvidenceResult(JSON.stringify({ ...validResult, version: 3 }))).toThrow(
      "unsupported result version: 3",
    );
  });

  it("rejects an environment that belongs to another platform", () => {
    expect(() => parseEvidenceResult(JSON.stringify({ ...validResult, platform: "ios" }))).toThrow(
      "the ios adapter reported an environment for another platform",
    );
  });

  it("requires the tool commit", () => {
    const { toolCommit: _omitted, ...withoutToolCommit } = validResult;
    expect(() => parseEvidenceResult(JSON.stringify(withoutToolCommit))).toThrow("result.toolCommit must be a string");
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

describe("isOutdatedResult", () => {
  it("recognises a version 1 result", () => {
    expect(isOutdatedResult(JSON.stringify({ ...validResult, version: 1 }))).toBe(true);
  });

  it("does not flag a current result", () => {
    expect(isOutdatedResult(JSON.stringify(validResult))).toBe(false);
  });

  it("leaves unreadable files to the parser", () => {
    expect(isOutdatedResult("{")).toBe(false);
  });
});

describe("pairEnvironment", () => {
  it("pairs a web platform with the dump details", () => {
    expect(pairEnvironment("web", webEnvironment)).toEqual({ platform: "web", environment: webEnvironment });
  });
});
