# Velae Lite — Changelog

The authoritative changelog table also lives in `architecture.md` §0; this file
mirrors it for quick reference. Bump the MINOR version by 0.1 for each
meaningful change and add a row here and in `architecture.md`.

| Version | Summary |
|---|---|
| v1.0 | Initial complete app: portable single-folder tracker; applications/companies CRUD; drag-and-drop pipeline board; dashboard (follow-ups, response rate, funnel, activity); search & filter; hybrid persistence (Chrome/Edge auto-save + Safari manual); one-time reconnect via stored IndexedDB folder handle. |
| v1.1 | AI Tailor "council": Gemini (one-click, free) + Claude-via-paste, side-by-side four-tab results, optional merge/judge step; `.docx` resume/cover-letter generation; resume parsing (.docx/.pdf/.txt); automatic timestamped backups (throttled, rolling 30) + "Export everything" zip with CSVs. Project renamed JobTracker → Velae; guiding-star brand mark. |
| v1.2 | User-editable pipeline statuses with `active`/`responded`/`terminal` types driving the dashboard (`meta.statusMeta`, `schemaVersion` 2 + legacy migration); pre-loaded real-world statuses (Under Consideration, Not Selected). Gemini upgraded to free `gemini-3-flash` with a free-tier fallback chain. Docs reconciled; versioning policy introduced. |
| v1.3 | Renamed product to **Velae Lite** and established the Lite / Web / Pro product family. Folder reorganization: app code/assets moved into `Core/` (`app.js`, `styles.css`, `vendor/`); documentation moved into `Doc/` (`architecture.md`, `Velae_User_Guide.docx`, `Changelog.md`). `index.html` and all data files remain at the root. No behavior or data-shape change (`schemaVersion` unchanged at 2); paths in `index.html` and the dynamic pdf.js import in `app.js` updated to match. |
| v1.4 | Fixed PDF resume parsing on `file://`. Replaced the ESM pdf.js build (`pdf.min.mjs`, loaded via dynamic `import()` — impossible from `file://`) with the pdf.js v3.11.174 UMD build (`pdf.min.js` + `pdf.worker.min.js`) loaded via classic `<script>` tags; worker runs on the main thread (fake worker via `window.pdfjsWorker`). `extractResumeFromFile` uses the `window.pdfjsLib` global. No data-shape change (`schemaVersion` 2). |
| v1.5 | Phase 1.1 — Undo/redo (Cmd/Ctrl+Z / Shift+Z / Ctrl+Y, 50-deep snapshot stack) + recycle bin. Deletes are now soft (records move to a `trash` array, kept 30 days, restorable) with an undo toast. `schemaVersion` → 3 (adds `trash[]`). Every mutation snapshots before mutating. |
| v1.6 | Phase 1.2 — Data-integrity scan & one-click repair in Settings (orphaned company links, unknown statuses, malformed dates, missing/duplicate ids). Repairs route through undo. |
| v1.7 | Phase 1.3 — CSV import (dependency-free parser) inverting the applications/companies exports: auto-creates companies, previews the diff, commits through undo. |
| v1.8 | Phase 2.1 — Profile page + `profile` object (`schemaVersion` → 4). Master resume and contact details (name, email, phone, location, LinkedIn, portfolio) move out of Settings into a dedicated Profile view; `ensureProfile()` migrates legacy `config.masterResume`/`applicantName`. Tailor feeds the contact block into cover-letter prompts. |
| v1.9 | Phase 2.2 — Per-application `application.json` (JD + tailored resume/cover-letter text). Tailor writes it when an app is linked, restores it on re-link, and the application form shows it inline. Chrome/Edge only; Safari degrades. Separate file — no `data.json` shape change. |
| v2.0 | Version display — `APP_VERSION` constant in `Core/app.js` shown in the sidebar and browser-tab title. Versioning switched to a plain decimal scheme (v1.9 → v2.0; no reserved "major" meaning). |
| v2.1 | Phase 3.1 — Command palette (⌘K / Ctrl+K): filtered command list with type-to-filter and ↑/↓/Enter; jumps to views, new application, exports, backup, undo/redo, connect folder. |
| v2.2 | Phase 3.2 — Keyboard navigation: number keys `1–9` switch views, `/` focuses search, `n` new application (suppressed while typing or when a modal is open). |
| v2.3 | Phase 3.3 — Calendar export (`.ics`, RFC 5545): all-day follow-up reminders with a 9am alarm; dependency-free generator with line folding. In Settings → Data & backups and the command palette. |
| v2.4 | Phase 4.2 — Sectioned application form (Role & company / Status & timeline / Documents / Notes) + a Notes UI that appends timestamped entries to `notesLog`. |
| v2.5 | Phase 4.3 — In-app document panel: lists the real files in an application's folder with inline preview (.docx/.pdf/.txt/.md), download, and copy-path. Chrome/Edge only. |
| v2.6 | Phase 5.1 — Time-in-stage + weekly-trend analytics (adds `statusHistory`, `schemaVersion` → 5). Dashboard gains average dwell time per stage (and the slowest "stalled" stage) and an inline-SVG sparkline of applications per week. |
| v2.7 | Phase 5.2 — Council polish: clearer message when all free Gemini models are unavailable; Merge button disabled with a note when no Gemini key is set. |
| v2.8 | Phase 6.1 — Dark theme ("candlelit ledger"): Light / Dark / System chooser in Settings → Appearance and a command-palette toggle; honors your OS preference, persists your choice. |
| v2.9 | Phase 6.2 — First-run onboarding: a dismissible 3-step card (connect folder → add resume → add first application) that disappears once you're set up. |
| v3.0 | Phase 6.3 — Polished, on-brand empty states across the Dashboard, Applications, Pipeline, and Companies. |
