import type { ChromeClient } from "./types.js";
import { withoutBrowserCancellation } from "./cancellation.js";

interface BrowserConnection {
  client: ChromeClient;
  users: number;
}

const connections = new Map<string, Promise<BrowserConnection>>();

// CRI exposes no ref API. Retain approval while idle without keeping a CLI alive.
function refTransport(client: ChromeClient, active: boolean): void {
  const socket = (
    client as ChromeClient & {
      _ws?: { _socket?: { ref(): void; unref(): void } };
    }
  )._ws?._socket;
  if (active) socket?.ref();
  else socket?.unref();
}

export async function acquireBrowserConnection(
  endpoint: string,
  connect: () => Promise<ChromeClient>,
): Promise<ChromeClient> {
  let pending = connections.get(endpoint);
  if (!pending) {
    pending = Promise.resolve().then(async () => {
      const client = await withoutBrowserCancellation(connect);
      const connection = { client, users: 0 };
      client.on?.("disconnect", () => {
        if (connections.get(endpoint) === pending) connections.delete(endpoint);
      });
      return connection;
    });
    connections.set(endpoint, pending);
  }
  let connection: BrowserConnection;
  try {
    connection = await pending;
  } catch (error) {
    if (connections.get(endpoint) === pending) connections.delete(endpoint);
    throw error;
  }
  connection.users += 1;
  refTransport(connection.client, true);
  let released = false;
  return new Proxy({} as ChromeClient, {
    ownKeys: () => Reflect.ownKeys(connection.client),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(connection.client, key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    get(_target, key) {
      const target = connection.client;
      if (key === "close") {
        return async () => {
          if (released) return;
          released = true;
          connection.users -= 1;
          if (connection.users === 0) refTransport(target, false);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
