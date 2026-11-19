import { describe, expect, it, vi } from "vitest";
import type { WrittenIOSConfig } from "../core/config.ts";
import type { Exec, ExecResult } from "../core/effects.ts";
import { IOS_CONFIG } from "../core/test-fixtures.ts";
import { findInstalledVersions } from "./versions.ts";

function ok(stdout: string): ExecResult { return { exitCode: 0, stdout, stderr: "" }; }

const { runtime: _runtime, xcodePath: _xcodePath, ...app } = IOS_CONFIG.ios;
const ANY_27: WrittenIOSConfig = { ...IOS_CONFIG, ios: { ...app, iosVersion: "27", xcodeVersion: "27" } };

const runtime = (name: string, deviceTypes: string[] = [IOS_CONFIG.ios.deviceType], isAvailable = true) => ({
  identifier: `com.apple.CoreSimulator.SimRuntime.${name}`,
  isAvailable,
  supportedDeviceTypes: deviceTypes.map((identifier) => ({ identifier })),
});

const BUNDLED_XCODEBUILD = "/Contents/Developer/usr/bin/xcodebuild";

// xcodes maps an .app path to what its own xcodebuild prints for -version. Safari.app has no xcodebuild
// inside it, and Xcode-broken.app has one that fails.
function machine(xcodes: Record<string, string>, runtimes: unknown[] = [runtime("iOS-27-0")]) {
  const exec = vi.fn<Exec>(async (command, args) => {
    if (command.endsWith(BUNDLED_XCODEBUILD)) {
      const app = command.slice(0, -BUNDLED_XCODEBUILD.length);
      if (app === "/Applications/Xcode-broken.app") return { exitCode: 1, stdout: "", stderr: "broken" };
      const version = xcodes[app];
      if (version === undefined) throw new Error(`spawn ${command} ENOENT`);
      return ok(`Xcode ${version}\nBuild version X\n`);
    }
    if (command === "xcrun" && args[1] === "list") return ok(JSON.stringify({ runtimes }));
    throw new Error(`unexpected ${command}`);
  });
  const listDirectory = async () => [...Object.keys(xcodes).map((path) => path.replace("/Applications/", "")), "Safari.app", "Xcode-broken.app", "Notes"];
  return { exec, listDirectory };
}

describe("findInstalledVersions", () => {
  it("anyMinorVersion: uses the newest installed Xcode of the major version, whatever its folder is called", async () => {
    const found = await findInstalledVersions(ANY_27, machine({
      "/Applications/Xcode-27.1.0.app": "27.1",
      "/Applications/Xcode.app": "27.10",
      "/Applications/Xcode-26.5.0.app": "26.5",
      "/Applications/Xcode-beta.app": "28.0",
    }));
    expect(found.ios.xcodePath).toBe("/Applications/Xcode.app");
  });

  it("anyMinorVersion: finds an Xcode whose folder name does not start with Xcode", async () => {
    const found = await findInstalledVersions(ANY_27, machine({ "/Applications/27.2-Xcode.app": "27.2", "/Applications/Xcode-27.1.0.app": "27.1" }));
    expect(found.ios.xcodePath).toBe("/Applications/27.2-Xcode.app");
  });

  it("anyMinorVersion: uses the newest installed runtime of the major version that can run the device", async () => {
    const found = await findInstalledVersions(ANY_27, machine({ "/Applications/Xcode-27.2.0.app": "27.2" }, [
      runtime("iOS-27-0"),
      runtime("iOS-27-2"),
      runtime("iOS-27-3", ["some-other-phone"]),
      runtime("iOS-27-4", undefined, false),
      runtime("iOS-27-2-iPhone19-4"),
      runtime("iOS-28-0"),
      runtime("tvOS-27-5"),
    ]));
    expect(found.ios.runtime).toBe("com.apple.CoreSimulator.SimRuntime.iOS-27-2");
    expect(found.ios).toMatchObject({ bundleId: IOS_CONFIG.ios.bundleId, deviceType: IOS_CONFIG.ios.deviceType });
  });

  it("anyMinorVersion: asks the chosen Xcode which runtimes it has", async () => {
    const { exec, listDirectory } = machine({ "/Applications/Xcode-27.2.0.app": "27.2" });
    await findInstalledVersions(ANY_27, { exec, listDirectory });
    const listing = exec.mock.calls.find(([command]) => command === "xcrun")!;
    expect(listing[2]?.env?.DEVELOPER_DIR).toBe("/Applications/Xcode-27.2.0.app/Contents/Developer");
  });

  it("leaves an exact Xcode and runtime as written, without looking at the machine", async () => {
    const exec = vi.fn<Exec>();
    const found = await findInstalledVersions(IOS_CONFIG, { exec, listDirectory: async () => { throw new Error("not read"); } });
    expect(found.ios).toEqual(IOS_CONFIG.ios);
    expect(exec).not.toHaveBeenCalled();
  });

  it("says which Xcodes it found when none has the major version", async () => {
    await expect(findInstalledVersions(ANY_27, machine({ "/Applications/Xcode-26.5.0.app": "26.5" })))
      .rejects.toThrow("no Xcode 27 is installed in /Applications (found 26.5); install any Xcode 27");
    await expect(findInstalledVersions(ANY_27, machine({})))
      .rejects.toThrow("no Xcode 27 is installed in /Applications (found none); install any Xcode 27");
  });

  it("says how to install a runtime when none of the major version can run the device", async () => {
    await expect(findInstalledVersions(ANY_27, machine({ "/Applications/Xcode-27.2.0.app": "27.2" }, [runtime("iOS-26-4")])))
      .rejects.toThrow(`no iOS 27 simulator runtime that can run ${IOS_CONFIG.ios.deviceType} is installed for /Applications/Xcode-27.2.0.app; install one with: xcodebuild -downloadPlatform iOS`);
  });
});
