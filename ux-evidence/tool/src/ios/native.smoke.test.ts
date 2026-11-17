import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Opt-in: UX_EVIDENCE_IOS_REPO=<clean playola-radio-ios checkout with qa/ux> npx vitest run src/ios/native.smoke.test.ts
// Builds the app twice and drives real simulators, so it takes minutes and needs a saved staging session.
const repo = process.env.UX_EVIDENCE_IOS_REPO;

describe.skipIf(repo === undefined)("native iOS recording", () => {
  it("the saved session survives launch and the first-launch prompt is dismissed", async () => {
    const tool = join(import.meta.dirname, "..", "..");
    const run = spawnSync("npx", ["tsx", "src/main.ts", "--repo", repo!, "record", "--case", "example-stations", "--allow-identical"], {
      cwd: tool, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    expect(run.stderr + run.stdout).not.toContain("error:");
    expect(run.status).toBe(0);
    const result = JSON.parse(await readFile(join(repo!, ".qa-artifacts", "example-stations", "result.json"), "utf8")) as {
      platform: string; artifacts: Array<{ path: string }>;
    };
    expect(result.platform).toBe("ios");
    expect(result.artifacts.map((artifact) => artifact.path)).toEqual(expect.arrayContaining([
      ".qa-artifacts/example-stations/before-stations-list.png",
      ".qa-artifacts/example-stations/after-stations-list.png",
    ]));
  }, 60 * 60 * 1000);
});
