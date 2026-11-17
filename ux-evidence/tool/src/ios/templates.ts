import type { NewCaseInput } from "../core/commands/new.ts";
import { renderManifestYaml } from "../core/commands/new.ts";

function header(bundleId: string): string {
  return `appId: ${bundleId}\n---\n`;
}

// The flow fails on a step that names the file to edit, so an unwritten case can never be recorded.
export function renderIOSCase(input: NewCaseInput, bundleId: string): ReadonlyMap<string, string> {
  const placeholder = `write your flow in qa/ux/${input.id}/flow.yaml`;
  const setup = [
    "# Runs after launch, before anything is captured: dismiss alerts and reach the first screen of the flow.",
    "- waitForAnimationToEnd",
    "",
  ];
  const flow = [
    input.classification === "visual"
      ? "# Each takeScreenshot step becomes a before/after pair."
      : "# Only these steps are recorded; keep them to the interaction being shown.",
    ...(input.classification === "visual" ? ["- takeScreenshot: main"] : []),
    `- assertVisible: ${JSON.stringify(placeholder)}`,
    "",
  ];
  return new Map([
    ["evidence.yaml", renderManifestYaml(input, "ios")],
    ["setup.yaml", header(bundleId) + setup.join("\n")],
    ["flow.yaml", header(bundleId) + flow.join("\n")],
  ]);
}
