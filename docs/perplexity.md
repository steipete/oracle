# Perplexity Integration

Oracle drives Perplexity through **browser automation only** (`--engine browser`), using your
signed-in Perplexity session in the persistent Oracle Chrome profile. There is no Perplexity API
mode: bare `perplexity` model ids are rejected by `--engine api` with a pointer to this page.

If you want Perplexity over an API instead, use the Sonar models through OpenRouter — those are
ordinary provider-qualified ids and need no browser (see [openrouter.md](openrouter.md)):

```bash
export OPENROUTER_API_KEY="sk-or-..."
oracle --engine api --model perplexity/sonar-pro --prompt "..."
```

## Models

| Model id              | Perplexity mode |
| --------------------- | --------------- |
| `perplexity`          | Search          |
| `perplexity-research` | Deep research   |

`pplx`, `perplexity-search`, and `perplexity-deep-research` are accepted aliases.

## Usage

```bash
# Quick search-mode consult
oracle --engine browser --model perplexity --prompt "What are the current Node.js LTS lines?"

# Deep research (slower; minutes rather than seconds)
oracle --engine browser --model perplexity-research \
  --prompt "Compare Bun and Node.js for production HTTP servers."
```

## Image generation

Perplexity generates images inline — describe the image in the prompt and it detects the intent;
there is no separate mode or button. `--generate-image` (or `--output`) writes the first generated
image to disk, and generated images are also returned in `generatedImages`.

```bash
oracle --engine browser --model perplexity \
  --prompt "Generate an image of a blue ceramic teapot on a wooden table." \
  --generate-image teapot.png
```

## Files

`--file` works as it does elsewhere. Text files are pasted inline into the prompt;
media, PDFs and archives are uploaded to the composer. `--browser-attachments always`
forces a real upload for text files too.

```bash
# Source files, pasted inline
oracle --engine browser --model perplexity -p "Review this" --file "src/**/*.ts"

# Images or PDFs, uploaded
oracle --engine browser --model perplexity -p "Describe this" --file diagram.png
```

Perplexity may transcode an upload (a `.png` can arrive as `.jpg`, recompressed), so
the confirmation matches the file name stem rather than the full basename.

## Prerequisites

- Chrome installed.
- Signed into `perplexity.ai` in the Oracle browser profile (`~/.oracle/browser-profile`).
  Sign in once with `--browser-manual-login`; the session persists across runs.

## Notes

- Oracle reuses an already-running Chrome on the profile when its DevTools port is reachable, and
  launches one otherwise. Only one Chrome may hold the profile at a time — a separately launched
  Chrome on the same `--user-data-dir` will block Oracle's launch.
- Sources are collected from both the inline citations in the answer and the sources list, then
  de-duplicated by URL and appended to `answerMarkdown` under a `## Sources` heading. The
  plain-text answer stays clean, so use `--render` to see them in the terminal.
- `--browser-model-strategy` is ignored for Perplexity runs; the mode is set from the model id.
- `--browser-follow-up` works: each follow-up runs in the same conversation and the result is
  returned as a multi-turn transcript. Attachments are uploaded once, on the first turn only.
- `--remote-host` cannot run Perplexity. The remote browser service drives ChatGPT automation
  only, so Perplexity runs are rejected up front rather than silently answered by ChatGPT.
- Perplexity's cookie consent dialog is dismissed automatically ("Only necessary") when present.

## Implementation details

- `src/browser/providers/perplexityDomProvider.ts` — the `ProviderDomAdapter`: selector table, mode
  selection, prompt entry, completion polling, and source extraction.
- `src/perplexity-web/` — `createPerplexityWebExecutor`, a drop-in for `runBrowserMode` selected in
  `bin/oracle-cli.ts` when the model starts with `perplexity`.
- `src/browser/webSessionManager.ts` — shared Chrome/CDP session handling, also used by Gemini web.

Several behaviours are load-bearing and worth preserving if the selectors are ever refreshed:

1. **The completion check must be scoped to the current turn.** The previous answer's `Helpful`
   footer stays in the DOM, so a page-wide check reports "done" immediately.
2. **`button[aria-label="Stop"]` disappears before the text finishes rendering.** Completion also
   requires the answer length to hold steady across consecutive polls.
3. **The sources list populates after the answer text settles.** A Deep research answer can finish
   with 3 inline citations and fill in ~30 more a beat later, so source extraction re-reads until
   the set stops growing rather than trusting one immediate read.
4. **An image answer renders no `.prose` turn at all**, so completion is keyed on a settled image
   count instead. Keying only on prose makes image prompts hang until the timeout.
5. **Uploads must go through the file chooser.** Setting `input.files` does not register:
   the composer mounts more than one file input depending on UI state and Perplexity's
   uploader ignores the element's `files` list. Attachments are delivered by intercepting
   the chooser (`Page.setInterceptFileChooserDialog`) and answering it with
   `DOM.setFileInputFiles({ backendNodeId })`.
6. **Clicking Submit can silently no-op** while the composer settles after attachments are
   added, so the send is verified and retried with a real Enter keypress.
7. **The mode menu is a Radix popup that ignores synthetic `element.click()`.** It is opened with
   real CDP `Input` mouse events, and the trigger is scoped to
   `[data-testid="ask-input-mode-toggle-width-wrapper"]` because the page renders several other
   menu triggers ("Filter projects", "Apps and more", "Model") ahead of it in document order.

Likewise, the composer is a rich-text editor that ignores `document.execCommand("insertText")`;
prompts are entered with CDP `Input.insertText`.
