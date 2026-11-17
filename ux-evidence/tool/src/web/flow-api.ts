import type { Page } from "playwright";

export type Shot = (name: string) => Promise<void>;
export interface SetupContext { page: Page }
export interface DemoContext { page: Page; shot: Shot }
export interface EvidenceFlow {
  setup?: (context: SetupContext) => Promise<void>;
  demo: (context: DemoContext) => Promise<void>;
}
