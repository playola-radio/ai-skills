import type { EvidenceClassification, RevisionName } from "./domain.ts";

export const MAX_ATTACHMENT_BYTES = 10_485_760;

export type RevisionStatus = "passed" | "failed" | "not-applicable";

export interface ArtifactRecord {
  kind: "video" | "screenshot" | "comparison";
  revision?: RevisionName;
  shotName?: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface RevisionResult {
  status: RevisionStatus;
  reason?: string;
  warnings: readonly string[];
}

export interface EvidenceResult {
  version: 1;
  caseId: string;
  classification: EvidenceClassification;
  baseCommit: string;
  headCommit: string;
  dump: { path: string; modifiedAt: string; sizeBytes: number };
  revisions: { base: RevisionResult; head: RevisionResult };
  artifacts: readonly ArtifactRecord[];
  tools: Record<string, string>;
  capturedAt: string;
  identical?: true;
}

export function assertArtifactsWithinLimit(artifacts: readonly ArtifactRecord[]): void {
  for (const artifact of artifacts) {
    if (artifact.sizeBytes > MAX_ATTACHMENT_BYTES) {
      const name = artifact.path.split("/").pop();
      throw new Error(`${name} is ${artifact.sizeBytes} bytes; GitHub limit is ${MAX_ATTACHMENT_BYTES}`);
    }
  }
}

export function parseEvidenceResult(jsonText: string): EvidenceResult {
  const raw: unknown = JSON.parse(jsonText);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("result must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) throw new Error(`unsupported result version: ${String(record.version)}`);
  for (const field of ["caseId", "headCommit", "baseCommit"]) {
    if (typeof record[field] !== "string") throw new Error(`result.${field} must be a string`);
  }
  if (!Array.isArray(record.artifacts)) throw new Error("result.artifacts must be an array");
  return raw as EvidenceResult;
}
