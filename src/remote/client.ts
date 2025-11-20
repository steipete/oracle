import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { BrowserRunOptions } from '../browserMode.js';
import type { BrowserRunResult } from '../browserMode.js';
import type { BrowserAttachment } from '../browser/types.js';
import type { RemoteRunPayload, RemoteRunEvent, RemoteAttachmentPayload } from './types.js';

interface RemoteExecutorOptions {
  host: string;
  token?: string;
}

export function createRemoteBrowserExecutor({ host, token }: RemoteExecutorOptions) {
  // Return a drop-in replacement for runBrowserMode so the browser session runner can stay unchanged.
  return async function remoteBrowserExecutor(options: BrowserRunOptions): Promise<BrowserRunResult> {
    const payload: RemoteRunPayload = {
      prompt: options.prompt,
      attachments: await serializeAttachments(options.attachments ?? []),
      browserConfig: options.config ?? {},
      options: {
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        verbose: options.verbose,
      },
    };

    const body = Buffer.from(JSON.stringify(payload));
    const { hostname, port } = parseHost(host);

    return new Promise<BrowserRunResult>((resolve, reject) => {
      const req = http.request(
        {
          hostname,
          port,
          path: '/runs',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            collectError(res)
              .then((message) => reject(new Error(message)))
              .catch(reject);
            return;
          }
          res.setEncoding('utf8');
          let buffer = '';
          let resolved: BrowserRunResult | null = null;
          res.on('data', (chunk: string) => {
            buffer += chunk;
            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex !== -1) {
              const line = buffer.slice(0, newlineIndex).trim();
              buffer = buffer.slice(newlineIndex + 1);
              if (line.length > 0) {
                handleEvent(line, options, (result) => {
                  resolved = result;
                }, reject);
              }
              newlineIndex = buffer.indexOf('\n');
            }
          });
          res.on('end', () => {
            if (resolved) {
              resolve(resolved);
              return;
            }
            reject(new Error('Remote browser run completed without a result.'));
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };
}

async function serializeAttachments(attachments: BrowserAttachment[]): Promise<RemoteAttachmentPayload[]> {
  const serialized: RemoteAttachmentPayload[] = [];
  for (const attachment of attachments) {
    // Read the local file upfront so the remote host never touches the caller's filesystem.
    const content = await readFile(attachment.path);
    serialized.push({
      fileName: path.basename(attachment.path),
      displayPath: attachment.displayPath,
      sizeBytes: attachment.sizeBytes,
      contentBase64: content.toString('base64'),
    });
  }
  return serialized;
}

function parseHost(input: string): { hostname: string; port: number } {
  const [hostname, portStr] = input.split(':');
  const port = Number.parseInt(portStr ?? '', 10);
  if (!hostname || Number.isNaN(port)) {
    throw new Error(`Invalid remote host: ${input}`);
  }
  return { hostname, port };
}

function handleEvent(
  line: string,
  options: BrowserRunOptions,
  onResult: (result: BrowserRunResult) => void,
  onError: (error: Error) => void,
) {
  let event: RemoteRunEvent;
  try {
    event = JSON.parse(line) as RemoteRunEvent;
  } catch (error) {
    onError(new Error(`Failed to parse remote event: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  if (event.type === 'log') {
    options.log?.(event.message);
    return;
  }
  if (event.type === 'error') {
    onError(new Error(event.message));
    return;
  }
  if (event.type === 'result') {
    onResult(event.result);
  }
}

function collectError(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed.error ?? `Remote host responded with status ${res.statusCode}`);
      } catch {
        resolve(raw || `Remote host responded with status ${res.statusCode}`);
      }
    });
    res.on('error', reject);
  });
}
