import { posix } from "node:path";
import type { EvidenceConfig } from "../config.ts";
import { renderEvidenceComment } from "../render.ts";
import { parseEvidenceResult } from "../results.ts";
import { resultPath, verifyEvidence, type VerifyDependencies } from "./verify.ts";

export const MISSING_EVIDENCE_MESSAGE =
  'client code changed but no evidence case was added (add a case under qa/ux/, or put "UX evidence: none — <reason>" in the PR body)';

export async function publishEvidence(
  input: { repoRoot: string; config: EvidenceConfig; pr: string },
  dependencies: VerifyDependencies,
): Promise<void> {
  const { repoRoot, config, pr } = input;
  const report = await verifyEvidence({ repoRoot, config }, dependencies);
  if (!report.current) {
    const reasons = report.cases.filter((c) => !c.current).map((c) => `${c.caseId}: ${c.reason}`);
    if (report.missingEvidenceForClientChanges) reasons.push(MISSING_EVIDENCE_MESSAGE);
    throw new Error(`UX evidence is stale or missing: ${reasons.join("; ")}`);
  }

  for (const { caseId } of report.cases) {
    const result = parseEvidenceResult(await dependencies.readTextFile(resultPath(repoRoot, caseId)));
    const { attachments } = renderEvidenceComment(result);
    const args = [
      "pr", "comment", pr,
      "--body-file", posix.join(repoRoot, ".qa-artifacts", caseId, "comment.md"),
      ...attachments.flatMap((attachment) => ["--attach", posix.join(repoRoot, attachment)]),
    ];
    const outcome = await dependencies.exec("gh", args, { cwd: repoRoot });
    if (outcome.exitCode !== 0) {
      const tail = outcome.stderr.trimEnd().split("\n").slice(-5).join("\n");
      throw new Error(`gh pr comment failed for ${caseId}: ${tail}`);
    }
  }
}
