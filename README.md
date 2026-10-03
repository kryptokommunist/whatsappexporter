# WhatsApp Web JSON Exporter

A single [Tampermonkey](https://www.tampermonkey.net/) / Violentmonkey **userscript** that exports your WhatsApp Web chats, straight from `web.whatsapp.com` in Chrome. It offers two modes:

- **JSON mode** (default) — exports **all chats** as a **ZIP of per-chat JSON files**, read from WhatsApp Web's own in-page data models (not the rendered DOM), so the JSON is clean: real message IDs, timestamps, types, authors, and media metadata.
- **Native mode** — automates WhatsApp's own per-chat **"Export chat"** button for a more complete, phone-sourced archive (see [Native export](#native-export-whatsapp-zips) below).

> ⚠️ **It only exports *your own* data from *your own* logged-in session.** It never sends messages, never uploads anything, and does not download media file bytes (only media metadata). Use at your own risk — see the disclaimer below.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension in Chrome (Violentmonkey also works).
2. Open `wa-export.user.js` from this repo, click **Raw**, and Tampermonkey will offer to install it. (Or: Tampermonkey dashboard → **+** → paste the file contents → save.)
3. Open <https://web.whatsapp.com/> and sign in by scanning the QR code.

## Usage

1. Once WhatsApp Web has loaded and you're logged in, a small **WA Exporter** panel appears at the top-right.
   - The badge shows how it reached the data: `store: named` (best), `store: moduleRaid` (fallback), or `no store` (couldn't connect — reload).
2. Click:
   - **Export all chats** — iterates every chat, force-loads full history, and downloads one ZIP.
   - **Export current chat** — exports only the conversation currently open on screen.
3. The **Rate limit** slider controls the delay between history-page loads. Higher = gentler on WhatsApp (recommended for large accounts); lower = faster.
4. **Cancel** stops the run and still downloads a `_partial` ZIP of whatever finished.
5. **Save log** downloads the full run log (`wa-export-log_<timestamp>.txt`) at any time — mid-run, after it finishes, or after a crash. The same log is also bundled as `_log.txt` inside every export ZIP, so a completed run is self-documenting.
6. **Debug: auto-save log on every run** — tick this and the log is downloaded automatically whenever a run **finishes**, is **cancelled**, or **crashes** (filenames tagged `_done` / `_cancelled` / `_crash`). The setting is remembered, and the `#waexport=dev` URL flag forces it on.

## Native export (WhatsApp ZIPs)

The JSON mode above is limited by what WhatsApp Web keeps in memory — deep history often lives only on your phone, so some chats export with very few messages. For a **complete** archive, tick **Use WhatsApp native export (ZIPs)** and the two export buttons instead automate WhatsApp's own per-chat **"Export chat"** feature:

- **Export current chat** triggers the native export for the open conversation.
- **Export all chats** opens every chat in turn (programmatically, via WhatsApp's own chat-open command — no scrolling the list) and triggers the native export for each.

What you get and the trade-offs:

- **Output is N separate ZIPs, named by WhatsApp**, dropped straight into your browser's **download folder**. The script cannot rename them or bundle them into one archive. It does download a small `whatsapp-native-export-index_<timestamp>.json` recording which chats it triggered (and any it skipped).
- The native ZIPs are **media-inclusive but not clean JSON** — they're WhatsApp's own `.txt` + attachments format. (The script chooses **"Without media"** to keep them light; this is text-only.)
- **It sends read receipts.** Opening each chat marks it read — unavoidable in this mode, unlike the read-only JSON mode. A warning is logged at the start of every native run.
- **English UI only.** It matches the buttons by visible text ("Export chat", "Without media"), so a non-English WhatsApp locale will cause chats to be skipped. Switch WhatsApp Web to English first.
- Chrome shows a **one-time "Allow multiple downloads"** prompt on the first ZIP of an "all" run — click Allow.
- The page can't tell when a native download finishes, so pacing is a fixed settle delay — it **reuses the Rate limit slider**. On a slow disk or for very large chats, raise the slider if downloads get dropped.

Per-chat failures are isolated: if a chat's export UI can't be found within a few seconds, it's logged, marked skipped, and the run continues. **Cancel** stops after the current chat and still downloads the partial index.

### Crash-safe logging

Exports can hang or crash before they ever get to write a log. To stay debuggable, the script continuously flushes the tail of the run log to the extension's own storage (`GM_setValue`) — throttled, plus a background timer so even a frozen run keeps a fresh snapshot. If a previous run never finished cleanly, the **next time you open WhatsApp Web** the panel reports a recoverable log in its mini-log; click **Save log** to download it (with Debug on, it downloads automatically as `wa-export-log_recovered_<timestamp>.txt`). A clean finish clears this storage so you aren't nagged with stale recoveries.

### Output

A ZIP named `whatsapp-export_YYYY-MM-DD.zip` containing:

- One JSON file per chat, named with the **date of the last message** and the **chat/contact name**, e.g. `2026-09-30_Alice-Smith.json`.
- A `_manifest.json` describing the export (version, timestamp, store source, account, and the chat → filename map).
- A `_log.txt` with the full run log (every chat processed, warnings, errors) for debugging.

See [`SCHEMA.md`](./SCHEMA.md) for the exact JSON structure, and [`docs/sample-export.json`](./docs/sample-export.json) for a tiny redacted example.

## How it works (and why it might break)

WhatsApp Web is a single-page app that keeps all chats and messages in in-memory data collections. This script locates those collections and reads them:

1. **Named modules** (`window.require('WAWebCollections')`) — the modern, preferred path.
2. **moduleRaid fallback** — if the module names have changed, it enumerates WhatsApp's webpack modules and finds the right collections by *shape* (e.g. "a collection whose models have `t` and `type`" = messages). Shapes are far more stable than names.
3. **DOM fallback** — reserved for a future version; current chat only.

Because this depends on WhatsApp's **undocumented internals**, a WhatsApp update can break it. If it stops working, the most common fix is updating the module names in the `KNOWN_NAMES` table at the top of `wa-export.user.js`. The shape-based fallback is designed to keep working across many such renames.

### Dev flags

Append to the URL to force a path for testing:

- `web.whatsapp.com/#waexport=raid` — force the moduleRaid fallback.
- `web.whatsapp.com/#waexport=dom` — force DOM mode (placeholder in 0.1.0).
- `web.whatsapp.com/#waexport=dev` — verbose console logging, auto-save log on every run, and expose `window.__waExport`.

## Disclaimer

This is an unofficial tool, not affiliated with or endorsed by WhatsApp/Meta. Automating WhatsApp Web may be against WhatsApp's Terms of Service. It is intended only for exporting your own conversation data for personal backup. You are responsible for how you use it. No warranty.

## License

MIT — see [`LICENSE`](./LICENSE).
