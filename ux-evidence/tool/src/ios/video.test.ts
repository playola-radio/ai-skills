import { describe, expect, it, vi } from "vitest";
import type { ExecResult, OwnedProcesses } from "../core/effects.ts";
import { measuredWindow, recordIOSVideo, renderMarkScript, serveFlowMarks, type FlowMarks } from "./video.ts";

const FINISHED: ExecResult = { exitCode: 0, stdout: "", stderr: "Recording completed. Writing to disk.\n" };

function fakeRecorder() {
  const events: string[] = [];
  let output: ((text: string) => void) | undefined;
  let finish: (result: ExecResult) => void = () => undefined;
  const finished = new Promise<ExecResult>((resolve) => { finish = resolve; });
  const start = vi.fn<OwnedProcesses["start"]>((_command, _args, options) => {
    events.push("recorder-start");
    output = options?.onOutput;
    return { finished, interrupt: () => { events.push("interrupt"); } };
  });
  return {
    events, start,
    announce: (text = "Recording started\n") => output?.(text),
    finish: (result: ExecResult = FINISHED) => { events.push("recorder-exit"); finish(result); },
  };
}

let clock = 0;
const now = () => clock;
const input = { udid: "UDID-1", rawPath: "/run/head/recording.mov", environment: { DEVELOPER_DIR: "/x" } };

