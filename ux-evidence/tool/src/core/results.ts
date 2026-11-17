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

export interface WebEnvironment { dump: { path: string; modifiedAt: string; sizeBytes: number } }
export interface IOSEnvironment { deviceType: string; runtime: string; xcodeVersion: string; apiHost: string }
export type EvidenceEnvironment = WebEnvironment | IOSEnvironment;

export type PlatformEnvironment =
  | { platform: "web"; environment: WebEnvironment }
  | { platform: "ios"; environment: IOSEnvironment };

export type EvidenceResult = PlatformEnvironment & {
  version: 2;
  caseId: string;
  classification: EvidenceClassification;
  baseCommit: string;
  headCommit: string;
  toolCommit: string;
  revisions: { base: RevisionResult; head: RevisionResult };
  artifacts: readonly ArtifactRecord[];
  tools: Record<string, string>;
  capturedAt: string;
  identical?: true;
};

export const OUTDATED_RESULT_REASON = "recorded by an older version of the UX evidence tool; record again";

export function pairEnvironment(platform: "web" | "ios", environment: EvidenceEnvironment): PlatformEnvironment {
  if (platform === "web" && "dump" in environment) return { platform, environment };
  if (platform === "ios" && "deviceType" in environment) return { platform, environment };
  throw new Error(`the ${platform} adapter reported an environment for another platform`);
}

export function assertArtifactsWithinLimit(artifacts: readonly ArtifactRecord[]): void {
  for (const artifact of artifacts) {
    if (artifact.sizeBytes > MAX_ATTACHMENT_BYTES) {
      const name = artifact.path.split("/").pop();
      throw new Error(`${name} is ${artifact.sizeBytes} bytes; GitHub limit is ${MAX_ATTACHMENT_BYTES}`);
    }
  }
}

function parseObject(jsonText: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(jsonText);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("result must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

export function isOutdatedResult(jsonText: string): boolean {
  try {
    return parseObject(jsonText).version === 1;
  } catch {
    return false;
  }
}

export function parseEvidenceResult(jsonText: string): EvidenceResult {
  const record = parseObject(jsonText);
  if (record.version !== 2) throw new Error(`unsupported result version: ${String(record.version)}`);
  if (record.platform !== "web" && record.platform !== "ios") throw new Error("result.platform must be web or ios");
  if (typeof record.environment !== "object" || record.environment === null) {
    throw new Error("result.environment must be an object");
  }
  pairEnvironment(record.platform, record.environment as EvidenceEnvironment);
  for (const field of ["caseId", "headCommit", "baseCommit", "toolCommit"]) {
    if (typeof record[field] !== "string") throw new Error(`result.${field} must be a string`);
  }
  if (!Array.isArray(record.artifacts)) throw new Error("result.artifacts must be an array");
  return record as unknown as EvidenceResult;
}
