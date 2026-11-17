import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { declaredScreenshotNames } from "./maestro.ts";
import { renderIOSCase } from "./templates.ts";

const functional = { id: "example-navigation", classification: "functional", beforePolicy: "required", reason: null } as const;
const yamlSteps = (text: string) => parseAllDocuments(text).map((document) => document.toJS());

describe("renderIOSCase", () => {
  it("iosTemplateOmitsWebFields: writes evidence, setup and flow, with no startPath, flow.ts or base override", () => {
    const files = renderIOSCase(functional, "fm.app");
    expect([...files.keys()]).toEqual(["evidence.yaml", "setup.yaml", "flow.yaml"]);
    expect(files.get("evidence.yaml")).not.toContain("startPath");
    expect(() => renderIOSCase({ ...functional, startPath: "/stations" }, "fm.app")).toThrow("startPath is only used by web cases");
  });

  it("the flow fails with a named step until it is written, and the setup runs as it is", () => {
    const files = renderIOSCase(functional, "fm.app");
    expect(yamlSteps(files.get("flow.yaml")!)).toEqual([
      { appId: "fm.app" },
      [{ assertVisible: "write your flow in qa/ux/example-navigation/flow.yaml" }],
    ]);
    expect(yamlSteps(files.get("setup.yaml")!)).toEqual([{ appId: "fm.app" }, ["waitForAnimationToEnd"]]);
  });

  it("a visual case starts with a named screenshot; a functional case takes none", () => {
    const visual = renderIOSCase({ ...functional, classification: "visual" }, "fm.app").get("flow.yaml")!;
    expect(declaredScreenshotNames(visual, "flow.yaml")).toEqual(["main"]);
    expect(declaredScreenshotNames(renderIOSCase(functional, "fm.app").get("flow.yaml")!, "flow.yaml")).toEqual([]);
  });
});
