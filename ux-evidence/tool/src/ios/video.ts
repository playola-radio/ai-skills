import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExecResult, OwnedProcesses, StartedProcess } from "../core/effects.ts";
import type { VideoTrim } from "../core/media.ts";

// Called by the generated Maestro scripts around flow.yaml: begin after setup, end after the last step.
export interface FlowMarks {
  begin(): Promise<void>;
  end(): void;
}

export interface VideoRecorderDependencies {
  start: OwnedProcesses["start"];
  now(): number;
  readyTimeoutMs?: number;
  finalizeTimeoutMs?: number;
}

// simctl prints this once frames are being written; until then a tap would not be in the video.
const RECORDING_STARTED = "Recording started";
const READY_TIMEOUT_MS = 8000;
const FINALIZE_TIMEOUT_MS = 30_000;
const END_HOLD_MS = 1000;

function tail(text: string, lineCount: number): string {
  return text.trimEnd().split("\n").slice(-lineCount).join("\n");
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The raw video starts when the recorder is ready; the published part runs from begin to just after end, so
// the last screen can settle, but never past the moment the recorder was stopped.
export function measuredWindow(times: { readyAt: number; beginAt: number; endAt: number; stoppedAt: number }): VideoTrim {
  const until = Math.min(times.endAt + END_HOLD_MS, times.stoppedAt);
  return { startSeconds: (times.beginAt - times.readyAt) / 1000, durationSeconds: (until - times.beginAt) / 1000 };
}

export async function recordIOSVideo(
  input: { udid: string; rawPath: string; environment: NodeJS.ProcessEnv },
  runFlow: (marks: FlowMarks) => Promise<void>,
  dependencies: VideoRecorderDependencies,
): Promise<{ path: string; trim: VideoTrim }> {
  const { udid, rawPath, environment } = input;
  const readyTimeoutMs = dependencies.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const finalizeTimeoutMs = dependencies.finalizeTimeoutMs ?? FINALIZE_TIMEOUT_MS;
  let recorder: StartedProcess | undefined;
  let readyAt: number | undefined;
  let beginAt: number | undefined;
  let endAt: number | undefined;

  const begin = async () => {
    if (recorder !== undefined) throw new Error("flow.yaml began the video twice");
    let output = "";
    let announce: () => void = () => undefined;
    const announced = new Promise<void>((resolve) => { announce = resolve; });
    const started = dependencies.start("xcrun", ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", rawPath], {
      env: environment,
      onOutput: (text) => {
        output += text;
        if (readyAt === undefined && output.includes(RECORDING_STARTED)) {
          readyAt = dependencies.now();
          announce();
        }
      },
    });
    recorder = started;
    const exitedEarly = started.finished.then((result) => {
      throw new Error(`simctl recordVideo exited before recording (exit ${result.exitCode}): ${tail(result.stderr || result.stdout, 5)}`);
    });
    await within(Promise.race([announced, exitedEarly]), readyTimeoutMs,
      `the simulator video recorder did not start within ${readyTimeoutMs / 1000} s`);
    beginAt = dependencies.now();
  };
  const end = () => {
    if (beginAt !== undefined) endAt ??= dependencies.now();
  };

  let flowError: unknown;
  try {
    await runFlow({ begin, end });
  } catch (error) {
    flowError = error;
  }
  if (recorder === undefined) {
    if (flowError !== undefined) throw flowError;
    throw new Error("flow.yaml finished without starting the video");
  }

  const stoppedAt = dependencies.now();
  recorder.interrupt();
  let stopped: ExecResult;
  try {
    stopped = await within(recorder.finished, finalizeTimeoutMs,
      `the simulator video recorder did not finish within ${finalizeTimeoutMs / 1000} s`);
  } catch (stopError) {
    throw flowError ?? stopError;
  }
  if (flowError !== undefined) throw flowError;
  if (stopped.exitCode !== 0) {
    throw new Error(`simctl recordVideo failed (exit ${stopped.exitCode}): ${tail(stopped.stderr || stopped.stdout, 5)}`);
  }
  if (readyAt === undefined || beginAt === undefined) throw new Error("flow.yaml finished without starting the video");
  if (endAt === undefined) throw new Error("flow.yaml finished without reaching the end of the recorded part");
  return { path: rawPath, trim: measuredWindow({ readyAt, beginAt, endAt, stoppedAt }) };
}

export interface MarkServer {
  beginUrl: string;
  endUrl: string;
  close(): Promise<void>;
}

// Loopback only, on a free port, under a random path so nothing else on the machine can move the marks.
export async function serveFlowMarks(marks: FlowMarks): Promise<MarkServer> {
  const token = randomUUID();
  const server = createServer((request, response) => {
    response.setHeader("connection", "close");
    const answer = (status: number, body: string) => { response.statusCode = status; response.end(body); };
    if (request.method !== "POST") return answer(404, "");
    if (request.url === `/${token}/begin`) {
      marks.begin().then(() => answer(200, "ok"), (error: unknown) => {
        answer(500, error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (request.url === `/${token}/end`) {
      marks.end();
      return answer(200, "ok");
    }
    answer(404, "");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`;
  return {
    beginUrl: `${base}/begin`,
    endUrl: `${base}/end`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// Runs inside Maestro (its JavaScript `http` client); a non-200 answer fails the flow.
export function renderMarkScript(url: string): string {
  return [
    `var response = http.post(${JSON.stringify(url)}, { body: "" });`,
    'if (response.status !== 200) throw new Error("UX evidence video: " + response.body);',
    "",
  ].join("\n");
}
