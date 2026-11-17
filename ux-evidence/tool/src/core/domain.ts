export type EvidenceClassification = "visual" | "functional";
export type BeforePolicy = "required" | "not-applicable";
export type RevisionName = "base" | "head";
export interface EvidenceManifest {
  version: 1;
  id: string;
  classification: EvidenceClassification;
  before: { policy: BeforePolicy; reason: string | null };
  startPath: string;
}
export type ReadTextFile = (path: string) => Promise<string>;
