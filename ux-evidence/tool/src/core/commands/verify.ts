import { posix } from "node:path";
import type { ReadTextFile } from "../domain.ts";
import type { Exec } from "../effects.ts";
import { changedCaseIds, decideEvidenceFreshness, hasRelevantClientChange } from "../freshness.ts";
import { changedPathsBetween, resolveGitRevisions } from "../git.ts";
import { assertValidCaseId } from "../case-id.ts";
import { renderEvidenceComment } from "../render.ts";
import { parseEvidenceResult, type EvidenceResult } from "../results.ts";

export interface VerificationReport {
  current: boolean;
  cases: readonly { caseId: string; current: boolean; reason: string }[];
  missingEvidenceForClientChanges: boolean;
}

export interface VerifyDependencies {
  exec: Exec;
  readTextFile: ReadTextFile;
  fileExists(path: string): Promise<boolean>;
  checksumFile(path: string): Promise<string>;
}

const EVIDENCE_FILES_STALE = "evidence files missing or changed; record again";

export function resultPath(repoRoot: string, caseId: string): string {
  return posix.join(repoRoot, ".qa-artifacts", caseId, "result.json");
}

async function evidenceFilesIntact(
  repoRoot: string,
  caseId: string,
  result: EvidenceResult,
  dependencies: VerifyDependencies,
): Promise<boolean> {
  const commentPath = posix.join(repoRoot, ".qa-artifacts", caseId, "comment.md");
  if (!(await dependencies.fileExists(commentPath))) return false;
  if ((await dependencies.readTextFile(commentPath)) !== renderEvidenceComment(result).markdown) return false;
  for (const artifact of result.artifacts) {
    const artifactPath = posix.join(repoRoot, artifact.path);
    if (!(await dependencies.fileExists(artifactPath))) return false;
    if ((await dependencies.checksumFile(artifactPath)) !== artifact.sha256) return false;
  }
  return true;
}

export async function verifyEvidence(
  input: { repoRoot: string },
  dependencies: VerifyDependencies,
): Promise<VerificationReport> {
  const { repoRoot } = input;
  const { exec } = dependencies;
  const { head, base } = await resolveGitRevisions(repoRoot, exec);
  const branchChanges = await changedPathsBetween(repoRoot, base, head, exec);
  const caseIds: string[] = [];
  for (const caseId of changedCaseIds(branchChanges)) {
    assertValidCaseId(caseId);
    if (await dependencies.fileExists(posix.join(repoRoot, "qa", "ux", caseId, "evidence.yaml"))) caseIds.push(caseId);
  }
  const missingEvidenceForClientChanges = caseIds.length === 0 && hasRelevantClientChange(branchChanges);

  const cases = [];
  for (const caseId of caseIds) {
    const path = resultPath(repoRoot, caseId);
    const recorded = (await dependencies.fileExists(path))
      ? parseEvidenceResult(await dependencies.readTextFile(path))
      : undefined;
    if (recorded !== undefined) assertValidCaseId(recorded.caseId);
    const recordedHead = recorded?.headCommit;
    const changedSinceRecordedHead = recordedHead === undefined || recordedHead === head
      ? []
      : await changedPathsBetween(repoRoot, recordedHead, head, exec);
    const decision = decideEvidenceFreshness({ recordedHead, currentHead: head, changedSinceRecordedHead, caseId });
    const intact = !decision.current || recorded === undefined || recorded.baseCommit === base
      && await evidenceFilesIntact(repoRoot, caseId, recorded, dependencies);
    cases.push({ caseId, ...(intact ? decision : { current: false, reason: EVIDENCE_FILES_STALE }) });
  }

  return {
    current: !missingEvidenceForClientChanges && cases.every((c) => c.current),
    cases,
    missingEvidenceForClientChanges,
  };
}
