## Two ways to use Velae Lite

**▸ Try it live —** [hasan005.github.io/Velae](https://hasansmr.github.io/Velae/)
Open it in your browser, nothing to download. On **Chrome or Edge**, click
*Connect folder* and your data auto-saves to a folder you pick — it never
leaves your machine and never touches any server. (Velae has no backend; the
page just runs locally in your browser.)

**▸ Or download the portable version —** click the green **Code ▸ Download ZIP**
button above, unzip it anywhere — a flash drive, an SSD, any folder — and
double-click `index.html`. Same app, fully offline, no internet needed after
download. Ideal for keeping your whole job search on a drive you carry with you.

> **Browser note:** Chrome and Edge give the full experience (automatic
> saving to your folder). Safari and Firefox work too, but save manually via
> the *Save* / *Load file* buttons — use those to keep a `data.json` you move
> in and out of the folder yourself.

---

# Velae Lite — Setup & Guide

**Version 3.0**

A portable, single-folder job-application tracker with an AI **Tailor** panel.
Everything lives in this folder — keep it on a flash drive or SSD and open it on
Windows or Mac. No install.

## Open it
Double-click `index.html`.

- **Chrome / Edge:** click **Connect folder** → pick this Velae folder
  once. Your data auto-saves to `data.json`. The folder is remembered, so next
  time you open the app you'll see **Reconnect folder** — one click (and an
  "allow" confirmation) resumes auto-save without re-picking. The browser
  requires that single click each session for security; it can't be skipped.
- **Safari:** use **Load file** / **Save** to manage `data.json` by hand.
  Tailored documents download to your Downloads folder; drop them into the
  matching application folder yourself.

## Set up the Tailor panel (one time)

1. Go to **Profile**.
2. Add your **master resume** — paste text, or upload a `.docx` / `.pdf`.
   It's stored once and reused for every job.
3. Fill in your **contact details** (name, email, phone, location, LinkedIn,
   portfolio) — the AI uses them to round out cover letters. All optional.
4. Go to **Settings** and add your free **Gemini API key** (see below) for
   one-click tailoring, and/or use **Claude via paste** (no key needed — the app
   builds a prompt you run in Claude.ai and paste back).

## Use it

The **Tailor** page runs a "council" of AI engines so you can compare and merge:

1. (Optional) link the run to an application so files save into its folder.
2. Under **Council**, pick engines: **Gemini** (free, one-click — needs a Gemini
   key in Settings) and/or **Claude via paste** (free, manual through Claude.ai).
3. Paste the job description.
4. Run **Gemini** and/or **Copy prompt → paste into Claude.ai → paste the JSON
   back**. Results appear side by side, each with four tabs: match score, gaps,
   tailored resume, cover letter.
5. With both present, click **⚖︎ Merge best of both** — Gemini acts as judge and
   synthesizes the strongest single version.
6. Save any version's resume/cover letter as `.docx`. Filenames are tagged by
   source (`_gemini`, `_paste`) so they don't overwrite; the merged version is
   the canonical un-suffixed file.

### Captured documents per application (Chrome / Edge)

When you run the Tailor **with an application linked**, Velae also saves an
`application.json` inside that application's folder — the captured job
description plus the tailored resume and cover letter as plain text. This means:

- **Re-link the application in Tailor later** and your last run comes back, ready
  to view or re-save — no need to re-run the AI.
- **Open the application** (Applications → click a row) and you'll see a
  **Captured documents** section showing the job description and tailored text
  inline. The job description stays readable even if the original posting is
  taken down — handy at interview time.

This needs a connected folder (Chrome/Edge). On Safari this feature is reduced.
The `.docx` files you actually email are still saved separately as before.

