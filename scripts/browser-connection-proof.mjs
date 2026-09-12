#!/usr/bin/env node
// Real CRI WebSockets and compiled transport in a child process; no Chrome/account required.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Server: WebSocketServer } = createRequire(require.resolve("chrome-remote-interface"))("ws");
const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });
let handshakes = 0;
let evaluations = 0;
server.on("upgrade", (req, socket, head) => {
  handshakes++;
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (raw) => {
      const { id, method, params, sessionId } = JSON.parse(String(raw));
      let result = {};
      if (method === "Target.getTargets")
        result = { targetInfos: [{ targetId: "saved", type: "page" }] };
      if (method === "Target.attachToTarget") result = { sessionId: params.targetId };
      if (method === "Runtime.evaluate") {
        evaluations++;
        setTimeout(
          () =>
            ws.send(
              JSON.stringify({
                id,
                sessionId,
                result: { result: { type: "string", value: "delayed-response" } },
              }),
            ),
          200,
        );
        return;
      }
      ws.send(JSON.stringify({ id, sessionId, result }));
    });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const moduleUrl = new URL("../dist/src/browser/chromeLifecycle.js", import.meta.url).href;
const source = `
import assert from 'node:assert/strict';
const {listRemoteChromeTargets,connectToRemoteChromeTarget}=await import(${JSON.stringify(moduleUrl)});
const endpoint={host:'127.0.0.1',port:${port},browserWSEndpoint:'ws://127.0.0.1:${port}/devtools/browser/proof'};
for(let n=0;n<3;n++) {
  await listRemoteChromeTargets(endpoint);
  const page=await connectToRemoteChromeTarget(endpoint.host,endpoint.port,()=>{},{...endpoint,targetId:'saved'});
  const result=await page.client.Runtime.evaluate({expression:'synthetic delayed response'});
  assert.equal(result.result.value,'delayed-response');
  await page.close();
}
console.log('completed three discoveries, page sessions, and delayed evaluations');
// No process.exit(): an idle retained browser socket must permit natural exit.
`;
const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (data) => {
  output += data;
});
child.stderr.on("data", (data) => {
  output += data;
});
const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
try {
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, output);
  assert.equal(evaluations, 3, "active socket must keep delayed commands alive");
  assert.equal(handshakes, 1, "all steps must use one browser handshake");
  console.log(
    "PASS: one WebSocket handshake, three complete multi-step operations, natural idle process exit",
  );
} finally {
  clearTimeout(timeout);
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  await new Promise((resolve) => server.close(resolve));
}
