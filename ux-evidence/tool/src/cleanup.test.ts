import { describe, expect, it, vi } from "vitest";
import { createCleanupRegistry, runWithSignalCleanup } from "./cleanup.ts";

describe("createCleanupRegistry", () => {
  it("runs cleanups in reverse order and continues past a failure", async () => {
    const order: string[] = [];
    const registry = createCleanupRegistry();
    registry.add(async () => { order.push("a"); });
    registry.add(async () => { order.push("b"); throw new Error("boom"); });
    registry.add(async () => { order.push("c"); });
    await expect(registry.run()).rejects.toThrow("cleanup failed: boom");
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("runs each cleanup only once", async () => {
    const spy = vi.fn(async () => undefined);
    const registry = createCleanupRegistry();
    registry.add(spy);
    await registry.run();
    await registry.run();
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("runWithSignalCleanup", () => {
  function fakeSignals() {
    const handlers = new Map<string, () => void>();
    const onSignal = (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void) => {
      handlers.set(signal, handler);
      return () => { handlers.delete(signal); };
    };
    return { handlers, onSignal };
  }

  it.each([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const)("awaits cleanup after %s", async (signal, code) => {
    const cleanupSpy = vi.fn(async () => undefined);
    const { handlers, onSignal } = fakeSignals();
    const run = runWithSignalCleanup(async (cleanup) => {
      cleanup.add(cleanupSpy);
      return new Promise<never>((_, reject) => {
        cleanup.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }, onSignal);
    await Promise.resolve();
    handlers.get(signal)!();
    await expect(run).rejects.toMatchObject({ exitCode: code });
    expect(cleanupSpy).toHaveBeenCalledOnce();
  });

  it("waits for the work to settle before cleaning up, and reports cleanup failures", async () => {
    const order: string[] = [];
    const { handlers, onSignal } = fakeSignals();
    const run = runWithSignalCleanup(async (cleanup) => {
      cleanup.add(async () => { order.push("cleanup-a"); });
      cleanup.add(async () => { order.push("cleanup-b"); throw new Error("down exploded"); });
      await new Promise<void>((resolve) => cleanup.signal.addEventListener("abort", () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("work-settled");
    }, onSignal);
    handlers.get("SIGTERM")!();
    await expect(run).rejects.toMatchObject({ exitCode: 143, message: expect.stringContaining("cleanup failed: down exploded") });
    expect(order).toEqual(["work-settled", "cleanup-b", "cleanup-a"]);
  });

  it("does not run cleanup twice on a second signal", async () => {
    const cleanupSpy = vi.fn(async () => undefined);
    const { handlers, onSignal } = fakeSignals();
    const run = runWithSignalCleanup(async (cleanup) => {
      cleanup.add(cleanupSpy);
      await new Promise<void>((resolve) => cleanup.signal.addEventListener("abort", () => resolve()));
    }, onSignal);
    handlers.get("SIGINT")!();
    handlers.get("SIGINT")!();
    handlers.get("SIGTERM")!();
    await expect(run).rejects.toMatchObject({ exitCode: 130 });
    expect(cleanupSpy).toHaveBeenCalledOnce();
  });

  it("returns the work result and unsubscribes", async () => {
    const { handlers, onSignal } = fakeSignals();
    await expect(runWithSignalCleanup(async () => 7, onSignal)).resolves.toBe(7);
    expect(handlers.size).toBe(0);
  });

  it("runs cleanup and exits with the interrupt code when the work never settles", async () => {
    const cleanupSpy = vi.fn(async () => undefined);
    const { handlers, onSignal } = fakeSignals();
    const run = runWithSignalCleanup(async (cleanup) => {
      cleanup.add(cleanupSpy);
      return new Promise<never>(() => undefined);
    }, onSignal, 20);
    handlers.get("SIGINT")!();
    await expect(run).rejects.toMatchObject({ exitCode: 130, message: "interrupted by SIGINT" });
    expect(cleanupSpy).toHaveBeenCalledOnce();
  });
});
