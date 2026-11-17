import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IOSSettings } from "../core/config.ts";
import type { Exec } from "../core/effects.ts";
import { simctl } from "./simulator.ts";

export const MIN_REMAINING_SECONDS = 1800;
export const CLIENT_CONFIG_PATH = "/v1/users/me/client-config";
const REQUEST_TIMEOUT_MS = 10_000;

export function sessionPath(homeDirectory: string): string {
  return join(homeDirectory, ".config", "playola-ux", "ios-staging-auth.json");
}

export interface ParsedSession { json: string; jwt: string; expiresAt: Date | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jwtExpiry(jwt: string): Date | null {
  const payload = jwt.split(".")[1];
  if (payload === undefined) throw new Error("the saved session's token is not a JWT");
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("the saved session's token is not a JWT");
  }
  if (!isRecord(claims) || claims.exp === undefined) return null;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new Error("the saved session's token has an unreadable expiry");
  }
  return new Date(claims.exp * 1000);
}

export function parseSession(json: string, now: Date): ParsedSession {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("the session file is not valid JSON");
  }
  if (!isRecord(raw) || !isRecord(raw.currentUser) || typeof raw.currentUser.id !== "string") {
    throw new Error("the session has no signed-in user; sign in to the staging app first");
  }
  if (typeof raw.jwt !== "string" || raw.jwt === "") {
    throw new Error("the session has no token; sign in to the staging app first");
  }
  const expiresAt = jwtExpiry(raw.jwt);
  if (expiresAt !== null && expiresAt.getTime() - now.getTime() < MIN_REMAINING_SECONDS * 1000) {
    throw new Error(`the saved session expires at ${expiresAt.toISOString()}, less than 30 minutes from now; sign in again and rerun make ux-evidence-ios-login`);
  }
  return { json, jwt: raw.jwt, expiresAt };
}

export type AuthorizedGet = (url: string, bearerToken: string) => Promise<{ status: number }>;

export const realAuthorizedGet: AuthorizedGet = async (url, bearerToken) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel();
  return { status: response.status };
};

export function clientConfigUrl(apiHost: string): string {
  const url = new URL(CLIENT_CONFIG_PATH, apiHost);
  if (url.protocol !== "https:") throw new Error(`ios.apiHost must be an https URL: ${apiHost}`);
  return url.toString();
}

export async function assertAcceptedByStaging(apiHost: string, jwt: string, get: AuthorizedGet): Promise<void> {
  const url = clientConfigUrl(apiHost);
  let status: number;
  try {
    ({ status } = await get(url, jwt));
  } catch (error) {
    throw new Error(`could not reach ${apiHost} to check the saved session: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`${apiHost} rejected the saved session (HTTP ${status}); sign in to the staging app again and rerun make ux-evidence-ios-login`);
  }
}

export interface SessionFiles {
  readTextFile(path: string): Promise<string>;
  makePrivateDirectory(path: string): Promise<void>;
  writePrivateFileAtomically(path: string, content: string): Promise<void>;
}

export const realSessionFiles: SessionFiles = {
  readTextFile: (path) => readFile(path, "utf8"),
  async makePrivateDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  },
  async writePrivateFileAtomically(path, content) {
    const temporaryPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  },
};

export interface SessionDependencies {
  exec: Exec;
  files: SessionFiles;
  get: AuthorizedGet;
  now(): Date;
  homeDirectory: string;
}

interface SimctlDevice { udid: string; state: string }

async function bootedDevices(settings: IOSSettings, exec: Exec): Promise<readonly string[]> {
  const listing = JSON.parse(await simctl(settings, exec, ["list", "devices", "booted", "-j"])) as {
    devices: Record<string, SimctlDevice[]>;
  };
  return Object.values(listing.devices).flat().filter((device) => device.state === "Booted").map((device) => device.udid);
}

async function appDataContainer(settings: IOSSettings, exec: Exec, udid: string): Promise<string | undefined> {
  try {
    return (await simctl(settings, exec, ["get_app_container", udid, settings.bundleId, "data"])).trim();
  } catch {
    return undefined;
  }
}

async function selectLoginContainer(settings: IOSSettings, exec: Exec, device: string | undefined): Promise<string> {
  const booted = await bootedDevices(settings, exec);
  if (device !== undefined) {
    if (!booted.includes(device)) throw new Error(`simulator ${device} is not booted`);
    const container = await appDataContainer(settings, exec, device);
    if (container === undefined) throw new Error(`simulator ${device} does not have ${settings.bundleId} installed`);
    return container;
  }
  const withApp: Array<{ udid: string; container: string }> = [];
  for (const udid of booted) {
    const container = await appDataContainer(settings, exec, udid);
    if (container !== undefined) withApp.push({ udid, container });
  }
  if (withApp.length === 0) {
    throw new Error(`no booted simulator has ${settings.bundleId} installed; sign in to the staging app in a simulator first`);
  }
  if (withApp.length > 1) {
    throw new Error(`more than one booted simulator has the staging app (${withApp.map((entry) => entry.udid).join(", ")}); pass DEVICE=<udid>`);
  }
  return withApp[0]!.container;
}

export async function captureSession(
  settings: IOSSettings,
  device: string | undefined,
  dependencies: SessionDependencies,
): Promise<{ path: string; expiresAt: Date | null }> {
  const container = await selectLoginContainer(settings, dependencies.exec, device);
  let json: string;
  try {
    json = await dependencies.files.readTextFile(join(container, "Documents", "auth.json"));
  } catch {
    throw new Error("the staging app on that simulator has no saved sign-in; sign in first");
  }
  const session = parseSession(json, dependencies.now());
  await assertAcceptedByStaging(settings.apiHost, session.jwt, dependencies.get);
  const path = sessionPath(dependencies.homeDirectory);
  await dependencies.files.makePrivateDirectory(dirname(path));
  await dependencies.files.writePrivateFileAtomically(path, session.json);
  return { path, expiresAt: session.expiresAt };
}

export async function loadSavedSession(settings: IOSSettings, dependencies: Omit<SessionDependencies, "exec">): Promise<ParsedSession> {
  const path = sessionPath(dependencies.homeDirectory);
  let json: string;
  try {
    json = await dependencies.files.readTextFile(path);
  } catch {
    throw new Error(`no saved staging session at ${path}; sign in to the staging app in a simulator, then run make ux-evidence-ios-login`);
  }
  const session = parseSession(json, dependencies.now());
  await assertAcceptedByStaging(settings.apiHost, session.jwt, dependencies.get);
  return session;
}
