# Linux Notes

- Browser engine now works on Linux (Chrome/Chromium/Edge) without the old `DISPLAY` guard. Oracle will launch whatever `chrome-launcher` finds or what you pass via `CHROME_PATH`.
- Profile sync supports snap-installed Chromium automatically. Common profile root for Default:
  - `~/snap/chromium/common/chromium/Default`
- If you use a non-default profile or a custom install, point Oracle at the correct paths:
  - `--browser-chrome-path /path/to/chrome`
  - `--browser-cookie-path /path/to/profile/Default`
- Browser runs are headful (Cloudflare blocks headless). Keep a compositor/virtual display running if you don’t have a desktop session.
- If profile sync still can’t find your profile, rerun with `--browser-fresh-profile` and sign in manually, or provide inline cookies with `--browser-inline-cookies-file`.
