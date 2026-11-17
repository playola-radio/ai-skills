import { posix } from "node:path";
import { stringify } from "yaml";
import type { Platform } from "../config.ts";
import type { BeforePolicy, EvidenceClassification } from "../domain.ts";
import { assertValidCaseId } from "../case-id.ts";
import { parseManifestYaml } from "../manifest.ts";

export interface NewCaseInput {
  id: string;
  classification: EvidenceClassification;
  beforePolicy: BeforePolicy;
  reason: string | null;
  startPath?: string;
}

export interface NewCaseDependencies {
  fileExists(path: string): Promise<boolean>;
  makeDirectory(path: string): Promise<void>;
  writeTextFile(path: string, content: string): Promise<void>;
  renderCase(input: NewCaseInput): ReadonlyMap<string, string>;
}

export function renderManifestYaml(input: NewCaseInput, platform: Platform): string {
  assertValidCaseId(input.id);
  const manifestYaml = stringify({
    version: 1,
    id: input.id,
    classification: input.classification,
    ...(input.startPath === undefined ? {} : { startPath: input.startPath }),
    before: input.reason === null
      ? { policy: input.beforePolicy }
      : { policy: input.beforePolicy, reason: input.reason },
  });
  parseManifestYaml(manifestYaml, input.id, platform);
  return manifestYaml;
}

export async function createEvidenceCase(
  input: NewCaseInput & { repoRoot: string },
  dependencies: NewCaseDependencies,
): Promise<readonly string[]> {
  const files = dependencies.renderCase(input);
  const caseDirectory = posix.join(input.repoRoot, "qa", "ux", input.id);
  if (await dependencies.fileExists(caseDirectory)) throw new Error(`case already exists: ${input.id}`);
  await dependencies.makeDirectory(caseDirectory);
  const written: string[] = [];
  for (const [name, content] of files) {
    const path = posix.join(caseDirectory, name);
    await dependencies.writeTextFile(path, content);
    written.push(path);
  }
  return written;
}