describe("recordIOSVideo", () => {
  it("setupOutsideVideo: the recorder starts only when the flow marks its beginning", async () => {
    const recorder = fakeRecorder();
    const recording = recordIOSVideo(input, async (marks) => {
      recorder.events.push("setup");
      const begun = marks.begin();
      recorder.announce();
      await begun;
      marks.end();
    }, { start: recorder.start, now });
    await vi.waitFor(() => expect(recorder.events).toContain("interrupt"));
    recorder.finish();
    await recording;
    expect(recorder.events.slice(0, 2)).toEqual(["setup", "recorder-start"]);
    expect(recorder.start).toHaveBeenCalledWith(
      "xcrun", ["simctl", "io", "UDID-1", "recordVideo", "--codec=h264", "--force", "/run/head/recording.mov"],
      expect.objectContaining({ env: input.environment }),
    );
  });

  it("beginWaitsForRecorder: begin resolves only after the recorder reports it is recording", async () => {
    const recorder = fakeRecorder();
    let begunAt: string | undefined;
    const recording = recordIOSVideo(input, async (marks) => {
      const begun = marks.begin().then(() => { begunAt = recorder.events.join(","); });
      recorder.announce("Note: No display specified. Defaulting to display\n");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(begunAt).toBeUndefined();
      recorder.events.push("ready");
      recorder.announce("Recording sta");
      recorder.announce("rted\n");
      await begun;
      marks.end();
    }, { start: recorder.start, now });
    await vi.waitFor(() => expect(recorder.events).toContain("interrupt"));
    recorder.finish();
    await recording;
    expect(begunAt).toBe("recorder-start,ready");
  });

  it("fails begin when the recorder does not start in time", async () => {
    const recorder = fakeRecorder();
    const recording = recordIOSVideo(input, async (marks) => { await marks.begin(); }, { start: recorder.start, now, readyTimeoutMs: 20 });
    await vi.waitFor(() => expect(recorder.events).toContain("interrupt"));
    recorder.finish();
    await expect(recording).rejects.toThrow("the simulator video recorder did not start within 0.02 s");
  });

  it("stopAwaitsFinalization: returns the video only after the interrupted recorder has exited", async () => {
    const recorder = fakeRecorder();
    clock = 1000;
    const recording = recordIOSVideo(input, async (marks) => {
      const begun = marks.begin();
      recorder.announce();
      await begun;
      clock = 3250;
      marks.end();
      clock = 5000;
    }, { start: recorder.start, now });
    let settled = false;
    void recording.then(() => { settled = true; });
    await vi.waitFor(() => expect(recorder.events).toContain("interrupt"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    recorder.finish();
    await expect(recording).resolves.toEqual({
      path: "/run/head/recording.mov", trim: { startSeconds: 0, durationSeconds: 2.25 },
    });
    expect(recorder.events.slice(-2)).toEqual(["interrupt", "recorder-exit"]);
  });

  it("failedFlowPublishesNothing: a failing flow still stops and awaits the recorder, then fails", async () => {
    const recorder = fakeRecorder();
    const recording = recordIOSVideo(input, async (marks) => {
      const begun = marks.begin();
      recorder.announce();
      await begun;
      throw new Error("the Maestro flow failed (exit 1)");
    }, { start: recorder.start, now });
    await vi.waitFor(() => expect(recorder.events).toContain("interrupt"));
    recorder.finish();
    await expect(recording).rejects.toThrow("the Maestro flow failed (exit 1)");
    expect(recorder.events).toEqual(["recorder-start", "interrupt", "recorder-exit"]);
  });

  it("fails when the flow never marks its end", async () => {
    const recorder = fakeRecorder();
    const recording = recordIOSVideo(input, async (marks) => {
      const begun = marks.begin();
      recorder.announce();
      await begun;
    }, { start: recorder.start, now });
    await vi.waitFor(() => expect(recorder.events).toContain("interrupt"));
    recorder.finish();
    await expect(recording).rejects.toThrow("flow.yaml finished without reaching the end of the recorded part");
  });

  it("fails when the flow never begins recording", async () => {
    const recorder = fakeRecorder();
    await expect(recordIOSVideo(input, async () => {}, { start: recorder.start, now }))
      .rejects.toThrow("flow.yaml finished without starting the video");
    expect(recorder.start).not.toHaveBeenCalled();
  });

  it("fails with the recorder's output when it exits with an error", async () => {
    const recorder = fakeRecorder();
    const recording = recordIOSVideo(input, async (marks) => {
      const begun = marks.begin();
      recorder.announce();
      await begun;
      marks.end();
    }, { start: recorder.start, now });
    await vi.waitFor(() => expect(recorder.events).toContain("interrupt"));
    recorder.finish({ exitCode: 1, stdout: "", stderr: "Error: device is not booted" });
    await expect(recording).rejects.toThrow("simctl recordVideo failed (exit 1): Error: device is not booted");
  });

  it("fails when the recorder stops on its own before the flow finishes", async () => {
    const recorder = fakeRecorder();
    const recording = recordIOSVideo(input, async (marks) => {
      const begun = marks.begin();
      recorder.announce();
      await begun;
      recorder.finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
      marks.end();
    }, { start: recorder.start, now });
    await expect(recording).rejects.toThrow("simctl recordVideo stopped before flow.yaml finished (exit 0)");
  });

  it("gives up waiting on a recorder that does not finish after the interrupt", async () => {
    const recorder = fakeRecorder();
    const recording = recordIOSVideo(input, async (marks) => {
      const begun = marks.begin();
      recorder.announce();
      await begun;
      marks.end();
    }, { start: recorder.start, now, finalizeTimeoutMs: 20 });
    await expect(recording).rejects.toThrow("the simulator video recorder did not finish within 0.02 s");
  });
});

describe("measuredWindow", () => {
  it("trimMeasuredWindow: recorder-ready 1000 ms, begin 1250 ms, end 3250 ms gives start 0.25 s, duration 2 s", () => {
    expect(measuredWindow({ readyAt: 1000, beginAt: 1250, endAt: 3250 }))
      .toEqual({ startSeconds: 0.25, durationSeconds: 2 });
  });
});

describe("serveFlowMarks", () => {
  function marks(begin: FlowMarks["begin"] = async () => {}) {
    return { begin: vi.fn(begin), end: vi.fn() };
  }

  it("answers begin only after the recorder is ready, and records end", async () => {
    let ready: () => void = () => undefined;
    const flow = marks(() => new Promise<void>((resolve) => { ready = resolve; }));
    const server = await serveFlowMarks(flow);
    try {
      let answered = false;
      const begin = fetch(server.beginUrl, { method: "POST" }).then((response) => { answered = true; return response.status; });
      await vi.waitFor(() => expect(flow.begin).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(answered).toBe(false);
      ready();
      expect(await begin).toBe(200);
      expect((await fetch(server.endUrl, { method: "POST" })).status).toBe(200);
      expect(flow.end).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("listens on loopback only and answers 404 to any other path", async () => {
    const flow = marks();
    const server = await serveFlowMarks(flow);
    try {
      expect(new URL(server.beginUrl).hostname).toBe("127.0.0.1");
      const other = new URL(server.beginUrl);
      other.pathname = "/begin";
      expect((await fetch(other, { method: "POST" })).status).toBe(404);
      expect(flow.begin).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("answers 500 with the reason when the recorder cannot start, so the flow fails", async () => {
    const server = await serveFlowMarks(marks(async () => { throw new Error("recorder did not start"); }));
    try {
      const response = await fetch(server.beginUrl, { method: "POST" });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("recorder did not start");
    } finally {
      await server.close();
    }
  });
});

describe("renderMarkScript", () => {
  it("posts to the mark and fails the flow on any other answer than 200", () => {
    const script = renderMarkScript("http://127.0.0.1:5000/t/begin");
    expect(script).toContain('http.post("http://127.0.0.1:5000/t/begin"');
    expect(script).toContain("response.status !== 200");
  });
});
