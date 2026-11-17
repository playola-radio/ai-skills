import { describe, expect, it } from "vitest";
import { loadManifest, parseManifestYaml } from "./manifest.ts";

const validYaml = `
version: 1
id: weekly-play-counts
classification: functional
before:
  policy: required
  reason: null
startPath: /stations
`;

describe("parseManifestYaml", () => {
  it("parses a valid functional manifest", () => {
    expect(parseManifestYaml(validYaml, "weekly-play-counts")).toEqual({
      version: 1, id: "weekly-play-counts", classification: "functional",
      before: { policy: "required", reason: null }, startPath: "/stations",
    });
  });
  it("requires id to match the case folder", () => {
    expect(() => parseManifestYaml(validYaml, "other")).toThrow("manifest id must equal folder name");
  });
  it("rejects an id that is not a safe case id even when it matches the folder", () => {
    expect(() => parseManifestYaml(validYaml.replace("weekly-play-counts", "../client"), "../client"))
      .toThrow("case id must be lowercase letters, digits and hyphens");
  });
  it("requires a reason when before is not-applicable", () => {
    expect(() => parseManifestYaml(validYaml.replace("policy: required", "policy: not-applicable"), "weekly-play-counts"))
      .toThrow("before.reason is required when policy is not-applicable");
  });
  it("treats a blank reason as missing", () => {
    const yaml = validYaml.replace("policy: required", "policy: not-applicable").replace("reason: null", 'reason: "   "');
    expect(() => parseManifestYaml(yaml, "weekly-play-counts"))
      .toThrow("before.reason is required when policy is not-applicable");
  });
  it("rejects unsupported versions", () => {
    expect(() => parseManifestYaml(validYaml.replace("version: 1", "version: 2"), "weekly-play-counts"))
      .toThrow("unsupported manifest version: 2");
  });
  it("requires startPath to begin with /", () => {
    expect(() => parseManifestYaml(validYaml.replace("/stations", "stations"), "weekly-play-counts"))
      .toThrow("startPath must begin with /");
  });
  it("rejects an unknown classification", () => {
    expect(() => parseManifestYaml(validYaml.replace("functional", "cosmetic"), "weekly-play-counts"))
      .toThrow("classification must be visual or functional");
  });
  it("drops unknown fields", () => {
    expect(parseManifestYaml(`${validYaml}extra: 1\n`, "weekly-play-counts")).not.toHaveProperty("extra");
  });
});

describe("loadManifest", () => {
  it("reads and parses the manifest file", async () => {
    const manifest = await loadManifest("/x/evidence.yaml", "weekly-play-counts", async () => validYaml);
    expect(manifest.id).toBe("weekly-play-counts");
  });
});
