# Bug: ChatGPT Browser Mode Fails With "No ChatGPT Cookies Were Applied"

Date: 2026-04-30
Environment: Linux, Chromium profile at `/home/derekszen/.config/chromium/Default/Cookies`
Branch observed: `update-gpt-5-5-defaults`

## Summary

Browser-mode ChatGPT runs fail immediately with:

```text
ERROR: No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode.
Make sure ChatGPT is signed in in the selected profile, use --browser-manual-login / inline cookies,
or retry with --browser-cookie-wait 5s if Keychain prompts are slow.
```

This happens even when an explicit Chromium cookie DB path is supplied and the cookie DB exists.

## Repro

From another repo, using `npx -y @steipete/oracle`:

```bash
npm_config_registry=https://registry.npmmirror.com \
npx -y @steipete/oracle \
  --engine browser \
  --model gpt-5.5-pro \
  --browser-cookie-path /home/derekszen/.config/chromium/Default/Cookies \
  --browser-cookie-wait 5s \
  --slug contract-locus-learning \
  -p "short test prompt" \
  --file docs/idea-status.md
```

Also reproduced without `--browser-cookie-wait`.

The cookie DB exists:

```bash
ls -l /home/derekszen/.config/chromium/Default/Cookies
# -rw------- 1 derekszen derekszen 86016 Apr 30 00:24 /home/derekszen/.config/chromium/Default/Cookies
```

The CLI starts browser mode, then exits:

```text
🧿 oracle 0.9.0 ...
Packed ... files into 1 bundle ...
Launching browser mode (gpt-5-pro) ...
ERROR: No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode.
```

## Expected

One of:

- cookies are copied from the supplied Chromium cookie DB and the ChatGPT browser run starts; or
- the CLI prints a more diagnostic reason for not applying cookies, such as:
  - no `chatgpt.com` / `chat.openai.com` cookies found
  - cookie DB locked
  - cookie values encrypted and keyring/keytar failed
  - model label normalization issue
  - supplied path is not the profile currently signed into ChatGPT
  - manual-login flag is required and supported

## Notes

- `--help --verbose` lists `--browser-cookie-path` and `--remote-chrome`, but not `--browser-manual-login`, even though the runtime error suggests `--browser-manual-login`.
- The skill docs mention `--browser-manual-login` and inline cookies, so either the flag is hidden/missing from help or the error message is stale.
- The model argument was `--model gpt-5.5-pro`; runtime text displayed `browser mode (gpt-5-pro)` in some runs, so model-label normalization may also be worth checking, though it is likely unrelated to cookie import.
- This blocks GPT-5.5 Pro browser review workflows for Codex when ChatGPT auth should already be available in Chromium.

## Suggested Investigation

1. Add a small cookie-probe command or verbose path that reports how many ChatGPT-domain cookies were discovered before copying.
2. Confirm Linux Chromium cookie decryption behavior and whether keytar/libsecret failures are swallowed.
3. Check whether explicit `--browser-cookie-path` is read directly or only used to infer a profile.
4. Ensure the suggested `--browser-manual-login` flag exists, is documented in help, and actually bypasses cookie requirements.
5. Add a regression/live test around explicit cookie path failure diagnostics.
