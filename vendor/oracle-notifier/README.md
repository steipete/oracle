# Oracle Notifier helper (macOS, arm64)

Builds a tiny signed helper app for macOS notifications with the Oracle icon.

## Build

```bash
cd vendor/oracle-notifier
# Optional: notarize by setting App Store Connect key credentials
export APP_STORE_CONNECT_API_KEY_P8="$(cat AuthKey_XXXXXX.p8)" # with literal newlines or \n escaped
export APP_STORE_CONNECT_KEY_ID=XXXXXX
export APP_STORE_CONNECT_ISSUER_ID=YYYYYYYY-YYYY-YYYY-YYYY-YYYYYYYYYYYY
./build-notifier.sh
```

- Requires Xcode command line tools (swiftc) and a macOS Developer ID certificate. Without a valid cert, the build fails (no ad-hoc fallback).
- If `APP_STORE_CONNECT_*` vars are set, the script notarizes and staples the ticket.
- Output: `OracleNotifier.app` (arm64 only), bundled with `OracleIcon.icns`.

## Usage
The CLI prefers this helper on macOS; if it fails or is missing, it falls back to toasted-notifier/terminal-notifier.

## Permissions
After first run, allow notifications for “Oracle Notifier” in System Settings → Notifications.
