[/private/tmp/oracle-composer/CHANGELOG.md#B261]
1:# Changelog
2:
3:## 0.17.3 — Unreleased
4:
5:### Fixed
6:
7:- Browser: recognize the Japanese `詳細設定` → `推論レベル` controls in ChatGPT's unified Intelligence picker, allowing explicit Pro effort selection without weakening the fail-closed guard for unknown languages.
8:- Browser: read the prompt composer through the editor's framework state when available so the current ChatGPT composer is correctly recognised as filled before sending, with a fallback for other builds.
9:- Browser: mark a prompt as submitted only after its turn is confirmed in the conversation, so session metadata reflects a committed turn rather than a dispatch attempt. Composer mismatch diagnostics keep lengths and hashes, not prompt text.
10:
11:## 0.17.2 — 2026-08-10
12:
13:**Highlight:** browser mode works with ChatGPT's redesigned model picker again —
14:model selection moved under Advanced → Model, and the `gpt-*-pro` aliases now
15:select the right model _and_ the Pro effort tier.
16:
17:### Fixed
18:
19:- Browser: navigate ChatGPT's unified picker, where the model version lives under Advanced → Model and effort under Advanced → Effort. The `gpt-5.5-pro` family of aliases now resolves to the GPT-5.5 model with Pro thinking time instead of failing against the removed flat menu; an explicit `--browser-thinking-time` still wins (#362, thanks @shivamiitgoa).
20:- Security: restrict existing and newly created session transcripts, model metadata, and browser artifacts to the current user, without following symlinks during upgrade hardening. Thanks @bunlongheng!
21:
22:### Added
23:
24:- Browser: a `pro` thinking-time level that selects ChatGPT's Pro effort tier on the model it is already using. It fails closed: an unconfirmed selection aborts the run rather than silently submitting at a cheaper tier.
25:
26:### Changed
27:
28:- Dependencies: update Google GenAI, Node types, Chrome DevTools protocol, esbuild, tsx, shiki, tokentally (now pricing cached tokens), hono, protobufjs, vite, and related transitives.
29:- Developer workflow: remove the obsolete scoped-commit helper and allow standard Git commands in isolated worktrees.
30:
31:## 0.17.1 — 2026-08-02
32:
33:### Changed
34:
35:- Dependencies: update OpenAI, Markdansi, Shiki, Hono, Fast URI, protobufjs, Vite, Puppeteer, Chrome DevTools protocol, Oxc tooling, tsx, and pnpm.
36:
37:### Fixed
38:
39:- Browser: keep `--browser-thinking-time extra-high` as Extra High (non-Pro) on GPT-5.6 Sol instead of selecting Pro. Fixes #353.
40:- Browser: match German Intelligence effort labels with whole-word Latin matching, and keep the currently selected effort when a requested tier has no matching row. Thanks @Jonasdero!
41:
42:## 0.17.0 — 2026-08-02
43:
44:### Added
45:
46:- API: add explicit GPT-5.6 reasoning mode and effort controls, including Pro mode, session persistence, long-run handling, and fail-closed route validation. Thanks @enki!
47:
48:### Changed
49:
50:- Dependencies: update Google GenAI, MCP SDK, OpenAI, Chalk, Shiki, TokenTally, Puppeteer, Chrome DevTools protocol, Oxc tooling, and related packages.
51:
52:### Docs
53:
54:- Rewrite the README around a verified install and quickstart, with detailed workflows linked to the docs site.
55:
56:### Fixed
57:
58:- Browser: reject retired GPT-5.2 base, Instant, and Thinking aliases before launching Chrome while keeping API aliases and legacy Pro routing. Fixes #344. Thanks @HidakaKoyo!
59:- Browser: preserve authenticated model-picker errors instead of appending a misleading cookie/login hint after login has already been verified.
60:- Browser: distinguish requested CLI model keys from verified ChatGPT picker labels without inferring a server-side GPT version from a generic label. Fixes #317. Thanks @DragonFSKY!
61:- Browser: recognize GPT-5.6 Sol as the selected model when ChatGPT exposes Pro in its independent effort pill. Thanks @jung0han!
62:- Browser: treat WSL's systemd-resolved loopback DNS stub as localhost when connecting to a freshly launched Chrome DevTools endpoint. Thanks @Rokurolize!
63:- CLI: reject junk between duration tokens and warn when malformed browser duration flags fall back to defaults. Thanks @devYRPauli!
64:- Browser: run long local Pro consultations in a detached worker while the CLI remains attached to its session log, so unexpected foreground termination cannot stop answer capture; Ctrl-C still cancels the worker. Thanks @Rokurolize!
65:- Browser: recognize ChatGPT's separate Pro effort control as the selected maximum effort for GPT-5.6 Sol when `--browser-thinking-time heavy` is requested. Thanks @Rokurolize!
66:- Gemini: type `.mp4`, `.mov`, and `.webm` uploads as video so Gemini receives them instead of silently discarding generic binary uploads. Thanks @mkubenka!
67:- Browser: wait for saved conversation turns to hydrate before retrying capture after a reload or reattach, and reject shell-only stop controls as recovery evidence. Thanks @pdurlej!
68:
69:## 0.16.1 — 2026-07-23
70:
71:### Changed
72:
73:- Dependencies: refresh Google GenAI, OpenAI, Clipboardy, Chrome DevTools protocol, Hono/MCP runtime security fixes, Oxc tooling, and TSX.
74:
75:### Fixed
76:
77:- Browser: ignore transient `/c/WEB:<request-id>` routes until ChatGPT exposes the durable conversation URL, preventing completed GPT-5.6 and Pro answers from hanging until timeout under a mismatched response scope. Fixes #333. Thanks @dbachko and @kesslerio!
78:- Browser: recover completed answers after a recoverable DevTools disconnect by confirming target liveness and attempting bounded reattachment, while preserving fail-closed handling for unavailable targets. Fixes #326. Thanks @piyushbag!
79:- CLI: avoid inheriting `browser.thinkingTime` from config when `--browser-model-strategy current` is explicit, while preserving an explicit `--browser-thinking-time` override. Thanks @jung0han!
80:- Browser/Serve: keep the authenticated manual-login Chrome process alive while closing each successfully captured service-owned run tab, preventing renderer and memory accumulation across repeated remote consultations without changing explicit `--browser-keep-browser`, attached-tab, or incomplete-run recovery behavior. Thanks @rtl-ai!
81:
82:## 0.16.0 — 2026-07-12
83:
84:### Added
85:
86:- Browser: allow `ORACLE_BROWSER_MAX_CONCURRENT_TABS` to set the per-host shared-profile tab cap while preserving explicit config precedence and the default limit. Thanks @StartupBros!
87:- Browser: detect ChatGPT's active Chat/Work mode before new browser runs, normalize Work pages and attached Work tabs to a new Chat with verified trusted input, and preserve explicit resume safety. Fixes #315. Thanks @DragonFSKY!
88:
89:### Fixed
90:
91:- Browser: scope the fallback stop-control selector to the composer so read-aloud, dictation, and voice controls cannot hold completed responses open until timeout. Thanks @StartupBros!
92:- Browser: support ChatGPT GPT-5.6's unified Intelligence picker, where the menu wraps `composer-intelligence-picker-content` and the highest effort is labeled `Pro` instead of `Pro Extended`; recognize the current Chinese effort labels (`极速5.5`, `中`, `高`, and `极高`) without prefix collisions and verify switches against React-replaced composer pills. Fixes #303. Thanks @DragonFSKY!
93:- GPT-5.6: add first-class `gpt-5.6` and `gpt-5.6-sol` aliases for the OpenAI API and ChatGPT's Sol picker entry, including navigation through the current-version submenu and strict selection evidence that cannot be replaced by a localized effort label. Fixes #305. Thanks @DragonFSKY!
94:- Browser: keep hidden macOS Chrome windows rendered off-screen so trusted prompt submissions land without retaining drafts or leaking them into later runs. Fixes #298 and #312. Thanks @LeoLin990405!
95:- Browser: require positive terminal evidence before finalizing ChatGPT responses so settled preambles and mid-stream text cannot be captured as the completed answer. Thanks @StartupBros!
96:- Browser: distinguish genuine Cloudflare interstitials from healthy ChatGPT pages that carry bot-management scripts or mention generic challenge text. Thanks @StartupBros!
97:- Browser: recover completed Deep Research reports when the initial capture contains only the Deep Research App tool-call wrapper. Thanks @devYRPauli!
98:
99:## 0.15.2 — 2026-07-06
100:
101:### Changed
102:
103:- Dependencies: update Google GenAI, OpenAI, Markdansi, osc-progress, Shiki, TokenTally, Vitest, Puppeteer, TypeScript native preview, Oxc tooling, and related packages.
104:
105:### Fixed
106:
107:- Browser: close the DevTools connection after live session reattach so the CLI exits instead of hanging after capture.
108:- Browser: persist late `/c/<id>` URLs during remote Chrome runs and prefer saved conversation targets over stale target IDs during reattach. Fixes #284. Thanks @LeoLin990405 and @StartupBros!
109:- Browser: keep prompt baselines, assistant snapshots, and artifact capture on one top-level ChatGPT turn index so nested message nodes cannot hide a new response. Thanks @cp7553479!
110:- Browser: reconfirm implausibly short ChatGPT captures after thinking-UI transitions, and fail closed rather than archiving when the response cannot be confirmed. Fixes #284. Thanks @LeoLin990405!
111:- Skills: remove personal credential-reveal and machine-local checkout instructions from the distributed Oracle skill. Fixes #292. Thanks @HikaruEgashira!
112:
113:## 0.15.1 — 2026-07-03
114:
115:### Added
116:
117:- Bridge/Browser: transfer ChatGPT-generated files from the browser host back to the client over a token-protected artifact endpoint, with capability discovery, safe filenames, byte counts, SHA-256 metadata, ZIP validation, and manual fallback guidance for mixed-version bridge deployments. Thanks @DK625!
118:- API: add user-only `modelOverrides` for remapping known models and their metadata on custom OpenAI-compatible gateways. Fixes #273. Thanks @wangwllu!
119:
120:### Fixed
121:
122:- Browser: retain runtime, model-selection, and redacted prompt-commit diagnostics in failed session metadata when ChatGPT submission verification times out. Fixes #286. Thanks @LeoLin990405!
123:- API: forward configured reasoning effort through custom OpenAI-compatible chat-completions gateways.
124:- Browser: clear stale ChatGPT temporary-conversation cookies before navigation while preserving keys for open or resumed conversations, preventing accumulated `conv_key_*` entries from triggering header-size failures. Thanks @jung0han!
125:- Browser: accept a stable, exact file-input name match when ChatGPT marks the composer ready but exposes no attachment chip or count, while still waiting through active uploads and rejecting missing or extra files. Fixes #275. Thanks @wangwllu!
126:- Browser: avoid returning truncated Pro answers when completion controls appear during the thinking-to-answer transition. Thanks @xuan-wei!
127:- Browser/Bridge: improve ChatGPT ZIP artifact capture before bridge transfer by broadening sandbox/file-card/download-control discovery, adding sanitized direct-download diagnostics, and falling back to scoped browser downloads when sandbox fetches fail. Thanks @DK625!
128:- Browser: wait up to eight seconds for the ChatGPT model/effort composer pill to mount before failing explicit selection, while leaving `option-not-found` failures immediate. Thanks @gustavosmendes!
129:- Browser: activate ChatGPT Deep Research after the final composer reset, select the current tools-menu row shape, and use trusted mouse clicks for Deep Research and send actions so the request reaches the real research-plan flow instead of being submitted as an ordinary Pro prompt. Fixes #281. Thanks @wbzjt!
130:- Browser: report `response streaming` when a visible stop control is the only remaining liveness signal, and share that signal with completion capture so selector drift cannot finalize a still-streaming answer. Refs #284. Thanks @StartupBros!
131:
132:## 0.15.0 — 2026-06-19
133:
134:### Added
135:
136:- Browser: `--copy-profile <dir>` copies the active signed-in Chrome profile (or an explicit `--browser-chrome-profile`) to a throwaway profile and runs browser mode against it, reusing the live ChatGPT session with no manual sign-in. Skips keychain-mocking flags so encrypted cookies decrypt via the real Chrome "Safe Storage" key (macOS/Linux; requires `rsync`). The throwaway copy is always cleaned up, rejects incompatible persistent/existing/remote browser modes, and fails fast if the required `Local State` cannot be copied. Thanks @edwarddgao!
137:
138:### Changed
139:
140:- Dependencies: update Vitest, coverage tooling, Vite, Hono, and protobufjs to remove vulnerable transitive releases.
141:
142:### Fixed
143:
144:- Browser: wait for the current ChatGPT Intelligence pill before falling back to the default thinking level, and make `--browser-model-strategy select` prefer concrete requested variants over version-only submenu wrappers with bounded retries. This lets current-model runs select and verify Extra High before submitting and prevents explicit Instant selection from hanging (thanks @alex-on-java and @servrox).
145:- Browser: save ChatGPT generated-file button downloads sequentially, preserve browser-provided filenames for generic endpoints, and stop after a timed-out download so late completions cannot be attributed to the next file. Thanks @orbitingflea!
146:- Browser: reject Deep Research planning/status captures and fail clearly when ChatGPT silently returns a normal response without observable research activity, instead of saving either as the final report. Fixes #261. Thanks @aaronflorey!
147:
148:## 0.14.1 — 2026-06-15
149:
150:### Changed
151:
152:- Dependencies: update sweet-cookie, Markdansi, osc-progress, esbuild, TypeScript native preview, es-toolkit, and related Node/Inquirer type packages.
153:
154:### Fixed
155:
156:- Browser: preserve original bytes when ZIP-bundling raw, archive, office, and media uploads; choose byte-preserving ZIPs automatically for mixed bundles while enforcing attachment and memory limits. Thanks @orbitingflea!
157:- Browser: select explicit Thinking model versions through ChatGPT's current `Configure...` Intelligence dialog, retain support for the earlier direct-version submenu, and require observable version evidence before reporting success. Thanks @aaronflorey!
158:- Browser: retry manual-login DevTools tab creation on fresh Chrome launches, recover ChatGPT generated-image downloads through the authenticated browser context when Node-side fetch fails, and keep generated-image artifact waits fail-fast on visible ChatGPT warnings. Thanks @derekszen!
159:- Browser: support ChatGPT's updated Intelligence model picker and Pro effort submenu, and accept `instant`, `medium`, `high`, and `extra-high` as thinking-time aliases while preserving existing Oracle names. Thanks @orbitingflea!
160:
161:## 0.14.0 — 2026-06-12
162:
163:### Added
164:
165:- Browser: `oracle --followup <browser-session> -p ...` now safely reopens the exact saved ChatGPT conversation, inherits its browser profile/configuration/model, and fails closed before submitting to the wrong thread; browser failures/timeouts print `--render`, `--live`, and `--harvest` reattach commands with the real session slug. Thanks @hbruceweaver and @pdurlej!
166:- Browser: clean stale manual-login Chrome profile locks before relaunching browser and Project Sources runs, while preserving locks when the recorded Chrome process is still alive. Thanks @derekszen!
167:- Browser: `oracle session <id> --harvest` and `--live` now auto-recover when the original Chrome has been closed by relaunching the manual-login profile and reopening the saved conversation URL, then retrying the harvest against the recovered tab. Resolves the failure mode where a long GPT-5 Pro Extended response completed in the background after the CLI's 20-minute wall expired and the conversation was archived. Recovery URL selection prefers `browser.harvest.url` over `browser.runtime.tabUrl` and is gated by a shared ChatGPT-conversation-URL check (rejects home, project shell, and external URLs so the persistent profile can't be navigated to the wrong page from stale metadata). Opt out with `--no-recover` on the `session` subcommand.
168:- Browser: persist ChatGPT-generated downloadable files such as CSV, PDF, ZIP, wheel, and source-distribution outputs beside the session transcript, limited to current-run assistant artifacts and known ChatGPT file endpoints. Fixes #244. Thanks @pdurlej!
169:- MCP: add a dedicated `chatgpt_image` tool plus `generateImage` / `outputPath` support in `consult` so agent callers can trigger ChatGPT image generation and receive saved local artifacts in typed structured output. Thanks @umutkeltek!
170:
171:### Fixed
172:
173:- Browser/MCP: save ChatGPT image-generation responses delivered as current-turn “Download…” behavior buttons, validating downloaded bytes as real images before returning typed artifacts instead of waiting for an inline image until timeout.
174:- Gemini: refresh browser mappings for Gemini 3.1 Flash-Lite, Gemini 3.5 Flash, Gemini 3.1 Pro, and Pro Deep Think; add current Flash API model configs; keep legacy browser aliases working; and make the live text smoke fail on stale mappings instead of skipping. Fixes #242. Thanks @goldengrape!
175:- Browser: restore Deep Research report capture from ChatGPT's out-of-process report iframe, prefer completed page-scoped reads with legacy frame fallback, and bind/filter CDP auto-attach by the active page session so other tabs or unrelated iframes cannot be harvested. Thanks @umutkeltek!
176:- API/OpenRouter: parse catalog prompt/completion prices as USD-per-token strings, preserving model/context metadata and accurate cost estimates while malformed prices fall back cleanly. Thanks @devYRPauli!
177:- Browser: honor `--browser-model-strategy current` when ChatGPT exposes a usable composer without a model-picker button, record unavailable current-model labels honestly, and keep strict selection failures actionable. Thanks @m-rousseau!
178:- Browser: select and verify requested thinking effort from ChatGPT's standalone Pro/Thinking composer pills and earlier Intelligence/per-model picker layouts, keep Pro Extended fail-closed when the selected effort cannot be confirmed, and ignore status-only assistant turns such as `Pro thinking` only while generation is active; picker failures now emit a bounded, redacted diagnostic in normal session logs. Thanks @umutkeltek!
179:- Browser: surface visible ChatGPT rate-limit, temporary-unavailable, and authentication/challenge warnings in assistant-timeout errors and session metadata instead of reporting only a generic timeout. Thanks @derekszen!
180:- Browser: verify ChatGPT login through the cookie-authenticated `/api/auth/session` endpoint before falling back to the legacy `/backend-api/me` probe and strong app-shell signals, avoiding false “session not detected” failures when the legacy endpoint requires bearer auth. Fixes #241. Thanks @hexsprite and @orbitingflea!
181:- Browser: select ChatGPT “Welcome back” accounts only by exact configured email, keep the address out of logs, and fail closed on ambiguous saved accounts. Thanks @derekszen!
182:- Browser: relax pre-send readiness for Oracle-generated `attachments-bundle.txt` and `.zip` uploads when ChatGPT exposes only the `attachments-bundle` stem, while keeping filename-boundary checks so unrelated attachment names do not satisfy the gate. Thanks @ig0rsky!
183:
184:### Changed
185:
186:- CLI/API/Browser: render generated prompt, inline, and text-bundle context with stable line numbers so model answers can cite source as `path:line` or `path:line-line`, while preserving indexed `buildPrompt(...)` headings, raw browser uploads, ZIP entries, `createFileSections().sectionText`, and the default `formatFileSection(...)` output. Callers can request numbered output directly with `formatFileSection(..., { lineNumbers: true })`. Thanks @tristanmanchester!
187:
188:### Security
189:
190:- MCP: constrain image output paths to the symlink-safe `ORACLE_HOME_DIR/generated` directory by default, keeping agent writes away from Oracle config, session, and browser-profile state; explicit opt-in remains required for external paths.
191:- MCP: reject image output through the remote browser service until generated artifacts can be transferred back to the caller.
192:
193:## 0.13.0 — 2026-05-22
194:
195:### Added
196:
197:- Browser: add `--browser-attachment-timeout`, `ORACLE_BROWSER_ATTACHMENT_TIMEOUT`, and `browser.attachmentTimeoutMs` so slow ChatGPT attachment uploads can extend the pre-send readiness gate and failures report the timeout budget. Fixes #214. Thanks @enieuwy!
198:- Browser: target ChatGPT's GPT-5.5 "Instant" picker row when `--model gpt-5.5-instant` (or label aliases like `"ChatGPT 5.5 Instant"` / `"5.5 fast"`) is requested, with dedicated picker testids so the selection no longer falls through to the bare 5.5 "Thinking" row. Browser-only; the API catalog is not modified. Thanks @LoukikNaik!
199:
200:### Changed
201:
202:- Config: layer safe project defaults from `.oracle/config.json` files discovered upward from the current working directory, so repos can pin workflow defaults like ChatGPT Project URLs without copying the user config.
203:- Website: point package/homepage metadata and generated site chrome at `https://askoracle.sh` instead of the GitHub repository.
204:
205:### Fixed
206:
207:- Browser: accept Cloudflare/throttling-blocked ChatGPT auth probes only when the signed-in app shell is visible, while keeping plain 401/403 login failures authoritative. Thanks @orbitingflea!
208:- Browser: resolve attachment readiness from the active ChatGPT composer so uploaded files do not false-fail with `attachment-send-not-ready` when the Send button is already clickable. Thanks @enieuwy!
209:- Browser: scope ChatGPT model picker scans to the real picker menu while preserving text-only fallback rows, so sidebar/search Radix menus do not block model selection. Thanks @orbitingflea!
210:- Browser: tolerate duplicate-renamed or ellipsized ChatGPT attachment chip names during pre-send readiness checks. Thanks @pdurlej!
211:
212:## 0.12.1 — 2026-05-17
213:
214:### Changed
215:
216:- Docs: update the bundled Oracle skill for GPT-5.5 Pro and current provider/preflight/perf-trace guidance (#204). Thanks @TomBener!
217:- Dependencies: update transitive fast-uri, hono, ip-address, express-rate-limit, and Vite to patched versions for Dependabot alerts (#205, #206, #207).
218:- Dependencies: update Gemini, sweet-cookie, Puppeteer, Vitest, Inquirer, tsx, oxfmt/oxlint, DevTools Protocol, and related type/tooling packages (#209).
219:- Dependencies: update the OpenAI SDK and TypeScript native preview.
220:
221:### Fixed
222:
223:- MCP: keep local mcporter smokes from failing when the optional Chrome DevTools browser endpoint env var is unset.
224:- Sessions: allocate same-slug session directories atomically, recreate missing per-model log directories, and persist zombie/dead-browser status reconciliation from session listings.
225:- API: share provider route resolution between doctor/preflight and runtime requests so route diagnostics match real execution.
226:- CLI: rethrow sanitized multi-model provider failures without mutating or linking the raw provider error, keeping secrets out of logs and error chains.
227:- Browser: mark Chrome disconnects before a recoverable ChatGPT conversation as errors instead of leaving sessions running for impossible reattach. Thanks @pdurlej!
228:- Browser: fail closed when GPT-5.5 Pro Extended effort cannot be confirmed instead of silently submitting with the wrong or default effort. Thanks @pdurlej!
229:- Release: write clean checksum files from `scripts/release.sh artifacts` without helper trace lines.
230:
231:## 0.12.0 — 2026-05-15
232:
233:### Added
234:
235:- CLI: add `--perf-trace` / `--perf-trace-path` / `ORACLE_PERF_TRACE` startup timing traces and lazy-load heavy browser/provider/runtime modules to reduce time-to-first-output.
236:- API: add `--allow-partial` / `--partial ok` for multi-model runs so advisory panels can exit 0 when at least one model succeeds, while still listing saved outputs and a JSON output manifest before failures.
237:- API: classify common provider failures in multi-model summaries and metadata, including auth, expired keys, quota, rate limits, and unavailable models, with secret-safe recovery hints.
238:- API: add root `--preflight` provider readiness checks and packed CLI help smoke coverage so stale installed help is caught before release.
239:- Sessions: print and persist a compact lifecycle block showing foreground/background execution, detach state, model count, and reattach command.
240:- Docs: add `oracle docs check` / `pnpm docs:check` to catch documented flags that are missing from Commander help metadata.
241:- Docs: document provider preflight, route diagnostics, partial multi-model recovery, and output manifest workflows in README/provider docs.
242:- API: add `--provider openai` / `--no-azure` to force first-party OpenAI when Azure env/config is present, add `oracle doctor --providers` and `--route` redacted route diagnostics, keep provider-qualified model IDs on OpenRouter/proxy routes instead of accidental Azure/native routes, and fail early when Azure routing lacks a deployment.
243:- Browser/MCP: add opt-in ZIP formatting for bundled browser uploads with `--browser-bundle-format zip` / `browserBundleFormat: "zip"`, preserving individual file names in one ChatGPT attachment.
244:
245:### Fixed
246:
247:- CLI: make missing-prompt help exit nonzero, reject `--dry-run --render` like `--dry-run --render-markdown`, and terminate promptly with code 130 on SIGINT.
248:- API: parse duration-style `--timeout` values such as `10m`, derive the HTTP transport timeout and stale-session cutoff from explicit overall timeouts, and warn when an explicit shorter `--http-timeout` can fail first.
249:- Browser: select thinking effort from the currently checked ChatGPT model row so Pro Extended runs do not fall back to the Thinking row's effort control.
250:- Browser: record ChatGPT model-selection evidence in session metadata and CLI output so Pro browser runs show the selected model proof (#195). Thanks @pdurlej!
251:- Browser: target ChatGPT's renamed bare Pro picker row for Pro browser runs while keeping older Pro CLI aliases mapped to the current browser target (#190, fixes #182). Thanks @jungdaesuh!
252:- Browser: recognize current ChatGPT attachment chips without treating stale page-level chips as ready, and keep the longer send-button wait scoped to attachment uploads (#192). Thanks @li-aolong!
253:
254:## 0.11.1 — 2026-05-10
255:
256:### Changed
257:
258:- Dependencies: update Google GenAI, OpenAI, Zod, Puppeteer, and developer tooling packages. (#187)
259:
260:### Fixed
261:
262:- Browser/MCP: avoid false ChatGPT login prompts when sidebar history starts with "Login..." and default MCP browser consults to manual login on Windows. (#189) — thanks @ndycode.
263:- Browser/MCP: fail fast when a manual-login browser profile has not been initialized or signed in, and show first-time setup guidance for the private Oracle Chrome profile used by Claude/Codex MCP consults.
264:- Browser: allow Pro model selection in ChatGPT Temporary Chat URLs and skip archive attempts for temporary conversations. (#185) — thanks @pdurlej.
265:- Browser: recognize ChatGPT's renamed GPT-5.5 Pro/Thinking model labels and always apply requested thinking time instead of assuming Pro implies Extended. (#183, fixes #182) — thanks @broady.
266:- CLI/Browser: expose `--max-file-size-bytes` on normal `oracle --file` runs, preserve the CLI override ahead of config/env defaults, and pass the raised cap through browser prompt assembly.
267:- MCP: reject unknown `consult` fields instead of silently ignoring misspelled tool-call arguments. (#184) — thanks @pdurlej.
268:
269:### Docs
270:
271:- Website: highlight code blocks in the generated docs site.
272:
273:### CI
274:
275:- Install dependencies before building the docs site and update the Homebrew tap after releases.
276:
277:## 0.11.0 — 2026-05-07
278:
279:### Added
280:
281:- Browser/MCP: add non-destructive ChatGPT Project Sources management (`oracle project-sources list|add`, MCP `project_sources`) so Developer Mode workflows can share explicit project context through Sources. Addresses #131 and builds on #132 by @vgorlovi.
282:- Browser: add repeatable `--browser-follow-up` prompts and MCP `browserFollowUps` for multi-turn ChatGPT browser consults in one conversation. (#170) — thanks @pdurlej.
283:- Browser: add live ChatGPT tab inspection, `oracle status --browser-tabs`, browser session harvest/live-tail commands, and `--browser-tab <ref>` to reuse an existing ChatGPT tab by current tab, target id, URL, or title substring. (#126) — thanks @NathanSkene.
284:- Browser: add `--browser-research deep` / MCP `browserResearchMode: "deep"` for ChatGPT Deep Research browser runs, including progress monitoring, reattach recovery, and iframe report capture. (#151) — thanks @pdurlej.
285:- Browser: save durable browser session artifacts, including transcripts, Deep Research reports, and ChatGPT-generated image files when downloadable image URLs are present. (#169) — thanks @pdurlej.
286:- Browser: add `--browser-archive` / MCP `browserArchive` to archive successful one-shot ChatGPT browser runs after local artifacts are saved. (#178) — thanks @pdurlej.
287:- Browser: add `--browser-attach-running` to reuse a local already-running signed-in Chrome through Chrome's local remote-debugging toggle. Oracle opens a dedicated tab, stores attach metadata for reattach, and leaves the browser itself untouched. (#119) — thanks @dedene.
288:- MCP: add the `chatgpt-pro-heavy` consult preset, MCP dry-runs, browser model strategy passthrough, and `oracle bridge claude-config --local-browser` for Claude Code + local ChatGPT Pro browser consults. (#149) — thanks @pdurlej.
289:- Browser: coordinate concurrent ChatGPT browser runs that share one manual-login profile with a tab lease registry, `--browser-max-concurrent-tabs`, stale lease cleanup, and shared Chrome discovery. (#150) — thanks @pdurlej.
290:- Browser: print a browser control plan before ChatGPT runs and dry-runs, and clean up leftover blank tabs after completed manual-profile runs. (#179) — thanks @pdurlej.
291:- Browser: document multi-turn consult guardrails and make browser dry-runs explicit that Oracle only sends caller-provided follow-up prompts. (#180) — thanks @pdurlej.
292:
293:### Docs
294:
295:- Browser: document the new attach-running workflow and add a manual smoke test for the direct attach path.
296:- Website: add the generated askoracle.dev docs site, social preview asset, and GitHub Pages deployment workflow.
297:
298:### Changed
299:
300:- Browser: emit `--heartbeat` status while waiting for ChatGPT browser responses, including safe Thinking/Reasoning sidecar liveness metadata without logging reasoning text. (#148) — thanks @pdurlej.
301:
…
312:
…
958:- `oracle status` and `oracle session` no longer demand `--prompt` when used directly.

[Showing lines 1-300 of 958. Use :301 to continue]
