# AdHoc TaskManager — Quick-Capture Inbox for Miscellaneous Assignments

An installable, offline-first PWA for logging sudden, unbudgeted directives ("Task 28 – Any other work assigned by your reporting manager/s"), timing the hours they divert, and producing manager-ready reports. Vanilla JS, no build step, no external dependencies.

## Run it

Service workers and install prompts need **HTTPS or `localhost`** (not `file://`). From this folder:

```bash
python3 -m http.server 8080
# or: npx serve .
```

Open <http://localhost:8080>. Chrome/Edge show an **Install** button in the app header; on iPhone/iPad use Safari → Share → Add to Home Screen.

## Structure

```
├── index.html              App shell, modals, inline UI icon sprite
├── manifest.webmanifest    Standalone display, #0f172a theme, icons, shortcuts
├── sw.js                   Cache-first static, network-first navigation, offline fallback
├── offline.html            Branded offline page with reconnect detection
├── favicon.ico / .svg      Browser tab icons
├── apple-touch-icon.png    180×180 iOS home-screen icon
├── icons/                  PNG icons 72–512 px + maskable 192/512
├── css/styles.css          Design tokens, dark/light/high-contrast themes, safe areas
├── js/app.js               State machine, IndexedDB storage, reports, backup, PWA hooks
└── README.md
```

## Features

- **Quick capture:** title with autofocus, one-tap Assigned By / Context / Urgency, change-order flag, raw note, dictation and audio recording. Drafts auto-save.
- **Views:** Inbox (grouped by urgency or requester), In Progress (live timer, one running at a time), Closed archive (resolution notes).
- **Reports:** plain-text executive summary and CSV (Date, Task, Assigned By, Hours Spent, Impact/Scope Flag, Resolution, …) for WhatsApp, Email or ClickUp.
- **Offline-first:** everything is stored on the device (IndexedDB, with a localStorage fallback). JSON backup/restore in Settings. Audio notes are not included in the JSON backup.
- **Shortcuts:** `N` quick add, `/` search; home-screen shortcuts for Quick Add, In Progress and Report.

## Deploying updates

Bump `VERSION` in `sw.js`. The new service worker activates immediately, deletes old caches, and open pages show a "Reload" prompt. If you add or rename files, update the `PRECACHE` list too.

## Regenerating icons

`favicon.svg` is the master logo. The PNGs were rendered from it with `rsvg-convert -w <size> -h <size> favicon.svg -o icons/icon-<size>.png`; the maskable versions use the same artwork scaled to 78% on a full-bleed background so launchers can crop them safely.
