export interface CleanupRegistry {
  readonly signal: AbortSignal;
  add(cleanup: () => Promise<void>): void;
  run(): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCleanupRegistry(signal: AbortSignal = new AbortController().signal): CleanupRegistry {
  const cleanups: Array<() => Promise<void>> = [];
  return {
    signal,
    add(cleanup) { cleanups.push(cleanup); },
    async run() {
      const errors: unknown[] = [];
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop()!;
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `cleanup failed: ${errors.map(messageOf).join("; ")}`);
      }
    },
  };
}

type TerminationSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
type OnSignal = (signal: TerminationSignal, handler: () => void) => () => void;

const EXIT_CODES: Record<TerminationSignal, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

const processOnSignal: OnSignal = (signal, handler) => {
  process.on(signal, handler);
  return () => { process.off(signal, handler); };
};

const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function runWithSignalCleanup<T>(
  work: (cleanup: CleanupRegistry) => Promise<T>,
  onSignal: OnSignal = processOnSignal,
  settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const cleanup = createCleanupRegistry(controller.signal);
  let interruption: Promise<Error> | undefined;
  let wake: () => void = () => undefined;
  const signalArrived = new Promise<void>((resolve) => { wake = resolve; });
  let workDone: Promise<Settled<T>> | undefined;

  const handle = (signal: TerminationSignal) => () => {
    if (interruption) return;
    controller.abort();
    interruption = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const gaveUp = new Promise<void>((resolve) => { timer = setTimeout(resolve, settleTimeoutMs); });
      await Promise.race([workDone, gaveUp]);
      clearTimeout(timer);
      let detail = "";
      try { await cleanup.run(); } catch (error) { detail = `; ${messageOf(error)}`; }
      return Object.assign(new Error(`interrupted by ${signal}${detail}`), { exitCode: EXIT_CODES[signal] });
    })();
    wake();
  };
  const unsubscribe = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => onSignal(signal, handle(signal)));
  try {
    workDone = work(cleanup).then(
      (value): Settled<T> => ({ ok: true, value }),
      (error): Settled<T> => ({ ok: false, error }),
    );
    await Promise.race([workDone, signalArrived]);
    if (interruption) throw await interruption;
    const result = await workDone;
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    unsubscribe.forEach((off) => off());
  }
}
