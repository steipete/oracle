#!/usr/bin/env node
// Serve renderer fixtures for the real compiled Retry collector in an existing browser.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  buildAssistantSnapshotExpressionForTest,
  readAssistantSnapshot,
  throwIfAssistantUiError,
} from "../dist/src/browser/actions/assistantResponse.js";

const cases = [
  { name: "new failed turn", expected: true },
  { name: "older failed turn", minTurn: 2, expected: false },
  { name: "hidden Retry", retryStyle: "display:none", expected: false },
  { name: "transparent Retry", retryStyle: "opacity:0", expected: false },
  { name: "no Retry", retry: false, expected: false },
  { name: "unrelated page error", outside: true, text: "A normal answer.", expected: false },
  {
    name: "ordinary Retry advice",
    text: "Retry the calculation with another input.",
    expected: false,
  },
  { name: "generation still active", stop: true, expected: false },
  { name: "assistant still busy", busy: true, expected: false },
];
const probes = cases.map((test) => ({
  ...test,
  expression: buildAssistantSnapshotExpressionForTest(test.minTurn ?? 1),
}));
const html = `<!doctype html><meta charset="utf-8"><title>Oracle Retry collector proof</title>
<style>body{font:18px system-ui;max-width:900px;margin:40px auto}button{padding:10px}iframe{width:100%;height:180px;border:1px solid #888}pre{white-space:pre-wrap}</style>
<h1>Oracle Retry collector proof</h1><p>Controlled fixtures using the compiled production collector. No provider requests.</p>
<button id="run">Run proof</button><pre id="results">Ready.</pre><iframe title="Synthetic assistant turn"></iframe>
<script type="module">
const cases = ${JSON.stringify(probes).replaceAll("<", "\\u003c")};
const frame = document.querySelector('iframe');
document.querySelector('#run').onclick = async () => {
  const results = [];
  for (const test of cases) {
    const doc = frame.contentDocument;
    doc.open();
    doc.write('<!doctype html><main><article data-testid="conversation-turn-0" data-turn="user">Synthetic prompt</article><article data-testid="conversation-turn-1" data-turn="assistant"><div data-message-author-role="assistant" data-message-id="synthetic-retry"><div class="markdown"></div></div></article></main><form></form>');
    doc.close();
    const turn = doc.querySelector('[data-turn="assistant"]');
    turn.querySelector('.markdown').textContent = test.text ?? 'Something went wrong while generating the response.';
    if (test.retry !== false) {
      const button = doc.createElement('button'); button.textContent = 'Retry';
      button.style.cssText = test.retryStyle ?? ''; turn.append(button);
    }
    if (test.outside) { const aside=doc.createElement('aside'); aside.textContent='Something went wrong. Retry'; doc.body.append(aside); }
    if (test.stop) { const button=doc.createElement('button'); button.dataset.testid='stop-button'; button.textContent='Stop'; doc.querySelector('form').append(button); }
    if (test.busy) { const busy=doc.createElement('div'); busy.setAttribute('aria-busy','true'); busy.textContent='Working'; turn.append(busy); }
    let clicks=0; doc.addEventListener('click',()=>clicks++);
    const snapshot = frame.contentWindow.eval(test.expression);
    const probe = await fetch('/probe', {method:'POST',body:JSON.stringify({snapshot,minTurn:test.minTurn ?? 1})});
    const {detected, code} = await probe.json();
    results.push({case:test.name, detected, expected:test.expected, code, clicks, pass:detected===test.expected && clicks===0 && (!detected || code==='chatgpt-ui-warning')});
  }
  document.querySelector('#results').textContent = JSON.stringify(results,null,2);
  await fetch('/result',{method:'POST',body:JSON.stringify(results)});
};
</script>`;
const server = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/probe") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { snapshot, minTurn } = JSON.parse(body);
    // The browser supplies the real evaluated DOM payload; the production reader owns filtering.
    const accepted = await readAssistantSnapshot(
      { evaluate: async () => ({ result: { value: snapshot } }) },
      minTurn,
    );
    let code;
    try {
      throwIfAssistantUiError(accepted);
    } catch (error) {
      assert.equal(error.category, "browser-automation");
      assert.equal(error.details.stage, "assistant-ui-error");
      code = error.details.code;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ detected: accepted?.uiError === "temporary_unavailable", code }));
    return;
  }
  if (request.method === "POST" && request.url === "/result") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const results = JSON.parse(body);
    console.log(JSON.stringify(results, null, 2));
    response.end("Recorded");
    try {
      assert.equal(results.length, cases.length);
      assert.ok(
        results.every((result) => result.pass),
        "Renderer proof failed",
      );
      console.log("PASS: Retry renderer fixtures; zero Retry clicks.");
    } catch (error) {
      process.exitCode = 1;
      console.error(error.message);
    }
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});
server.listen(0, "127.0.0.1", () => {
  console.log(`Open http://127.0.0.1:${server.address().port} in a browser and choose Run proof.`);
});
