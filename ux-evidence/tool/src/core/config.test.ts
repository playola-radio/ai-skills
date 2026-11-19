import { describe, expect, it } from "vitest";
import { exactIOSConfig, isIgnoredPath, isRelevantPath, loadConfig, parseConfigYaml, requiresEvidence } from "./config.ts";

const webYaml = `
version: 1
platform: web
baseBranch: develop
relevant: ["client/**", "server/**"]
requiresEvidence: ["client/**"]
ignored: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/*.md"]
web:
  viewport: {width: 1440, height: 900}
  locale: en-US
  timezoneId: America/Chicago
`;

const iosYaml = `
version: 1
platform: ios
baseBranch: develop
relevant: ["PlayolaRadio/**", "PlayolaRadio.xcodeproj/**"]
requiresEvidence: ["PlayolaRadio/**", "PlayolaRadio.xcodeproj/**"]
ignored: ["**/*Tests.swift", "PlayolaRadioTests/**", "**/*.md", "docs/**", "design/**", "fastlane/**"]
ios:
  project: PlayolaRadio.xcodeproj
  scheme: PlayolaRadio-Staging
  configuration: Debug
  productName: PlayolaRadio Staging.app
  bundleId: fm.playola.playolaradio.staging
  apiHost: https://admin-api-staging.playola.fm
  deviceType: com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro
  runtime: com.apple.CoreSimulator.SimRuntime.iOS-27-1
  xcodePath: /Applications/Xcode-27.1.0.app
  maestroPath: ~/.maestro/bin/maestro
  javaHome: /opt/homebrew/opt/openjdk@17
  secretsSource: ~/playola/playola-radio-ios
`;

const web = () => parseConfigYaml(webYaml);

describe("parseConfigYaml", () => {
  it("configSelectsWeb: parses the complete web config", () => {
    expect(web()).toEqual({
      version: 1,
      platform: "web",
      baseBranch: "develop",
      relevant: ["client/**", "server/**"],
      requiresEvidence: ["client/**"],
      ignored: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/*.md"],
      web: { viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "America/Chicago" },
    });
  });

  it("parses the complete iOS config and expands home-relative paths", () => {
    const config = parseConfigYaml(iosYaml, "/Users/someone");
    expect(config.platform).toBe("ios");
    if (config.platform !== "ios") throw new Error("expected ios");
    expect(config.ios.maestroPath).toBe("/Users/someone/.maestro/bin/maestro");
    expect(config.ios.secretsSource).toBe("/Users/someone/playola/playola-radio-ios");
    expect(config.ios.xcodePath).toBe("/Applications/Xcode-27.1.0.app");
    expect(config.ios.productName).toBe("PlayolaRadio Staging.app");
  });

  it("iosNeedsNativeSettings: rejects an iOS config without ios.bundleId", () => {
    expect(() => parseConfigYaml(iosYaml.replace(/\n {2}bundleId:.*/, ""))).toThrow("ios.bundleId must be a non-empty string");
  });

  it("stagingOnly: rejects an iOS config that points at another server", () => {
    expect(() => parseConfigYaml(iosYaml.replace("admin-api-staging.playola.fm", "admin-api.playola.fm")))
      .toThrow("ios.apiHost must be https://admin-api-staging.playola.fm: evidence is only ever recorded from the staging app");
  });

  it("stagingOnly: rejects an iOS config for another app", () => {
    expect(() => parseConfigYaml(iosYaml.replace("fm.playola.playolaradio.staging", "fm.playola.playolaradio")))
      .toThrow("ios.bundleId must be fm.playola.playolaradio.staging: evidence is only ever recorded from the staging app");
  });

  const anyMajorYaml = iosYaml
    .replace(/runtime: .*/, 'iosVersion: "27"')
    .replace(/xcodePath: .*/, "xcodeVersion: 27");

  it("anyMinorVersion: accepts a major version in place of the exact Xcode and simulator runtime", () => {
    const config = parseConfigYaml(anyMajorYaml);
    if (config.platform !== "ios") throw new Error("expected ios");
    expect(config.ios).toMatchObject({ iosVersion: "27", xcodeVersion: "27" });
    expect(config.ios.xcodePath).toBeUndefined();
    expect(config.ios.runtime).toBeUndefined();
  });

  it("anyMinorVersion: rejects a version that is not a whole major number", () => {
    expect(() => parseConfigYaml(anyMajorYaml.replace("xcodeVersion: 27", "xcodeVersion: 27.1")))
      .toThrow('ios.xcodeVersion must be a major version such as "27"');
  });

  it("anyMinorVersion: wants each of Xcode and the runtime named exactly one way", () => {
    expect(() => parseConfigYaml(anyMajorYaml.replace("xcodeVersion: 27", "xcodeVersion: 27\n  xcodePath: /Applications/Xcode.app")))
      .toThrow("ios needs exactly one of xcodePath or xcodeVersion");
    expect(() => parseConfigYaml(iosYaml.replace(/\n {2}runtime:.*/, "")))
      .toThrow("ios needs exactly one of runtime or iosVersion");
  });

  it("anyMinorVersion: a config that names only major versions is not ready to record from", () => {
    const config = parseConfigYaml(anyMajorYaml);
    if (config.platform !== "ios") throw new Error("expected ios");
    expect(() => exactIOSConfig(config)).toThrow("the installed Xcode and simulator runtime were not looked up");
    const pinned = parseConfigYaml(iosYaml);
    if (pinned.platform !== "ios") throw new Error("expected ios");
    expect(exactIOSConfig(pinned).ios.xcodePath).toBe("/Applications/Xcode-27.1.0.app");
  });

  it("rejects an unknown top-level key", () => {
    expect(() => parseConfigYaml(`${webYaml}extra: 1\n`)).toThrow("unknown key in config: extra");
  });

  it("rejects an unknown key inside a platform block", () => {
    expect(() => parseConfigYaml(webYaml.replace("locale: en-US", "locale: en-US\n  colorScheme: dark")))
      .toThrow("unknown key in web: colorScheme");
  });

  it("rejects a settings block for the other platform", () => {
    expect(() => parseConfigYaml(`${webYaml}ios: {}\n`)).toThrow("unknown key in config: ios");
  });

  it("rejects an unsupported version", () => {
    expect(() => parseConfigYaml(webYaml.replace("version: 1", "version: 2"))).toThrow("unsupported config version: 2");
  });

  it("rejects an unknown platform", () => {
    expect(() => parseConfigYaml(webYaml.replace("platform: web", "platform: android")))
      .toThrow("platform must be web or ios");
  });

  it("requires every path list", () => {
    expect(() => parseConfigYaml(webYaml.replace(/\nrequiresEvidence:.*/, "")))
      .toThrow("requiresEvidence must be a list of glob strings");
  });

  it("rejects a base branch that could be read as an option", () => {
    expect(() => parseConfigYaml(webYaml.replace("baseBranch: develop", "baseBranch: --all")))
      .toThrow("baseBranch must be a branch name");
  });

  it("requires a positive whole-number viewport", () => {
    expect(() => parseConfigYaml(webYaml.replace("width: 1440", "width: 0")))
      .toThrow("web.viewport.width must be a positive whole number");
  });
});

