export interface HeartbeatConfig {
  intervalMs?: number;
  log: (message: string) => void;
  isActive: () => boolean;
  makeMessage: (elapsedMs: number) => Promise<string | null> | string | null;
}

export function startHeartbeat(config: HeartbeatConfig): () => void {
  const { intervalMs, log, isActive, makeMessage } = config;
  if (!intervalMs || intervalMs <= 0) {
    return () => {};
  }
  let stopped = false;
  let pending = false;
  const start = Date.now();
  const timer = setInterval(async () => {
    // stop flag flips asynchronously
    if (stopped || pending) {
      return;
    }
    if (!isActive()) {
      stop();
      return;
    }
    pending = true;
    try {
      const elapsed = Date.now() - start;
      const message = await makeMessage(elapsed);
      if (message && !stopped) {
        log(message);
      }
    } catch {
      // ignore heartbeat errors
    } finally {
      pending = false;
    }
  }, intervalMs);
  timer.unref?.();
  const stop = () => {
    // multiple callers may race to stop
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}
