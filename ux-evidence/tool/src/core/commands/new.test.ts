import { describe, expect, it, vi } from "vitest";
import { parseManifestYaml } from "../manifest.ts";
import { createEvidenceCase, renderManifestYaml, type NewCaseInput } from "./new.ts";

const input: NewCaseInput = {
  id: "weekly-play-counts", classification: "visual", beforePolicy: "required", reason: null, startPath: "/stations",
};

describe("renderManifestYaml", () => {
  it("renders YAML that parses back to the input", () => {
    expect(parseManifestYaml(renderManifestYaml(input, "web"), input.id, "web")).toEqual({
      version: 1, id: input.id, classification: "visual", before: { policy: "required", reason: null }, startPath: "/stations",
    });
  });

  it("keeps a reason that contains YAML punctuation", () => {
    const manifestYaml = renderManifestYaml({ ...input, beforePolicy: "not-applicable", reason: "new page: no base" }, "web");
    expect(parseManifestYaml(manifestYaml, input.id, "web").before).toEqual({ policy: "not-applicable", reason: "new page: no base" });
  });

  it("rejects not-applicable without a reason", () => {
    expect(() => renderManifestYaml({ ...input, beforePolicy: "not-applicable" }, "web")).toThrow("before.reason is required");
  });

  it("rejects an invalid id", () => {
    expect(() => renderManifestYaml({ ...input, id: "Bad_Id" }, "web")).toThrow("case id must be lowercase letters, digits and hyphens");
  });

  it("requires a start path for web", () => {
    const { startPath: _omitted, ...withoutStartPath } = input;
    expect(() => renderManifestYaml(withoutStartPath, "web")).toThrow("startPath must begin with /");
  });

  it("rejects a start path for iOS", () => {
    expect(() => renderManifestYaml(input, "ios")).toThrow("startPath is only used by web cases");
  });
});

describe("createEvidenceCase", () => {
  function deps(exists: boolean) {
    return {
      fileExists: vi.fn(async () => exists),
      makeDirectory: vi.fn(async () => {}),
      writeTextFile: vi.fn(async (_path: string, _content: string) => {}),
      renderCase: vi.fn(() => new Map([["evidence.yaml", "yaml"], ["flow.ts", "flow"]])),
    };
  }

  it("writes every file the platform renders into the case folder", async () => {
    const d = deps(false);
    const written = await createEvidenceCase({ ...input, repoRoot: "/repo" }, d);
    expect(d.makeDirectory).toHaveBeenCalledWith("/repo/qa/ux/weekly-play-counts");
    expect(d.writeTextFile.mock.calls).toEqual([
      ["/repo/qa/ux/weekly-play-counts/evidence.yaml", "yaml"],
      ["/repo/qa/ux/weekly-play-counts/flow.ts", "flow"],
    ]);
    expect(written).toEqual(["/repo/qa/ux/weekly-play-counts/evidence.yaml", "/repo/qa/ux/weekly-play-counts/flow.ts"]);
  });

  it("validates the input before touching the case folder", async () => {
    const d = deps(false);
    d.renderCase.mockImplementation(() => { throw new Error("before.reason is required"); });
    await expect(createEvidenceCase({ ...input, repoRoot: "/repo" }, d)).rejects.toThrow("before.reason is required");
    expect(d.fileExists).not.toHaveBeenCalled();
  });

  it("refuses an existing case and writes nothing", async () => {
    const d = deps(true);
    await expect(createEvidenceCase({ ...input, repoRoot: "/repo" }, d)).rejects.toThrow("case already exists: weekly-play-counts");
    expect(d.makeDirectory).not.toHaveBeenCalled();
    expect(d.writeTextFile).not.toHaveBeenCalled();
  });
});
