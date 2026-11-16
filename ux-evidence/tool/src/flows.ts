import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EvidenceFlow } from "./flow-api.ts";
import type { RevisionName } from "./domain.ts";

export function selectFlowPath(input: { caseDirectory: string; revision: RevisionName; baseOverrideExists: boolean }): string {
  const useOverride = input.revision === "base" && input.baseOverrideExists;
  return join(input.caseDirectory, useOverride ? "flow.base.ts" : "flow.ts");
}

export async function loadEvidenceFlow(
  path: string,
  importFlow: (path: string) => Promise<unknown> = (flowPath) => import(pathToFileURL(flowPath).href),
): Promise<EvidenceFlow> {
  const name = basename(path);
  const module = (await importFlow(path)) as { setup?: unknown; demo?: unknown };
  if (typeof module.demo !== "function") throw new Error(`${name} must export demo`);
  if (module.setup !== undefined && typeof module.setup !== "function") throw new Error(`${name} setup must be a function`);
  return { setup: module.setup as EvidenceFlow["setup"], demo: module.demo as EvidenceFlow["demo"] };
}
