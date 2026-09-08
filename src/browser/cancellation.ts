import { AsyncLocalStorage } from "node:async_hooks";
import { BrowserRunCancelledError } from "../oracle/errors.js";
import type { ChromeClient } from "./types.js";

const context = new AsyncLocalStorage<AbortSignal | undefined>();
const cleanupContext = new AsyncLocalStorage<boolean>();
export const currentBrowserAbortSignal = (): AbortSignal | undefined => context.getStore();
export const withoutBrowserCancellation = <T>(task: () => T): T =>
  cleanupContext.run(true, () => context.run(undefined, task));

/** Per-run cancellation, including polling and resources that arrive after their caller left. */
export class BrowserCancellation {
  private readonly aborted: Promise<never> | undefined;
  private readonly onAbort: (() => void) | undefined;
  private readonly proxies = new WeakMap<object, object>();

  constructor(
    readonly signal?: AbortSignal,
    private readonly log: (message: string) => void = () => {},
  ) {
    if (signal) {
      let rejectAbort!: (reason: Error) => void;
      this.aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      this.aborted.catch(() => undefined);
      this.onAbort = () => rejectAbort(new BrowserRunCancelledError());
      if (signal.aborted) this.onAbort();
      else signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }
  check(): void {
    if (this.signal?.aborted) throw new BrowserRunCancelledError();
  }
  run<T>(task: () => T): T {
    return cleanupContext.run(false, () => context.run(this.signal, task));
  }
  dispose(): void {
    if (this.onAbort) this.signal?.removeEventListener("abort", this.onAbort);
  }
  race<T>(pending: Promise<T>): Promise<T> {
    return this.aborted ? Promise.race([pending, this.aborted]) : pending;
  }
  call<T>(create: () => Promise<T>): Promise<T> {
    this.check();
    return this.race(create());
  }

  acquire<T>(create: () => Promise<T>, releaseLate: (resource: T) => Promise<void>): Promise<T> {
    this.check();
    const pending = create().then(async (resource) => {
      if (this.signal?.aborted) {
        await withoutBrowserCancellation(() => releaseLate(resource)).catch((error) => {
          this.log(
            `[browser] Late cancelled resource cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        throw new BrowserRunCancelledError();
      }
      return resource;
    });
    return this.race(pending);
  }

  client(client: ChromeClient): ChromeClient {
    if (!this.signal) return client;
    const wrap = (target: object): object => {
      const cached = this.proxies.get(target);
      if (cached) return cached;
      const proxy = new Proxy(target, {
        get: (object, key) => {
          const value = Reflect.get(object, key);
          if (typeof value === "function") {
            if (
              [
                "on",
                "once",
                "off",
                "emit",
                "removeListener",
                "removeAllListeners",
                "addListener",
                "close",
              ].includes(String(key))
            )
              return value.bind(object);
            return (...args: unknown[]) => {
              // CDP event subscriptions are synchronous and must remain removable during cleanup.
              if (typeof args[0] === "function") return Reflect.apply(value, object, args);
              if (cleanupContext.getStore()) return Reflect.apply(value, object, args);
              if (this.signal?.aborted) return Promise.reject(new BrowserRunCancelledError());
              const result = Reflect.apply(value, object, args);
              return result && typeof (result as PromiseLike<unknown>).then === "function"
                ? this.race(Promise.resolve(result))
                : result;
            };
          }
          return value && typeof value === "object" ? wrap(value) : value;
        },
      });
      this.proxies.set(target, proxy);
      return proxy;
    };
    return wrap(client) as ChromeClient;
  }
}
