import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvidenceFlow, selectFlowPath } from "./flows.ts";

const caseDirectory = "/repo/qa/ux/c";

describe("selectFlowPath", () => {
  it("uses flow.ts for base when there is no override", () => {
    expect(selectFlowPath({ caseDirectory, revision: "base", baseOverrideExists: false })).toBe("/repo/qa/ux/c/flow.ts");
  });

  it("uses flow.base.ts only for base", () => {
    expect(selectFlowPath({ caseDirectory, revision: "base", baseOverrideExists: true })).toBe("/repo/qa/ux/c/flow.base.ts");
    expect(selectFlowPath({ caseDirectory, revision: "head", baseOverrideExists: true })).toBe("/repo/qa/ux/c/flow.ts");
  });
});

describe("loadEvidenceFlow", () => {
  it("loads a flow from another repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ux-evidence-flow-"));
    const path = join(directory, "flow.ts");
    await writeFile(path, "export async function demo() {}\n");

    try {
      const flow = await loadEvidenceFlow(path);
      await expect(flow.demo(undefined as never)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns setup and demo", async () => {
    const setup = async () => {};
    const demo = async () => {};
    const flow = await loadEvidenceFlow("/x/flow.ts", async () => ({ setup, demo, extra: 1 }));
    expect(flow).toEqual({ setup, demo });
  });

  it("allows a flow without setup", async () => {
    const demo = async () => {};
    expect((await loadEvidenceFlow("/x/flow.ts", async () => ({ demo }))).setup).toBeUndefined();
  });

  it("rejects a flow without demo", async () => {
    await expect(loadEvidenceFlow("/x/flow.ts", async () => ({ setup: async () => {} }))).rejects.toThrow("flow.ts must export demo");
  });

  it("names the override file in the error", async () => {
    await expect(loadEvidenceFlow("/x/flow.base.ts", async () => ({}))).rejects.toThrow("flow.base.ts must export demo");
  });

  it("rejects a setup that is not a function", async () => {
    await expect(loadEvidenceFlow("/x/flow.ts", async () => ({ setup: 1, demo: async () => {} }))).rejects.toThrow("flow.ts setup must be a function");
  });
});
