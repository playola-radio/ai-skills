import { describe, expect, it, vi } from "vitest";
import { parseAllDocuments } from "yaml";
import type { Exec } from "../core/effects.ts";
import { IOS_CONFIG } from "../core/test-fixtures.ts";
import { collectScreenshots, declaredScreenshotNames, renderMaestroWrapper, runMaestro } from "./maestro.ts";

describe("renderMaestroWrapper", () => {
  it("wrapperPreservesSession: launch keeps app data, denies permissions and never uses SCREENSHOT_PAGE", () => {
    const wrapper = renderMaestroWrapper("fm.app", "/case dir/setup.yaml", "/case dir/flow.yaml");
    const [header, commands] = parseAllDocuments(wrapper).map((document) => document.toJS());
    expect(header).toEqual({ appId: "fm.app" });
    expect(commands).toEqual([
      { launchApp: { appId: "fm.app", clearState: false, permissions: { all: "deny" } } },
      { runFlow: "/case dir/setup.yaml" },
      { runFlow: "/case dir/flow.yaml" },
    ]);
  });

  it("setupOutsideVideo: the video marks wrap only the case's flow, after launch and setup", () => {
    const wrapper = renderMaestroWrapper("fm.app", "/c/setup.yaml", "/c/flow.yaml", { begin: "/run/begin.js", end: "/run/end.js" });
    expect(parseAllDocuments(wrapper)[1]!.toJS()).toEqual([
      { launchApp: { appId: "fm.app", clearState: false, permissions: { all: "deny" } } },
      { runFlow: "/c/setup.yaml" },
      { runScript: "/run/begin.js" },
      { runFlow: "/c/flow.yaml" },
      { runScript: "/run/end.js" },
    ]);
  });

  it("omits setup when the case has none", () => {
    const commands = parseAllDocuments(renderMaestroWrapper("fm.app", undefined, "/c/flow.yaml"))[1]!.toJS() as unknown[];
    expect(commands).toEqual([expect.objectContaining({ launchApp: expect.anything() }), { runFlow: "/c/flow.yaml" }]);
  });
});

describe("declaredScreenshotNames", () => {
  const flow = (steps: string) => `appId: fm.app\n---\n${steps}`;

  it("finds screenshots in order, including inside nested commands", () => {
    expect(declaredScreenshotNames(flow("- takeScreenshot: one\n- repeat:\n    times: 1\n    commands:\n      - takeScreenshot:\n          path: two\n"), "f"))
      .toEqual(["one", "two"]);
  });

  it("duplicateShotRejected: two stations-list screenshots fail", () => {
    expect(() => declaredScreenshotNames(flow("- takeScreenshot: stations-list\n- takeScreenshot: stations-list\n"), "flow.yaml"))
      .toThrow('flow.yaml takes the screenshot "stations-list" more than once');
  });

  it("rejects names that are not lowercase-hyphen", () => {
    expect(() => declaredScreenshotNames(flow("- takeScreenshot: Stations List\n"), "f")).toThrow("lowercase letters, digits and hyphens");
    expect(() => declaredScreenshotNames(flow("- takeScreenshot: ../x\n"), "f")).toThrow("lowercase letters, digits and hyphens");
  });

  it("reports invalid YAML", () => {
    expect(() => declaredScreenshotNames("a: [", "flow.yaml")).toThrow("flow.yaml is not valid YAML");
  });
});

describe("collectScreenshots", () => {
  const out = "/run/head/maestro";
  const at = (name: string) => `${out}/test-output/2026-11-16_201505/wrapper/takeScreenshot/${name}.png`;
  const files = (paths: string[]) => ({ listFilesRecursively: async () => paths });

  it("maps each declared name to Maestro's file, ignoring logs", async () => {
    const found = await collectScreenshots(out, ["stations-list"], files([at("stations-list"), `${out}/debug/maestro.log`]));
    expect(found).toEqual(new Map([["stations-list", at("stations-list")]]));
  });

  it("rejects missing and undeclared screenshots", async () => {
    await expect(collectScreenshots(out, ["a", "b"], files([at("a")]))).rejects.toThrow("did not produce screenshots: b");
    await expect(collectScreenshots(out, ["a"], files([at("a"), at("setup-shot")]))).rejects.toThrow("does not declare: setup-shot");
  });

  it("rejects the same name produced twice", async () => {
    await expect(collectScreenshots(out, ["a"], files([at("a"), `${out}/test-output/x/other/takeScreenshot/a.png`])))
      .rejects.toThrow('produced the screenshot "a" more than once');
  });
});

describe("runMaestro", () => {
  it("targets the device, isolates output and sets Java only for Maestro", async () => {
    const exec = vi.fn<Exec>(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await runMaestro({ settings: IOS_CONFIG.ios, udid: "UDID", wrapperPath: "/run/w.yaml", outputDirectory: "/run/m" }, exec);
    const [command, args, options] = exec.mock.calls[0]!;
    expect(command).toBe("/home/u/.maestro/bin/maestro");
    expect(args).toEqual([
      "test", "--udid", "UDID", "--test-output-dir", "/run/m/test-output",
      "--debug-output", "/run/m/debug", "--flatten-debug-output", "/run/w.yaml",
    ]);
    expect(options?.env).toMatchObject({ JAVA_HOME: "/opt/java17", MAESTRO_CLI_NO_ANALYTICS: "1", DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" });
    expect(process.env.JAVA_HOME).not.toBe("/opt/java17");
  });

  it("reports the end of Maestro's output when the flow fails", async () => {
    const exec = vi.fn<Exec>(async () => ({ exitCode: 1, stdout: "Assert that \"All\" is visible... FAILED\n", stderr: "" }));
    await expect(runMaestro({ settings: IOS_CONFIG.ios, udid: "U", wrapperPath: "/w", outputDirectory: "/o" }, exec))
      .rejects.toThrow('the Maestro flow failed (exit 1):\nAssert that "All" is visible... FAILED');
  });
});

