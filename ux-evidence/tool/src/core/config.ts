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

interface IOSAppSettings {
  project: string;
  scheme: string;
  configuration: string;
  productName: string;
  bundleId: string;
  apiHost: string;
  deviceType: string;
  maestroPath: string;
  javaHome: string;
  secretsSource: string;
}

// What a recording runs on: one exact Xcode and one exact simulator runtime.
export interface IOSSettings extends IOSAppSettings { runtime: string; xcodePath: string }

// As written in qa/ux/config.yaml. Xcode and the runtime are each either exact (xcodePath, runtime) or a
// major version (xcodeVersion, iosVersion: "27" means any 27.x installed on this machine).
export interface WrittenIOSSettings extends IOSAppSettings {
  runtime?: string;
  iosVersion?: string;
  xcodePath?: string;
  xcodeVersion?: string;
}

export interface WebConfig extends PathPolicy { platform: "web"; web: WebSettings }
export interface WrittenIOSConfig extends PathPolicy { platform: "ios"; ios: WrittenIOSSettings }
export interface IOSConfig extends WrittenIOSConfig { ios: IOSSettings }
export type EvidenceConfig = WebConfig | WrittenIOSConfig;
export type Platform = EvidenceConfig["platform"];

const POLICY_KEYS = ["version", "platform", "baseBranch", "relevant", "requiresEvidence", "ignored"];
const WEB_KEYS = ["viewport", "locale", "timezoneId"];
const VIEWPORT_KEYS = ["width", "height"];
const IOS_APP_KEYS: readonly (keyof IOSAppSettings)[] = [
  "project", "scheme", "configuration", "productName", "bundleId", "apiHost",
  "deviceType", "maestroPath", "javaHome", "secretsSource",
];
// Each pair is [exact, major version]; a config gives exactly one of the two.
const IOS_VERSIONED = [["runtime", "iosVersion"], ["xcodePath", "xcodeVersion"]] as const;
const IOS_PATH_KEYS: readonly (keyof WrittenIOSSettings)[] = ["xcodePath", "maestroPath", "javaHome", "secretsSource"];
const STAGING_ONLY: Partial<Record<keyof IOSAppSettings, string>> = {
  apiHost: "https://admin-api-staging.playola.fm",
  bundleId: "fm.playola.playolaradio.staging",
};

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

function majorVersion(value: unknown, name: string): string {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d*$/.test(text)) throw new Error(`${name} must be a major version such as "27"`);
  return text;
}

function parseIOSSettings(value: unknown, homeDirectory: string): WrittenIOSSettings {
  const ios = mapping(value, "ios", [...IOS_APP_KEYS, ...IOS_VERSIONED.flat()]);
  const path = (key: keyof WrittenIOSSettings, text: string) => (IOS_PATH_KEYS.includes(key) ? expandHome(text, homeDirectory) : text);
  const settings = Object.fromEntries(IOS_APP_KEYS.map((key) => {
    const text = nonEmptyString(ios[key], `ios.${key}`);
    const required = STAGING_ONLY[key];
    if (required !== undefined && text !== required) {
      throw new Error(`ios.${key} must be ${required}: evidence is only ever recorded from the staging app`);
    }
    return [key, path(key, text)];
  }));
  for (const [exact, major] of IOS_VERSIONED) {
    if ((ios[exact] === undefined) === (ios[major] === undefined)) throw new Error(`ios needs exactly one of ${exact} or ${major}`);
    if (ios[major] !== undefined) settings[major] = majorVersion(ios[major], `ios.${major}`);
    else settings[exact] = path(exact, nonEmptyString(ios[exact], `ios.${exact}`));
  }
  return settings as unknown as WrittenIOSSettings;
}

// The iOS recorder works from an exact Xcode and runtime; ios/versions.ts fills them in from the machine.
export function exactIOSConfig(config: WrittenIOSConfig): IOSConfig {
  const { runtime, xcodePath } = config.ios;
  if (runtime === undefined || xcodePath === undefined) throw new Error("the installed Xcode and simulator runtime were not looked up");
  return { ...config, ios: { ...config.ios, runtime, xcodePath } };
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

// In a glob, each alternative of a brace group that opens a segment also opens that segment.
function exposeGlobDotfiles(glob: string): string {
  const braceOpensSegment: boolean[] = [];
  let atSegmentStart = true;
  let exposed = "";
  for (const character of glob) {
    exposed += character === "." && atSegmentStart ? HIDDEN_DOT : character;
    if (character === "{") braceOpensSegment.push(atSegmentStart);
    else if (character === "," && braceOpensSegment.length > 0) atSegmentStart = braceOpensSegment.at(-1)!;
    else if (character === "}" && braceOpensSegment.length > 0) { braceOpensSegment.pop(); atSegmentStart = false; }
    else atSegmentStart = character === "/";
  }
  return exposed;
}

function matchesAny(path: string, globs: readonly string[]): boolean {
  const subject = exposeDotfiles(path);
  return globs.some((glob) => posix.matchesGlob(subject, exposeGlobDotfiles(glob)));
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
