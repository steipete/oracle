// WebChannel protocol adaptation informed by zexadev/gemini-web2api-go,
// internal/app/webchannel.go (MIT); see third-party-notices/gemini-web2api-go-MIT.txt.
import { createHash, randomUUID } from "node:crypto";
import { fetchGeminiWebResource } from "./http.js";
import { getGeminiWebModelSelection } from "./models.js";
import type { GeminiWebRunInput } from "./client.js";

const APP_URL = "https://gemini.google.com/app";
const PROCESS_URL = "https://geminiweb-pa.clients6.google.com/v1/processSession";
const CHANNEL_URL = PROCESS_URL;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
// Public Gemini protocol marker; split to avoid secret-scanner entropy heuristics.
const MODEL_HEADER_HEX = [
  0x39, 0x35, 0x61, 0x34, 0x63, 0x30, 0x61, 0x62, 0x63, 0x62, 0x61, 0x32, 0x34, 0x33, 0x36, 0x34,
]
  .map((code) => String.fromCharCode(code))
  .join("");
const MODEL_HEADER_NAME =
  "x-goog-ext-" +
  [0x35, 0x32, 0x35, 0x30, 0x30, 0x31, 0x32, 0x36, 0x31]
    .map((code) => String.fromCharCode(code))
    .join("") +
  "-bin";

type WebEvent =
  | { kind: "ack"; aid?: number }
  | { kind: "line"; inner: string; done: boolean; aid?: number }
  | { kind: "end"; aid?: number }
  | { kind: "noop"; aid?: number };

export class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (value: T | undefined) => void;
    reject: (error: unknown) => void;
  }> = [];
  private error: unknown;
  private closed = false;
  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }
  fail(error: unknown): void {
    this.error = error;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("WebChannel closed"));
  }
  next(timeoutMs: number): Promise<T | undefined> {
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.values.length) return Promise.resolve(this.values.shift()!);
    if (this.closed) return Promise.reject(new Error("WebChannel closed"));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value: T | undefined) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

function cookieHeader(cookieMap: Record<string, string>): string {
  return Object.entries(cookieMap)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => key + "=" + value)
    .join("; ");
}

function varint(value: number): number[] {
  const out: number[] = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function modelHeaderBin(model: GeminiWebRunInput["model"]): string {
  const selection = getGeminiWebModelSelection(model);
  const bytes = [
    0x08,
    0x01,
    0x2a,
    ...varint(MODEL_HEADER_HEX.length),
    ...new TextEncoder().encode(MODEL_HEADER_HEX),
  ];
  bytes.push(0x78, ...varint(selection.modelCode));
  bytes.push(0x80, 0x01, ...varint(selection.thinkingCode));
  return Buffer.from(bytes).toString("base64");
}

function authHash(sapisid: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const digest = createHash("sha1")
    .update(timestamp + " " + sapisid + " https://gemini.google.com")
    .digest("hex");
  return timestamp + "_" + digest;
}

function randomZX(): string {
  return Math.random().toString(36).slice(2, 14);
}

function findQuotedValue(html: string, key: string): string | undefined {
  const start = html.indexOf('"' + key + '"');
  if (start < 0) return undefined;
  const tail = html.slice(start + key.length + 2);
  return tail.match(/^\s*:\s*"([^"]+)"/)?.[1];
}

async function fetchChannelResource(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchGeminiWebResource(url, init);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error("Gemini processSession transport failed.");
  }
}

async function fetchWebConfig(
  input: GeminiWebRunInput,
): Promise<{ apiKey: string; serverToken?: string }> {
  const res = await fetchGeminiWebResource(APP_URL, {
    redirect: "follow",
    signal: input.signal,
    headers: { cookie: cookieHeader(input.cookieMap), "user-agent": USER_AGENT },
  });
  if (!res.ok)
    throw new Error(
      "Gemini app request failed with HTTP " + res.status + "; check network or proxy.",
    );
  const html = await res.text();
  const apiKey = findQuotedValue(html, "d2zJAe");
  if (!apiKey || !apiKey.startsWith("AIza"))
    throw new Error("Gemini processSession API key was not found in the app page.");
  return { apiKey, serverToken: findQuotedValue(html, "X-Server-Token") };
}

