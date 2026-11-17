import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import type { WebSettings } from "../core/config.ts";
import type { EvidenceClassification, RevisionName } from "../core/domain.ts";
import type { EvidenceFlow, Shot } from "./flow-api.ts";

export interface BrowserCapture {
  videoPath?: string;
  screenshots: ReadonlyMap<string, string>;
}

export interface CaptureRevisionInput {
  revision: RevisionName;
  classification: EvidenceClassification;
  clientUrl: string;
  startPath: string;
  flow: EvidenceFlow;
  outputDirectory: string;
  settings: WebSettings;
}

const LOGIN_TIMEOUT_MS = 30_000;
const SHOT_NAME = /^[a-z0-9-]+$/;

export async function captureRevision(
  input: CaptureRevisionInput,
  launchBrowser: () => Promise<Browser> = () => chromium.launch(),
): Promise<BrowserCapture> {
  const { revision, classification, clientUrl, flow, outputDirectory, settings } = input;
  const contextOptions = { viewport: settings.viewport, locale: settings.locale, timezoneId: settings.timezoneId };
  const prefix = revision === "base" ? "before" : "after";
  const screenshots = new Map<string, string>();
  const browser = await launchBrowser();
  try {
    const loginContext = await browser.newContext(contextOptions);
    const loginPage = await loginContext.newPage();
    await loginPage.goto(`${clientUrl}/dev-user`);
    try {
      await loginPage.waitForURL((url) => url.pathname === "/stations", { timeout: LOGIN_TIMEOUT_MS });
    } catch {
      throw new Error(`dev login did not reach /stations (${revision})`);
    }
    await flow.setup?.({ page: loginPage });
    const storageState = await loginContext.storageState();
    await loginContext.close();

    const recording = classification === "functional";
    const context = await browser.newContext({
      ...contextOptions,
      storageState,
      ...(recording ? { recordVideo: { dir: outputDirectory, size: settings.viewport } } : {}),
    });
    const page = await context.newPage();
    await page.goto(`${clientUrl}${input.startPath}`);
    const shot: Shot = async (name) => {
      if (!SHOT_NAME.test(name)) throw new Error(`invalid shot name: "${name}" (use lowercase letters, digits and hyphens)`);
      if (screenshots.has(name)) throw new Error(`duplicate shot name: ${name}`);
      const path = join(outputDirectory, `${prefix}-${name}.png`);
      await page.screenshot({ path });
      screenshots.set(name, path);
    };
    await runDemo(context, () => flow.demo({ page, shot }));

    if (classification === "visual" && screenshots.size === 0) throw new Error("visual flow must call shot at least once");
    if (!recording) return { screenshots };
    const videoPath = await page.video()?.path();
    if (!videoPath) throw new Error(`no video was recorded (${revision})`);
    return { videoPath, screenshots };
  } finally {
    await browser.close();
  }
}

async function runDemo(context: BrowserContext, demo: () => Promise<void>): Promise<void> {
  try {
    await demo();
  } finally {
    await context.close();
  }
}
