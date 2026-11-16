import { join, posix } from "node:path";
import type { captureRevision, BrowserCapture } from "../browser.ts";
import type { EvidenceManifest, ReadTextFile, RevisionName } from "../domain.ts";
import type { Exec, PathStat } from "../effects.ts";
import { selectFlowPath, type loadEvidenceFlow } from "../flows.ts";
import { listBlockingDirtyPaths, resolveDumpMetadata, resolveGitRevisions } from "../git.ts";
import { assertValidCaseId } from "../case-id.ts";
import { loadManifest } from "../manifest.ts";
import type { composeComparisonPng, encodeVideo } from "../media.ts";
import { renderEvidenceComment } from "../render.ts";
import {
  assertArtifactsWithinLimit,
  type ArtifactRecord,
  type EvidenceResult,
  type RevisionResult,
} from "../results.ts";
import type { withRevisionStack, StackDependencies } from "../stack.ts";

export interface RecordDependencies {
  exec: Exec;
  stat: PathStat;
  readTextFile: ReadTextFile;
  fileExists(path: string): Promise<boolean>;
  withRevisionStack: typeof withRevisionStack;
  stackDependencies: StackDependencies;
  captureRevision: typeof captureRevision;
  loadEvidenceFlow: typeof loadEvidenceFlow;
  encodeVideo: typeof encodeVideo;
  composeComparisonPng: typeof composeComparisonPng;
  writeTextFile(path: string, content: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  clearDirectory(path: string): Promise<void>;
  filesIdentical(leftPath: string, rightPath: string): Promise<boolean>;
  checksumFile(path: string): Promise<string>;
  toolVersions(): Promise<Record<string, string>>;
  now(): Date;
}

interface RevisionOutcome { capture: BrowserCapture; warnings: readonly string[] }

function shotNames(capture: BrowserCapture): string[] {
  return [...capture.screenshots.keys()];
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.length === right.length && left.every((name) => rightSet.has(name));
}

export async function recordEvidenceCase(
  input: { repoRoot: string; caseId: string; environment: NodeJS.ProcessEnv; homeDirectory: string; allowIdentical?: boolean },
  dependencies: RecordDependencies,
): Promise<EvidenceResult> {
  const { repoRoot, caseId, environment, homeDirectory, allowIdentical = false } = input;
  assertValidCaseId(caseId);
  const { exec, stat } = dependencies;
  const caseDirectory = join(repoRoot, "qa", "ux", caseId);
  const artifactDirectory = posix.join(repoRoot, ".qa-artifacts", caseId);
  const relativeArtifactDirectory = posix.join(".qa-artifacts", caseId);

  const manifest: EvidenceManifest = await loadManifest(join(caseDirectory, "evidence.yaml"), caseId, dependencies.readTextFile);

  const dirty = await listBlockingDirtyPaths(repoRoot, caseId, exec);
  if (dirty.length > 0) throw new Error(`uncommitted changes block recording: ${dirty.join(", ")}`);

  const dump = await resolveDumpMetadata({ environment, homeDirectory, stat });
  const { head, base } = await resolveGitRevisions(repoRoot, exec);

  const tools = await dependencies.toolVersions();

  await dependencies.clearDirectory(artifactDirectory);

  const capturedAt = dependencies.now().toISOString();
  const runId = `${capturedAt.replace(/\D/g, "")}-${process.pid}`;

  async function recordRevision(revision: RevisionName, commit: string): Promise<RevisionOutcome> {
    const baseOverrideExists = revision === "base"
      && await dependencies.fileExists(join(caseDirectory, "flow.base.ts"));
    const flow = await dependencies.loadEvidenceFlow(selectFlowPath({ caseDirectory, revision, baseOverrideExists }));
    return dependencies.withRevisionStack(
      { repoRoot, revision, commit, dumpPath: dump.path, runId },
      dependencies.stackDependencies,
      async (stack) => ({
        capture: await dependencies.captureRevision({
          revision,
          classification: manifest.classification,
          clientUrl: stack.clientUrl,
          startPath: manifest.startPath,
          flow,
          outputDirectory: artifactDirectory,
        }).catch((error: unknown) => {
          throw new Error(`${caseId}: ${revision} capture failed: ${error instanceof Error ? error.message : String(error)}`);
        }),
        warnings: stack.warnings,
      }),
    );
  }

  const baseApplicable = manifest.before.policy === "required";
  const baseOutcome = baseApplicable ? await recordRevision("base", base) : undefined;
  const headOutcome = await recordRevision("head", head);

  if (baseOutcome) {
    const baseNames = shotNames(baseOutcome.capture);
    const headNames = shotNames(headOutcome.capture);
    if (!sameNames(baseNames, headNames)) {
      throw new Error(`${manifest.classification} shot names differ: base [${baseNames.join(", ")}], head [${headNames.join(", ")}]`);
    }
  }

  let identical = false;
  if (manifest.classification === "visual" && baseOutcome) {
    const comparisons = await Promise.all(shotNames(headOutcome.capture).map((shotName) =>
      dependencies.filesIdentical(
        posix.join(artifactDirectory, `before-${shotName}.png`),
        posix.join(artifactDirectory, `after-${shotName}.png`),
      )));
    identical = comparisons.length > 0 && comparisons.every(Boolean);
    if (identical && !allowIdentical) {
      throw new Error(
        `no visible difference: every before/after screenshot of ${caseId} is identical. Either the case does not show the change, or the change has no visible effect (then use "UX evidence: none — <reason>" in the PR body).`,
      );
    }
  }

  const artifacts: ArtifactRecord[] = [];
  async function addArtifact(
    kind: ArtifactRecord["kind"],
    fileName: string,
    extra: { revision?: RevisionName; shotName?: string },
  ): Promise<void> {
    const absolutePath = posix.join(artifactDirectory, fileName);
    artifacts.push({
      kind,
      ...extra,
      path: posix.join(relativeArtifactDirectory, fileName),
      sizeBytes: (await stat(absolutePath)).size,
      sha256: await dependencies.checksumFile(absolutePath),
    });
  }

  if (manifest.classification === "functional") {
    for (const [revision, outcome, fileName] of [
      ["base", baseOutcome, "before.mp4"],
      ["head", headOutcome, "after.mp4"],
    ] as const) {
      if (!outcome) continue;
      if (!outcome.capture.videoPath) throw new Error(`no video was recorded (${revision})`);
      await dependencies.encodeVideo({
        sourcePath: outcome.capture.videoPath,
        destinationPath: posix.join(artifactDirectory, fileName),
        exec,
        stat,
      });
      await dependencies.removeFile(outcome.capture.videoPath);
      await addArtifact("video", fileName, { revision });
    }
  }
  for (const shotName of shotNames(headOutcome.capture)) {
    if (baseOutcome) await addArtifact("screenshot", `before-${shotName}.png`, { revision: "base", shotName });
    await addArtifact("screenshot", `after-${shotName}.png`, { revision: "head", shotName });
    if (baseOutcome) {
      await dependencies.composeComparisonPng({
        beforePath: posix.join(artifactDirectory, `before-${shotName}.png`),
        afterPath: posix.join(artifactDirectory, `after-${shotName}.png`),
        destinationPath: posix.join(artifactDirectory, `compare-${shotName}.png`),
        exec,
      });
      await addArtifact("comparison", `compare-${shotName}.png`, { shotName });
    }
  }
  assertArtifactsWithinLimit(artifacts);

  const baseResult: RevisionResult = baseOutcome
    ? { status: "passed", warnings: baseOutcome.warnings }
    : { status: "not-applicable", reason: manifest.before.reason ?? "", warnings: [] };
  const result: EvidenceResult = {
    version: 1,
    caseId,
    classification: manifest.classification,
    baseCommit: base,
    headCommit: head,
    dump,
    revisions: { base: baseResult, head: { status: "passed", warnings: headOutcome.warnings } },
    artifacts,
    tools,
    capturedAt,
    ...(identical ? { identical: true as const } : {}),
  };

  await dependencies.writeTextFile(posix.join(artifactDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await dependencies.writeTextFile(posix.join(artifactDirectory, "comment.md"), renderEvidenceComment(result).markdown);
  return result;
}