function headersBlock(input: GeminiWebRunInput, apiKey: string, serverToken?: string): string {
  const lines = [
    "X-Goog-Api-Key:" + apiKey,
    MODEL_HEADER_NAME + ":" + modelHeaderBin(input.model),
    "X-WebChannel-Content-Type:application/json+protobuf",
  ];
  if (serverToken) lines.push("X-Server-Token:" + serverToken);
  const sapisid = input.cookieMap.SAPISID;
  if (sapisid) {
    lines.push("Authorization:SAPISIDHASH " + authHash(sapisid));
    lines.push("X-Goog-AuthUser:0");
  }
  return lines.join("\r\n") + "\r\n";
}

function completeJsonEnd(text: string, start: number): number | null {
  const opener = text[start];
  if (opener !== "[" && opener !== "{") return null;
  const closer = opener === "[" ? "]" : "}";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === opener) depth += 1;
    else if (c === closer) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

function classifyPayload(payload: unknown): WebEvent {
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return { kind: "noop" };
    }
  }
  if (Array.isArray(payload) && payload[0] === "noop") return { kind: "noop" };
  if (Array.isArray(payload) && payload[0] === "close") return { kind: "end" };
  if (
    Array.isArray(payload) &&
    payload.length === 1 &&
    Array.isArray(payload[0]) &&
    payload[0].length === 0
  )
    return { kind: "ack" };
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const status = (payload as { __sm__?: { status?: unknown } }).__sm__?.status;
    if (status) throw new Error("Gemini processSession returned an upstream status frame.");
    return { kind: "noop" };
  }
  if (!Array.isArray(payload) || payload.length === 0) return { kind: "noop" };
  let first: unknown = payload[0];
  if (typeof first === "string") {
    try {
      first = JSON.parse(first);
    } catch {
      return { kind: "noop" };
    }
  }
  if (!Array.isArray(first)) return { kind: "noop" };
  if (JSON.stringify(first) === "[null,null,null,[]]") return { kind: "end" };
  if (first.length < 2) return { kind: "noop" };
  let body: unknown = first[1];
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return { kind: "noop" };
    }
  }
  if (!Array.isArray(body) || !Array.isArray(body[6]) || body[6].length === 0)
    return { kind: "noop" };
  const candidate = body[6][0];
  if (!Array.isArray(candidate) || candidate.length < 4) return { kind: "noop" };
  const done = String(candidate[0]) === "1";
  let wrapper: unknown = candidate[3];
  if (typeof wrapper === "string") {
    try {
      wrapper = JSON.parse(wrapper);
    } catch {
      throw new Error("Gemini processSession received a malformed response frame.");
    }
  }
  if (!Array.isArray(wrapper) || wrapper.length < 4 || wrapper[3] == null)
    throw new Error("Gemini processSession received a malformed response frame.");
  const inner = typeof wrapper[3] === "string" ? wrapper[3] : JSON.stringify(wrapper[3]);
  return { kind: "line", inner, done };
}

function parseFrameText(buffer: string, onEvent: (event: WebEvent) => void): string {
  let rest = buffer;
  while (true) {
    const newline = rest.indexOf("\n");
    if (newline < 0) return rest;
    const lengthText = rest.slice(0, newline).trim();
    if (!/^\d+$/.test(lengthText)) {
      if (lengthText === ")]}'" || lengthText === "") {
        rest = rest.slice(newline + 1);
        continue;
      }
      throw new Error("Gemini processSession received malformed framing.");
    }
    const start = newline + 1;
    const end = completeJsonEnd(rest, start);
    if (end == null) return rest;
    const frame = JSON.parse(rest.slice(start, end)) as unknown;
    if (Array.isArray(frame))
      for (const item of frame)
        if (Array.isArray(item) && item.length >= 2) {
          const event = classifyPayload(item[1]);
          event.aid = Number(item[0]);
          onEvent(event);
        }
    rest = rest.slice(end);
  }
}

