import { CONFIG_PATH, isIgnoredPath, isRelevantPath, requiresEvidence, type EvidenceConfig } from "./config.ts";

export interface FreshnessDecision { current: boolean; reason: string }

const CASES_PREFIX = "qa/ux/";

function isRelevantToCase(path: string, caseId: string, config: EvidenceConfig): boolean {
  if (isRelevantPath(path, config)) return true;
  const ownsPath = path === CONFIG_PATH || path.startsWith(`${CASES_PREFIX}${caseId}/`);
  return ownsPath && !isIgnoredPath(path, config);
}

export function decideEvidenceFreshness(input: {
  recordedHead: string | undefined;
  currentHead: string;
  changedSinceRecordedHead: readonly string[];
  caseId: string;
  config: EvidenceConfig;
}): FreshnessDecision {
  if (input.recordedHead === undefined) return { current: false, reason: "result.json is missing" };
  if (input.recordedHead === input.currentHead) return { current: true, reason: "recorded at current HEAD" };
  const relevant = input.changedSinceRecordedHead.find((path) => isRelevantToCase(path, input.caseId, input.config));
  if (relevant !== undefined) return { current: false, reason: `${relevant} changed after recording` };
  return { current: true, reason: "no relevant changes since recording" };
}

export function changedCaseIds(changedPaths: readonly string[]): readonly string[] {
  const ids = new Set<string>();
  for (const path of changedPaths) {
    if (!path.startsWith(CASES_PREFIX)) continue;
    const [id, ...rest] = path.slice(CASES_PREFIX.length).split("/");
    if (id !== undefined && id !== "" && rest.length > 0) ids.add(id);
  }
  return [...ids];
}

export function hasChangeRequiringEvidence(changedPaths: readonly string[], config: EvidenceConfig): boolean {
  return changedPaths.some((path) => requiresEvidence(path, config));
}

export function blockingDirtyPaths(
  changedPaths: readonly string[],
  caseId: string,
  config: EvidenceConfig,
): readonly string[] {
  return changedPaths.filter((path) => isRelevantToCase(path, caseId, config));
}
