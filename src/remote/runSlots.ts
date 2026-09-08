export class RunQueueFullError extends Error {
  constructor() {
    super("The browser run queue is full.");
    this.name = "RunQueueFullError";
  }
}

export class RunSlots {
  private active = 0;
  private readonly waiting: {
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {
    if (
      !Number.isSafeInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      !Number.isSafeInteger(maxQueued) ||
      maxQueued < 0
    ) {
      throw new Error(
        "Run capacity must be a positive integer and queue capacity a nonnegative integer.",
      );
    }
  }
  get activeCount(): number {
    return this.active;
  }
  get queuedCount(): number {
    return this.waiting.length;
  }
  get capacity(): number {
    return this.maxConcurrent;
  }
  get queueCapacity(): number {
    return this.maxQueued;
  }
  get isSaturated(): boolean {
    return this.active >= this.maxConcurrent && this.waiting.length >= this.maxQueued;
  }
  positionFor(): number {
    return this.active < this.maxConcurrent ? 0 : this.waiting.length + 1;
  }

  // Reservation is synchronous, including the queue bound; request-body reads cannot race it.
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("cancelled before a slot was available"));
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    if (this.waiting.length >= this.maxQueued) return Promise.reject(new RunQueueFullError());
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        entry.cleanup();
        reject(new Error("cancelled while waiting for a slot"));
      };
      const entry = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      this.waiting.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.cleanup();
        next.resolve(this.makeRelease());
      } else this.active--;
    };
  }
}