### Gemini key setup
Get a free key at aistudio.google.com → Create API key (your existing "My First
Project" is fine). Velae uses Google's free `gemini-3-flash` model — no billing
needed. If a request is ever rejected with a permission error, add an API
restriction to the key (restrict it to the "Generative Language API") in Google
Cloud Console; many free keys work without this, so try it first.

## Security & keys

- API keys live in a separate `config.json` in this folder — never in
  `data.json` — so you can share or back up your data without leaking secrets.
- The Gemini key sits **unencrypted** in `config.json` on this drive. If the
  drive is lost, revoke the key at aistudio.google.com.
- Free-tier Gemini may use submitted text to improve Google's products; the app
  warns you not to paste anything sensitive. Your resume and a public job
  description are generally fine.
- Costs: the Gemini free tier and Claude-via-paste are both $0. (An optional
  Anthropic key field exists for a paid one-click Claude path, but isn't needed.)

## Track applications

Go to **Applications** → **New application**. The form is grouped into
**Role & company**, **Status & timeline**, **Documents**, and **Notes**. Fill in
the role, pick or type a company (new companies are created automatically), set
status, dates, source, URL, and salary. The folder name auto-generates as
`YYYY-MM_Company_Role`; on Chrome/Edge the subfolder is created on disk when you
save. Edit or delete any application from its row. Deleting a company unlinks its
applications rather than deleting them.

- **Notes** — add a timestamped note at the bottom of the form; past notes are
  listed there too.
- **Documents** (Chrome/Edge) — the form lists the real files in the
  application's folder. **Preview** a `.docx` / `.pdf` / `.txt` inline,
  **Download** the exact file you'll email, or **copy the folder path**. The
  captured job description and tailored text (from the Tailor) also show here.

Manage companies, notes, and contacts under **Companies**.

### Customizing your pipeline statuses
Under **Settings → Pipeline statuses** you can add, rename, reorder, and delete
the funnel stages to match your real process (e.g. "Under Consideration", "Not
Selected"). Each status has a **type** that drives the dashboard: *active* (in
progress), *responded* (counts as "heard back"), or *terminal* (closed out).
Renaming a status updates every application using it; deleting one asks you to
reassign its applications first, so nothing is ever orphaned.

## Pipeline board

**Pipeline** shows every application as a card in a column for its status. Drag
a card to another column to change its status (saves immediately). Click a card
to edit it. A ▲ marks a follow-up date, shown red if it's overdue. Works with
mouse or touch.

## Dashboard & search

**Dashboard** computes everything from your real data: upcoming and overdue
follow-ups (click one to open it), response rate (heard back ÷ applied), offer
rate, active count, a pipeline funnel, and activity over the last 7/30 days.
Stats populate as you add applications with dates and statuses.

It also shows **Time in stage** — the average number of days your applications
spend in each status, highlighting the slowest ("stalled") stage so you can see
where things get stuck — and a **Weekly trend** sparkline of applications per
week over the last 8 weeks. Time-in-stage builds up as you move applications
through the pipeline; applications you added before this version begin tracking
from their next move.

**Applications** has a search box plus status and company filters, so a large
pile stays navigable. Search matches role, company, location, source, status,
and URL.

## Notes on the stats

- Status **types** drive the math: "Applied" counts anything past the first
  stage (Wishlist); "heard back" counts any *responded*-type status (Under
  Consideration, Phone Screen, Interview, Offer). So response/offer rates only
  mean something once you've moved cards through the pipeline.
- Follow-up reminders only show for non-*terminal* applications (not Not
  Selected or Closed) that have a follow-up date set.
- You can customize statuses and their types under **Settings → Pipeline
  statuses** (see above).

## Speed: command palette & keyboard shortcuts

- **Command palette** — press **Ctrl/⌘ + K** to open a searchable list of every
  action: jump to any page, add an application, run a tailoring, export, back up,
  undo/redo, connect a folder. Type to filter, **↑/↓** to choose, **Enter** to run.
- **Quick keys** (when you're not typing in a box): number keys **1–7** switch
  pages in sidebar order, **/** jumps to Applications and focuses the search box,
  and **n** starts a new application. **Esc** closes any dialog.

## Appearance

Under **Settings → Appearance**, pick **Light**, **Dark** (a warm "candlelit
ledger" theme), or **System** (follows your OS setting). You can also toggle
light/dark from the command palette. Your choice is remembered on this computer
and travels with your folder.

First time in? A short **welcome card** walks you through connecting your folder,
adding your master resume, and creating your first application. It disappears
once you're set up (or dismiss it anytime).

## Backups & export

On Chrome/Edge with a connected folder, every save also writes a timestamped
copy to `data.backups/` (at most one every few minutes; the 30 most recent are
kept, older ones pruned automatically). If anything goes wrong, copy a backup
over `data.json` to roll back.

Under **Settings → Data & backups**:
- **Export everything** downloads a ZIP with `data.json` (re-importable via Load
  file), plus readable `applications.csv` and `companies.csv`. Tailored
  documents stay in their application folders — they're not in the export.
- **Export follow-ups (.ics)** downloads a calendar file of your follow-up dates —
  one all-day reminder per application (with a 9am alert). Import it into Google
  Calendar, Apple Calendar, or Outlook to see your follow-ups alongside everything
  else. Only non-closed applications with a follow-up date are included.
- **Back up now** writes an immediate timestamped backup (Chrome/Edge).

On Safari, use Export periodically for safekeeping since automatic folder
backups need the connected-folder mode.

## Undo, recycle bin & repair

Nothing you do is unrecoverable:

- **Undo / redo** — press **Ctrl/⌘ + Z** to undo your last change (add, edit,
  delete, status move, import) and **Ctrl/⌘ + Shift + Z** (or **Ctrl + Y**) to
  redo. This works everywhere except while you're typing in a text field, where
  Ctrl/⌘ + Z still does the normal text undo.
- **Recycle bin** — deleted applications and companies aren't gone; they move to
  the recycle bin under **Settings → Recycle bin**, where you can **Restore**
  them for 30 days (restoring a company re-links its applications). A pop-up
  "Undo" appears right after each delete too.
- **Data integrity** — **Settings → Data integrity** scans for problems
  (applications pointing at a deleted company, unknown statuses, bad dates,
  missing ids) and fixes them with one **Repair all** click. Repairs are
  undoable.

## Import from CSV

**Settings → Import (CSV)** brings in applications or companies from a CSV in the
same shape **Export everything** produces. Pick the file, review the preview
(how many records, which new companies will be created), and confirm. Nothing is
overwritten, and the import can be undone.

## That's the full app

Add applications, track them on the board, tailor with the AI council, and watch
the dashboard. Come back anytime for tweaks.
