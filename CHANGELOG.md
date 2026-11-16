# Changelog

All notable changes to this package are recorded here. The version in
`package.json` and the latest entry below move together when a release is
tagged.

## 0.1.2

- Move the quota widget from the session header to the **left sidebar foot**
  (`sidebar.footer.action`, above Settings), so it is visible without an open
  Session: an expanded row with label, percentage and progress bar, and a
  centered percentage in the collapsed 56px rail.
- Register the Client module against `@deepseek-ai/dsh-client-ui-sidebar`.

## 0.1.1

- Render an unconfigured key as a resting dash instead of an error glyph.
- Show refresh progress: content dims while reloading and a failed refresh
  flags the number.
- Report key validation back in the Settings row (for example "MiMo rejected
  the API key") instead of claiming success.
- Raise the click target to at least 24×24 and use `--dsw-radius-*` /
  `--dsw-focus-ring-*` tokens.
- Fix: a failed clear no longer reports success; unreadable key status is no
  longer shown as "not configured"; client calls carry a 15s timeout.
- Fix: a key change retires in-flight and cached answers from the previous
  credential.

## 0.1.0

- First working version: Host route `GET/POST /api/mimo.quota` on DSH's
  authenticated same-origin channel, Token Plan API key in the DSH credential
  store (or `MIMO_API_KEY`), 60s upstream cache, 10s upstream timeout, and the
  Settings → General row for key entry.
