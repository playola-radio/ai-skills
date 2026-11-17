import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../core/effects.ts";
import { IOS_CONFIG } from "../core/test-fixtures.ts";
import {
  captureSession,
  loadSavedSession,
  parseSession,
  realSessionFiles,
  sessionPath,
  type SessionDependencies,
  type SessionFiles,
} from "./session.ts";

const settings = IOS_CONFIG.ios;
const NOW = new Date("2030-01-01T00:00:00Z");
const SENTINEL = "SENTINELSIGNATURE";

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${SENTINEL}`;
}
function sessionJson(token: string): string {
  return JSON.stringify({ currentUser: { id: "user-1", firstName: "Test" }, jwt: token });
}
const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function ok(stdout: string): ExecResult { return { exitCode: 0, stdout, stderr: "" }; }

function simulators(booted: Record<string, string | undefined>) {
  return vi.fn(async (_command: string, args: readonly string[]) => {
    if (args[1] === "list") {
      return ok(JSON.stringify({ devices: { runtime: Object.keys(booted).map((udid) => ({ udid, state: "Booted" })) } }));
    }
    if (args[1] === "get_app_container") {
      const container = booted[args[2]!];
      return container === undefined ? { exitCode: 2, stdout: "", stderr: "No such app" } : ok(`${container}\n`);
    }
    throw new Error(`unexpected command ${args.join(" ")}`);
  });
}

function memoryFiles(contents: Record<string, string>) {
  const written = new Map<string, string>();
  const files: SessionFiles = {
    readTextFile: vi.fn(async (path: string) => {
      const content = contents[path];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    }),
    makePrivateDirectory: vi.fn(async () => {}),
    writePrivateFileAtomically: vi.fn(async (path: string, content: string) => { written.set(path, content); }),
  };
  return { files, written };
}

function dependencies(overrides: Partial<SessionDependencies> & Pick<SessionDependencies, "files">): SessionDependencies {
  return {
    exec: simulators({ "AAAA": "/containers/a" }),
    get: vi.fn(async () => ({ status: 200 })),
    now: () => NOW,
    homeDirectory: "/home/u",
    ...overrides,
  };
}

describe("parseSession", () => {
  it("expiryBoundary: exactly 30 minutes left passes, one second less fails", () => {
    expect(parseSession(sessionJson(jwt({ exp: at("2030-01-01T00:30:00Z") })), NOW).expiresAt)
      .toEqual(new Date("2030-01-01T00:30:00Z"));
    expect(() => parseSession(sessionJson(jwt({ exp: at("2030-01-01T00:29:59Z") })), NOW))
      .toThrow("less than 30 minutes from now");
  });

  it("needs a signed-in user and a token", () => {
    expect(() => parseSession(JSON.stringify({ jwt: jwt({}) }), NOW)).toThrow("no signed-in user");
    expect(() => parseSession(JSON.stringify({ currentUser: { id: "u" }, jwt: "" }), NOW)).toThrow("no token");
    expect(() => parseSession("{", NOW)).toThrow("not valid JSON");
  });

  it("rejects an expiry that is not a number", () => {
    expect(() => parseSession(sessionJson(jwt({ exp: "soon" })), NOW)).toThrow("unreadable expiry");
  });
});

describe("captureSession", () => {
  const authPath = "/containers/a/Documents/auth.json";

  it("missingExpUsesServer: a token without exp is saved only after staging accepts it", async () => {
    const token = jwt({ sub: "user-1" });
    const { files, written } = memoryFiles({ [authPath]: sessionJson(token) });
    const get = vi.fn(async () => ({ status: 200 }));
    const saved = await captureSession(settings, undefined, dependencies({ files, get }));
    expect(get).toHaveBeenCalledWith("https://admin-api-staging.playola.fm/v1/users/me/client-config", token);
    expect(saved).toEqual({ path: sessionPath("/home/u"), expiresAt: null });
    expect(written.get(sessionPath("/home/u"))).toBe(sessionJson(token));
  });

  it("unauthorizedWritesNothing: HTTP 401 saves no session", async () => {
    const { files, written } = memoryFiles({ [authPath]: sessionJson(jwt({})) });
    await expect(captureSession(settings, undefined, dependencies({ files, get: vi.fn(async () => ({ status: 401 })) })))
      .rejects.toThrow("rejected the saved session (HTTP 401)");
    expect(written.size).toBe(0);
    expect(files.makePrivateDirectory).not.toHaveBeenCalled();
  });

  it("treats a redirect as a rejection", async () => {
    const { files, written } = memoryFiles({ [authPath]: sessionJson(jwt({})) });
    await expect(captureSession(settings, undefined, dependencies({ files, get: vi.fn(async () => ({ status: 302 })) })))
      .rejects.toThrow("HTTP 302");
    expect(written.size).toBe(0);
  });

  it("ambiguousLoginDevice: two booted simulators with the app need --device", async () => {
    const exec = simulators({ "AAAA": "/containers/a", "BBBB": "/containers/b", "CCCC": undefined });
    const { files } = memoryFiles({ [authPath]: sessionJson(jwt({})), "/containers/b/Documents/auth.json": sessionJson(jwt({})) });
    await expect(captureSession(settings, undefined, dependencies({ files, exec })))
      .rejects.toThrow("more than one booted simulator has the staging app (AAAA, BBBB); pass DEVICE=<udid>");
    await expect(captureSession(settings, "BBBB", dependencies({ files, exec }))).resolves.toMatchObject({ expiresAt: null });
    expect(files.readTextFile).toHaveBeenLastCalledWith("/containers/b/Documents/auth.json");
  });

  it("only reads the login simulator: list and get_app_container, nothing else", async () => {
    const exec = simulators({ "AAAA": "/containers/a" });
    const { files } = memoryFiles({ [authPath]: sessionJson(jwt({})) });
    await captureSession(settings, "AAAA", dependencies({ files, exec }));
    expect(exec.mock.calls.map(([, args]) => args[1])).toEqual(["list", "get_app_container"]);
  });

  it("explains a device that is not booted or lacks the app", async () => {
    const exec = simulators({ "AAAA": undefined });
    const { files } = memoryFiles({});
    await expect(captureSession(settings, "ZZZZ", dependencies({ files, exec }))).rejects.toThrow("simulator ZZZZ is not booted");
    await expect(captureSession(settings, "AAAA", dependencies({ files, exec }))).rejects.toThrow("does not have fm.playola.playolaradio.staging installed");
    await expect(captureSession(settings, undefined, dependencies({ files, exec }))).rejects.toThrow("no booted simulator has");
  });

  it("refuses a non-https API host before sending the token", async () => {
    const { files } = memoryFiles({ [authPath]: sessionJson(jwt({})) });
    const get = vi.fn(async () => ({ status: 200 }));
    await expect(captureSession({ ...settings, apiHost: "http://admin-api-staging.playola.fm" }, undefined, dependencies({ files, get })))
      .rejects.toThrow("must be an https URL");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("saved session on disk", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "ios-session-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it("sessionPermissions: directory 0700, file 0600, and no message carries the token", async () => {
    const token = jwt({ exp: at("2030-01-01T05:00:00Z") });
    const { files: source } = memoryFiles({ "/containers/a/Documents/auth.json": sessionJson(token) });
    const files: SessionFiles = { ...realSessionFiles, readTextFile: source.readTextFile };
    const saved = await captureSession(settings, undefined, dependencies({ files, homeDirectory: home }));

    expect((await stat(join(home, ".config", "playola-ux"))).mode & 0o777).toBe(0o700);
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(home, ".config", "playola-ux"))).toEqual(["ios-staging-auth.json"]);
    expect(JSON.stringify(saved)).not.toContain(SENTINEL);

    const messages: string[] = [];
    for (const status of [401, 500]) {
      await loadSavedSession(settings, { files: realSessionFiles, get: async () => ({ status }), now: () => NOW, homeDirectory: home })
        .catch((error: Error) => messages.push(error.message));
    }
    await loadSavedSession(settings, {
      files: realSessionFiles, get: async () => { throw new Error("offline"); }, now: () => NOW, homeDirectory: home,
    }).catch((error: Error) => messages.push(error.message));
    await loadSavedSession(settings, {
      files: realSessionFiles, get: async () => ({ status: 200 }), now: () => new Date("2030-01-01T04:45:00Z"), homeDirectory: home,
    }).catch((error: Error) => messages.push(error.message));
    expect(messages).toHaveLength(4);
    for (const message of messages) expect(message).not.toContain(SENTINEL);
  });

  it("explains a missing saved session", async () => {
    await expect(loadSavedSession(settings, { files: realSessionFiles, get: async () => ({ status: 200 }), now: () => NOW, homeDirectory: home }))
      .rejects.toThrow("no saved staging session");
  });
});
