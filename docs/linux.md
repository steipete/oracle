# Linux Notes

- Browser engine now works on Linux (Chrome/Chromium/Edge) without the old `DISPLAY` guard. Oracle will launch whatever `chrome-launcher` finds or what you pass via `CHROME_PATH`.
- Cookie sync supports snap-installed Chromium automatically. Common cookie DB for the Default profile:
  - `~/snap/chromium/common/chromium/Default/Cookies`
- If you use a non-default profile or a custom install, point Oracle at the correct paths:
  - `--browser-chrome-path /path/to/chrome`
  - `--browser-cookie-path /path/to/profile/Default/Cookies`
- Browser runs are headful (Cloudflare blocks headless). Keep a compositor/virtual display running if you don’t have a desktop session.
- To keep the browser visible but reduce focus stealing, use `--browser-prevent-focus` or set `browser.preventFocus: true`. Oracle opens automation tabs with DevTools `focus: false` and then tries to restore focus with `xdotool`; Wayland compositors may still block restoring focus to native Wayland windows.
- If cookie sync still can’t find your DB, rerun with `--browser-allow-cookie-errors --browser-no-cookie-sync` and sign in manually, or dump the session cookies with `--browser-inline-cookies-file`.