describe("path policy", () => {
  it("onePathPolicy: a server change is relevant but does not require evidence", () => {
    expect([isRelevantPath("server/src/a.ts", web()), requiresEvidence("server/src/a.ts", web())]).toEqual([true, false]);
  });

  it("onePathPolicy: a client change is relevant and requires evidence", () => {
    expect([isRelevantPath("client/src/a.tsx", web()), requiresEvidence("client/src/a.tsx", web())]).toEqual([true, true]);
  });

  it("onePathPolicy: a client test file does neither", () => {
    expect([isRelevantPath("client/a.test.ts", web()), requiresEvidence("client/a.test.ts", web())]).toEqual([false, false]);
  });

  it("ignores Markdown anywhere", () => {
    expect(isRelevantPath("client/docs/notes.md", web())).toBe(false);
  });

  it("matches dotfiles", () => {
    expect(isRelevantPath("client/.eslintrc", web())).toBe(true);
  });

  it("applies ignore patterns to dotfiles", () => {
    expect(isIgnoredPath("client/.notes.md", web())).toBe(true);
  });

  it("matches dotfile names inside brace alternatives", () => {
    const config = { ...web(), relevant: ["client/{.config,src}/**"] };
    expect([isRelevantPath("client/.config/theme.json", config), isRelevantPath("client/src/a.ts", config)]).toEqual([true, true]);
  });

  it("keeps dots inside a segment literal in brace alternatives", () => {
    const config = { ...web(), relevant: ["client/foo{.bar,baz}/**"] };
    expect([isRelevantPath("client/foo.bar/a.ts", config), isRelevantPath("client/foobaz/a.ts", config)]).toEqual([true, true]);
  });

  it("treats paths outside both lists as irrelevant", () => {
    expect(isRelevantPath("docs/a.ts", web())).toBe(false);
  });
});

describe("loadConfig", () => {
  it("reads qa/ux/config.yaml under the repository root", async () => {
    const read: string[] = [];
    const config = await loadConfig("/repo", async (path) => {
      read.push(path);
      return webYaml;
    });
    expect([read, config.platform]).toEqual([["/repo/qa/ux/config.yaml"], "web"]);
  });

  it("names the file when it is invalid", async () => {
    await expect(loadConfig("/repo", async () => "version: 3\n"))
      .rejects.toThrow("/repo/qa/ux/config.yaml: unsupported config version: 3");
  });
});
