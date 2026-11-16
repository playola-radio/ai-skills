import { describe, expect, it, vi } from "vitest";
import { parseManifestYaml } from "../manifest.ts";
import { createEvidenceCase, renderNewCase, type NewCaseInput } from "./new.ts";

const input: NewCaseInput = {
  id: "weekly-play-counts", classification: "visual", beforePolicy: "required", reason: null, startPath: "/stations",
};

describe("renderNewCase", () => {
  it("renders YAML that parses back to the input", () => {
    const { manifestYaml } = renderNewCase(input);
    expect(parseManifestYaml(manifestYaml, input.id)).toEqual({
      version: 1, id: input.id, classification: "visual", before: { policy: "required", reason: null }, startPath: "/stations",
    });
  });

  it("keeps a reason that contains YAML punctuation", () => {
    const { manifestYaml } = renderNewCase({ ...input, beforePolicy: "not-applicable", reason: "new page: no base" });
    expect(parseManifestYaml(manifestYaml, input.id).before).toEqual({ policy: "not-applicable", reason: "new page: no base" });
  });

  it("rejects not-applicable without a reason", () => {
    expect(() => renderNewCase({ ...input, beforePolicy: "not-applicable" })).toThrow("before.reason is required");
  });

  it("rejects an invalid id", () => {
    expect(() => renderNewCase({ ...input, id: "Bad_Id" })).toThrow("case id must be lowercase letters, digits and hyphens");
  });

  it("includes a shot line for visual cases only", () => {
    expect(renderNewCase(input).flowSource).toContain("shot(");
    expect(renderNewCase({ ...input, classification: "functional" }).flowSource).not.toContain("shot(");
  });
});

describe("createEvidenceCase", () => {
  function deps(exists: boolean) {
    return {
      fileExists: vi.fn(async () => exists),
      makeDirectory: vi.fn(async () => {}),
      writeTextFile: vi.fn(async (_path: string, _content: string) => {}),
    };
  }

  it("writes the manifest and flow into the case folder", async () => {
    const d = deps(false);
    await createEvidenceCase({ ...input, repoRoot: "/repo" }, d);
    expect(d.makeDirectory).toHaveBeenCalledWith("/repo/qa/ux/weekly-play-counts");
    expect(d.writeTextFile.mock.calls.map(([path]) => path)).toEqual([
      "/repo/qa/ux/weekly-play-counts/evidence.yaml",
      "/repo/qa/ux/weekly-play-counts/flow.ts",
    ]);
  });

  it("refuses an existing case and writes nothing", async () => {
    const d = deps(true);
    await expect(createEvidenceCase({ ...input, repoRoot: "/repo" }, d)).rejects.toThrow("case already exists: weekly-play-counts");
    expect(d.makeDirectory).not.toHaveBeenCalled();
    expect(d.writeTextFile).not.toHaveBeenCalled();
  });
});
