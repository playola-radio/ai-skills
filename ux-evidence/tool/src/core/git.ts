import type { EvidenceConfig } from "./config.ts";
import type { Exec } from "./effects.ts";
import { blockingDirtyPaths } from "./freshness.ts";

async function git(repoRoot: string, exec: Exec, args: readonly string[]): Promise<string> {
  const result = await exec("git", args, { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function nulSeparated(output: string): readonly string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

export async function resolveGitRevisions(
  repoRoot: string,
  baseBranch: string,
  exec: Exec,
): Promise<{ head: string; base: string }> {
  const head = (await git(repoRoot, exec, ["rev-parse", "HEAD"])).trim();
  const base = (await git(repoRoot, exec, ["merge-base", "HEAD", `origin/${baseBranch}`])).trim();
  return { head, base };
}

function pathsFromPorcelain(output: string): readonly string[] {
  const entries = nulSeparated(output);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      index += 1;
      const origin = entries[index];
      if (origin !== undefined) paths.push(origin);
    }
  }
  return paths;
}

export async function listBlockingDirtyPaths(
  repoRoot: string,
  caseId: string,
  config: EvidenceConfig,
  exec: Exec,
): Promise<readonly string[]> {
  const status = await git(repoRoot, exec, ["status", "--porcelain", "-z"]);
  return blockingDirtyPaths(pathsFromPorcelain(status), caseId, config);
}

export async function changedPathsBetween(
  repoRoot: string,
  from: string,
  to: string,
  exec: Exec,
): Promise<readonly string[]> {
  return nulSeparated(await git(repoRoot, exec, ["diff", "--name-only", "-z", from, to]));
}
