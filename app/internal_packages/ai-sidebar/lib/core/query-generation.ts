/** Monotonic id so a late mock response cannot attach after Cancel. */
export function nextQueryGeneration(current: number): number {
  return current + 1;
}

export function isStaleQueryGeneration(started: number, current: number): boolean {
  return started !== current;
}

export function shouldAcceptAssistantResponse(opts: {
  startedGeneration: number;
  currentGeneration: number;
  aborted: boolean;
}): boolean {
  if (opts.aborted) {
    return false;
  }
  return !isStaleQueryGeneration(opts.startedGeneration, opts.currentGeneration);
}

/** Demo+dev only. Ignored when demo is off. Capped at 30s. Not a network endpoint. */
export function parseDemoQueryDelayMs(
  raw: string | number | undefined | null,
  demoEnabled: boolean
): number {
  if (!demoEnabled) {
    return 0;
  }
  if (raw === undefined || raw === null || raw === '') {
    return 0;
  }
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.min(Math.floor(n), 30000);
}

export function demoQueryDelayFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parseDemoQueryDelayMs(env.MAILSPRING_DEMO_DELAY_MS, env.MAILSPRING_DEMO === '1');
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms || ms <= 0) {
    if (signal?.aborted) {
      throw new Error('Operation cancelled');
    }
    return;
  }
  if (signal?.aborted) {
    throw new Error('Operation cancelled');
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Operation cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    }
  });
}