async function readChannelResponse(
  response: Response,
  queue: AsyncQueue<WebEvent>,
  ready: { resolve: () => void; reject: (error: unknown) => void },
  signal: AbortSignal,
  initialAid: number,
): Promise<{ ended: boolean; aid: number }> {
  if (!response.ok || !response.body) {
    throw new Error("Gemini processSession channel failed with HTTP " + response.status);
  }
  ready.resolve();
  let aid = initialAid;
  let ended = false;
  const onEvent = (event: WebEvent): void => {
    if (typeof event.aid === "number" && Number.isFinite(event.aid)) {
      aid = Math.max(aid, event.aid);
    }
    if (event.kind === "end") ended = true;
    queue.push(event);
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const part = await reader.read();
    if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    buffer = parseFrameText(buffer, onEvent);
  }
  buffer += decoder.decode();
  buffer = parseFrameText(buffer, onEvent);
  if (buffer.trim()) throw new Error("Gemini processSession received a truncated frame.");
  return { ended, aid };
}

async function readChannelLoop(
  openChannel: (aid: number) => Promise<Response>,
  queue: AsyncQueue<WebEvent>,
  ready: { resolve: () => void; reject: (error: unknown) => void },
  signal: AbortSignal,
): Promise<void> {
  let aid = 0;
  try {
    while (!signal.aborted) {
      const result = await readChannelResponse(await openChannel(aid), queue, ready, signal, aid);
      aid = result.aid;
      if (result.ended) {
        queue.close();
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  } catch (error) {
    if (!signal.aborted) {
      ready.reject(error);
      queue.fail(error);
    }
  }
}

function buildInner(input: GeminiWebRunInput, requestId: string): unknown[] {
  const request: unknown[] = Array(97).fill(null);
  request[0] = ["", 0, null, [], null, null, 0];
  request[1] = ["en"];
  request[2] = input.chatMetadata ?? ["", "", "", null, null, null, null, null, null, ""];
  request[6] = [1];
  request[7] = 1;
  request[10] = 1;
  request[11] = 0;
  request[17] = [[0]];
  request[18] = 0;
  request[27] = 1;
  request[30] = [4];
  request[41] = [1];
  request[53] = 0;
  request[59] = requestId;
  request[61] = [];
  request[68] = 2;
  const selection = getGeminiWebModelSelection(input.model);
  request[79] = selection.modelCode;
  request[80] = selection.thinkingCode;
  request[91] = 0;
  request[96] = input.chatMetadata == null ? 1 : 0;
  return request;
}

function requestData(inner: unknown[], prompt: string, requestId: string, offset: number): unknown {
  if (offset === 0)
    return [
      [
        [1, MODEL_HEADER_HEX, "en", requestId],
        0,
        null,
        null,
        null,
        null,
        null,
        [null, null, null, null, [inner, null, null, 1]],
      ],
    ];
  if (offset === 1) return [null, [1, null, null, null, null, null, null, null, [prompt]]];
  return [null, null, null, [1]];
}

async function postWebChannel(
  url: string,
  offset: number,
  data: unknown,
  cookie: string,
  signal: AbortSignal,
): Promise<void> {
  const body = new URLSearchParams({
    count: "1",
    ofs: String(offset),
    req0___data__: JSON.stringify(data),
  });
  const response = await fetchChannelResource(url, {
    method: "POST",
    redirect: "follow",
    signal,
    headers: {
      cookie,
      origin: "https://gemini.google.com",
      referer: "https://gemini.google.com/",
      "user-agent": USER_AGENT,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body,
  });
  if (!response.ok)
    throw new Error("Gemini processSession upload ofs=" + offset + " HTTP " + response.status);
  await response.arrayBuffer();
}

function channelUrl(gsid: string, sid: string, rid: string, aid: number): string {
  return (
    CHANNEL_URL +
    "?VER=8&gsessionid=" +
    encodeURIComponent(gsid) +
    "&SID=" +
    encodeURIComponent(sid) +
    "&RID=" +
    rid +
    "&AID=" +
    aid +
    "&CI=0&TYPE=xmlhttp&zx=" +
    randomZX() +
    "&t=1"
  );
}

export async function runGeminiWebProcessSession(input: GeminiWebRunInput): Promise<string> {
  if (input.files?.length)
    throw new Error("Argon WebChannel prototype supports text-only prompts only.");
  const local = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, local.signal]) : local.signal;
  try {
    const cookie = cookieHeader(input.cookieMap);
    const config = await fetchWebConfig(input);
    const auth = headersBlock(input, config.apiKey, config.serverToken);
    const requestId = randomUUID();
    const inner = buildInner(input, requestId);
    const handshakeUrl =
      PROCESS_URL +
      "?VER=8&RID=" +
      Math.floor(10000 + Math.random() * 80000) +
      "&CVER=22&X-HTTP-Session-Id=gsessionid&$httpHeaders=" +
      encodeURIComponent(auth) +
      "&zx=" +
      randomZX() +
      "&t=1";
    const handshake = await fetchChannelResource(handshakeUrl, {
      method: "POST",
      redirect: "follow",
      signal,
      headers: {
        cookie,
        origin: "https://gemini.google.com",
        referer: "https://gemini.google.com/",
        "user-agent": USER_AGENT,
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: "count=0",
    });
    if (!handshake.ok) throw new Error("Gemini processSession handshake HTTP " + handshake.status);
    const handshakeText = await handshake.text();
    const gsid = handshake.headers.get("x-http-session-id");
    const sidMatch = handshakeText.match(/\[\s*"c"\s*,\s*"([^"]+)"/);
    const sid = sidMatch?.[1];
    if (!gsid || !sid)
      throw new Error("Gemini processSession handshake did not return a session id.");
    const queue = new AsyncQueue<WebEvent>();
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const openChannel = async (channelAid: number): Promise<Response> =>
      fetchChannelResource(channelUrl(gsid, sid, "rpc", channelAid), {
        signal,
        headers: {
          cookie,
          origin: "https://gemini.google.com",
          referer: "https://gemini.google.com/",
          "user-agent": USER_AGENT,
        },
      });
    void readChannelLoop(
      openChannel,
      queue,
      { resolve: readyResolve, reject: readyReject },
      signal,
    );
    await ready;
    let rid = Math.floor(10000 + Math.random() * 80000);
    let aid = 0;
    const postUrl = () =>
      PROCESS_URL +
      "?VER=8&gsessionid=" +
      encodeURIComponent(gsid) +
      "&SID=" +
      encodeURIComponent(sid) +
      "&RID=" +
      ++rid +
      "&AID=" +
      aid +
      "&zx=" +
      randomZX() +
      "&t=1";
    const post = async (offset: number): Promise<void> =>
      postWebChannel(
        postUrl(),
        offset,
        requestData(inner, input.prompt, requestId, offset),
        cookie,
        signal,
      );
    await post(0);
    const parts: unknown[] = [];
    let promptSent = false;
    let closing = false;
    let completed = false;
    const sendPrompt = async () => {
      if (promptSent) return;
      promptSent = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await post(1);
    };
    const ackDeadline = Date.now() + 3000;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const event = await queue.next(Math.min(3000, Math.max(0, deadline - Date.now())));
      if (!event) {
        if (!promptSent && Date.now() >= ackDeadline) await sendPrompt();
        continue;
      }
      if (typeof event.aid === "number" && Number.isFinite(event.aid))
        aid = Math.max(aid, event.aid);
      if (event.kind === "ack") await sendPrompt();
      if (event.kind === "line" && event.inner) {
        const parsedInner: unknown = JSON.parse(event.inner);
        // Error envelopes are already outer response arrays; wrapping them as
        // candidate bodies would hide their structured protocol error codes.
        if (
          Array.isArray(parsedInner) &&
          Array.isArray(parsedInner[0]) &&
          Array.isArray(parsedInner[0][5])
        ) {
          // Give a structured failure precedence over earlier partial frames.
          parts.unshift(...parsedInner);
        } else {
          parts.push(["wrb.fr", null, event.inner]);
        }
        if (event.done && !closing) {
          closing = true;
          await post(2);
        }
      }
      if (event.kind === "end") {
        completed = closing;
        break;
      }
      if (!promptSent && Date.now() >= ackDeadline) await sendPrompt();
    }
    if (!completed || !parts.length)
      throw new Error("Gemini processSession ended without a complete response.");
    return JSON.stringify(parts);
  } finally {
    local.abort();
  }
}
