import { posix } from "node:path";
import { stringify } from "yaml";
import type { BeforePolicy, EvidenceClassification } from "../domain.ts";
import { assertValidCaseId } from "../case-id.ts";
import { parseManifestYaml } from "../manifest.ts";

export interface NewCaseInput {
  id: string;
  classification: EvidenceClassification;
  beforePolicy: BeforePolicy;
  reason: string | null;
  startPath: string;
}

export interface NewCaseDependencies {
  fileExists(path: string): Promise<boolean>;
  makeDirectory(path: string): Promise<void>;
  writeTextFile(path: string, content: string): Promise<void>;
}

export function renderNewCase(input: NewCaseInput): { manifestYaml: string; flowSource: string } {
  assertValidCaseId(input.id);
  const manifestYaml = stringify({
    version: 1,
    id: input.id,
    classification: input.classification,
    startPath: input.startPath,
    before: input.reason === null
      ? { policy: input.beforePolicy }
      : { policy: input.beforePolicy, reason: input.reason },
  });
  parseManifestYaml(manifestYaml, input.id);

  const shotLine = input.classification === "visual" ? '  await shot("main");\n' : "";
  const flowSource = [
    'import type { DemoContext } from "../../src/flow-api.ts";',
    "",
    `export async function demo(${input.classification === "visual" ? "{ page, shot }" : "{ page }"}: DemoContext): Promise<void> {`,
    ...(shotLine === "" ? [] : [shotLine.trimEnd()]),
    '  throw new Error("flow not written yet");',
    "}",
    "",
  ].join("\n");
  return { manifestYaml, flowSource };
}

export async function createEvidenceCase(
  input: NewCaseInput & { repoRoot: string },
  dependencies: NewCaseDependencies,
): Promise<{ manifestPath: string; flowPath: string }> {
  const { manifestYaml, flowSource } = renderNewCase(input);
  const caseDirectory = posix.join(input.repoRoot, "qa", "ux", input.id);
  if (await dependencies.fileExists(caseDirectory)) throw new Error(`case already exists: ${input.id}`);
  await dependencies.makeDirectory(caseDirectory);
  const manifestPath = posix.join(caseDirectory, "evidence.yaml");
  const flowPath = posix.join(caseDirectory, "flow.ts");
  await dependencies.writeTextFile(manifestPath, manifestYaml);
  await dependencies.writeTextFile(flowPath, flowSource);
  return { manifestPath, flowPath };
}
