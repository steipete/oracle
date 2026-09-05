#!/usr/bin/env node
// Real Chrome regression proof. No ChatGPT account, cookies, or network requests.
// An optional directory argument retains the three public fixtures for manual testing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Launcher } from "chrome-launcher";
import CDP from "chrome-remote-interface";
import {
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
} from "../dist/src/browser/actions/attachments.js";
import { uploadAttachmentViaDataTransfer } from "../dist/src/browser/actions/remoteFileTransfer.js";
import { buildAttachmentEvidenceExpression } from "../dist/src/browser/actions/attachmentEvidence.js";
import {
  submitPrompt,
  buildAttachmentReadyExpressionForTest,
} from "../dist/src/browser/actions/promptComposer.js";

// Snap Chromium has a private /tmp. Keep disk-backed uploads in its allowed home tree.
const root = await mkdtemp(path.join(os.homedir(), "oracle-attachment-proof-"));
const fixtures = process.argv[2] ? path.resolve(process.argv[2]) : root;
const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].find((candidate) => candidate && existsSync(candidate));
assert.ok(chromePath, "Set CHROME_PATH to an installed Chrome/Chromium binary");
const chrome = new Launcher({
  chromePath,
  chromeFlags: [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
  userDataDir: path.join(root, "chrome"),
  handleSIGINT: false,
});
let client;
try {
  await mkdir(path.join(root, "chrome"));
  await mkdir(fixtures, { recursive: true });
  await chrome.launch();
  client = await CDP({ host: "127.0.0.1", port: chrome.port });
  const { Runtime, DOM, Input, Page } = client;
  await Promise.all([Page.enable(), DOM.enable()]);
  const evaluate = async (expression) => {
    const response = await Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(
      response.exceptionDetails,
      undefined,
      response.exceptionDetails?.exception?.description,
    );
    return response.result.value;
  };
  const jpeg = await evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1100; canvas.height = 100;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1100, 100);
    ctx.fillStyle = 'black'; ctx.font = '30px monospace'; ctx.fillText('test-token-not-real-jpg-000', 20, 60);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  })()`);
  const names = ["case418.md", "case418.jpg", "third418.txt"];
  await writeFile(path.join(fixtures, names[0]), "test-token-not-real-md-000\n");
  await writeFile(path.join(fixtures, names[1]), Buffer.from(jpeg, "base64"));
  await writeFile(path.join(fixtures, names[2]), "test-token-not-real-txt-000\n");
  const reset = async (offscreen) =>
    evaluate(`(() => {
    document.body.innerHTML = '<aside><button>Inspect Fixtures 3 Files</button></aside><main><section><form data-testid="composer"><textarea id="prompt-textarea" name="prompt-textarea" style="width:400px;height:100px"></textarea><input id="upload" type="file"><div id="chips"></div><div id="spacer"></div><button type="button" data-testid="send-button">Send</button></form></section></main><div id="turns"></div>';
    window.proof = { assignments: [], clicks: 0, enters: 0, commits: 0, scrolls: 0, trusted: [] };
    window.proofFiles = [];
    const input = document.querySelector('#upload');
    input.addEventListener('change', () => {
      for (const file of Array.from(input.files || [])) {
        window.proofFiles.push(file); window.proof.assignments.push(file.name);
        const chip = document.createElement('div'); chip.dataset.testid = 'attachment-chip';
        if (file.name.endsWith('.jpg')) { const image = document.createElement('img'); image.alt = 'Image preview'; image.width = 100; image.src = URL.createObjectURL(file); chip.append(image); }
        else { const label = document.createElement('span'); label.textContent = file.name; chip.append(label); }
        const remove = document.createElement('button'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove attachment'); remove.textContent = '×'; remove.onclick = () => chip.remove(); chip.append(remove);
        document.querySelector('#chips').append(chip);
      }
      // This is the regressed UI shape: consume the FileList and omit the image filename.
      input.value = '';
    });
    const button = document.querySelector('[data-testid="send-button"]');
    const nativeScroll = button.scrollIntoView.bind(button);
    button.scrollIntoView = options => { window.proof.scrolls++; nativeScroll(options); };
    if (${offscreen}) document.querySelector('#spacer').style.height = '1600px';
    const commit = () => {
      const editor = document.querySelector('#prompt-textarea'); const prompt = editor.value;
      setTimeout(() => {
        const article = document.createElement('article'); article.dataset.testid = 'conversation-turn-' + (++window.proof.commits); article.dataset.messageAuthorRole = 'user';
        const text = document.createElement('p'); text.textContent = prompt; article.append(text);
        for (const file of window.proofFiles) { const tile = document.createElement('div'); tile.dataset.testid = 'attachment-chip'; tile.textContent = file.name; article.append(tile); }
        document.querySelector('#turns').append(article); editor.value = ''; document.querySelector('#chips').replaceChildren();
      }, 2500);
    };
    button.addEventListener('click', event => { window.proof.clicks++; window.proof.trusted.push(event.isTrusted); commit(); });
    document.querySelector('#prompt-textarea').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); window.proof.enters++; commit(); } });
  })()`);
  const logger = Object.assign(() => {}, { verbose: false });
  for (const mode of ["local", "remote"]) {
    await reset(false);
    await assert.rejects(
      waitForAttachmentCompletion(Runtime, 500, names, logger),
      /did not finish uploading/,
    );
    for (const [index, name] of names.entries()) {
      const attachment = { path: path.join(fixtures, name), displayPath: name };
      if (mode === "local")
        await uploadAttachmentFile(
          { runtime: Runtime, dom: DOM, input: Input },
          attachment,
          logger,
          { expectedCount: index + 1 },
        );
      else
        await uploadAttachmentViaDataTransfer({ runtime: Runtime, dom: DOM }, attachment, logger);
    }
    if (mode === "local") {
      // Rechecking an already queued filename-less image must not upload it twice.
      await uploadAttachmentFile(
        { runtime: Runtime, dom: DOM, input: Input },
        { path: path.join(fixtures, names[1]), displayPath: names[1] },
        logger,
        { expectedCount: 2 },
      );
    }
    assert.deepEqual(await evaluate(buildAttachmentEvidenceExpression(names)), [true, true, true]);
    assert.equal(
      await evaluate(
        'Array.from(document.querySelectorAll("input[type=file]")).some(input => input.files.length > 0)',
      ),
      false,
    );
    assert.equal(
      await evaluate('document.querySelector("#chips").innerText.includes("case418.jpg")'),
      false,
    );
    await evaluate(`(() => {
      const progress = document.createElement('div'); progress.id = 'upload-progress';
      progress.dataset.state = 'uploading'; progress.textContent = 'Uploading 50%';
      const editor = document.createElement('div'); editor.contentEditable = 'true';
      const widget = document.createElement('div'); widget.contentEditable = 'false';
      widget.append(progress); editor.append(widget); document.querySelector('form').append(editor);
    })()`);
    await assert.rejects(
      waitForAttachmentCompletion(Runtime, 4500, names, logger),
      /did not finish uploading/,
    );
    assert.equal(await evaluate(buildAttachmentReadyExpressionForTest(names)), false);
    await assert.rejects(
      submitPrompt(
        {
          runtime: Runtime,
          input: Input,
          page: Page,
          attachmentNames: names,
          attachmentTimeoutMs: 1000,
          baselineTurns: 0,
        },
        "Do not send while a file is still uploading.",
        logger,
      ),
      /Attachments never reached a clickable send button/,
    );
    assert.equal(await evaluate("window.proof.clicks + window.proof.enters"), 0);
    await evaluate('document.querySelector("#upload-progress").style.opacity = "0"');
    assert.equal(await evaluate(buildAttachmentReadyExpressionForTest(names)), true);
    await evaluate('document.querySelector("#upload-progress").style.opacity = "1"');
    assert.equal(await evaluate(buildAttachmentReadyExpressionForTest(names)), false);
    await evaluate(`(() => {
      document.querySelector('#upload-progress').remove();
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'upload-progress'; svg.setAttribute('role', 'progressbar');
      svg.setAttribute('aria-valuenow', '50'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
      document.querySelector('form').append(svg);
    })()`);
    assert.equal(await evaluate(buildAttachmentReadyExpressionForTest(names)), false);
    await evaluate(
      'document.querySelector("#upload-progress").setAttribute("aria-valuenow", "100")',
    );
    assert.equal(await evaluate(buildAttachmentReadyExpressionForTest(names)), true);
    await evaluate(`(() => {
      document.querySelector('#upload-progress').remove();
      const progress = document.createElement('progress'); progress.id = 'upload-progress';
      progress.value = 50; progress.max = 100; document.querySelector('form').append(progress);
    })()`);
    assert.equal(await evaluate(buildAttachmentReadyExpressionForTest(names)), false);
    await evaluate('document.querySelector("#upload-progress").value = 100');
    assert.equal(await evaluate(buildAttachmentReadyExpressionForTest(names)), true);
    await evaluate(`(() => {
      document.querySelector('#upload-progress').remove();
      const unrelated = document.createElement('div'); unrelated.dataset.state = 'uploading';
      unrelated.textContent = 'Uploading another conversation'; document.querySelector('aside').append(unrelated);
    })()`);
    await waitForAttachmentCompletion(Runtime, 4000, names, logger);
    assert.equal(await evaluate(buildAttachmentReadyExpressionForTest(names)), true);
    const bytes = await evaluate(
      "(async () => Promise.all(window.proofFiles.map(async file => ({ name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) }))))()",
    );
    const payloads = [];
    for (const file of bytes) {
      const expected = await readFile(path.join(fixtures, file.name));
      assert.deepEqual(Buffer.from(file.bytes), expected);
      payloads.push({
        name: file.name,
        bytes: expected.length,
        sha256: createHash("sha256").update(expected).digest("hex"),
      });
    }
    const events = [];
    const runtime = {
      evaluate: (args) => {
        if (args.expression.includes("button.scrollIntoView")) events.push("measure");
        return Runtime.evaluate(args);
      },
    };
    const input = {
      insertText: (args) => Input.insertText(args),
      dispatchKeyEvent: (args) => {
        events.push("key:" + args.type);
        return Input.dispatchKeyEvent(args);
      },
      dispatchMouseEvent: (args) => {
        events.push(args.type);
        return Input.dispatchMouseEvent(args);
      },
    };
    const page = {
      bringToFront: async () => {
        events.push("activate");
        await Page.bringToFront();
      },
    };
    const prompt =
      "Read the three attached public synthetic fixtures. Return each test-token-not-real marker.";
    const started = Date.now();
    const turns = await submitPrompt(
      { runtime, input, page, attachmentNames: names, baselineTurns: 0 },
      prompt,
      logger,
    );
    const elapsedMs = Date.now() - started;
    assert.equal(turns, 1);
    assert.equal(
      await waitForUserTurnAttachments(Runtime, names, 2000, logger, {
        minTurnIndex: 0,
        expectedPrompt: prompt,
      }),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    const state = await evaluate("window.proof");
    assert.deepEqual(state.assignments, names);
    assert.equal(state.clicks, 1);
    assert.equal(state.enters, 0);
    assert.equal(state.commits, 1);
    assert.equal(state.scrolls, 0);
    assert.deepEqual(state.trusted, [true]);
    assert.deepEqual(events, [
      "activate",
      "measure",
      "measure",
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    assert.deepEqual(await evaluate(buildAttachmentEvidenceExpression(names)), [
      false,
      false,
      false,
    ]);
    console.log(
      JSON.stringify({
        mode,
        uploadProgressBlocksSend: true,
        filenameLessImage: true,
        elapsedMs,
        events,
        payloads,
        ...state,
      }),
    );
  }
  await reset(true);
  const turns = await submitPrompt(
    { runtime: Runtime, input: Input, page: Page, baselineTurns: 0 },
    "Offscreen staged prompt: scroll, remeasure, then send once.",
    logger,
  );
  const offscreen = await evaluate("window.proof");
  assert.equal(turns, 1);
  assert.equal(offscreen.scrolls, 1);
  assert.equal(offscreen.clicks, 1);
  assert.equal(offscreen.enters, 0);
  assert.equal(offscreen.commits, 1);
  console.log(JSON.stringify({ mode: "offscreen-recovery", ...offscreen }));
  console.log(
    "PROOF_OK local and remote three-file sends, filename-less images, delayed commitment, and offscreen recovery",
  );
} finally {
  await client?.close();
  await chrome.kill();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
