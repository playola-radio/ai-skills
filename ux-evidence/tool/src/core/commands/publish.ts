import { posix } from "node:path";
import type { EvidenceConfig } from "../config.ts";
import { renderEvidenceComment } from "../render.ts";
import { parseEvidenceResult } from "../results.ts";
import { resultPath, verifyEvidence, type VerifyDependencies } from "./verify.ts";

export const MISSING_EVIDENCE_MESSAGE =
  'client code changed but no evidence case was added (add a case under qa/ux/, or put "UX evidence: none — <reason>" in the PR body)';

const PHONE_WIDTHS: Record<string, number> = { screenshot: 300, comparison: 600 };

// A full-size phone screenshot fills the page; GitHub only takes a width on an <img> tag, and the upload keeps full size behind the click.
export function shrinkPhoneShots(body: string): string {
  return body.replaceAll(/!\[phone (screenshot|comparison)\]\(([^)]+)\)/g, (_, kind, url) => `<img src="${url}" width="${PHONE_WIDTHS[kind]}" alt="phone ${kind}">`);
}

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
    const comment = await dependencies.readTextFile(posix.join(repoRoot, ".qa-artifacts", caseId, "comment.md"));
    const phoneShots = result.platform === "ios" ? result.artifacts.filter((a) => a.kind in PHONE_WIDTHS) : [];
    const body = phoneShots.reduce((text, shot) => text.replace(`![](${shot.path})`, `![phone ${shot.kind}](${shot.path})`), comment);
    const gh = async (args: string[]): Promise<string> => {
      const outcome = await dependencies.exec("gh", args, { cwd: repoRoot });
      if (outcome.exitCode !== 0) {
        const tail = outcome.stderr.trimEnd().split("\n").slice(-5).join("\n");
        throw new Error(`gh ${args.slice(0, 2).join(" ")} failed for ${caseId}: ${tail}`);
      }
      return outcome.stdout;
    };
    const posted = await gh(["pr", "comment", pr, "--body", body, ...attachments.flatMap((attachment) => ["--attach", posix.join(repoRoot, attachment)])]);
    const commentId = /issuecomment-(\d+)/.exec(posted)?.[1];
    if (commentId === undefined) continue;
    const endpoint = `repos/{owner}/{repo}/issues/comments/${commentId}`;
    if (phoneShots.length > 0) {
      const uploaded = await gh(["api", endpoint, "--jq", ".body"]);
      await gh(["api", "-X", "PATCH", endpoint, "-f", `body=${shrinkPhoneShots(uploaded.trimEnd())}`]);
    }
    const [issueUrl, author] = (await gh(["api", endpoint, "--jq", "[.issue_url, .user.login] | @tsv"])).trim().split("\t");
    const heading = comment.split("\n")[0];
    const older = await gh(["api", "--paginate", `${issueUrl}/comments`, "--jq",
      `.[] | select(.id != ${commentId} and .user.login == ${JSON.stringify(author)}` +
      ` and (.body | split("\\n")[0] | rtrimstr("\\r")) == ${JSON.stringify(heading)}) | .id`]);
    for (const id of older.split("\n").filter((line) => line !== "")) {
      await gh(["api", "-X", "DELETE", `repos/{owner}/{repo}/issues/comments/${id}`]);
    }
  }
}
