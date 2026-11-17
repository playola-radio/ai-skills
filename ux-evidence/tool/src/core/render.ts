import type { ArtifactRecord, EvidenceResult, RevisionResult } from "./results.ts";

export interface RenderedComment {
  markdown: string;
  attachments: readonly string[];
}

const SHORT_COMMIT_LENGTH = 7;

function shortCommit(commit: string): string {
  return commit.slice(0, SHORT_COMMIT_LENGTH);
}

function warningLines(label: string, revision: RevisionResult): string[] {
  return revision.warnings.map((warning) => `Warning (${label}): ${warning}`);
}

function functionalSections(result: EvidenceResult): { blocks: string[]; attachments: string[] } {
  const video = (revision: "base" | "head"): ArtifactRecord | undefined =>
    result.artifacts.find((a) => a.kind === "video" && a.revision === revision);
  const blocks: string[] = [];
  const attachments: string[] = [];
  const before = video("base");
  if (result.revisions.base.status === "not-applicable") {
    blocks.push(`Before: not applicable — ${result.revisions.base.reason ?? "no reason recorded"}`);
  } else {
    if (before === undefined) throw new Error("missing before video for a passed base revision");
    blocks.push("Before:", `![](${before.path})`);
    attachments.push(before.path);
  }
  const after = video("head");
  if (after === undefined) throw new Error("missing after video for a passed head revision");
  blocks.push("After:", `![](${after.path})`);
  attachments.push(after.path);
  const shots = screenshotSections(result);
  return { blocks: [...blocks, ...shots.blocks], attachments: [...attachments, ...shots.attachments] };
}

function screenshotSections(result: EvidenceResult): { blocks: string[]; attachments: string[] } {
  const skippedBefore = result.revisions.base.status === "not-applicable";
  const shown = result.artifacts.filter((a) =>
    skippedBefore ? a.kind === "screenshot" && a.revision === "head" : a.kind === "comparison",
  );
  const blocks = shown.flatMap((artifact) => [`${artifact.shotName ?? "screenshot"}:`, `![](${artifact.path})`]);
  return { blocks, attachments: shown.map((a) => a.path) };
}

function visualSections(result: EvidenceResult): { blocks: string[]; attachments: string[] } {
  const skippedBefore = result.revisions.base.status === "not-applicable";
  const shots = screenshotSections(result);
  if (shots.attachments.length === 0) {
    throw new Error(
      skippedBefore
        ? "missing after screenshot for a passed head revision"
        : "missing comparison for a passed base revision",
    );
  }
  const blocks = skippedBefore
    ? [`Before: not applicable — ${result.revisions.base.reason ?? "no reason recorded"}`, ...shots.blocks]
    : shots.blocks;
  return { blocks, attachments: shots.attachments };
}

export function renderEvidenceComment(result: EvidenceResult): RenderedComment {
  const { base, head } = result.revisions;
  if (base.status === "failed" || head.status === "failed") {
    throw new Error("cannot publish a failed run");
  }
  const sections = result.classification === "functional" ? functionalSections(result) : visualSections(result);
  const blocks = [
    `## UX evidence: ${result.caseId}`,
    ...(result.identical ? ["> Before and after are identical (recorded with ALLOW_IDENTICAL)."] : []),
    [
      `Classification: ${result.classification}`,
      `Base: \`${shortCommit(result.baseCommit)}\``,
      `Head: \`${shortCommit(result.headCommit)}\``,
      `Data: production dump from ${result.dump.modifiedAt.slice(0, 10)}`,
      ...warningLines("base", base),
      ...warningLines("head", head),
    ].join("\n"),
    ...sections.blocks,
    `Captured ${result.capturedAt}`,
  ];
  return { markdown: `${blocks.join("\n\n")}\n`, attachments: sections.attachments };
}
