import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { assertValidCaseId } from "./case-id.ts";
import type { Platform } from "./config.ts";
import type { BeforePolicy, EvidenceClassification, EvidenceManifest, ReadTextFile } from "./domain.ts";

const CLASSIFICATIONS: readonly EvidenceClassification[] = ["visual", "functional"];
const BEFORE_POLICIES: readonly BeforePolicy[] = ["required", "not-applicable"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseManifestYaml(yamlText: string, folderCaseId: string, platform: Platform): EvidenceManifest {
  const raw: unknown = parse(yamlText);
  if (!isRecord(raw)) throw new Error("manifest must be a YAML mapping");
  if (raw.version !== 1) throw new Error(`unsupported manifest version: ${String(raw.version)}`);
  if (typeof raw.id === "string") assertValidCaseId(raw.id);
  if (raw.id !== folderCaseId) throw new Error("manifest id must equal folder name");
  if (!CLASSIFICATIONS.includes(raw.classification as EvidenceClassification)) {
    throw new Error("classification must be visual or functional");
  }
  if (platform === "ios" && raw.startPath !== undefined) throw new Error("startPath is only used by web cases");
  if (platform === "web" && (typeof raw.startPath !== "string" || !raw.startPath.startsWith("/"))) {
    throw new Error("startPath must begin with /");
  }
  const before = raw.before;
  if (!isRecord(before) || !BEFORE_POLICIES.includes(before.policy as BeforePolicy)) {
    throw new Error("before.policy must be required or not-applicable");
  }
  const reason = typeof before.reason === "string" && before.reason.trim() !== "" ? before.reason : null;
  if (before.policy === "not-applicable" && reason === null) {
    throw new Error("before.reason is required when policy is not-applicable");
  }
  return {
    version: 1,
    id: raw.id,
    classification: raw.classification as EvidenceClassification,
    before: { policy: before.policy as BeforePolicy, reason },
    ...(platform === "web" ? { startPath: raw.startPath as string } : {}),
  };
}

export async function loadManifest(
  manifestPath: string,
  folderCaseId: string,
  platform: Platform,
  readTextFile: ReadTextFile = (path) => readFile(path, "utf8"),
): Promise<EvidenceManifest> {
  return parseManifestYaml(await readTextFile(manifestPath), folderCaseId, platform);
}
