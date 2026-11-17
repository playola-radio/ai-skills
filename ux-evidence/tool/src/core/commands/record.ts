import { join, posix } from "node:path";
import { assertValidCaseId } from "../case-id.ts";
import type { CleanupRegistry } from "../cleanup.ts";
import type { EvidenceConfig, Platform } from "../config.ts";
import type { ReadTextFile, RevisionName } from "../domain.ts";
import type { Exec, PathStat } from "../effects.ts";
import { listBlockingDirtyPaths, resolveGitRevisions } from "../git.ts";
import { loadManifest } from "../manifest.ts";
import type { composeComparisonPng, encodeVideo } from "../media.ts";
import type { Capture, PlatformAdapter, PreparedRun, RecordContext } from "../platform.ts";
import { renderEvidenceComment } from "../render.ts";
import {
  assertArtifactsWithinLimit,
  pairEnvironment,
  type ArtifactRecord,
  type EvidenceResult,
  type RevisionResult,
} from "../results.ts";

export interface RecordDependencies {
  exec: Exec;
  stat: PathStat;
  readTextFile: ReadTextFile;
  adapter: PlatformAdapter;
  cleanup: CleanupRegistry;
  encodeVideo: typeof encodeVideo;
  composeComparisonPng: typeof composeComparisonPng;
  writeTextFile(path: string, content: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  clearDirectory(path: string): Promise<void>;
  makeRunDirectory(platform: Platform, runId: string): Promise<string>;
  removeDirectory(path: string): Promise<void>;
  imagesIdentical(leftPath: string, rightPath: string): Promise<boolean>;
  checksumFile(path: string): Promise<string>;
  toolCommit(): Promise<string>;
  now(): Date;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shotNames(capture: Capture): string[] {
  return [...capture.screenshots.keys()];
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.length === right.length && left.every((name) => rightSet.has(name));
}

async function captureRevisions(
  prepared: PreparedRun,
  baseApplicable: boolean,
): Promise<{ baseCapture: Capture | undefined; headCapture: Capture }> {
  let captures: { baseCapture: Capture | undefined; headCapture: Capture };
  try {
    const baseCapture = baseApplicable ? await prepared.capture("base") : undefined;
    captures = { baseCapture, headCapture: await prepared.capture("head") };
  } catch (error) {
    try {
      await prepared.dispose();
    } catch (disposeError) {
      throw new Error(`${messageOf(error)}; cleanup also failed: ${messageOf(disposeError)}`, { cause: error });
    }
    throw error;
  }
  await prepared.dispose();
  return captures;
}

export async function recordEvidenceCase(
  input: { repoRoot: string; caseId: string; config: EvidenceConfig; allowIdentical?: boolean },
  dependencies: RecordDependencies,
): Promise<EvidenceResult> {
  const { repoRoot, caseId, config, allowIdentical = false } = input;
  assertValidCaseId(caseId);
  const { exec, stat, adapter } = dependencies;
  const caseDirectory = join(repoRoot, "qa", "ux", caseId);
  const artifactDirectory = posix.join(repoRoot, ".qa-artifacts", caseId);
  const relativeArtifactDirectory = posix.join(".qa-artifacts", caseId);

  const manifest = await loadManifest(join(caseDirectory, "evidence.yaml"), caseId, config.platform, dependencies.readTextFile);
  const toolCommit = await dependencies.toolCommit();

  const dirty = await listBlockingDirtyPaths(repoRoot, caseId, config, exec);
  if (dirty.length > 0) throw new Error(`uncommitted changes block recording: ${dirty.join(", ")}`);

  const { head, base } = await resolveGitRevisions(repoRoot, config.baseBranch, exec);
  const capturedAt = dependencies.now().toISOString();
  const runId = `${capturedAt.replace(/\D/g, "")}-${process.pid}`;
  const runDirectory = await dependencies.makeRunDirectory(config.platform, runId);
  let removeRunDirectory: Promise<void> | undefined;
  const removeRun = () => (removeRunDirectory ??= dependencies.removeDirectory(runDirectory));
  dependencies.cleanup.add(removeRun);

  try {
    const context: RecordContext = {
      repoRoot, config, manifest, commits: { base, head }, caseDirectory, artifactDirectory, runDirectory,
      cleanup: dependencies.cleanup,
    };
    const preflight = await adapter.preflight(context);
    const platformEnvironment = pairEnvironment(config.platform, preflight.environment);

    await dependencies.clearDirectory(artifactDirectory);

    const baseApplicable = manifest.before.policy === "required";
    const { baseCapture, headCapture } = await captureRevisions(await adapter.prepare(context), baseApplicable);

    if (baseCapture) {
      const baseNames = shotNames(baseCapture);
      const headNames = shotNames(headCapture);
      if (!sameNames(baseNames, headNames)) {
        throw new Error(`${manifest.classification} shot names differ: base [${baseNames.join(", ")}], head [${headNames.join(", ")}]`);
      }
    }

    let identical = false;
    if (manifest.classification === "visual" && baseCapture) {
      const comparisons = await Promise.all(shotNames(headCapture).map((shotName) =>
        dependencies.imagesIdentical(
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
      for (const [revision, capture, fileName] of [
        ["base", baseCapture, "before.mp4"],
        ["head", headCapture, "after.mp4"],
      ] as const) {
        if (!capture) continue;
        if (!capture.videoPath) throw new Error(`no video was recorded (${revision})`);
        await dependencies.encodeVideo({
          sourcePath: capture.videoPath,
          destinationPath: posix.join(artifactDirectory, fileName),
          exec,
          stat,
        });
        await dependencies.removeFile(capture.videoPath);
        await addArtifact("video", fileName, { revision });
      }
    }
    for (const shotName of shotNames(headCapture)) {
      if (baseCapture) await addArtifact("screenshot", `before-${shotName}.png`, { revision: "base", shotName });
      await addArtifact("screenshot", `after-${shotName}.png`, { revision: "head", shotName });
      if (baseCapture) {
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

    const baseResult: RevisionResult = baseCapture
      ? { status: "passed", warnings: baseCapture.warnings }
      : { status: "not-applicable", reason: manifest.before.reason ?? "", warnings: [] };
    const result: EvidenceResult = {
      version: 2,
      ...platformEnvironment,
      caseId,
      classification: manifest.classification,
      baseCommit: base,
      headCommit: head,
      toolCommit,
      revisions: { base: baseResult, head: { status: "passed", warnings: headCapture.warnings } },
      artifacts,
      tools: preflight.tools,
      capturedAt,
      ...(identical ? { identical: true as const } : {}),
    };

    await removeRun();
    await dependencies.writeTextFile(posix.join(artifactDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    await dependencies.writeTextFile(posix.join(artifactDirectory, "comment.md"), renderEvidenceComment(result).markdown);
    await dependencies.cleanup.run();
    return result;
  } finally {
    await dependencies.cleanup.run();
    await removeRun();
  }
}
