import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { parse } from "yaml";
import type { ReadTextFile } from "./domain.ts";

export const CONFIG_PATH = "qa/ux/config.yaml";

interface PathPolicy {
  version: 1;
  baseBranch: string;
  relevant: readonly string[];
  requiresEvidence: readonly string[];
  ignored: readonly string[];
}

export interface WebSettings {
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
}

export interface IOSSettings {
  project: string;
  scheme: string;
  configuration: string;
  productName: string;
  bundleId: string;
  apiHost: string;
  deviceType: string;
  runtime: string;
  xcodePath: string;
  maestroPath: string;
  javaHome: string;
  secretsSource: string;
}

export interface WebConfig extends PathPolicy { platform: "web"; web: WebSettings }
export interface IOSConfig extends PathPolicy { platform: "ios"; ios: IOSSettings }
export type EvidenceConfig = WebConfig | IOSConfig;
export type Platform = EvidenceConfig["platform"];

const POLICY_KEYS = ["version", "platform", "baseBranch", "relevant", "requiresEvidence", "ignored"];
const WEB_KEYS = ["viewport", "locale", "timezoneId"];
const VIEWPORT_KEYS = ["width", "height"];
const IOS_KEYS: readonly (keyof IOSSettings)[] = [
  "project", "scheme", "configuration", "productName", "bundleId", "apiHost",
  "deviceType", "runtime", "xcodePath", "maestroPath", "javaHome", "secretsSource",
];
const IOS_PATH_KEYS: readonly (keyof IOSSettings)[] = ["xcodePath", "maestroPath", "javaHome", "secretsSource"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapping(value: unknown, name: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be a YAML mapping`);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknownKey !== undefined) throw new Error(`unknown key in ${name}: ${unknownKey}`);
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

function globList(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item !== "")) {
    throw new Error(`${name} must be a list of glob strings`);
  }
  return value;
}

function positiveWholeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return value;
}

function expandHome(path: string, homeDirectory: string): string {
  return path.startsWith("~/") ? join(homeDirectory, path.slice(2)) : path;
}

function parseWebSettings(value: unknown): WebSettings {
  const web = mapping(value, "web", WEB_KEYS);
  const viewport = mapping(web.viewport, "web.viewport", VIEWPORT_KEYS);
  return {
    viewport: {
      width: positiveWholeNumber(viewport.width, "web.viewport.width"),
      height: positiveWholeNumber(viewport.height, "web.viewport.height"),
    },
    locale: nonEmptyString(web.locale, "web.locale"),
    timezoneId: nonEmptyString(web.timezoneId, "web.timezoneId"),
  };
}

function parseIOSSettings(value: unknown, homeDirectory: string): IOSSettings {
  const ios = mapping(value, "ios", IOS_KEYS);
  const settings = Object.fromEntries(IOS_KEYS.map((key) => {
    const text = nonEmptyString(ios[key], `ios.${key}`);
    return [key, IOS_PATH_KEYS.includes(key) ? expandHome(text, homeDirectory) : text];
  }));
  return settings as unknown as IOSSettings;
}

export function parseConfigYaml(yamlText: string, homeDirectory: string = homedir()): EvidenceConfig {
  const raw: unknown = parse(yamlText);
  if (!isRecord(raw)) throw new Error("config must be a YAML mapping");
  if (raw.version !== 1) throw new Error(`unsupported config version: ${String(raw.version)}`);
  if (raw.platform !== "web" && raw.platform !== "ios") throw new Error("platform must be web or ios");
  mapping(raw, "config", [...POLICY_KEYS, raw.platform]);
  const baseBranch = nonEmptyString(raw.baseBranch, "baseBranch");
  if (baseBranch.startsWith("-") || /\s/.test(baseBranch)) throw new Error("baseBranch must be a branch name");
  const policy: PathPolicy = {
    version: 1,
    baseBranch,
    relevant: globList(raw.relevant, "relevant"),
    requiresEvidence: globList(raw.requiresEvidence, "requiresEvidence"),
    ignored: globList(raw.ignored, "ignored"),
  };
  if (raw.platform === "web") return { ...policy, platform: "web", web: parseWebSettings(raw.web) };
  return { ...policy, platform: "ios", ios: parseIOSSettings(raw.ios, homeDirectory) };
}

export async function loadConfig(
  repoRoot: string,
  readTextFile: ReadTextFile = (path) => readFile(path, "utf8"),
): Promise<EvidenceConfig> {
  const path = join(repoRoot, CONFIG_PATH);
  try {
    return parseConfigYaml(await readTextFile(path));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes(path) ? message : `${path}: ${message}`);
  }
}

// path.posix.matchesGlob never lets a wildcard match a leading dot, so hide segment-leading dots
// from it on both sides; literal dots in patterns still match literal dots in paths.
const HIDDEN_DOT = "\u0001";
function exposeDotfiles(path: string): string {
  return path.split("/").map((segment) => (segment.startsWith(".") ? `${HIDDEN_DOT}${segment.slice(1)}` : segment)).join("/");
}

function matchesAny(path: string, globs: readonly string[]): boolean {
  const subject = exposeDotfiles(path);
  return globs.some((glob) => posix.matchesGlob(subject, exposeDotfiles(glob)));
}

export function isIgnoredPath(path: string, config: EvidenceConfig): boolean {
  return matchesAny(path, config.ignored);
}

export function isRelevantPath(path: string, config: EvidenceConfig): boolean {
  return matchesAny(path, config.relevant) && !isIgnoredPath(path, config);
}

export function requiresEvidence(path: string, config: EvidenceConfig): boolean {
  return matchesAny(path, config.requiresEvidence) && !isIgnoredPath(path, config);
}
