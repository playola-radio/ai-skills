import type { CleanupRegistry } from "./cleanup.ts";
import type { NewCaseInput } from "./commands/new.ts";
import type { EvidenceConfig } from "./config.ts";
import type { EvidenceManifest, RevisionName } from "./domain.ts";
import type { VideoTrim } from "./media.ts";
import type { EvidenceEnvironment } from "./results.ts";

export interface RecordContext {
  repoRoot: string;
  config: EvidenceConfig;
  manifest: EvidenceManifest;
  commits: { base: string; head: string };
  caseDirectory: string;
  artifactDirectory: string;
  runDirectory: string;
  cleanup: CleanupRegistry;
}

export interface Capture {
  screenshots: ReadonlyMap<string, string>;
  videoPath?: string;
  videoTrim?: VideoTrim;
  warnings: readonly string[];
}

export interface PreparedRun {
  capture(revision: RevisionName): Promise<Capture>;
  dispose(): Promise<void>;
}

export interface PlatformAdapter {
  preflight(context: RecordContext): Promise<{ environment: EvidenceEnvironment; tools: Record<string, string> }>;
  prepare(context: RecordContext): Promise<PreparedRun>;
  renderCase(input: NewCaseInput, config: EvidenceConfig): ReadonlyMap<string, string>;
}
