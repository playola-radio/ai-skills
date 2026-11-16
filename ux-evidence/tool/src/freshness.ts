export interface FreshnessDecision { current: boolean; reason: string }

const CASES_PREFIX = "qa/ux/";
const IGNORED_PATTERNS: readonly RegExp[] = [/\.test\./, /\.spec\./, /(^|\/)__tests__\//, /\.md$/];

export function isFreshnessIgnoredPath(path: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(path));
}

function isInCaseFolder(path: string, caseId: string): boolean {
  return path.startsWith(`${CASES_PREFIX}${caseId}/`);
}

function isUnderAppCode(path: string): boolean {
  return path.startsWith("client/") || path.startsWith("server/");
}

export function decideEvidenceFreshness(input: {
  recordedHead: string | undefined;
  currentHead: string;
  changedSinceRecordedHead: readonly string[];
  caseId: string;
}): FreshnessDecision {
  if (input.recordedHead === undefined) return { current: false, reason: "result.json is missing" };
  if (input.recordedHead === input.currentHead) return { current: true, reason: "recorded at current HEAD" };
  const relevant = input.changedSinceRecordedHead.find(
    (path) => (isUnderAppCode(path) || isInCaseFolder(path, input.caseId)) && !isFreshnessIgnoredPath(path),
  );
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

export function hasRelevantClientChange(changedPaths: readonly string[]): boolean {
  return changedPaths.some((path) => path.startsWith("client/") && !isFreshnessIgnoredPath(path));
}

export function blockingDirtyPaths(changedPaths: readonly string[], caseId: string): readonly string[] {
  return changedPaths.filter((path) => isUnderAppCode(path) || isInCaseFolder(path, caseId));
}
