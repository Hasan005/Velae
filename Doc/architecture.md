# Velae Lite — Architecture

**Current version: v3.0**

This document explains how Velae Lite is built, why the key decisions were made, and the constraints any future change must respect. It is written for a developer or an AI coding agent (e.g. Claude Code) picking up the project cold.

Read the "Invariants & gotchas" section before making changes — it lists the non-obvious things that will break the app if violated.

> **Product note (read once for orientation).** The product is **Velae Lite** — the portable, `file://` edition. It is the flagship and the only edition this repository builds today. Two sibling editions are planned but **out of scope for this codebase**: *Velae Web* (the same frontend served as a static site over `https://`, data still local via the File System Access API) and *Velae Pro* (the same frontend served by a small backend running on the **user's own** machine, unlocking native-OS features like opening a file in Word). All three share one frontend and one interchange format — `data.json`. Versioning is name-as-identity: Lite continues its own `v1.x` line; Pro/Web each get their own version line if and when built. Nothing in this document assumes Web or Pro exists; build for Lite.

---

## 0. Versioning policy (read first if you are making changes)

Velae Lite uses a simple **decimal** version, currently **v2.0**.

**Rule for any future development session:** when you make a meaningful change to the app (a new feature, a behavior change, a fix), **bump the version by 0.1** (… v1.8 → v1.9 → v2.0 → v2.1 …) and add a row to the changelog below. The `0.9 → next whole number` step is normal — **v2.0 is simply the step after v1.9**, with no special "major redesign" meaning. (`schemaVersion` is independent — see below.)

> **History — why the early changelog reads differently.** Through **v1.x**, the policy reserved a whole-number (MAJOR) bump for "a fundamental redesign or a deliberate break in the core portability constraint," with 0.1 MINOR bumps for everything else. That reserved meaning was **deliberately dropped at v2.0**: it added ceremony without value for a single-developer project shipping a feature at a time. From v2.0 onward the version is a **plain decimal odometer** — every meaningful change is +0.1 and whole-number rollovers (v1.9 → v2.0, v2.9 → v3.0) carry no special significance. The v1.0–v1.9 rows below were authored under the old rule; they are left unchanged as an accurate record. Only the *interpretation* of the numbers changed, not the numbers themselves.

As of v2.0 the version string lives in **three** places that must be kept in sync:
1. The `APP_VERSION` constant at the top of `Core/app.js` (the source of truth in code; surfaced in the sidebar and the browser-tab title at boot).
2. The "Current version" line at the top of this file (`Doc/architecture.md`).
3. The version note at the top of `README.md`.

Note that `schemaVersion` inside `data.json` is a **separate** number — it tracks the data shape for migrations, not the app version. Bump `schemaVersion` only when the data shape changes, independently of the app version.

**Keep the architecture honest as you build.** This document describes the system *as it actually is*, not what is planned. A phase of work is not "done" until this file reflects it: when a change alters the data shape, update section 5 and bump `schemaVersion`; when it adds an invariant, add it to section 10; when it adds a code region, update section 6. The development plan (delivered separately) is the *route*; this file is the *map of the territory as built*. Do not paste roadmap/future items here.

### Changelog

| Version | Summary |
|---|---|
| v1.0 | Initial complete app: portable single-folder tracker; applications/companies CRUD; drag-and-drop pipeline board; dashboard (follow-ups, response rate, funnel, activity); search & filter; hybrid persistence (Chrome/Edge auto-save + Safari manual); one-time reconnect via stored IndexedDB folder handle. |
| v1.1 | AI Tailor "council": Gemini (one-click, free) + Claude-via-paste, side-by-side four-tab results, optional merge/judge step; `.docx` resume/cover-letter generation; resume parsing (.docx/.pdf/.txt); automatic timestamped backups (throttled, rolling 30) + "Export everything" zip with CSVs. Project renamed JobTracker → Velae; guiding-star brand mark. |
| v1.2 | User-editable pipeline statuses with `active`/`responded`/`terminal` types driving the dashboard (`meta.statusMeta`, `schemaVersion` 2 + legacy migration); pre-loaded real-world statuses (Under Consideration, Not Selected). Gemini upgraded to free `gemini-3-flash` with a free-tier fallback chain. Docs reconciled; versioning policy introduced. |
| v1.3 | Renamed product to **Velae Lite** and established the Lite / Web / Pro product family (orientation note above). **Folder reorganization:** app code/assets moved into `Core/` (`app.js`, `styles.css`, `vendor/`); documentation moved into `Doc/` (`architecture.md`, `Velae_User_Guide.docx`, `Changelog.md`). `index.html` and all data files (`data.json`, `config.json`, `data.backups/`, `applications/`) remain at the root. No behavior or data-shape change (`schemaVersion` unchanged at 2); paths in `index.html` and the dynamic pdf.js import in `app.js` updated to match. |
| v1.4 | **Fixed PDF resume parsing on `file://`.** pdf.js was vendored as the ESM build (`pdf.min.mjs`) and loaded via dynamic `import()`, which cannot work from `file://` (Chrome resolves a classic script's `import()` base to `about:blank` and blocks fetching ES modules / spawning Workers over `file://`). Replaced it with the pdf.js **v3.11.174 UMD build** (`pdf.min.js` + `pdf.worker.min.js`) loaded via classic `<script>` tags like the other vendored libs; the worker runs on the main thread (fake worker via `window.pdfjsWorker`). `extractResumeFromFile` now uses the `window.pdfjsLib` global instead of `import()`. No data-shape change (`schemaVersion` unchanged at 2). |
| v1.5 | **Undo/redo + recycle bin (Phase 1.1, `schemaVersion` → 3).** In-memory snapshot stack (`State.undo`/`redo`, cap 50) wired to Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Ctrl+Y (suppressed while typing in a field so native text-undo still works). Every data mutation `snapshot()`s before mutating. Deletes are now soft: records move to a persistent `trash` array (recycle bin) auto-purged after 30 days, with restore (re-linking a company's applications) and an Undo toast. Added `trash:[]` migration. |
| v1.6 | **Integrity check & one-click repair (Phase 1.2).** Settings panel scans on load + on demand for orphaned `companyId`, statuses absent from `meta.statuses`, malformed dates, and missing/duplicate ids; "Repair all" fixes them through undo (so a bad repair is reversible). |
| v1.7 | **CSV import (Phase 1.3).** Dependency-free `parseCSV` (quoted fields, embedded commas/newlines, `""` escapes) inverts the `applications.csv`/`companies.csv` exports; auto-creates companies, previews the diff in a modal, and commits through undo. No data-shape change since v1.5. |
| v1.8 | **Profile page (Phase 2.1, `schemaVersion` → 4).** New `profile` object in `data.json` (`name`, `email`, `phone`, `location`, `linkedin`, `portfolio`, `masterResume`) with a dedicated Profile view + nav item. `ensureProfile()` migrates legacy `config.masterResume`/`applicantName` into it and strips them from `config`. The master resume + "your name" relocated out of Settings; the Tailor now reads `profile.masterResume` and feeds the contact block into cover-letter prompts. |
| v1.9 | **Per-application `application.json` (Phase 2.2).** Each app's folder can hold an `application.json` (captured JD + tailored resume/cover-letter text + score/rationale/gaps). The Tailor writes it when a result is produced with an app linked (`persistTailorToApp`), restores it on re-link (`maybeRestoreTailor` — this is Phase 5.2's "persist last tailoring"), and the application form shows it inline (`populateAppDocs`). Chrome/Edge only; Safari degrades to a hint. Separate file — **no `data.json` shape change** (`schemaVersion` stays 4); the `.docx` deliverables are still generated. |
| v2.0 | **Version display.** Added an `APP_VERSION` constant in `Core/app.js` (now the in-code source of truth) surfaced in the sidebar (under the wordmark) and the browser-tab title at boot. Versioning switched to a plain decimal scheme — v1.9 rolls to v2.0, no reserved "major redesign" meaning — and the version now lives in three synced places (see §0). No data-shape change. |
| v2.1 | **Command palette (Phase 3.1).** ⌘K / Ctrl+K opens a filtered command list (`openCommandPalette` over `commandRegistry`) with type-to-filter and ↑/↓/Enter selection: navigate to any view, new application, run tailor, exports, backup, undo/redo, connect folder. Guarded so it won't open over another modal. No data-shape change. |
| v2.2 | **Keyboard navigation (Phase 3.2).** Global plain-key shortcuts (suppressed while typing or when a modal is open): number keys `1–9` jump to nav items in order, `/` focuses the Applications search, `n` opens a new application. Nav switching refactored into `setView`. |
| v2.3 | **Calendar export (Phase 3.3).** `.ics` (RFC 5545) export of follow-up dates — one all-day VEVENT per non-terminal application with a `followUpDate`, plus a 9am VALARM. Dependency-free `buildICS` with text escaping and ≤75-octet line folding (`icsFold`); exposed in Settings → Data & backups and the command palette. No data-shape change. |
| v2.4 | **Sectioned application form (Phase 4.2).** `openAppForm` regrouped into Role & company / Status & timeline / Documents / Notes sections (same fields + `saveAppForm` logic, restructured markup). Added a **Notes** UI that appends timestamped entries to the existing `notesLog` (previously schema-only, no UI). (Phase 4.1 "resume removable" already shipped in v1.8 on the Profile page.) No data-shape change. |
| v2.5 | **In-app document panel (Phase 4.3).** The Documents section lists the real files in an application's folder via the directory handle (`populateFolderFiles`), with inline **Preview** (`.docx` via mammoth, `.pdf` via pdf.js, `.txt`/`.md`), **Download**, and copy-folder-path. Complements the v1.9 captured-text view. Chrome/Edge only (gated on `State.dirHandle`); Safari shows a hint. No data-shape change. |
| v2.6 | **Time-in-stage + trend analytics (Phase 5.1, `schemaVersion` → 5).** Added per-application `statusHistory[]` (`recordStatus` on every status change via `moveCard`/`saveAppForm`; empty on migration). `computeStats` now derives average dwell time per status (and the "stalled" slowest stage) and an 8-week applications-per-week trend; the dashboard gains a **Time in stage** card and a **Weekly trend** inline-SVG sparkline (`sparkline`, no charting lib). |
| v2.7 | **Council polish (Phase 5.2).** Clearer error when the whole `GEMINI_MODELS` fallback chain is exhausted (names the tried models + points at the constant). The **Merge** button is disabled with an explanatory note when no Gemini key is set (merge uses Gemini as judge). (Phase 5.2's "persist last tailoring" already shipped in v1.9.) No data-shape change. |
| v2.8 | **Dark theme (Phase 6.1).** A "candlelit ledger" palette behind `[data-theme="dark"]`, built entirely from the existing CSS tokens (audited all hard-coded colors into tokens: `--seal-deep`, `--on-seal`, `--tag-*-bg`). Light / Dark / **System** chooser in Settings → Appearance + a command-palette toggle; choice persists in `localStorage` (`velae_theme`) and mirrors to `config.theme` so it travels with the folder; first run honors `prefers-color-scheme`, with a live listener for system changes. No `data.json` shape change (optional `config.theme` field, no migration). |
| v2.9 | **First-run onboarding (Phase 6.2).** A dismissible 3-step card (connect folder → add master resume → add first application) that reflects live state and disappears when complete; shown on the dashboard and in the no-data notice. Dismiss state in `localStorage` (`velae_onboard`). No data-shape change. |
| v3.0 | **Empty-state polish (Phase 6.3).** Replaced the italic one-liners on Dashboard, Applications, Pipeline, and Companies with on-brand `emptyStatePanel`s (guiding-star mark, title, hint, action button). No data-shape change. |

---

## 1. What Velae Lite is

Velae Lite is a **portable, offline, single-folder job-search manager**. It tracks applications, runs an AI "council" to tailor resumes and cover letters, shows a drag-and-drop pipeline board, and surfaces a dashboard of follow-ups and stats.

The entire application — code and data — lives inside one folder. You can copy that folder to a flash drive and open it on any Windows or Mac machine with no installation, no server, and no account. The only network calls are the optional, user-initiated requests to an AI provider (Gemini) when tailoring.

---

## 2. The defining constraint

Every architectural decision flows from one requirement:

> **The app must run by double-clicking `index.html` from a folder (a `file://` URL), with no build step, no server, and no installation, on both Windows and Mac.**

This rules out: a backend, a bundler/transpiler, npm dependencies resolved at runtime, frameworks requiring a build (React/Vue/etc.), and any database engine that needs a process. It is why the stack is vanilla HTML/CSS/JS with libraries vendored as plain files. **Do not introduce a build step or a server dependency** without explicitly revisiting this constraint with the owner — it is the product's core promise, not an accident.

(The planned *Velae Pro* edition intentionally relaxes this with a user-local backend, and *Velae Web* serves the same files over `https://` — but both are separate efforts. This codebase is Lite and must honor the constraint above.)

---

## 3. Technology stack

- **HTML / CSS / vanilla JavaScript** — no framework, no build. One `app.js` IIFE, one `styles.css`, one `index.html`.
- **Browser APIs**: File System Access API (folder read/write), IndexedDB (remembering the folder handle), Blob/`<a download>` (Safari fallback + exports), native HTML5 drag-and-drop, `fetch` (AI calls).
- **Vendored libraries** (in `Core/vendor/`, loaded locally, never from a CDN at runtime):
  - `mammoth.browser.min.js` — extract text from uploaded `.docx` resumes. Global: `window.mammoth`.
  - `pdf.min.js` + `pdf.worker.min.js` — extract text from uploaded `.pdf` resumes (pdf.js **v3.11.174 UMD build**). Loaded via classic `<script>` tags. Global: `window.pdfjsLib`; the worker script registers `window.pdfjsWorker`. **Must be the UMD build, not the ESM `.mjs` build:** dynamic `import()` of an ES module cannot load from `file://` (the classic-script `import()` base is `about:blank` and `file://` module/Worker fetches are blocked). pdf.js runs its worker on the main thread (fake worker) because Workers can't spawn from `file://` either.
  - `docx.umd.js` — generate `.docx` resume/cover-letter output. Global: `window.docx`.
  - `jszip.min.js` — build the "Export everything" zip. Global: `window.JSZip`.

All are standard UMD browser builds loaded via classic `<script>` tags. They attach to `window` in a browser even though they detect CommonJS under Node — this is expected; do not "fix" it. **Do not switch any of these to an ESM (`.mjs`) build loaded via `import()`** — ES-module `import()`, `fetch`, and `Worker` are all blocked over `file://`, which is the product's core constraint (see §2).

---

## 4. File layout

As of v1.3, application code and documentation are organized into subfolders, while the entry point and all data stay at the root. **The user connects the root folder; everything the app reads/writes as data is resolved relative to that root, not relative to the code.**

```
Velae/                       <- the folder the user connects (root)
|- index.html                Entry point. KEEP THIS NAME (web-host default doc + convention).
|                            Sidebar shell; loads Core/styles.css, Core/vendor/*, Core/app.js.
|- README.md                 End-user setup notes. Stays at root (convention; GitHub auto-renders).
|- Core/                     APP CODE & ASSETS (safe to nest)
|   |- app.js                The entire application (one IIFE).
|   |- styles.css            All styling. "Ledger" aesthetic; design tokens are CSS vars at top.
|   '- vendor/               Vendored libraries (see section 3). Offline, portable.
|- Doc/                      DOCUMENTATION (safe to nest)
|   |- architecture.md       This file.
|   |- Velae_User_Guide.docx
|   '- Changelog.md
|- data.json                 DATA - the "database", all structured data (see schema below). ROOT.
|- config.json               DATA - API keys ONLY. Created at runtime; kept separate on purpose. ROOT.
|- data.backups/             DATA - auto-written timestamped snapshots of data.json (rolling 30). ROOT.
'- applications/             DATA - one subfolder per application; tailored .docx + posting. ROOT.
    '- 2026-07_Company_Role/
        |- application.json     captured JD + tailored text (see §5); written by Tailor
        |- resume_*.docx
        |- cover-letter_*.docx
        '- job-posting.pdf      (user-placed)
```

**Why the split is drawn here (important):** code/asset files (`Core/`) and docs (`Doc/`) are *app* files and may be relocated freely — the only cost is updating the references in `index.html` and the dynamic pdf.js `import()` path in `app.js`. The *data* files (`data.json`, `config.json`, `data.backups/`, `applications/`) must remain at the connected-folder root: they are the user's data and the cross-edition interchange contract, and moving them would break every existing user's connected folder. **Reorganize the app; never reorganize the data.**

`index.html` keeps its exact name: it is the default document a static host/browser serves for a folder or domain (which the planned Web edition relies on), and it is the conventional entry-point signal. For a branded click target, a `Velae.url` / `Velae.command` shortcut at the root is acceptable — do not rename the entry file.

---

## 5. Data model

There is **no database**. All structured data is a single JSON object persisted to `data.json`. This is deliberate (see section 8). The shape:

```jsonc
{
  "schemaVersion": 5,
  "meta": {
    "appName": "Velae",
    "lastSaved": "<ISO timestamp>",
    "statuses": ["Wishlist","Applied","Under Consideration","Phone Screen","Interview","Offer","Not Selected","Closed"],
    "statusMeta": {
      "Wishlist": "active", "Applied": "active",
      "Under Consideration": "responded", "Phone Screen": "responded",
      "Interview": "responded", "Offer": "responded",
      "Not Selected": "terminal", "Closed": "terminal"
    }
  },
  "profile": {   // schemaVersion 4: identity + master resume (was config.masterResume / applicantName)
    "name": "...", "email": "...", "phone": "...", "location": "...",
    "linkedin": "...", "portfolio": "...",
    "masterResume": "<plain text>"
  },
  "config": {
    "model": "claude-opus-4-8",   // label used in the paste-prompt only; keys-adjacent settings only
    "theme": "system"             // optional (v2.8): "light" | "dark" | "system"; localStorage is the primary store
  },
  "companies": [
    {
      "id": "co_xxxxxxx",
      "name": "...", "website": "...", "notes": "...",
      "contacts": [ { "id": "ct_xxx", "name": "...", "role": "...", "email": "...", "phone": "..." } ]
    }
  ],
  "applications": [
    {
      "id": "app_xxxxxxx",
      "companyId": "co_xxxxxxx",   // FK into companies; "" if unlinked
      "role": "...", "location": "...", "source": "...", "url": "...",
      "salaryRange": "...",
      "status": "Applied",          // must be one of meta.statuses
      "dateApplied": "YYYY-MM-DD", "followUpDate": "YYYY-MM-DD",
      "folder": "applications/2026-07_Company_Role",  // path string only, not contents
      "notesLog": [ { "id": "n_xxx", "ts": "<ISO>", "text": "..." } ],
      "statusHistory": [ { "status": "Applied", "ts": "<ISO>" } ]  // schemaVersion 5: time-in-stage analytics
    }
  ],
  "trash": [   // schemaVersion 3: recycle bin (soft delete), auto-purged after 30 days
    {
      "kind": "application",        // "application" | "company"
      "item": { /* full cloned record, as above */ },
      "linkedAppIds": ["app_xxx"],  // company entries only: apps to re-link on restore
      "deletedAt": "<ISO timestamp>",
      "label": "Role · Company"     // human-readable, for the recycle-bin list
    }
  ]
}
```

Notes:
- **API keys are NOT in `data.json`.** They live in `config.json` (`{ "apiKey": "...", "geminiKey": "..." }`) so the data file can be shared/backed up without leaking secrets. Keep this separation.
- IDs are generated by `uid(prefix)` — `prefix + "_" + base36 random`. Not cryptographic; fine for a single-user local app.
- The `folder` field is just a **path string**. Tailored documents are real files on disk inside that folder, never embedded in `data.json`. This keeps the JSON small regardless of how many documents accumulate.
- **`profile` (schemaVersion 4)** holds the user's identity (`name`, `email`, `phone`, `location`, `linkedin`, `portfolio`) and the `masterResume`. It was promoted out of `config` — `ensureProfile()` (run on load via `ensureConfig`) moves legacy `config.masterResume` → `profile.masterResume` and `config.applicantName` → `profile.name`, then deletes them from `config`. The Tailor reads `profile.masterResume` + contact details; `config` now holds only `model` (keys live in `config.json`).
- **`trash` (schemaVersion 3)** holds soft-deleted applications/companies. Deletes move a deep clone here instead of dropping the record; `purgeTrash()` (run on load via `ensureConfig`) removes entries older than `TRASH_TTL_DAYS` (30). Restoring re-adds the record; restoring a company re-links the applications named in `linkedAppIds`. This is **separate from undo** — undo is an in-memory session stack (`State.undo`/`State.redo`), the recycle bin persists in `data.json`.
- **Per-application `application.json` (schemaVersion 4 feature, but a *separate file* — not part of the `data.json` schema).** Each application's folder may hold an `application.json` capturing bulky per-app text as plain JSON (so it renders inline without opening binaries — see invariant #7): `{ jobDescription, tailoredResume, coverLetter, matchScore, rationale, gaps[], savedAt, source }`. The Tailor writes it (`persistTailorToApp`) when a result is produced with an app linked; the application form reads it (`readAppData` → `populateAppDocs`) and the Tailor restores it on re-link (`maybeRestoreTailor`). **Chrome/Edge only** (needs the directory handle); Safari degrades to a hint. The `.docx` deliverables are still generated separately — `application.json` is the viewable/restorable data, not a replacement for them.
- **`statusHistory` (schemaVersion 5)** is a per-application append-only log of `{ status, ts }` entries driving the dashboard's **time-in-stage** analytics. `recordStatus(a, status)` appends an entry (deduping consecutive repeats) whenever a status changes — `moveCard` (board drag) and `saveAppForm` (edit or new-app seed). Migration adds an empty `[]` to existing apps, so their analytics read "—" until they next move (no back-dating). Completed dwell times come from consecutive entries; the last entry is the current stage (open-ended).
- `schemaVersion` exists for migrations. v1→v2 added `statusMeta`; v2→v3 added `trash`; v3→v4 added `profile` (promoting `config.masterResume`/`applicantName`); v4→v5 added `statusHistory`. All migrations are idempotent and run on load. If you change the `data.json` shape, bump it and add a migration on load. (Bulky per-app text goes in the folder's `application.json`, **not** here — see invariant #7.)

---

## 6. Code organization (`app.js`)

Everything is inside one IIFE to avoid leaking globals. Top-to-bottom, the major regions (search for the banner comments):

| Region | Responsibility |
|---|---|
| capability detection | `HAS_FS` = is File System Access API available (Chrome/Edge yes, Safari no). |
| state | The single `State` object — `data`, `dirHandle`, `fileHandle`, keys, `view`, `tailor`, `filter`, `undo`/`redo` (snapshot stacks), `integrity` (last scan). |
| seal / save indicator | `setSeal`, `markDirty`, `markClean` — drive the wax-seal status UI. |
| persistent folder handle (IndexedDB) | `idbGet/Set/Del`, `tryRestoreFolder`, `showReconnect`, `reconnectSaved`. |
| persistence: Chrome/Edge | `connectFolder`, `openDirHandle`, `writeFile`. |
| automatic backups | `maybeBackup` (throttled), `writeBackup`, `pruneBackups`, `backupNow`. |
| persistence: Safari fallback | `downloadData`, `loadFromFile`, `onFilePicked`. |
| CONFIG / PROFILE | `loadConfigKey`, `writeConfigFile`, `saveConfigKey`, `saveGeminiKey`, `hasKey`, `hasGemini`; `ensureProfile` (schemaVersion-4 migration). |
| EXPORT EVERYTHING | `exportEverything`, `applicationsCSV`, `companiesCSV`. |
| CALENDAR EXPORT | `exportICS`, `buildICS`, `icsFollowups`, `icsEscape`, `icsFold` (RFC 5545 `.ics` of follow-up dates; line-folded ≤75 octets). |
| DATA SAFETY | `snapshot`/`undo`/`redo` (in-memory ring buffer, cap `UNDO_LIMIT`), `toast`; recycle bin (`purgeTrash`, `restoreFromTrash`, `purgeTrashItem`, `emptyTrash`); integrity (`checkIntegrity`, `repairAll`); CSV import (`parseCSV`, `planApplicationsImport`/`planCompaniesImport`, `showImportPreview`, `commitImport`). |
| RESUME PARSING | `extractResumeFromFile` (.docx via mammoth, .pdf via pdf.js, .txt/.md). |
| PROMPT | `buildTailorPrompt`, `parseTailorJSON`, `buildMergePrompt`. |
| AI CALL | `callClaude` (unused in council; kept for reference), `callGemini`. |
| DOCX GENERATION | `textToDocxBlob`, `saveDocx`, `resolveAppFolder`. |
| PER-APP DATA FILE | `writeAppData`/`readAppData` (`application.json` in the app folder), `persistTailorToApp`, `maybeRestoreTailor`, `populateAppDocs`. Chrome/Edge only. |
| TAILOR — council | `runGemini`, `applyPastedResponse`, `copyPrompt`, `mergeResults`, `clearTailor`, status helpers. |
| Views | The `Views` object: one entry per screen (`dashboard`, `applications`, `pipeline`, `companies`, `tailor`, `profile`, `settings`), each a `render()` returning an HTML string. |
| APPLICATION FORM | `openAppForm` (sectioned modal: Role & company / Status & timeline / Documents / Notes), `saveAppForm` (appends `notesLog` entries), `deleteApp`; in-folder file panel (`populateFolderFiles`, `previewFolderFile`, `downloadFolderFile`, `getAppDirRead`) — Chrome/Edge. |
| COMPANY FORM | `openCoForm`, `deleteCompany` (modal, with contacts). |
| DASHBOARD STATS | `computeStats` — all derived metrics incl. time-in-stage (avg dwell per status, "stalled" stage) + 8-week trend; `sparkline` (inline-SVG); `recordStatus` logs status changes. |
| PIPELINE BOARD | `bindBoard`, `bindTouchDrag`, `moveCard`. |
| render / bind / nav / boot | `render`, `bindViewEvents`, `bindResultTabs`, `setView`/`bindNav`, `boot`; command palette (`openCommandPalette`, `commandRegistry`); global keydown (⌘K palette, undo/redo, plain-key nav: number keys, `/`, `n`); theme (`themeMode`/`resolveTheme`/`applyTheme`/`setThemeMode`/`toggleTheme`); onboarding (`renderOnboarding`/`onboardingState`/`shouldShowOnboarding`/`dismissOnboarding`); `emptyStatePanel`. |

---

## 7. Rendering model

Velae Lite uses a **string-render + rebind** pattern, not a reactive framework. Understand this before touching the UI:

1. `render()` looks up `Views[State.view].render()`, which returns an HTML string, and sets it as `#viewBody.innerHTML`.
2. Because `innerHTML` replaces DOM nodes, **all event listeners are lost on every render**. So `render()` then calls `bindViewEvents()`, which re-attaches listeners for the current view by `id`/`data-` attribute.
3. State changes call `markDirty()` (which triggers a save) and then `render()` to repaint.

Implications for any change:
- If you add an interactive element to a view, you **must** add its listener in `bindViewEvents()` under the matching `State.view` branch. A handler defined only in the view string will not fire.
- Inputs that must keep focus across re-render (e.g. the Applications search box) save/restore `selectionStart` manually — see the `#fltQ` handler for the pattern.
- Modals are rendered into a separate `#modalHost` and bind their own listeners at open time (they are not re-rendered by `render()`).

This pattern is simple and dependency-free but does not scale to a very large UI. If the app grows substantially, the right refactor is to introduce a small reactive layer — but that likely means accepting a build step, which breaks the core constraint. Discuss before doing so.

---

## 8. Persistence — the two-path model

Saving differs by browser capability (`HAS_FS`):

**Chrome / Edge (File System Access API):**
- User clicks "Connect folder" once → `showDirectoryPicker()` → handle stored in IndexedDB.
- `data.json` is read/written directly. Every `markDirty()` debounces a `writeFile()` (auto-save).
- The folder handle is remembered across sessions in IndexedDB, but the browser still requires **one permission click per session** before write access resumes — this is `tryRestoreFolder()` → `showReconnect()` → `reconnectSaved()`. This single click is a browser security requirement and cannot be removed.

**Safari / Firefox (no File System Access API):**
- No silent disk access. The user clicks "Save" → `data.json` downloads via a Blob; they place it in the folder. "Load file" reads it back via a file input.
- Keys are held in memory only for the session (not written to `config.json`).

The same `data.json` format works in both paths, so a folder edited in Chrome opens cleanly in Safari and vice versa. (The richest experience is on Chrome/Edge; this is stated for users in `README.md`.)

### Backups
On the Chrome/Edge path, `writeFile()` calls `maybeBackup()`, which writes a timestamped copy to `data.backups/` — **throttled to one per ~4 minutes** (so keystroke-level autosaves don't flood the folder) and **pruned to the most recent 30**. Backups are best-effort and never block the main save.

---

## 9. The AI "council"

Tailoring compares the master resume against a pasted job description and returns four things: a match score + rationale, a gap analysis, a tailored resume, and a cover letter. Two engines can run side by side:

- **Gemini** (`callGemini`) — one-click, free tier. Direct browser `fetch` to `generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` with an `x-goog-api-key` header. Works from `file://` because Google's endpoint supports CORS. `callGemini` tries each model in `GEMINI_MODELS` (currently `gemini-3-flash` → `gemini-3.1-flash-lite` → `gemini-2.5-flash`, all free-tier) in order, falling through only on "model not found / unsupported" errors and stopping immediately on auth/quota errors. Google retires and renames free models frequently, so keep this list current; deliberately avoid paid models (e.g. 3.5 Flash, any Pro) to preserve the no-cost guarantee.
- **Claude via paste** (`copyPrompt` + `applyPastedResponse`) — no key, no cost. The app builds the prompt; the user runs it in claude.ai and pastes the JSON back.

`buildTailorPrompt()` instructs the model to return **only** a strict JSON object. `parseTailorJSON()` is intentionally tolerant — it strips code fences and extracts the outermost `{...}` block — because pasted output from a chat UI often has preamble/markdown. Keep that tolerance.

**Merge / judge step:** when both results exist, `mergeResults()` sends both to Gemini via `buildMergePrompt()` to synthesize a single best version. Results are stored in `State.tailor.results` keyed `gemini` | `paste` | `merged`, and each renders an independent four-tab panel via `renderTailorResult(r, key)`. Save filenames are suffixed by key (`_gemini`, `_paste`; merged is unsuffixed) so they never overwrite.

Note: `callClaude()` exists (direct Anthropic API, needs the `anthropic-dangerous-direct-browser-access` header) but is **not wired into the council**, which uses Gemini + paste. It is kept as a reference implementation if a paid one-click Claude path is ever desired.

---

## 10. Invariants & gotchas (read before changing anything)

1. **No build step, no server, no runtime npm.** Must keep working from `file://`. Vendored libs only.
2. **Do not rename `data.json`, `config.json`, or the IndexedDB name `"jobtracker"`.** The IDB name is intentionally the old project codename — changing it orphans every user's saved folder handle (they'd have to reconnect and could appear to "lose" their connection). It is an internal id, never shown to users. There is a comment at its definition saying exactly this.
3. **Keep API keys out of `data.json`.** They belong in `config.json` so data can be shared without leaking secrets.
4. **After any `innerHTML` render, listeners must be rebound** in `bindViewEvents()`. See section 7.
5. **`status` values must come from `meta.statuses`, and each needs a type in `meta.statusMeta`** (`active` | `responded` | `terminal`). The dashboard's response-rate math reads these types, not hard-coded names — `isResponded()`/`isTerminal()` consult `statusMeta`. Statuses are user-editable in Settings (add/rename/reorder/delete); **renaming migrates all applications that use the status, and deleting requires reassigning any applications first** (see `renameStatus`/`deleteStatus`). `ensureStatusMeta()` runs on load and migrates legacy schema-v1 data (string-only statuses) by inferring types via `inferType()`.
6. **Deleting a company unlinks its applications (`companyId = ""`), it does not delete them.** Preserve this; users rely on not losing application history. As of v1.5, deletes are also *soft*: the record is cloned into `trash` (recycle bin) before removal.
7. **Tailored documents are files on disk, not data in JSON.** `data.json` stores only the folder path. Don't embed document contents in it. As of v1.9 this principle is realized by **`application.json`** (per-app folder file: captured JD + tailored resume/cover-letter *text*, see §5) — bulky per-application text goes there, keeping `data.json` small. Extend this for any future bulky per-app content; never grow `data.json` with it. (Profile data, by contrast, is small and single-instance, so it lives *in* `data.json` under `profile` — the contrast is deliberate.)
8. **`parseTailorJSON` must stay tolerant** of fenced/preamble-wrapped JSON, because paste-mode input comes from a chat UI.
9. **`Core/vendor/*` UMD globals attaching under `window` (not Node `module.exports`) is correct** in the browser. Don't "fix" the CommonJS branch.
10. **Backups are throttled and pruned.** If you change save frequency, re-check `BACKUP_MIN_INTERVAL_MS` and `BACKUP_KEEP` so the folder doesn't flood.
11. **Reorganize the app, never the data.** Files under `Core/` and `Doc/` may move (update references in `index.html` and the pdf.js worker path resolved via `document.baseURI` in `app.js`). `data.json`, `config.json`, `data.backups/`, and `applications/` must stay at the connected-folder root — they are user data and the cross-edition interchange contract. `index.html` keeps its name (web-host default document + convention).
12. **No ES modules, `import()`, `fetch`, or `Worker` over `file://`.** Chrome blocks all of these for `file://` documents (opaque origin): a classic script's `import()` base resolves to `about:blank`, and module/`fetch`/`Worker` loads of `file://` URLs fail. Vendor libraries as **UMD classic-script builds** only (see §3). pdf.js specifically runs its worker on the main thread (fake worker) for this reason. This is why v1.4 replaced the ESM pdf.js build with the UMD one.
13. **Every data mutation calls `snapshot()` *before* mutating** (v1.5+). `snapshot()` deep-clones `State.data` onto the undo stack and clears redo; place it after all validation/cancel guards but before the first write, so a cancelled action doesn't disturb undo/redo (see `deleteStatus`). The mutations currently wrapped: `deleteApp`, `deleteCompany`, `saveAppForm`, `moveCard`, the company save handler, `addStatus`/`renameStatus`/`setStatusType`/`moveStatus`/`deleteStatus`, and `commitImport`/recycle-bin ops. Any new mutation must do the same or it won't be undoable. Snapshots **must** deep-clone (`structuredClone`), never hold a reference, or undo is hollow.
14. **Integrity repairs and CSV imports route through `snapshot()`/undo**, and imports preview before committing — never mutate silently. Keep `parseCSV` tolerant of quoted fields, embedded commas/newlines, and `""` escapes (it round-trips the `csvCell` export format).

---

## 11. How to extend it (common tasks)

**Add a field to applications:** add it to the `data.json` sample + schema (section 5), add an input in `openAppForm()`, persist it in `saveAppForm()`, and display it in the `applications` view's row (and the pipeline card if relevant).

**Add a new view/screen:** add a key to the `Views` object with a `render()` returning HTML; add a nav button in `index.html`; add a `State.view === "<name>"` branch in `bindViewEvents()` for its listeners.

**Add a new AI provider:** write a `callX(prompt)` returning text (mirror `callGemini`); add a key field in Settings + `config.json` plumbing; add it to `State.tailor.providers` and the council toggle/run logic.

**Add a new export format:** extend `exportEverything()` (it already builds a zip with JSZip) or add a sibling function.

**Add `.ics` follow-up export / CSV import:** natural next features. Follow-up dates already exist on applications; an `.ics` generator would iterate `applications` with a `followUpDate`.

**Add bulky per-application content (e.g. captured job description, tailored documents as text):** store it as a file in the application's own folder (resolve via `resolveAppFolder(app.folder)`), not inside `data.json` — see invariant #7. On Chrome/Edge it is read/written via the directory handle; on Safari it degrades, consistent with the rest of the app.

---

## 12. Testing

There is no test framework (kept dependency-free). The project was validated during development with small Node scripts that stub the DOM/`window` and exercise pure logic (stats math, CSV escaping, the JSON parser, council orchestration, CRUD). If developing further with Claude Code, a reasonable step is to formalize these into a `test/` folder runnable with `node`, stubbing browser globals — but keep it out of the shipped folder so the app stays clean and portable.

For UI changes, the practical check is: open `index.html` in Chrome, connect a folder, and exercise the changed view. Watch the browser console for errors. After any schema migration, also load a pre-migration `data.json` and confirm a clean upgrade with no data loss.

---

## 13. Known limitations (by design, not bugs)

- **Single user, last-write-wins.** No concurrency control. Two tabs editing at once would clobber. Fine for one person.
- **No version history beyond the rolling backups.** Roll back by copying a `data.backups/` file over `data.json`.
- **Folder links are path strings.** Manually renaming an application folder on disk breaks its link; let the app name/create folders.
- **Stats are meaningful only after applications move through the pipeline.** A fresh batch all at "Applied" shows 0% response rate — expected.
- **Free-tier Gemini may use submitted text** to improve Google's products; the UI warns users not to paste sensitive data.

If the project ever outgrows the portable-single-user model (multi-device sync, multiple users, heavy analytics), the right move is a real backend + database — at which point it is the *Velae Pro* edition (user-local backend) or a hosted service, designed as its own effort and likely reusing the data model in section 5 as the schema.
