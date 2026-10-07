#!/usr/bin/env node
// Recorded, sanitized ChatGPT DOM and synthetic input; no account or external requests.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Launcher } from "chrome-launcher";
import { connectToChrome } from "../dist/src/browser/chromeLifecycle.js";
import { buildConversationTurnCountExpression } from "../dist/src/browser/conversationTurns.js";
import {
  browserPromptFingerprint,
  readSubmittedPromptFingerprint,
  readUserMessageIds,
} from "../dist/src/browser/promptFingerprint.js";
import {
  readAssistantSnapshot,
  captureAssistantMarkdown,
  buildCompletionVisibilityExpressionForTest,
} from "../dist/src/browser/actions/assistantResponse.js";
import {
  buildChatModeProbeExpressionForTest,
  navigateToPromptReadyWithFallback,
} from "../dist/src/browser/actions/navigation.js";
import { ensureModelSelection } from "../dist/src/browser/actions/modelSelection.js";
import { submitPrompt } from "../dist/src/browser/actions/promptComposer.js";

const root = await mkdtemp(path.join(os.homedir(), "oracle-layout-proof-"));
const chromePath = [
  process.env.CHROME_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));
assert.ok(chromePath, "Set CHROME_PATH to an installed Chromium binary");
const chrome = new Launcher({
  chromePath,
  userDataDir: root,
  handleSIGINT: false,
  chromeFlags: [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
  ],
});
const logger = Object.assign(() => {}, { verbose: false });
let client;
let navigationServer;
try {
  await chrome.launch();
  client = await connectToChrome(chrome.port, logger);
  const { Runtime, Page, Input, Network } = client;
  await Page.enable();
  await Network.enable();
  await Network.setBlockedURLs({ urls: ["*"] });
  const evaluate = async (expression) => {
    const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    assert.equal(
      result.exceptionDetails,
      undefined,
      result.exceptionDetails?.exception?.description,
    );
    return result.result.value;
  };
  const setHtml = async (html) => {
    const { frameTree } = await Page.getFrameTree();
    await Page.setDocumentContent({ frameId: frameTree.frame.id, html });
  };
  const completed = await readFile(
    new URL("../tests/fixtures/chatgpt-dom-2026-09/completed.html", import.meta.url),
    "utf8",
  );
  for (const omitted of [null, "data-content-search-unit-key", "data-chatgpt-search-unit-key"]) {
    await setHtml(completed);
    if (omitted)
      await evaluate(
        `document.querySelectorAll('[${omitted}]').forEach(node => node.removeAttribute('${omitted}'))`,
      );
    assert.equal(await evaluate(buildConversationTurnCountExpression()), 1);
    assert.equal(new Set(await readUserMessageIds(Runtime)).size, 1);
    assert.equal(
      await readSubmittedPromptFingerprint(Runtime, []),
      browserPromptFingerprint("Reply with exactly: OK", "11111111-1111-4111-8111-111111111111"),
    );
    const snapshot = await readAssistantSnapshot(Runtime);
    assert.equal(snapshot.text.trim(), "OK");
    assert.equal(snapshot.messageId, "22222222-2222-4222-8222-222222222222");
    assert.equal(await evaluate(buildCompletionVisibilityExpressionForTest(snapshot, 0)), true);
    await evaluate(
      `Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }); document.querySelector('.turn-action-controls button[aria-label="Copy"]').onclick = () => navigator.clipboard.writeText('**OK**')`,
    );
    assert.equal(await captureAssistantMarkdown(Runtime, snapshot, logger), "**OK**");
    await evaluate(
      `document.querySelectorAll('.turn-action-controls').forEach(n => n.remove()); document.querySelector('[data-user-message-bubble]').insertAdjacentHTML('beforeend', '<button aria-label="Copy">Copy</button>'); document.querySelector('[data-markdown-text-style="assistant-message"]').insertAdjacentHTML('beforeend', '<pre><button aria-label="Copy">Copy</button></pre>'); document.body.insertAdjacentHTML('afterbegin', '<button aria-label="Share">Share</button>')`,
    );
    assert.equal(await evaluate(buildCompletionVisibilityExpressionForTest(snapshot, 0)), false);
  }
  await setHtml(
    await readFile(
      new URL("../tests/fixtures/chatgpt-dom-2026-09/streaming.html", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(await evaluate(buildCompletionVisibilityExpressionForTest({}, 0)), false);

  const modes =
    '<div role="group" aria-label="Composer mode"><button aria-pressed="true">Chat</button><button aria-pressed="false">Work</button></div>';
  for (const work of [true, false]) {
    await setHtml(
      `${modes}<nav><a href="/c/synthetic-thread"><span data-thread-title>Work</span>${work ? "<span>Work</span>" : ""}</a></nav>`,
    );
    const expression = buildChatModeProbeExpressionForTest();
    const verdict = await evaluate(
      `((location) => ${expression})({ pathname: '/c/synthetic-thread', origin: 'https://chatgpt.com' })`,
    );
    assert.equal(verdict.status, work ? "work-conversation" : "chat-conversation");
  }

  await setHtml(
    '<button id="picker" aria-label="Select ChatGPT model" aria-haspopup="menu">Medium</button><div role="menu" aria-labelledby="picker"><div data-model-picker-view="simple"><button role="menuitem" data-model-picker-view-toggle="true">Select model</button></div><div id="models" data-model-picker-view="models" style="display:none"><button role="menuitemradio" aria-checked="true">Latest</button><button role="menuitemradio" aria-checked="false">GPT-5.5</button></div></div>',
  );
  await evaluate(
    `document.querySelector('[data-model-picker-view-toggle]').onclick = () => { document.querySelector('#models').style.display = ''; }; document.querySelectorAll('[role="menuitemradio"]').forEach(button => button.onclick = () => { document.querySelectorAll('[role="menuitemradio"]').forEach(row => row.setAttribute('aria-checked', String(row === button))); document.querySelector('#picker').textContent = button.textContent; })`,
  );
  const model = await ensureModelSelection(Runtime, "GPT-5.5", logger);
  assert.equal(model.status, "switched");
  assert.equal(model.resolvedLabel, "GPT-5.5");

  for (const corrupt of [null, "content", "blank-lines"]) {
    await setHtml(
      '<form data-chatgpt-composer><div contenteditable="true" role="textbox" style="width:600px;min-height:80px;white-space:pre-wrap"></div><button type="submit" aria-label="Send">Send</button></form><main></main>',
    );
    await evaluate(
      `(() => { window.submissions = []; const editor = document.querySelector('[contenteditable]'); editor.addEventListener('paste', event => { event.preventDefault(); const parsed = new DOMParser().parseFromString(event.clipboardData.getData('text/html'), 'text/html'); editor.append(...parsed.querySelector('p').childNodes); ${corrupt === "content" ? "editor.textContent = editor.textContent.replace('marker', 'broken');" : corrupt === "blank-lines" ? "editor.textContent = editor.innerText.replace(/\\n\\n/, '\\n');" : ""} }); document.querySelector('form').onsubmit = event => { event.preventDefault(); submissions.push(editor.innerText); const wrapper = document.createElement('div'); wrapper.setAttribute('data-turn-key','synthetic-user'); const user = document.createElement('div'); user.setAttribute('data-content-search-unit-key','synthetic:0:user'); user.textContent = editor.innerText; wrapper.append(user); document.querySelector('main').append(wrapper); editor.textContent = ''; }; })()`,
    );
    const prompt = "Keep every line.\n\n  marker: " + "x".repeat(3990) + "🙂\n  end-marker";
    const run = submitPrompt(
      { runtime: Runtime, input: Input, page: Page, baselineTurns: 0 },
      prompt,
      logger,
    );
    if (corrupt) {
      await assert.rejects(run, (error) => error.details?.code === "prompt-paste-incomplete");
      assert.deepEqual(await evaluate("submissions"), []);
    } else {
      await run;
      assert.deepEqual(await evaluate("submissions"), [prompt]);
    }
  }
  // Exercise dismissal through real navigation, including an inaccessible-project fallback.
  navigationServer = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    const missing = request.url === "/missing";
    response.end(`<!doctype html><html><body>
      <nav><a href="/wrong">Close test task</a><a href="/wrong">Return policy draft</a></nav>
      <div role="dialog" style="opacity:0"><button onclick="window.hiddenClicks++">Got it</button></div>
      <dialog open><button aria-label="Close" onclick="window.dialogClicks++;this.closest('dialog').close()">Close</button></dialog>
      ${missing ? "<p>Project unavailable</p>" : '<textarea id="prompt-textarea" placeholder="Ask anything"></textarea>'}
      <script>window.hiddenClicks=0;window.dialogClicks=0;</script>
    </body></html>`);
  });
  await new Promise((resolve) => navigationServer.listen(0, "127.0.0.1", resolve));
  const navigationOrigin = `http://127.0.0.1:${navigationServer.address().port}`;
  await Network.setBlockedURLs({ urls: [] });
  for (const missing of [false, true]) {
    const target = `${navigationOrigin}/${missing ? "missing" : "project"}`;
    const fallback = `${navigationOrigin}/`;
    const result = await navigateToPromptReadyWithFallback(Page, Runtime, {
      url: target,
      fallbackUrl: fallback,
      timeoutMs: 200,
      fallbackTimeoutMs: 2_000,
      headless: true,
      logger,
    });
    assert.equal(result.usedFallback, missing);
    assert.deepEqual(
      await evaluate(
        "({url:location.href,hidden:window.hiddenClicks,visible:window.dialogClicks})",
      ),
      {
        url: missing ? fallback : target,
        hidden: 0,
        visible: 1,
      },
    );
  }
  console.log(
    "Navigation proof passed: sidebar Close/Return links untouched, hidden dialog untouched, visible dialog dismissed, missing project recovered through homepage fallback.",
  );
  console.log(
    "ChatGPT layout proof passed: recorded completed/streaming DOM, both role markers, prompt identity, scoped Markdown copy, Work safety, model switching, intact multiline paste and fail-closed corruption.",
  );
} finally {
  await new Promise((resolve) => (navigationServer ? navigationServer.close(resolve) : resolve()));
  await client?.close().catch(() => {});
  try {
    await chrome.kill();
  } catch {}
  await rm(root, { recursive: true, force: true });
}
