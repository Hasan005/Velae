/* ============================================================
   Velae — app.js  (complete: tracker + tailor + pipeline + dashboard)
   (formerly "JobTracker"; internal data.json/config.json/IDB keys kept stable)
   - Hybrid persistence:
       Chrome/Edge  -> File System Access API, auto-save to folder
       Safari/etc.  -> manual Save (download) + Load (file picker)
   - In-memory state, simple hash-free view router.
   Later stages add CRUD, board, companies, dashboard logic.
   ============================================================ */

(() => {
  "use strict";

  // App version — single source of truth in code. Keep in sync with the
  // "Current version" line in Doc/architecture.md and README.md (see §0).
  const APP_VERSION = "3.0";

  // ---------- capability detection ----------
  const HAS_FS = "showDirectoryPicker" in window;

  // ---------- state ----------
  const State = {
    data: null,          // the loaded data.json object
    dirHandle: null,     // FileSystemDirectoryHandle (Chrome/Edge)
    fileHandle: null,    // handle to data.json
    apiKey: "",          // Anthropic key (loaded from config.json), kept for paste-fallback parity
    geminiKey: "",       // Gemini key from config.json
    dirty: false,
    view: "dashboard",
    tailor: {
      busy: false, jdText: "", appId: "",
      providers: { gemini: true, paste: true },  // which engines to run
      results: {},        // { gemini: {...}, paste: {...}, merged: {...} }
      _status: "", _statusErr: false,
    },
    filter: { q: "", status: "", companyId: "" },
    undo: [],            // ring buffer of structuredClone(data) snapshots (pre-mutation)
    redo: [],
    integrity: null,     // last integrity scan result (array of issue groups)
  };

  // Status model: meta.statuses is the ordered list of names (drives board/funnel order).
  // meta.statusMeta maps each name -> type: "active" | "responded" | "terminal".
  // "responded" counts as "heard back"; "terminal" drops out of "active". This replaces
  // the old hard-coded ["Phone Screen","Interview","Offer"] / ["Rejected","Closed"] logic.
  const DEFAULT_STATUSES = [
    { name: "Wishlist",            type: "active" },
    { name: "Applied",             type: "active" },
    { name: "Under Consideration", type: "responded" },
    { name: "Phone Screen",        type: "responded" },
    { name: "Interview",           type: "responded" },
    { name: "Offer",               type: "responded" },
    { name: "Not Selected",        type: "terminal" },
    { name: "Closed",              type: "terminal" },
  ];

  const PROFILE_FIELDS = ["name","email","phone","location","linkedin","portfolio","masterResume"];
  const EMPTY = {
    schemaVersion: 5,
    meta: {
      appName: "Velae",
      lastSaved: null,
      statuses: DEFAULT_STATUSES.map(s => s.name),
      statusMeta: Object.fromEntries(DEFAULT_STATUSES.map(s => [s.name, s.type])),
    },
    profile: Object.fromEntries(PROFILE_FIELDS.map(k => [k, ""])),  // identity + master resume
    companies: [],
    applications: [],
    trash: [],   // soft-deleted apps/companies; auto-purged after TRASH_TTL_DAYS
  };

  // ---------- tiny DOM helpers ----------
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];

  // ---------- seal / save indicator ----------
  function setSeal(stateName, label){
    const seal = $("#seal");
    seal.className = "seal " + stateName; // is-saved | is-dirty | is-syncing | is-none
    $("#sealLabel").textContent = label;
  }
  function markDirty(){
    State.dirty = true;
    if (HAS_FS && State.dirHandle) {
      autosave();                    // silent write on Chrome/Edge
    } else {
      setSeal("is-dirty", "Unsaved");
    }
  }
  function markClean(){
    State.dirty = false;
    setSeal("is-saved", "Saved");
  }

  // ---------- persistent folder handle (IndexedDB) ----------
  // Browsers can persist a directory handle across sessions, but still require
  // one permission click per session before granting write access again.
  // NOTE: IDB_NAME kept as "jobtracker" on purpose — changing it would orphan
  // any saved folder handle from before the rename. Internal id only; never shown.
  const IDB_NAME = "jobtracker", IDB_STORE = "handles", IDB_KEY = "dir";

  function idbOpen(){
    return new Promise((res, rej) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  async function idbSet(key, val){
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function idbGet(key){
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const r = tx.objectStore(IDB_STORE).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbDel(key){
    const db = await idbOpen();
    return new Promise((res) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }

  // ---------- persistence: Chrome/Edge (File System Access) ----------
  async function connectFolder(){
    try{
      const dir = await window.showDirectoryPicker({ mode:"readwrite" });
      await idbSet(IDB_KEY, dir);          // remember for next session
      await openDirHandle(dir);
    }catch(err){
      if (err && err.name === "AbortError") return; // user cancelled
      console.error(err);
      alert("Couldn't open that folder. See console for details.");
    }
  }

  // shared: take a directory handle, load data.json + config, render
  async function openDirHandle(dir){
    State.dirHandle = dir;
    let fh;
    try { fh = await dir.getFileHandle("data.json"); }
    catch { fh = await dir.getFileHandle("data.json", { create:true }); }
    State.fileHandle = fh;

    const file = await fh.getFile();
    if (file.size > 0){
      State.data = JSON.parse(await file.text());
    } else {
      State.data = structuredClone(EMPTY);
      await writeFile();
    }
    ensureConfig();
    await loadConfigKey();
    applyTheme();          // a folder may carry its own config.theme
    render();
    markClean();
  }

  // on boot: if we have a saved handle, offer a one-click reconnect
  async function tryRestoreFolder(){
    if (!HAS_FS) return;
    let dir;
    try { dir = await idbGet(IDB_KEY); } catch { return; }
    if (!dir) return;

    // check current permission without prompting
    let perm = "prompt";
    try { perm = await dir.queryPermission({ mode:"readwrite" }); } catch {}

    if (perm === "granted"){
      // rare: some setups keep the grant — open immediately
      try { await openDirHandle(dir); return; } catch(e){ console.warn(e); }
    }
    // otherwise show a reconnect affordance (single click -> requestPermission)
    showReconnect(dir);
  }

  function showReconnect(dir){
    State._savedDir = dir;
    setSeal("is-none", "Reconnect");
    const btn = $("#btnConnect");
    if (btn) btn.textContent = "Reconnect folder";
    if (!State.data) render(); // refresh the no-data notice to the reconnect variant
    const note = $("#storageNote");
    if (note) note.innerHTML = `Folder remembered. <a href="#" id="reconnectLink" style="color:var(--seal)">Reconnect</a> to resume auto-save.`;
    $("#reconnectLink")?.addEventListener("click", async (e) => {
      e.preventDefault();
      await reconnectSaved();
    });
  }

  async function reconnectSaved(){
    const dir = State._savedDir;
    if (!dir) return connectFolder();
    try{
      const perm = await dir.requestPermission({ mode:"readwrite" });
      if (perm === "granted"){
        await openDirHandle(dir);
        const btn = $("#btnConnect"); if (btn) btn.textContent = "Connect folder";
      } else {
        alert("Permission denied. Click Connect folder to pick it again.");
      }
    }catch(err){
      console.error(err);
      // handle may be stale (folder moved/renamed) — fall back to picker
      await idbDel(IDB_KEY);
      connectFolder();
    }
  }


  async function writeFile(){
    if (!State.fileHandle) return;
    State.data.meta.lastSaved = new Date().toISOString();
    const json = JSON.stringify(State.data, null, 2);
    const w = await State.fileHandle.createWritable();
    await w.write(json);
    await w.close();
    maybeBackup(json);   // best-effort, throttled
  }

  // ---------- automatic timestamped backups ----------
  const BACKUP_MIN_INTERVAL_MS = 4 * 60 * 1000; // at most one every 4 minutes
  const BACKUP_KEEP = 30;                        // rolling window
  let lastBackupAt = 0;

  async function maybeBackup(json){
    if (!State.dirHandle) return;
    const now = Date.now();
    if (now - lastBackupAt < BACKUP_MIN_INTERVAL_MS) return;
    lastBackupAt = now;
    try { await writeBackup(json); }
    catch(e){ console.warn("backup skipped:", e); } // never block the main save
  }

  function backupStamp(d = new Date()){
    const p = (n) => String(n).padStart(2,"0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  async function writeBackup(json){
    const dir = await State.dirHandle.getDirectoryHandle("data.backups", { create:true });
    const name = `data_${backupStamp()}.json`;
    const fh = await dir.getFileHandle(name, { create:true });
    const w = await fh.createWritable();
    await w.write(json);
    await w.close();
    await pruneBackups(dir);
  }

  async function pruneBackups(dir){
    const names = [];
    for await (const [n, h] of dir.entries()){
      if (h.kind === "file" && /^data_.*\.json$/.test(n)) names.push(n);
    }
    if (names.length <= BACKUP_KEEP) return;
    names.sort(); // lexicographic == chronological for this stamp format
    const remove = names.slice(0, names.length - BACKUP_KEEP);
    for (const n of remove){
      try { await dir.removeEntry(n); } catch(e){ console.warn("prune failed", n, e); }
    }
  }

  // manual backup-now (used by export / explicit save)
  async function backupNow(){
    if (!State.dirHandle) return false;
    try { await writeBackup(JSON.stringify(State.data, null, 2)); lastBackupAt = Date.now(); return true; }
    catch(e){ console.warn(e); return false; }
  }

  let autosaveTimer = null;
  function autosave(){
    setSeal("is-syncing", "Saving…");
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      try { await writeFile(); markClean(); }
      catch(e){ console.error(e); setSeal("is-dirty","Save failed"); }
    }, 350);
  }

  // ---------- persistence: Safari fallback (download / upload) ----------
  function downloadData(){
    if (!State.data) State.data = structuredClone(EMPTY);
    State.data.meta.lastSaved = new Date().toISOString();
    const blob = new Blob([JSON.stringify(State.data, null, 2)], { type:"application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "data.json";
    a.click();
    URL.revokeObjectURL(a.href);
    markClean();
  }

  function loadFromFile(){
    $("#fileInput").click();
  }
  function onFilePicked(e){
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        State.data = JSON.parse(r.result);
        ensureConfig();
        applyTheme();
        render();
        markClean();
      } catch { alert("That file isn't valid JSON."); }
    };
    r.readAsText(f);
    e.target.value = "";
  }

  // ---------- warn on unsaved changes (Safari path) ----------
  window.addEventListener("beforeunload", (e) => {
    if (State.dirty && !(HAS_FS && State.dirHandle)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ============================================================
  //  SHARED HELPERS
  // ============================================================
  function uid(prefix){ return prefix + "_" + Math.random().toString(36).slice(2,9); }

  function companyName(id){
    const c = State.data.companies.find(x => x.id === id);
    return c ? c.name : "";
  }

  // build "applications/2026-06_Acme_SeniorOpsAnalyst" from fields
  function buildFolderName(coName, role, dateApplied){
    const ym = (dateApplied && /^\d{4}-\d{2}/.test(dateApplied))
      ? dateApplied.slice(0,7) : new Date().toISOString().slice(0,7);
    const clean = (s) => (s||"").replace(/[^A-Za-z0-9]+/g," ").trim()
      .split(/\s+/).map(w => w.charAt(0).toUpperCase()+w.slice(1)).join("");
    const co = clean(coName) || "Company";
    const rl = clean(role) || "Role";
    return `applications/${ym}_${co}_${rl}`;
  }

  async function createFolderOnDisk(path){
    if (!State.dirHandle) return false;
    try{ await resolveAppFolder(path); return true; }
    catch(e){ console.warn("folder create failed", e); return false; }
  }

  // ---------- modal ----------
  function openModal(html){
    const host = $("#modalHost");
    host.innerHTML = `<div class="modal-backdrop" id="mBackdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const backdrop = $("#mBackdrop");
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) closeModal(); });
    document.addEventListener("keydown", escClose);
  }
  function closeModal(){
    $("#modalHost").innerHTML = "";
    document.removeEventListener("keydown", escClose);
  }
  function escClose(e){ if (e.key === "Escape") closeModal(); }

  function selectOptions(values, selected){
    return values.map(v => `<option value="${v}" ${v===selected?"selected":""}>${v}</option>`).join("");
  }


  function ensureConfig(){
    if (!State.data.config) State.data.config = { model:"claude-opus-4-8" };
    if (!State.data.config.model) State.data.config.model = "claude-opus-4-8";
    ensureStatusMeta();
    // schemaVersion 3: recycle bin (soft-delete). Add trash[] if missing, purge stale.
    if (!Array.isArray(State.data.trash)) State.data.trash = [];
    purgeTrash();
    // schemaVersion 4: Profile object (promotes config.masterResume / applicantName).
    ensureProfile();
    // schemaVersion 5: per-application statusHistory[] (empty on migration → analytics "—").
    for (const a of (State.data.applications || [])){
      if (!Array.isArray(a.statusHistory)) a.statusHistory = [];
    }
    if (typeof State.data.schemaVersion === "number" && State.data.schemaVersion < 5){
      State.data.schemaVersion = 5;
    }
    // run an integrity scan on load so the Settings panel can surface findings
    State.integrity = checkIntegrity();
  }

  // Record a status entry (for time-in-stage analytics). Dedupes consecutive repeats.
  function recordStatus(a, status){
    if (!Array.isArray(a.statusHistory)) a.statusHistory = [];
    const last = a.statusHistory[a.statusHistory.length - 1];
    if (last && last.status === status) return;
    a.statusHistory.push({ status, ts: new Date().toISOString() });
  }

  // Make sure data.profile exists; migrate legacy config.masterResume / applicantName into it.
  function ensureProfile(){
    const d = State.data;
    if (!d.profile || typeof d.profile !== "object") d.profile = {};
    if (d.config){
      if (d.config.masterResume && !d.profile.masterResume) d.profile.masterResume = d.config.masterResume;
      if (d.config.applicantName && !d.profile.name) d.profile.name = d.config.applicantName;
      delete d.config.masterResume;     // config keeps model + keys-adjacent settings only
      delete d.config.applicantName;
    }
    for (const k of PROFILE_FIELDS){ if (typeof d.profile[k] !== "string") d.profile[k] = ""; }
  }

  // Make sure meta.statuses + meta.statusMeta exist and are consistent.
  // Handles legacy data (schemaVersion 1: statuses as plain string array, no statusMeta).
  function ensureStatusMeta(){
    const m = State.data.meta || (State.data.meta = {});
    if (!Array.isArray(m.statuses) || !m.statuses.length){
      m.statuses = DEFAULT_STATUSES.map(s => s.name);
    }
    if (!m.statusMeta || typeof m.statusMeta !== "object"){
      m.statusMeta = {};
    }
    // infer a type for any status that lacks one
    for (const name of m.statuses){
      if (!m.statusMeta[name]) m.statusMeta[name] = inferType(name);
    }
    // drop orphaned statusMeta entries no longer in the list
    for (const name of Object.keys(m.statusMeta)){
      if (!m.statuses.includes(name)) delete m.statusMeta[name];
    }
    if (typeof State.data.schemaVersion === "number" && State.data.schemaVersion < 2){
      State.data.schemaVersion = 2;
    }
  }

  // Best-effort type inference for legacy / unknown status names.
  function inferType(name){
    const n = name.toLowerCase();
    if (/(reject|not selected|declin|withdraw|closed|filled|inactive)/.test(n)) return "terminal";
    if (/(screen|interview|offer|consideration|review|assessment|onsite|final)/.test(n)) return "responded";
    return "active";
  }

  // type lookups used across the app
  function statusType(name){ return (State.data.meta.statusMeta && State.data.meta.statusMeta[name]) || inferType(name); }
  function isTerminal(name){ return statusType(name) === "terminal"; }
  function isResponded(name){ return statusType(name) === "responded"; }

  async function loadConfigKey(){
    if (!State.dirHandle) return;
    try{
      const fh = await State.dirHandle.getFileHandle("config.json");
      const f  = await fh.getFile();
      const cfg = JSON.parse(await f.text());
      State.apiKey = cfg.apiKey || "";
      State.geminiKey = cfg.geminiKey || "";
    }catch{ /* no config.json yet — fine */ }
  }

  async function writeConfigFile(){
    if (!State.dirHandle) return;
    try{
      const fh = await State.dirHandle.getFileHandle("config.json", { create:true });
      const w  = await fh.createWritable();
      await w.write(JSON.stringify({ apiKey: State.apiKey, geminiKey: State.geminiKey }, null, 2));
      await w.close();
    }catch(e){ console.error(e); }
  }

  async function saveConfigKey(key){
    State.apiKey = (key||"").trim();
    await writeConfigFile();
  }
  async function saveGeminiKey(key){
    State.geminiKey = (key||"").trim();
    await writeConfigFile();
  }

  function hasKey(){ return !!State.apiKey; }
  function hasGemini(){ return !!State.geminiKey; }

  // ============================================================
  //  EXPORT EVERYTHING  (zip: data.json + applications.csv)
  // ============================================================
  function csvCell(v){
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  }

  function applicationsCSV(){
    const cols = ["role","company","location","status","dateApplied","followUpDate","source","salaryRange","url","folder"];
    const header = cols.join(",");
    const rows = (State.data.applications||[]).map(a => {
      const row = {
        role:a.role, company:companyName(a.companyId), location:a.location, status:a.status,
        dateApplied:a.dateApplied, followUpDate:a.followUpDate, source:a.source,
        salaryRange:a.salaryRange, url:a.url, folder:a.folder
      };
      return cols.map(c => csvCell(row[c])).join(",");
    });
    return [header, ...rows].join("\r\n");
  }

  function companiesCSV(){
    const header = "company,website,notes,contacts";
    const rows = (State.data.companies||[]).map(c => {
      const contacts = (c.contacts||[]).map(ct =>
        [ct.name, ct.role, ct.email, ct.phone].filter(Boolean).join(" / ")).join("; ");
      return [c.name, c.website, c.notes, contacts].map(csvCell).join(",");
    });
    return [header, ...rows].join("\r\n");
  }

  async function exportEverything(){
    try{
      const zip = new window.JSZip();
      zip.file("data.json", JSON.stringify(State.data, null, 2));
      zip.file("applications.csv", applicationsCSV());
      zip.file("companies.csv", companiesCSV());
      const readme = `Velae export — ${new Date().toISOString()}\n\n`
        + `data.json        full structured data (re-importable via Load file)\n`
        + `applications.csv readable list of all applications\n`
        + `companies.csv    companies with notes and contacts\n\n`
        + `Note: tailored .docx files and job postings live in the applications/ subfolders, not in this export.\n`;
      zip.file("README.txt", readme);

      const blob = await zip.generateAsync({ type:"blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `Velae_export_${backupStamp()}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
      return true;
    }catch(e){
      console.error(e);
      alert("Export failed — see console.");
      return false;
    }
  }

  // ============================================================
  //  CALENDAR EXPORT  (.ics — follow-up reminders, RFC 5545)
  // ============================================================
  function icsEscape(s){
    return String(s ?? "").replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\r?\n/g,"\\n");
  }
  // Fold lines to <=75 octets; continuation lines begin with a single space (RFC 5545 §3.1).
  function icsFold(line){
    if (line.length <= 75) return line;
    const out = [];
    let i = 0;
    while (i < line.length){
      const take = i === 0 ? 75 : 74;          // continuation lines lose 1 col to the leading space
      out.push((i === 0 ? "" : " ") + line.substr(i, take));
      i += take;
    }
    return out.join("\r\n");
  }
  function icsFollowups(){
    return (State.data?.applications || [])
      .filter(a => a.followUpDate && DATE_RE.test(a.followUpDate) && !isTerminal(a.status));
  }
  function buildICS(apps){
    const ymd = (d) => d.replace(/-/g, "");                       // YYYY-MM-DD -> YYYYMMDD
    const nextDay = (d) => {                                       // all-day DTEND is exclusive
      const dt = new Date(d + "T00:00:00Z");
      dt.setUTCDate(dt.getUTCDate() + 1);
      return dt.toISOString().slice(0,10).replace(/-/g,"");
    };
    const dtstamp = new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"");  // YYYYMMDDTHHMMSSZ
    const lines = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Velae Lite//Follow-ups//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH"];
    for (const a of apps){
      const co = companyName(a.companyId);
      const summary = `Follow up: ${a.role || "application"}${co ? ` @ ${co}` : ""}`;
      const desc = [a.status && `Status: ${a.status}`, a.url && `Posting: ${a.url}`].filter(Boolean).join("\n");
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${a.id}@velae`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART;VALUE=DATE:${ymd(a.followUpDate)}`);
      lines.push(`DTEND;VALUE=DATE:${nextDay(a.followUpDate)}`);
      lines.push(`SUMMARY:${icsEscape(summary)}`);
      if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
      lines.push("BEGIN:VALARM","TRIGGER:PT9H","ACTION:DISPLAY",`DESCRIPTION:${icsEscape(summary)}`,"END:VALARM"); // 9am day-of
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.map(icsFold).join("\r\n") + "\r\n";
  }
  function exportICS(){
    const apps = icsFollowups();
    if (!apps.length){ toast("No upcoming follow-up dates to export."); return false; }
    const blob = new Blob([buildICS(apps)], { type:"text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Velae_followups_${backupStamp()}.ics`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${apps.length} follow-up${apps.length>1?"s":""} to .ics`);
    return true;
  }


  // ============================================================
  //  DATA SAFETY — undo/redo, recycle bin, integrity, CSV import
  // ============================================================
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  const UNDO_LIMIT = 50;                 // cap the snapshot ring buffer
  const TRASH_TTL_DAYS = 30;             // recycle-bin auto-purge window
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function clone(o){
    try { return structuredClone(o); }
    catch { return JSON.parse(JSON.stringify(o)); }
  }

  // --- undo / redo: snapshot the WHOLE data object before each mutation ---
  function snapshot(){
    if (!State.data) return;
    State.undo.push(clone(State.data));         // deep copy, never a reference
    if (State.undo.length > UNDO_LIMIT) State.undo.shift();
    State.redo.length = 0;                       // a new action invalidates redo
  }
  function undo(){
    if (!State.undo.length){ toast("Nothing to undo"); return; }
    State.redo.push(clone(State.data));
    if (State.redo.length > UNDO_LIMIT) State.redo.shift();
    State.data = State.undo.pop();
    State.integrity = checkIntegrity();
    markDirty(); render();
    toast("Undid last change", "Redo", redo);
  }
  function redo(){
    if (!State.redo.length){ toast("Nothing to redo"); return; }
    State.undo.push(clone(State.data));
    if (State.undo.length > UNDO_LIMIT) State.undo.shift();
    State.data = State.redo.pop();
    State.integrity = checkIntegrity();
    markDirty(); render();
    toast("Redid change");
  }

  // --- toast (auto-dismiss, optional action button) ---
  let toastTimer = null;
  function toast(msg, actionLabel, actionFn){
    let host = $("#toastHost");
    if (!host){ host = document.createElement("div"); host.id = "toastHost"; document.body.appendChild(host); }
    host.innerHTML = `<div class="toast">
        <span class="toast-msg"></span>
        ${actionLabel ? `<button class="toast-action"></button>` : ""}
        <button class="toast-close" aria-label="Dismiss">&times;</button>
      </div>`;
    host.querySelector(".toast-msg").textContent = msg;     // textContent: no injection
    const el = host.querySelector(".toast");
    const dismiss = () => { if (el && el.parentNode) el.remove(); };
    el.querySelector(".toast-close").addEventListener("click", dismiss);
    if (actionLabel){
      const a = el.querySelector(".toast-action");
      a.textContent = actionLabel;
      a.addEventListener("click", () => { dismiss(); actionFn && actionFn(); });
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(dismiss, 6000);
  }

  // --- recycle bin (soft delete) ---
  function purgeTrash(){
    if (!Array.isArray(State.data.trash)) return 0;
    const cutoff = Date.now() - TRASH_TTL_DAYS*24*60*60*1000;
    const before = State.data.trash.length;
    State.data.trash = State.data.trash.filter(t => {
      const ts = Date.parse(t && t.deletedAt);
      return isNaN(ts) ? true : ts >= cutoff;     // keep undated entries (safety)
    });
    return before - State.data.trash.length;
  }
  function restoreFromTrash(idx){
    const t = State.data.trash[idx];
    if (!t) return;
    snapshot();
    if (t.kind === "application"){
      State.data.applications.push(t.item);
    } else if (t.kind === "company"){
      State.data.companies.push(t.item);
      // re-link the applications that were unlinked when this company was deleted
      (t.linkedAppIds||[]).forEach(aid => {
        const a = State.data.applications.find(x => x.id === aid);
        if (a && !a.companyId) a.companyId = t.item.id;
      });
    }
    State.data.trash.splice(idx, 1);
    State.integrity = checkIntegrity();
    markDirty(); render();
    toast((t.kind === "company" ? "Company" : "Application") + " restored");
  }
  function purgeTrashItem(idx){
    if (!State.data.trash[idx]) return;
    snapshot();
    State.data.trash.splice(idx, 1);
    markDirty(); render();
  }
  function emptyTrash(){
    if (!State.data.trash || !State.data.trash.length) return;
    snapshot();
    State.data.trash = [];
    markDirty(); render();
    toast("Recycle bin emptied");
  }

  // --- integrity check & one-click repair ---
  function checkIntegrity(){
    const d = State.data; if (!d) return [];
    const apps = d.applications || [], cos = d.companies || [], statuses = (d.meta && d.meta.statuses) || [];
    const coIds = new Set(cos.map(c => c.id));
    const issues = [];

    const orphan = apps.filter(a => a.companyId && !coIds.has(a.companyId)).length;
    if (orphan) issues.push({ key:"orphan", count:orphan,
      message:`${orphan} application(s) link to a company that no longer exists — will be unlinked.` });

    const badStatus = apps.filter(a => !statuses.includes(a.status)).length;
    if (badStatus) issues.push({ key:"badStatus", count:badStatus,
      message:`${badStatus} application(s) have a status not in your pipeline — will reset to "${statuses[0]||"?"}".` });

    const badDate = apps.filter(a =>
      (a.dateApplied && !DATE_RE.test(a.dateApplied)) ||
      (a.followUpDate && !DATE_RE.test(a.followUpDate))).length;
    if (badDate) issues.push({ key:"badDate", count:badDate,
      message:`${badDate} application(s) have a malformed date (expected YYYY-MM-DD) — will be cleared.` });

    const missingId = apps.filter(a => !a.id).length + cos.filter(c => !c.id).length;
    if (missingId) issues.push({ key:"missingId", count:missingId,
      message:`${missingId} record(s) are missing an id — will be assigned one.` });

    const seen = new Set(), dupes = new Set();
    [...cos, ...apps].forEach(r => { if (r.id){ if (seen.has(r.id)) dupes.add(r.id); else seen.add(r.id); } });
    if (dupes.size) issues.push({ key:"dupeId", count:dupes.size,
      message:`${dupes.size} duplicate id(s) across records — duplicates will be re-issued.` });

    return issues;
  }
  function repairAll(){
    const issues = checkIntegrity();
    if (!issues.length){ State.integrity = []; render(); toast("No issues found"); return; }
    snapshot();
    const d = State.data;
    const coIds = new Set(d.companies.map(c => c.id));
    const fallback = d.meta.statuses[0] || "Applied";
    d.applications.forEach(a => {
      if (a.companyId && !coIds.has(a.companyId)) a.companyId = "";
      if (!statusKnown(a.status)) a.status = fallback;
      if (a.dateApplied && !DATE_RE.test(a.dateApplied)) a.dateApplied = "";
      if (a.followUpDate && !DATE_RE.test(a.followUpDate)) a.followUpDate = "";
      if (!a.id) a.id = uid("app");
    });
    d.companies.forEach(c => { if (!c.id) c.id = uid("co"); });
    // de-dupe ids: companies first so app->company links stay pointed at the original
    const seen = new Set();
    d.companies.forEach(c => { if (seen.has(c.id)) c.id = uid("co"); seen.add(c.id); });
    d.applications.forEach(a => { if (seen.has(a.id)) a.id = uid("app"); seen.add(a.id); });

    const total = issues.reduce((n,i) => n + i.count, 0);
    State.integrity = checkIntegrity();
    markDirty(); render();
    toast(`Repaired ${total} issue(s)`);
  }
  function statusKnown(s){ return !!s && State.data.meta.statuses.includes(s); }

  // --- CSV import (inverse of applicationsCSV / companiesCSV) ---
  // Dependency-free parser: handles quoted fields, embedded commas/newlines, "" escapes.
  function parseCSV(text){
    text = String(text).replace(/^﻿/, "");   // strip BOM
    const rows = [];
    let row = [], field = "", i = 0, inQ = false;
    while (i < text.length){
      const ch = text[i];
      if (inQ){
        if (ch === '"'){
          if (text[i+1] === '"'){ field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"'){ inQ = true; i++; continue; }
      if (ch === ','){ row.push(field); field = ""; i++; continue; }
      if (ch === '\r'){ i++; continue; }
      if (ch === '\n'){ row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += ch; i++;
    }
    row.push(field); rows.push(row);
    // drop a trailing blank row (trailing newline)
    if (rows.length && rows[rows.length-1].length === 1 && rows[rows.length-1][0] === "") rows.pop();
    return rows;
  }
  function normDate(s){ return DATE_RE.test(s) ? s : ""; }
  function parseContacts(s){   // "Name / Role / email / phone; Name2 / …"
    if (!s) return [];
    return s.split(";").map(x => x.trim()).filter(Boolean).map(chunk => {
      const parts = chunk.split("/").map(p => p.trim());
      return { id: uid("ct"), name:parts[0]||"", role:parts[1]||"", email:parts[2]||"", phone:parts[3]||"" };
    });
  }

  function importCSVFile(file){
    const r = new FileReader();
    r.onload = () => {
      try{
        const rows = parseCSV(String(r.result));
        if (rows.length < 2){ alert("That CSV has no data rows."); return; }
        const header = rows[0].map(h => h.trim().toLowerCase());
        const has = (name) => header.indexOf(name) !== -1;
        let plan;
        if (has("role")){
          plan = planApplicationsImport(rows, header);
        } else if (has("company") && (has("website") || has("contacts"))){
          plan = planCompaniesImport(rows, header);
        } else {
          alert("Unrecognized CSV. Expected an applications export (has a 'role' column) or a companies export (has 'company' plus 'website'/'contacts').");
          return;
        }
        showImportPreview(plan);
      }catch(e){ console.error(e); alert("Couldn't parse that CSV — see console for details."); }
    };
    r.readAsText(file);
  }
  function planApplicationsImport(rows, header){
    const col = (name) => header.indexOf(name);
    const get = (r, name) => { const i = col(name); return i >= 0 ? String(r[i] ?? "").trim() : ""; };
    const statuses = State.data.meta.statuses;
    const existingCo = new Set(State.data.companies.map(c => c.name.toLowerCase()));
    const newApps = [], newCompanies = new Map();
    rows.slice(1).forEach(r => {
      if (r.every(c => String(c ?? "").trim() === "")) return;
      const coName = get(r, "company");
      let status = get(r, "status");
      if (status && !statuses.includes(status)) status = "";
      newApps.push({
        role: get(r,"role"), location: get(r,"location"),
        status: status || statuses[1] || statuses[0] || "Applied",
        dateApplied: normDate(get(r,"dateapplied")), followUpDate: normDate(get(r,"followupdate")),
        source: get(r,"source"), salaryRange: get(r,"salaryrange"),
        url: get(r,"url"), folder: get(r,"folder"), companyName: coName,
      });
      const lc = coName.toLowerCase();
      if (coName && !existingCo.has(lc) && !newCompanies.has(lc)) newCompanies.set(lc, coName);
    });
    return { kind:"applications", newApps, newCompanies:[...newCompanies.values()] };
  }
  function planCompaniesImport(rows, header){
    const col = (name) => header.indexOf(name);
    const get = (r, name) => { const i = col(name); return i >= 0 ? String(r[i] ?? "").trim() : ""; };
    const existing = new Set(State.data.companies.map(c => c.name.toLowerCase()));
    const toAdd = [], skipped = [];
    rows.slice(1).forEach(r => {
      if (r.every(c => String(c ?? "").trim() === "")) return;
      const name = get(r, "company");
      if (!name) return;
      const lc = name.toLowerCase();
      if (existing.has(lc)){ skipped.push(name); return; }
      existing.add(lc);
      toAdd.push({ name, website:get(r,"website"), notes:get(r,"notes"), contacts:parseContacts(get(r,"contacts")) });
    });
    return { kind:"companies", toAdd, skipped };
  }
  function showImportPreview(plan){
    const zKey = `${IS_MAC ? "⌘" : "Ctrl"}+Z`;
    let body;
    if (plan.kind === "applications"){
      if (!plan.newApps.length){ alert("No application rows found to import."); return; }
      body = `<p>Ready to import <strong>${plan.newApps.length}</strong> application(s).</p>
        ${plan.newCompanies.length
          ? `<p class="hint">${plan.newCompanies.length} new compan(y/ies) will be created: ${esc(plan.newCompanies.join(", "))}</p>`
          : `<p class="hint">No new companies need to be created.</p>`}`;
    } else {
      if (!plan.toAdd.length){ alert(plan.skipped.length ? "All companies in that CSV already exist." : "No company rows found to import."); return; }
      body = `<p>Ready to import <strong>${plan.toAdd.length}</strong> compan(y/ies).</p>
        ${plan.skipped.length ? `<p class="hint">${plan.skipped.length} already exist and will be skipped: ${esc(plan.skipped.join(", "))}</p>` : ""}`;
    }
    openModal(`
      <div class="modal-head"><h2>Import preview</h2><button class="modal-close" data-close>&times;</button></div>
      ${body}
      <p class="hint">This is added to your existing data — nothing is overwritten — and can be reversed with ${zKey} or from the recycle bin's undo.</p>
      <div class="modal-foot">
        <button class="btn btn-quiet" data-close>Cancel</button>
        <button class="btn btn-primary" id="impCommit">Import</button>
      </div>`);
    $("#impCommit").addEventListener("click", () => { commitImport(plan); closeModal(); });
    $$("[data-close]").forEach(b => b.addEventListener("click", closeModal));
  }
  function commitImport(plan){
    snapshot();
    if (plan.kind === "applications"){
      const coId = new Map(State.data.companies.map(c => [c.name.toLowerCase(), c.id]));
      plan.newCompanies.forEach(name => {
        const lc = name.toLowerCase();
        if (!coId.has(lc)){
          const c = { id: uid("co"), name, website:"", notes:"", contacts:[] };
          State.data.companies.push(c); coId.set(lc, c.id);
        }
      });
      plan.newApps.forEach(na => {
        const companyId = na.companyName ? (coId.get(na.companyName.toLowerCase()) || "") : "";
        const folder = na.folder || buildFolderName(na.companyName, na.role, na.dateApplied);
        State.data.applications.push({
          id: uid("app"), companyId, role:na.role, location:na.location, source:na.source,
          url:na.url, salaryRange:na.salaryRange, status:na.status,
          dateApplied:na.dateApplied, followUpDate:na.followUpDate, folder, notesLog:[],
        });
      });
      toast(`Imported ${plan.newApps.length} application(s)`, "Undo", undo);
    } else {
      plan.toAdd.forEach(c => State.data.companies.push({
        id: uid("co"), name:c.name, website:c.website, notes:c.notes, contacts:c.contacts,
      }));
      toast(`Imported ${plan.toAdd.length} compan(y/ies)`, "Undo", undo);
    }
    State.integrity = checkIntegrity();
    markDirty(); render();
  }

  // ============================================================
  //  RESUME PARSING  (paste text, or upload .docx / .pdf)
  // ============================================================
  async function extractResumeFromFile(file){
    const name = file.name.toLowerCase();
    if (name.endsWith(".docx")){
      const buf = await file.arrayBuffer();
      const res = await window.mammoth.extractRawText({ arrayBuffer: buf });
      return res.value.trim();
    }
    if (name.endsWith(".pdf")){
      // pdf.js is the classic (UMD) build loaded via <script> in index.html:
      // ESM import() and Workers can't load from file://. window.pdfjsWorker is
      // registered by pdf.worker.min.js; pdf.js runs it on the main thread.
      const pdfjs = window.pdfjsLib;
      if (!pdfjs) throw new Error("pdf.js not loaded");
      // workerSrc must be set or pdf.js throws; the real Worker can't spawn from
      // file:// so pdf.js falls back to the main-thread fake worker (pdfjsWorker).
      if (!pdfjs.GlobalWorkerOptions.workerSrc){
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("Core/vendor/pdf.worker.min.js", document.baseURI).href;
      }
      const buf = await file.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data: buf }).promise;
      let text = "";
      for (let i=1; i<=pdf.numPages; i++){
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(it => it.str).join(" ") + "\n";
      }
      return text.trim();
    }
    if (name.endsWith(".txt") || name.endsWith(".md")){
      return (await file.text()).trim();
    }
    throw new Error("Unsupported file. Use .docx, .pdf, .txt, or .md.");
  }

  // ============================================================
  //  PROMPT  (shared by API path and paste path)
  // ============================================================
  function buildTailorPrompt(resume, jd, profile){
    profile = profile || {};
    const contact = [
      profile.name && `Name: ${profile.name}`,
      profile.email && `Email: ${profile.email}`,
      profile.phone && `Phone: ${profile.phone}`,
      profile.location && `Location: ${profile.location}`,
      profile.linkedin && `LinkedIn: ${profile.linkedin}`,
      profile.portfolio && `Portfolio: ${profile.portfolio}`,
    ].filter(Boolean).join("\n");
    return `You are an expert career coach and resume writer. Compare the candidate's master resume against the job description, then produce tailored materials.

Return ONLY a valid JSON object, no markdown fences, no preamble, with exactly these keys:
{
  "matchScore": <integer 0-100>,
  "rationale": "<2-4 sentence explanation of the score and overall fit>",
  "gaps": [ { "item": "<skill/keyword>", "severity": "missing" | "weak", "note": "<short advice>" } ],
  "tailoredResume": "<the full tailored resume as plain text, reworked to mirror the job's language and prioritize relevant experience; do not invent experience>",
  "coverLetter": "<a tailored cover letter, ~250-350 words, addressed generically if no contact is known>"
}

Rules:
- Never fabricate experience, employers, dates, or credentials. Only rephrase, reorder, and emphasize what is in the master resume.
- In gaps, list real skills/keywords the JD wants that the resume lacks ("missing") or underplays ("weak").
- Keep the tailored resume truthful and ATS-friendly.
- Applicant details (use in the cover letter heading/signature where natural; do not invent any not listed below):
${contact || "(none provided — use the name in the resume)"}

=== MASTER RESUME ===
${resume}

=== JOB DESCRIPTION ===
${jd}`;
  }

  function parseTailorJSON(raw){
    let s = raw.trim();
    // strip accidental code fences
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
    // grab outermost JSON object if there's stray prose
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b+1);
    return JSON.parse(s);
  }

  // ============================================================
  //  AI CALL  (Anthropic direct-from-browser; bring-your-own-key)
  // ============================================================
  async function callClaude(prompt){
    const model = State.data.config.model || "claude-opus-4-8";
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{
        "content-type":"application/json",
        "x-api-key": State.apiKey,
        "anthropic-version":"2023-06-01",
        "anthropic-dangerous-direct-browser-access":"true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages:[{ role:"user", content: prompt }],
      }),
    });
    if (!resp.ok){
      const t = await resp.text();
      throw new Error(`API ${resp.status}: ${t.slice(0,300)}`);
    }
    const data = await resp.json();
    return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  }

  // ---- Gemini (free tier; direct browser call with CORS) ----
  // Free-tier models, in preference order. gemini-3-flash is Google's recommended
  // free model ("Pro-level intelligence at Flash speed/price"). If a model is
  // unavailable (Google retires/renames them often), fall through to the next.
  // All of these are free-tier; we deliberately avoid paid models (3.5 Flash, Pro).
  const GEMINI_MODELS = ["gemini-3-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash"];

  async function callGemini(prompt){
    let lastErr;
    for (const model of GEMINI_MODELS){
      try{
        return await callGeminiModel(model, prompt);
      }catch(e){
        lastErr = e;
        // only fall through on "model not found / unsupported" style errors;
        // for auth/quota errors, stop and surface immediately
        const msg = String(e.message || "");
        if (!/40[04]|not found|not supported|unsupported|does not exist/i.test(msg)) throw e;
      }
    }
    // Whole fallback chain exhausted — every model was unavailable.
    throw new Error(
      `None of the free Gemini models are available right now (tried ${GEMINI_MODELS.join(", ")}). ` +
      `Google renames free models often — update GEMINI_MODELS in app.js to a current one. ` +
      (lastErr ? `Last error: ${lastErr.message}` : "")
    );
  }

  async function callGeminiModel(model, prompt){
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const resp = await fetch(url, {
      method:"POST",
      headers:{
        "content-type":"application/json",
        "x-goog-api-key": State.geminiKey,
      },
      body: JSON.stringify({
        contents:[{ role:"user", parts:[{ text: prompt }] }],
        generationConfig:{ temperature:0.7, maxOutputTokens:4096 },
      }),
    });
    if (!resp.ok){
      const t = await resp.text();
      throw new Error(`Gemini ${resp.status}: ${t.slice(0,300)}`);
    }
    const data = await resp.json();
    const cand = data.candidates && data.candidates[0];
    const parts = cand && cand.content && cand.content.parts || [];
    return parts.map(p => p.text || "").join("\n");
  }

  // ============================================================
  //  DOCX GENERATION  (tailored resume + cover letter)
  // ============================================================
  function textToDocxBlob(text, title){
    const { Document, Packer, Paragraph, TextRun } = window.docx;
    const paras = text.split(/\n/).map(line =>
      new Paragraph({ children:[ new TextRun({ text: line, font:"Calibri", size:22 }) ] })
    );
    const doc = new Document({ sections:[{ properties:{}, children: paras }] });
    return Packer.toBlob(doc).then(blob => blob);
  }

  async function saveDocx(text, filename, app){
    const blob = await textToDocxBlob(text, filename);
    // Chrome/Edge with connected folder + known app folder -> write into it
    if (State.dirHandle && app && app.folder){
      try{
        const dir = await resolveAppFolder(app.folder);
        const fh  = await dir.getFileHandle(filename, { create:true });
        const w   = await fh.createWritable();
        await w.write(blob);
        await w.close();
        return { written:true, where: app.folder + "/" + filename };
      }catch(e){ console.warn("folder write failed, downloading instead", e); }
    }
    // fallback: download
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    return { written:false, where: filename + " (downloaded)" };
  }

  // walk/create nested folder path like "applications/2026-06_Acme_Role"
  async function resolveAppFolder(path){
    let dir = State.dirHandle;
    for (const part of path.split("/").filter(Boolean)){
      dir = await dir.getDirectoryHandle(part, { create:true });
    }
    return dir;
  }

  // ---------- per-application data file (application.json) ----------
  // Bulky, per-app text (JD + tailored resume/cover letter) lives in the app's
  // own folder, NOT in data.json (invariant #7). Chrome/Edge only; Safari degrades.
  async function writeAppData(app, obj){
    if (!State.dirHandle || !app || !app.folder) return false;
    try{
      const dir = await resolveAppFolder(app.folder);
      const fh = await dir.getFileHandle("application.json", { create:true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(obj, null, 2));
      await w.close();
      return true;
    }catch(e){ console.warn("application.json write failed", e); return false; }
  }
  // Walk an app-folder path WITHOUT creating anything (for reads/listing).
  async function getAppDirRead(path){
    let dir = State.dirHandle;
    for (const part of path.split("/").filter(Boolean)){
      dir = await dir.getDirectoryHandle(part);   // throws if missing — caller handles
    }
    return dir;
  }
  async function readAppData(app){
    if (!State.dirHandle || !app || !app.folder) return null;
    try{
      const dir = await getAppDirRead(app.folder);
      const fh = await dir.getFileHandle("application.json");
      return JSON.parse(await (await fh.getFile()).text());
    }catch{ return null; }   // missing/unreadable -> treated as "none captured"
  }

  // Persist the current tailoring (best available result + JD) into the linked app's folder.
  async function persistTailorToApp(){
    if (!State.dirHandle) return;
    const app = State.data.applications.find(a => a.id === State.tailor.appId);
    if (!app || !app.folder) return;
    const r = State.tailor.results || {};
    const key = r.merged ? "merged" : (r.gemini ? "gemini" : (r.paste ? "paste" : null));
    if (!key) return;
    const best = r[key];
    await writeAppData(app, {
      jobDescription: State.tailor.jdText || "",
      tailoredResume: best.tailoredResume || "",
      coverLetter: best.coverLetter || "",
      matchScore: best.matchScore ?? null,
      rationale: best.rationale || "",
      gaps: best.gaps || [],
      savedAt: new Date().toISOString(),
      source: key,
    });
  }

  // When linking the Tailor to an app, restore its last saved run (if any) so it's
  // viewable again — but never clobber an in-progress result.
  async function maybeRestoreTailor(){
    const app = State.data.applications.find(a => a.id === State.tailor.appId);
    if (!app) return;
    const r = State.tailor.results;
    if (r.gemini || r.paste || r.merged) return;     // work in progress — leave it
    const data = await readAppData(app);
    if (!data) return;
    if (!State.tailor.jdText) State.tailor.jdText = data.jobDescription || "";
    const key = (data.source === "gemini" || data.source === "paste") ? data.source : "merged";
    State.tailor.results[key] = {
      matchScore: data.matchScore, rationale: data.rationale, gaps: data.gaps,
      tailoredResume: data.tailoredResume, coverLetter: data.coverLetter,
    };
    setTailorStatus(`Restored saved tailoring for this application (${fmtWhen(data.savedAt)}).`);
    render();
  }

  // ============================================================
  //  TAILOR — council orchestration (Gemini + paste, side-by-side)
  // ============================================================
  function tailorPreflight(){
    const resume = State.data.profile.masterResume;
    const jd = State.tailor.jdText.trim();
    if (!resume){ setTailorStatus("Add your master resume on the Profile page first.", true); return null; }
    if (!jd){ setTailorStatus("Paste a job description first.", true); return null; }
    return buildTailorPrompt(resume, jd, State.data.profile);
  }

  // Run the Gemini provider (one-click). Paste provider is handled separately.
  async function runGemini(){
    const prompt = tailorPreflight();
    if (!prompt) return;
    if (!hasGemini()){ setTailorStatus("Add a Gemini API key in Settings to run Gemini.", true); return; }

    State.tailor.busy = true;
    setTailorStatus("Asking Gemini…");
    try{
      const raw = await callGemini(prompt);
      State.tailor.results.gemini = parseTailorJSON(raw);
      setTailorStatus("");
      await persistTailorToApp();
    }catch(e){
      console.error(e);
      setTailorStatus("Gemini failed: " + e.message, true);
    }finally{
      State.tailor.busy = false;
      render();
    }
  }

  function applyPastedResponse(raw){
    try{
      State.tailor.results.paste = parseTailorJSON(raw);
      setTailorStatus("");
      persistTailorToApp();   // best-effort; no need to block render
      render();
    }catch(e){
      setTailorStatus("Couldn't parse that — make sure you pasted the full JSON.", true);
    }
  }

  function copyPrompt(){
    const prompt = tailorPreflight();
    if (!prompt) return;
    navigator.clipboard.writeText(prompt).then(
      () => setTailorStatus("Prompt copied — paste it into Claude.ai, then paste the JSON back below."),
      () => setTailorStatus("Couldn't access clipboard; select the prompt box and copy manually.", true)
    );
  }

  // Merge: ask Gemini to synthesize the best of the available results.
  async function mergeResults(){
    const r = State.tailor.results;
    const have = ["gemini","paste"].filter(k => r[k]);
    if (have.length < 2){ setTailorStatus("Need two results to merge.", true); return; }
    if (!hasGemini()){ setTailorStatus("Merge uses Gemini — add a Gemini key in Settings.", true); return; }

    const mergePrompt = buildMergePrompt(r.gemini, r.paste);
    State.tailor.busy = true;
    setTailorStatus("Merging the best of both…");
    try{
      const raw = await callGemini(mergePrompt);
      State.tailor.results.merged = parseTailorJSON(raw);
      setTailorStatus("");
      await persistTailorToApp();
    }catch(e){
      console.error(e);
      setTailorStatus("Merge failed: " + e.message, true);
    }finally{
      State.tailor.busy = false;
      render();
    }
  }

  function buildMergePrompt(a, b){
    return `You are a senior career coach acting as a judge. Two AI assistants each produced tailored job-application materials for the same candidate and job. Synthesize the single best version, taking the strongest resume bullets, the sharpest cover letter phrasing, and the most accurate gap analysis from each. Do not invent experience.

Return ONLY a valid JSON object, no markdown fences, with exactly these keys:
{ "matchScore": <integer 0-100>, "rationale": "<why this merged version is strong>",
  "gaps": [ { "item": "...", "severity": "missing"|"weak", "note": "..." } ],
  "tailoredResume": "<best merged resume, plain text>",
  "coverLetter": "<best merged cover letter, ~250-350 words>" }

=== VERSION A ===
${JSON.stringify(a)}

=== VERSION B ===
${JSON.stringify(b)}`;
  }

  function clearTailor(){
    State.tailor.results = {};
    setTailorStatus("");
    render();
  }

  function setTailorStatus(msg, isErr){
    State.tailor._status = msg;
    State.tailor._statusErr = !!isErr;
    renderTailorStatus();
  }
  function renderTailorStatus(){
    const el = $("#tailorStatus");
    if (!el) return;
    el.className = "status-line" + (State.tailor._statusErr ? " err" : "");
    el.innerHTML = State.tailor.busy
      ? `<span class="spinner"></span>${State.tailor._status || "Working…"}`
      : (State.tailor._status || "");
  }


  const Views = {
    dashboard: {
      title: "Dashboard",
      sub: "An at-a-glance read of your search.",
      render(){
        const s = computeStats();
        const ob = shouldShowOnboarding() ? renderOnboarding() : "";
        if (!s.apps.length){
          return ob + emptyStatePanel("Your dashboard is ready",
            "Add roles under <strong>Applications</strong> — follow-ups, response rate, the funnel, and trends all build from your real data.",
            `<button class="btn btn-primary" data-go-newapp>Add your first application</button>`);
        }

        // follow-ups panel
        const fmtFu = (a) => {
          const cls = a.followUpDate < s.today ? "overdue" : (a.followUpDate === s.today ? "today" : "");
          const tag = a.followUpDate < s.today ? "overdue" : (a.followUpDate === s.today ? "today" : a.followUpDate);
          return `<div class="followup" data-open-app="${a.id}">
            <div><p class="fu-role">${esc(a.role)||"Untitled"}</p><p class="fu-co">${esc(companyName(a.companyId))||"—"} · ${a.status}</p></div>
            <div class="fu-date ${cls}">${a.followUpDate < s.today ? `overdue<br>${a.followUpDate}` : tag}</div>
          </div>`;
        };
        const fuList = s.followups.length
          ? s.followups.slice(0,8).map(fmtFu).join("")
          : `<p class="empty">No upcoming follow-ups.</p>`;
        const fuSub = s.overdue ? `${s.overdue} overdue` : (s.dueToday ? `${s.dueToday} due today` : "all clear");

        // funnel
        const maxN = Math.max(1, ...s.statuses.map(st => s.byStatus[st]||0));
        const funnel = s.statuses.map(st => {
          const n = s.byStatus[st]||0;
          const term = isTerminal(st);
          return `<div class="funnel-row">
            <span class="funnel-label">${st}</span>
            <span class="funnel-bar"><span class="funnel-fill ${term?"term":""}" style="width:${Math.round((n/maxN)*100)}%"></span></span>
            <span class="funnel-n">${n}</span>
          </div>`;
        }).join("");

        // time-in-stage + weekly trend (Phase 5.1)
        const fmtDays = (d) => d == null ? "—" : (d < 1 ? "<1 day" : `${Math.round(d)} day${Math.round(d)===1?"":"s"}`);
        const tisRows = s.timeInStage.filter(t => t.samples > 0)
          .map(t => `<div class="tis-row"><span class="tis-label">${esc(t.status)}</span><span class="tis-val">${fmtDays(t.avgDays)}</span></div>`).join("");
        const tisCard = tisRows
          ? `${s.stalled ? `<div class="big-stat"><span class="n" style="font-size:21px">${esc(s.stalled.status)}</span><span class="d">slowest stage · avg ${fmtDays(s.stalled.avgDays)}</span></div>` : ""}
             <div class="tis-list">${tisRows}</div>`
          : `<p class="empty">Move applications through the pipeline to see how long they dwell in each stage. Apps added before this update start tracking from their next move.</p>`;
        const trendVals = s.weekly.map(w => w.count);
        const trendTotal = trendVals.reduce((x,y)=>x+y,0);
        const trendCard = `${sparkline(trendVals)}
          <div class="mini-stats" style="margin-top:8px">
            <div class="m"><div class="mn">${trendVals[trendVals.length-1]}</div><div class="ml">This week</div></div>
            <div class="m"><div class="mn">${(trendTotal/trendVals.length).toFixed(1)}</div><div class="ml">Avg/week</div></div>
            <div class="m"><div class="mn">${trendTotal}</div><div class="ml">8-week total</div></div>
          </div>
          <p class="board-hint" style="margin-top:10px">Applications per week (last 8 weeks), by date applied.</p>`;

        return ob + `
        <div class="dash-grid">
          <div class="dash-card">
            <h2>Follow-ups <span class="sub">${fuSub}</span></h2>
            ${fuList}
          </div>
          <div class="dash-card">
            <h2>Response rate <span class="sub">heard back ÷ applied</span></h2>
            <div class="big-stat"><span class="n">${s.responseRate}%</span><span class="d">${s.heardBack} of ${s.reachedApplied} applied</span></div>
            <div class="mini-stats">
              <div class="m"><div class="mn">${s.offers}</div><div class="ml">Offers</div></div>
              <div class="m"><div class="mn">${s.offerRate}%</div><div class="ml">Offer rate</div></div>
              <div class="m"><div class="mn">${s.active}</div><div class="ml">Active</div></div>
            </div>
          </div>
        </div>

        <div class="dash-grid">
          <div class="dash-card">
            <h2>Pipeline funnel</h2>
            ${funnel}
          </div>
          <div class="dash-card">
            <h2>Activity</h2>
            <div class="mini-stats">
              <div class="m"><div class="mn">${s.apps.length}</div><div class="ml">Total</div></div>
              <div class="m"><div class="mn">${s.last7}</div><div class="ml">Last 7 days</div></div>
              <div class="m"><div class="mn">${s.last30}</div><div class="ml">Last 30 days</div></div>
            </div>
            <p class="board-hint" style="margin-top:16px">Counts applications by their <em>date applied</em>. Add dates to applications to populate this.</p>
          </div>
        </div>

        <div class="dash-grid">
          <div class="dash-card">
            <h2>Time in stage <span class="sub">avg days per status</span></h2>
            ${tisCard}
          </div>
          <div class="dash-card">
            <h2>Weekly trend <span class="sub">applications / week</span></h2>
            ${trendCard}
          </div>
        </div>`;
      }
    },
    applications: {
      title: "Applications",
      sub: "Every role you've tracked.",
      render(){
        const all = State.data?.applications ?? [];
        const f = State.filter;
        const q = f.q.trim().toLowerCase();

        const apps = all.filter(a => {
          if (f.status && (a.status||"") !== f.status) return false;
          if (f.companyId && a.companyId !== f.companyId) return false;
          if (q){
            const hay = [a.role, companyName(a.companyId), a.location, a.source, a.status, a.url].join(" ").toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });

        const statusOpts = `<option value="">All statuses</option>` +
          State.data.meta.statuses.map(s => `<option value="${s}" ${f.status===s?"selected":""}>${s}</option>`).join("");
        const coOpts = `<option value="">All companies</option>` +
          State.data.companies.map(c => `<option value="${c.id}" ${f.companyId===c.id?"selected":""}>${esc(c.name)}</option>`).join("");
        const filtering = q || f.status || f.companyId;

        const head = `<div class="list-head">
          <button class="btn btn-primary" id="btnNewApp">New application</button>
        </div>
        <div class="filterbar">
          <input type="search" id="fltQ" placeholder="Search role, company, location…" value="${esc(f.q)}" />
          <select id="fltStatus">${statusOpts}</select>
          <select id="fltCompany">${coOpts}</select>
          ${filtering?`<button class="filter-clear" id="fltClear">clear</button>`:""}
        </div>
        <p class="result-count">${apps.length} of ${all.length} shown</p>`;

        if (!all.length){
          return head + emptyStatePanel("No applications yet",
            "Track your first role — pick or type a company, set a status and dates, and it'll show up here and on the board.",
            `<button class="btn btn-primary" data-go-newapp>New application</button>`);
        }
        if (!apps.length){
          return head + emptyStatePanel("Nothing matches those filters",
            "No applications match your current search and filters. Try clearing them to see everything again.",
            `<button class="btn" id="fltClear2">Clear filters</button>`);
        }

        const rows = apps.map(a => {
          const co = companyName(a.companyId);
          const sCls = "s-" + (a.status||"").replace(/\s+/g,"");
          const link = a.url ? `<a href="${a.url}" target="_blank" rel="noopener">posting ↗</a> · ` : "";
          return `<div class="row">
            <div class="row-main">
              <h3 class="row-title">${esc(a.role)||"Untitled role"}<span class="pill ${sCls}">${a.status||"—"}</span></h3>
              <p class="row-meta">${esc(co)||"—"}${a.location?` · ${esc(a.location)}`:""}</p>
              <p class="row-meta">${link}${a.source?`${esc(a.source)} · `:""}applied ${a.dateApplied||"—"}${a.followUpDate?` · follow up ${a.followUpDate}`:""}</p>
              ${a.folder?`<p class="row-meta" style="margin-top:4px">📁 ${esc(a.folder)}</p>`:""}
            </div>
            <div class="row-actions">
              <button class="icon-btn" data-edit-app="${a.id}">Edit</button>
              <button class="icon-btn danger" data-del-app="${a.id}">Delete</button>
            </div>
          </div>`;
        }).join("");
        return head + rows;
      }
    },
    pipeline: {
      title: "Pipeline",
      sub: "Drag roles through your stages.",
      render(){
        const apps = State.data?.applications ?? [];
        const statuses = State.data?.meta?.statuses ?? [];
        const firstName = statuses[0] || "Wishlist";
        const today = new Date().toISOString().slice(0,10);

        if (!apps.length){
          return emptyStatePanel("Your board is empty",
            "Add applications and drag their cards between columns to move them through your pipeline.",
            `<button class="btn btn-primary" data-go-newapp>New application</button>`);
        }

        const cols = statuses.map(st => {
          const inCol = apps.filter(a => (a.status||firstName) === st);
          const cards = inCol.map(a => {
            const co = companyName(a.companyId);
            const overdue = a.followUpDate && a.followUpDate < today && !isTerminal(st);
            return `<div class="card" draggable="true" data-card="${a.id}">
              <p class="card-role">${esc(a.role)||"Untitled"}</p>
              <p class="card-co">${esc(co)||"—"}</p>
              <div class="card-foot">
                <span class="card-date ${overdue?"overdue":""}">${a.followUpDate?`▲ ${a.followUpDate}`:""}</span>
                <span class="card-dot"></span>
              </div>
            </div>`;
          }).join("") || `<div class="col-empty">—</div>`;

          return `<div class="col ${isTerminal(st)?"is-terminal":""}" data-col="${st}">
            <div class="col-head"><span class="col-name">${st}</span><span class="col-count">${inCol.length}</span></div>
            <div class="col-body" data-dropcol="${st}">${cards}</div>
          </div>`;
        }).join("");

        return `<p class="board-hint">Drag a card to change its status. Click a card to edit it. ▲ marks a follow-up date (red if overdue).</p>
          <div class="board">${cols}</div>`;
      }
    },
    companies: {
      title: "Companies",
      sub: "Notes and contacts, reused across applications.",
      render(){
        const cos = State.data?.companies ?? [];
        const head = `<div class="list-head">
          <p class="row-meta" style="margin:0">${cos.length} compan${cos.length===1?"y":"ies"}</p>
          <button class="btn btn-primary" id="btnNewCo">New company</button>
        </div>`;
        if (!cos.length){
          return head + emptyStatePanel("No companies yet",
            "Add a company here with its notes and contacts — or just type a new company name while adding an application and it'll be created for you.",
            `<button class="btn btn-primary" id="btnNewCo2">Add a company</button>`);
        }
        const rows = cos.map(c => {
          const appCount = State.data.applications.filter(a => a.companyId === c.id).length;
          const contacts = (c.contacts||[]).map(ct =>
            `<p class="row-meta" style="margin-top:3px">${ct.name||""}${ct.role?` · ${ct.role}`:""}${ct.email?` · ${ct.email}`:""}${ct.phone?` · ${ct.phone}`:""}</p>`
          ).join("");
          return `<div class="row">
            <div class="row-main">
              <h3 class="row-title">${c.name||"Unnamed"}</h3>
              ${c.website?`<p class="row-meta"><a href="${c.website}" target="_blank" rel="noopener">${c.website} ↗</a></p>`:""}
              ${c.notes?`<p class="row-notes">${c.notes}</p>`:""}
              ${contacts || `<p class="row-meta" style="margin-top:6px">No contacts</p>`}
              <p class="row-meta" style="margin-top:6px">${appCount} application${appCount===1?"":"s"}</p>
            </div>
            <div class="row-actions">
              <button class="icon-btn" data-edit-co="${c.id}">Edit</button>
              <button class="icon-btn danger" data-del-co="${c.id}">Delete</button>
            </div>
          </div>`;
        }).join("");
        return head + rows;
      }
    },

    tailor: {
      title: "Tailor",
      sub: "Run Gemini and Claude side by side, then compare or merge.",
      render(){
        const apps = State.data?.applications ?? [];
        const t = State.tailor;
        const r = t.results || {};
        const appOpts = `<option value="">— not linked —</option>` +
          apps.map(a => {
            const co = State.data.companies.find(c => c.id === a.companyId);
            return `<option value="${a.id}" ${t.appId===a.id?"selected":""}>${a.role}${co?` · ${co.name}`:""}</option>`;
          }).join("");

        const gOn = t.providers.gemini, pOn = t.providers.paste;
        const geminiReady = hasGemini();
        const haveTwo = r.gemini && r.paste;
        const anyResult = r.gemini || r.paste || r.merged;

        return `
        <div class="panel">
          <h2 style="margin:0 0 14px">New tailoring</h2>

          <div class="field">
            <label>Link to application (optional — controls where files save)</label>
            <select id="tailorApp">${appOpts}</select>
          </div>

          <div class="field">
            <label>Council — choose engines</label>
            <div class="provider-toggle">
              <label class="prov ${gOn?"on":""}">
                <input type="checkbox" id="provGemini" ${gOn?"checked":""}/>
                <span>Gemini <em>${geminiReady?"· one-click, free":"· add key in Settings"}</em></span>
              </label>
              <label class="prov ${pOn?"on":""}">
                <input type="checkbox" id="provPaste" ${pOn?"checked":""}/>
                <span>Claude via paste <em>· free, manual</em></span>
              </label>
            </div>
          </div>

          <div class="field">
            <label>Job description</label>
            <textarea id="tailorJD" class="jd" placeholder="Paste the full job posting here…">${esc(t.jdText)||""}</textarea>
          </div>

          <div class="toolbar">
            ${gOn ? `<button class="btn btn-primary" id="btnRunGemini" ${t.busy?"disabled":""}>Run Gemini</button>` : ""}
            ${pOn ? `<button class="btn ${gOn?"btn-quiet":"btn-primary"}" id="btnCopyPrompt">Copy prompt for Claude.ai</button>` : ""}
            ${pOn ? `<button class="btn btn-quiet" id="btnPasteToggle">Paste response</button>` : ""}
            ${anyResult ? `<button class="btn btn-quiet" id="btnClearTailor" style="margin-left:auto">Clear results</button>` : ""}
          </div>
          <div id="tailorStatus" class="status-line"></div>

          ${pOn ? `
          <div class="field" id="pasteBox" style="display:none">
            <label>Paste Claude's JSON response (from Claude.ai)</label>
            <textarea id="tailorPaste" placeholder="Paste the JSON you got back…"></textarea>
            <button class="btn" id="btnApplyPaste" style="margin-top:8px">Parse response</button>
          </div>` : ""}
        </div>

        ${haveTwo ? `<div class="toolbar" style="margin:0 0 12px">
          <button class="btn btn-primary" id="btnMerge" ${(t.busy || !hasGemini())?"disabled":""}>⚖︎ Merge best of both</button>
          <span class="hint" style="margin:0">${hasGemini()
            ? "A judge step — Gemini synthesizes the strongest resume, letter, and gaps from both."
            : "Merge uses Gemini as the judge — add a Gemini key in Settings to enable it."}</span>
        </div>` : ""}

        ${r.merged ? `<div class="merged-banner">Merged result</div>${renderTailorResult(r.merged, "merged")}` : ""}

        ${(r.gemini || r.paste) ? `<div class="council">
          ${r.gemini ? `<div class="council-col"><div class="council-head">Gemini</div>${renderTailorResult(r.gemini, "gemini")}</div>` : ""}
          ${r.paste ? `<div class="council-col"><div class="council-head">Claude (pasted)</div>${renderTailorResult(r.paste, "paste")}</div>` : ""}
        </div>` : ""}
        `;
      }
    },

    profile: {
      title: "Profile",
      sub: "Your master resume and contact details — reused for every tailoring.",
      render(){
        const p = State.data?.profile ?? {};
        const field = (id, label, val, ph, type) =>
          `<div class="field"><label>${label}</label><input id="${id}" ${type?`type="${type}"`:""} value="${esc(val||"")}" placeholder="${ph}" /></div>`;
        return `
        <div class="panel">
          <h2>Master resume</h2>
          <p class="hint">Stored once and reused for every tailoring. Paste text or upload a file (.docx / .pdf / .txt).</p>
          <div class="dropzone ${p.masterResume?"has-file":""}" id="resumeDrop">
            ${p.masterResume
              ? `Resume loaded (${p.masterResume.length.toLocaleString()} chars). Click to replace, or edit below.`
              : `Click to upload .docx / .pdf / .txt — or paste below.`}
          </div>
          <input type="file" id="resumeFile" accept=".docx,.pdf,.txt,.md" hidden />
          <div class="field" style="margin-top:12px">
            <label>Resume text</label>
            <textarea id="resumeText" placeholder="Your master resume in plain text…">${p.masterResume || ""}</textarea>
          </div>
          ${p.masterResume ? `<button class="btn btn-quiet" id="btnRemoveResume" style="margin-top:8px">Remove resume</button>` : ""}
        </div>

        <div class="panel">
          <h2>Contact details</h2>
          <p class="hint">The Tailor council can draw on these for cover letters. Optional, but a name and email make letters read better.</p>
          ${field("p_name", "Full name", p.name, "e.g. Hasan…")}
          <div class="field-row">
            ${field("p_email", "Email", p.email, "you@example.com", "email")}
            ${field("p_phone", "Phone", p.phone, "optional", "tel")}
          </div>
          ${field("p_location", "Location", p.location, "City, ST / Remote")}
          <div class="field-row">
            ${field("p_linkedin", "LinkedIn URL", p.linkedin, "https://linkedin.com/in/…", "url")}
            ${field("p_portfolio", "Portfolio / website", p.portfolio, "https://…", "url")}
          </div>
          <button class="btn btn-primary" id="btnSaveProfile" style="margin-top:6px">Save profile</button>
          <span class="hint" id="profileStatus" style="margin-left:10px"></span>
        </div>
        `;
      }
    },

    settings: {
      title: "Settings",
      sub: "API keys, model, data tools, and pipeline statuses.",
      render(){
        const cfg = State.data?.config ?? {};
        const keyOn = hasKey();
        const tmode = themeMode();
        return `
        <div class="panel">
          <h2>Appearance</h2>
          <p class="hint">Choose a theme. “System” follows your operating-system light/dark setting. (Also toggles with the command palette — ${IS_MAC ? "⌘" : "Ctrl"}+K.)</p>
          <div class="toolbar" id="themeChoice">
            ${["light","dark","system"].map(m =>
              `<button class="btn ${tmode===m?"btn-primary":"btn-quiet"}" data-theme-set="${m}">${m[0].toUpperCase()+m.slice(1)}</button>`).join("")}
          </div>
        </div>

        <div class="panel">
          <h2>AI access</h2>
          <p class="hint">
            The Tailor page runs a "council" — Gemini (free, one-click) and/or Claude via
            copy-paste into Claude.ai. Keys are saved in a separate <code>config.json</code> in your
            folder, never in data.json. Treat them like house keys; if the drive is lost, revoke them.
          </p>

          <div class="field">
            <label>Gemini API key ${hasGemini()?`<span class="key-badge ok">set</span>`:""}</label>
            <input id="geminiKey" type="password" placeholder="AIza…" value="${State.geminiKey || ""}" />
            <button class="btn" id="btnSaveGemini" style="margin-top:8px">Save Gemini key</button>
            ${hasGemini()?`<button class="btn btn-quiet" id="btnClearGemini" style="margin-top:8px;margin-left:6px">Remove</button>`:""}
            <p class="hint">Free key from Google AI Studio (aistudio.google.com). Uses Google's free <code>gemini-3-flash</code> model — no billing needed. <strong>Important:</strong> as of mid-2026 Google requires keys to have restrictions applied — when creating the key, add an application or API restriction, or requests will be rejected.</p>
          </div>

          <div class="field">
            <label>Anthropic API key ${keyOn?`<span class="key-badge ok">set</span>`:""} <span class="hint" style="display:inline">— optional, paid</span></label>
            <input id="apiKey" type="password" placeholder="sk-ant-…" value="${State.apiKey || ""}" />
            <button class="btn" id="btnSaveKey" style="margin-top:8px">Save key</button>
            ${keyOn?`<button class="btn btn-quiet" id="btnClearKey" style="margin-top:8px;margin-left:6px">Remove key</button>`:""}
            <p class="hint">Optional. The council currently uses Gemini (one-click) + Claude-via-paste; an Anthropic key isn't required.</p>
          </div>

          <div class="field">
            <label>Claude model (paste-prompt label only)</label>
            <select id="modelSel">
              <option value="claude-opus-4-8" ${cfg.model==="claude-opus-4-8"?"selected":""}>Claude Opus 4.8 — best quality</option>
              <option value="claude-sonnet-4-6" ${cfg.model==="claude-sonnet-4-6"?"selected":""}>Claude Sonnet 4.6 — faster, cheaper</option>
            </select>
          </div>
          ${!State.dirHandle ? `<p class="hint">Note: on Safari (no connected folder) keys are held only for this session and aren't written to disk.</p>` : ""}
        </div>

        <div class="panel">
          <h2>Data &amp; backups</h2>
          <p class="hint">
            All your structured data lives in <code>data.json</code>. ${State.dirHandle
              ? `On save, a timestamped copy is written to <code>data.backups/</code> (most recent ${30} kept), so you can roll back if something goes wrong.`
              : `Connect a folder (Chrome/Edge) to enable automatic timestamped backups. On Safari, use Export below for safekeeping.`}
          </p>
          <div class="toolbar" style="margin-top:6px">
            <button class="btn btn-primary" id="btnExport">Export everything (.zip)</button>
            <button class="btn btn-quiet" id="btnExportICS">Export follow-ups (.ics)</button>
            ${State.dirHandle ? `<button class="btn btn-quiet" id="btnBackupNow">Back up now</button>` : ""}
          </div>
          <p class="hint" id="dataStatus"></p>
          <p class="hint">Export includes <code>data.json</code> (re-importable via Load file) plus readable <code>applications.csv</code> and <code>companies.csv</code> (re-importable below). Tailored documents stay in their application folders.</p>
        </div>

        <div class="panel">
          <h2>Data integrity</h2>
          <p class="hint">Scans for orphaned company links, unknown statuses, malformed dates, and missing or duplicate ids. Repairs run through undo, so a bad repair is reversible.</p>
          <div id="integrityFindings">${renderIntegrityFindings()}</div>
          <div class="toolbar" style="margin-top:10px">
            <button class="btn" id="btnScan">Scan now</button>
            <button class="btn btn-primary" id="btnRepair">Repair all</button>
          </div>
        </div>

        <div class="panel">
          <h2>Import (CSV)</h2>
          <p class="hint">Bring in applications or companies from a CSV — the same shape “Export everything” produces. You’ll see a preview before anything is added; nothing is overwritten and the import can be undone (${IS_MAC ? "⌘" : "Ctrl"}+Z).</p>
          <input type="file" id="csvFile" accept=".csv,text/csv" hidden />
          <button class="btn btn-primary" id="btnImportCSV">Choose CSV…</button>
          <p class="hint" id="importStatus"></p>
        </div>

        <div class="panel">
          <h2>Recycle bin</h2>
          <p class="hint">Deleted applications and companies are kept here for ${TRASH_TTL_DAYS} days before automatic removal. Restoring a company also re-links its applications.</p>
          <div id="trashList">${renderTrashList()}</div>
          ${(State.data.trash||[]).length ? `<div class="toolbar" style="margin-top:10px"><button class="btn icon-btn danger" id="btnEmptyTrash">Empty recycle bin</button></div>` : ""}
        </div>

        <div class="panel">
          <h2>Pipeline statuses</h2>
          <p class="hint">These are your funnel stages — they drive the pipeline board, the dashboard, and the status dropdown on applications. Reorder them to match your real process. Each has a <strong>type</strong> that tells the dashboard how to count it:</p>
          <ul class="gap-list" style="margin:0 0 14px">
            <li><span class="gap-tag" style="background:var(--tag-active-bg);color:var(--sage)">active</span><span>In progress, not yet a response (e.g. Wishlist, Applied).</span></li>
            <li><span class="gap-tag" style="background:var(--tag-responded-bg);color:var(--seal)">responded</span><span>Counts as “heard back” for response rate (e.g. Under Consideration, Interview).</span></li>
            <li><span class="gap-tag" style="background:var(--tag-terminal-bg);color:var(--faded)">terminal</span><span>Closed out — drops from “active” (e.g. Not Selected, Closed).</span></li>
          </ul>
          <div id="statusList">${renderStatusEditor()}</div>
          <div class="field" style="margin-top:14px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
            <div style="flex:1;min-width:160px"><label>Add a status</label><input id="newStatusName" placeholder="e.g. Assessment" /></div>
            <select id="newStatusType" style="flex:0 0 auto">
              <option value="active">active</option>
              <option value="responded">responded</option>
              <option value="terminal">terminal</option>
            </select>
            <button class="btn" id="btnAddStatus">Add</button>
          </div>
        </div>
        `;
      }
    },
  };

  function renderStatusEditor(){
    const m = State.data.meta;
    const typeColor = (t) => t==="responded" ? "background:var(--tag-responded-bg);color:var(--seal)"
                          : t==="terminal" ? "background:var(--tag-terminal-bg);color:var(--faded)"
                          : "background:var(--tag-active-bg);color:var(--sage)";
    return m.statuses.map((name, i) => {
      const t = statusType(name);
      const count = State.data.applications.filter(a => a.status === name).length;
      return `<div class="status-row" data-status="${esc(name)}">
        <div class="status-reorder">
          <button class="icon-btn" data-smove="-1" data-name="${esc(name)}" ${i===0?"disabled":""}>↑</button>
          <button class="icon-btn" data-smove="1" data-name="${esc(name)}" ${i===m.statuses.length-1?"disabled":""}>↓</button>
        </div>
        <input class="status-name" data-rename="${esc(name)}" value="${esc(name)}" />
        <select class="status-type" data-stype="${esc(name)}">
          <option value="active" ${t==="active"?"selected":""}>active</option>
          <option value="responded" ${t==="responded"?"selected":""}>responded</option>
          <option value="terminal" ${t==="terminal"?"selected":""}>terminal</option>
        </select>
        <span class="status-count">${count}</span>
        <button class="icon-btn danger" data-sdelete="${esc(name)}">delete</button>
      </div>`;
    }).join("");
  }

  // --- Settings: data-integrity findings + recycle-bin list ---
  function renderIntegrityFindings(){
    const issues = State.integrity || [];
    if (!issues.length) return `<p class="hint">No issues detected — your data looks healthy.</p>`;
    return `<ul class="gap-list">${issues.map(i =>
      `<li><span class="gap-tag" style="background:var(--tag-responded-bg);color:var(--seal)">${i.count}</span><span>${esc(i.message)}</span></li>`
    ).join("")}</ul>`;
  }
  function fmtWhen(iso){
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric" });
  }
  function renderTrashList(){
    const t = State.data.trash || [];
    if (!t.length) return `<p class="hint">Recycle bin is empty.</p>`;
    return `<ul class="trash-list">${t.map((x, i) => `
      <li class="trash-item">
        <div>
          <span class="trash-kind">${x.kind === "company" ? "Company" : "Application"}</span>
          <span class="trash-label">${esc(x.label || "")}</span>
          <span class="hint" style="display:block">deleted ${esc(fmtWhen(x.deletedAt))}</span>
        </div>
        <div class="trash-actions">
          <button class="btn btn-quiet" data-restore="${i}">Restore</button>
          <button class="btn icon-btn danger" data-purge="${i}">Delete forever</button>
        </div>
      </li>`).join("")}</ul>`;
  }

  // ============================================================
  //  APPLICATION FORM (add / edit / delete)
  // ============================================================
  function openAppForm(appId){
    if (!State.data){ toast("Connect a folder first to add applications."); return; }
    const editing = !!appId;
    const a = editing ? State.data.applications.find(x => x.id === appId) : {
      id: uid("app"), companyId:"", role:"", location:"", source:"", url:"",
      salaryRange:"", status:"Wishlist", dateApplied:"", followUpDate:"", folder:"", notesLog:[], statusHistory:[]
    };
    const statuses = State.data.meta.statuses;
    const coOpts = `<option value="">— select or add below —</option>` +
      State.data.companies.map(c => `<option value="${c.id}" ${c.id===a.companyId?"selected":""}>${c.name}</option>`).join("");

    const notes = (a.notesLog || []).slice().reverse();
    openModal(`
      <div class="modal-head">
        <h2>${editing?"Edit application":"New application"}</h2>
        <button class="modal-close" data-close>&times;</button>
      </div>

      <section class="form-section">
        <h3 class="form-section-title">Role &amp; company</h3>
        <div class="field">
          <label>Role / title</label>
          <input id="f_role" value="${esc(a.role)}" placeholder="e.g. Senior Operations Analyst" />
        </div>
        <div class="field">
          <label>Company</label>
          <select id="f_company">${coOpts}</select>
          <p class="hint">Not listed? Type a new name below and it'll be created.</p>
          <input id="f_newco" placeholder="New company name (optional)" style="margin-top:6px" />
        </div>
        <div class="field-row">
          <div class="field"><label>Location</label><input id="f_location" value="${esc(a.location)}" placeholder="City, ST / Remote" /></div>
          <div class="field"><label>Salary range</label><input id="f_salary" value="${esc(a.salaryRange)}" placeholder="optional" /></div>
        </div>
        <div class="field"><label>Source</label><input id="f_source" value="${esc(a.source)}" placeholder="LinkedIn, referral…" /></div>
      </section>

      <section class="form-section">
        <h3 class="form-section-title">Status &amp; timeline</h3>
        <div class="field-row">
          <div class="field"><label>Status</label><select id="f_status">${selectOptions(statuses, a.status)}</select></div>
          <div class="field"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Date applied</label><input id="f_dateApplied" type="date" value="${esc(a.dateApplied)}" /></div>
          <div class="field"><label>Follow-up date</label><input id="f_followUpDate" type="date" value="${esc(a.followUpDate)}" /></div>
        </div>
      </section>

      <section class="form-section">
        <h3 class="form-section-title">Documents</h3>
        <div class="field">
          <label>Posting URL</label>
          <input id="f_url" value="${esc(a.url)}" placeholder="https://…" />
        </div>
        <div class="field">
          <label>Folder ${State.dirHandle?`<span class="key-badge ok">auto-created on save</span>`:`<span class="key-badge">create manually</span>`}</label>
          <input id="f_folder" value="${esc(a.folder)}" placeholder="auto-generated from company + role" />
          <p class="hint">Leave blank to auto-name it (YYYY-MM_Company_Role). ${State.dirHandle?"The subfolder is created on disk when you save.":"On Safari, create this subfolder yourself inside /applications."}</p>
        </div>
        <div class="field">
          <label>Files in this folder</label>
          <div id="folderFiles"><p class="hint">${State.dirHandle
            ? (editing ? "Checking this application's folder…" : "Save the application first; tailored .docx files saved into it will be listed here.")
            : "Connect a folder (Chrome/Edge) to list, preview, and download the files saved for this application."}</p></div>
          <div id="filePreview"></div>
        </div>
        ${editing ? `
        <div class="field">
          <label>Captured text (from Tailor)</label>
          <div id="appDocs"><p class="hint">${State.dirHandle
            ? "Checking this application's folder…"
            : "Connect a folder (Chrome/Edge) to view the captured job description and tailored documents inline."}</p></div>
        </div>` : ""}
      </section>

      <section class="form-section">
        <h3 class="form-section-title">Notes</h3>
        ${notes.length
          ? `<ul class="note-log">${notes.map(n => `<li><span class="note-ts">${esc(fmtWhen(n.ts))}</span><span class="note-text">${esc(n.text)}</span></li>`).join("")}</ul>`
          : `<p class="hint">No notes yet.</p>`}
        <div class="field" style="margin-top:8px">
          <textarea id="f_newNote" placeholder="Add a note — saved when you save the application…"></textarea>
        </div>
      </section>

      <div class="modal-foot">
        ${editing?`<button class="btn icon-btn danger" data-del-app="${a.id}" style="margin-right:auto">Delete</button>`:""}
        <button class="btn btn-quiet" data-close>Cancel</button>
        <button class="btn btn-primary" id="f_save">${editing?"Save changes":"Add application"}</button>
      </div>
    `);

    $("#f_save").addEventListener("click", () => saveAppForm(a, editing));
    $$("[data-close]").forEach(b => b.addEventListener("click", closeModal));
    $("[data-del-app]")?.addEventListener("click", () => { if (confirmDelete()) { deleteApp(a.id); closeModal(); } });
    if (editing && State.dirHandle) populateAppDocs(a);     // application.json text (Phase 2)
    if (State.dirHandle) populateFolderFiles(a);            // list real files in the folder (Phase 4.3)
  }

  // List the actual files in an application's folder, with preview/download (Chrome/Edge).
  async function populateFolderFiles(app){
    const host = $("#folderFiles");
    if (!host) return;
    if (!app.folder){ host.innerHTML = `<p class="hint">Save the application first to create its folder.</p>`; return; }
    let dir;
    try { dir = await getAppDirRead(app.folder); }
    catch { host.innerHTML = `<p class="hint">No folder on disk yet — it's created when you save.</p>`; return; }
    const files = [];
    try {
      for await (const [name, h] of dir.entries()){
        if (h.kind === "file" && name !== "application.json") files.push(name);  // app.json shown as "Captured text"
      }
    } catch(e){ console.warn(e); host.innerHTML = `<p class="hint">Couldn't read the folder.</p>`; return; }
    if (!host.isConnected) return;
    files.sort();
    if (!files.length){
      host.innerHTML = `<p class="hint">No files saved here yet. Tailored <code>.docx</code> files land here when you save them from the Tailor.</p>`;
      return;
    }
    const canPreview = (n) => /\.(docx|pdf|txt|md)$/i.test(n);
    host.innerHTML = `<ul class="file-list">${files.map(n => `
      <li class="file-item">
        <span class="file-name">${esc(n)}</span>
        <span class="file-actions">
          ${canPreview(n) ? `<button class="btn btn-quiet" data-preview="${esc(n)}">Preview</button>` : ""}
          <button class="btn btn-quiet" data-download="${esc(n)}">Download</button>
        </span>
      </li>`).join("")}</ul>
      <button class="btn btn-quiet" id="copyFolderPath" style="margin-top:6px">Copy folder path</button>`;
    host.querySelectorAll("[data-preview]").forEach(b => b.addEventListener("click", () => previewFolderFile(app, b.dataset.preview)));
    host.querySelectorAll("[data-download]").forEach(b => b.addEventListener("click", () => downloadFolderFile(app, b.dataset.download)));
    $("#copyFolderPath")?.addEventListener("click", () =>
      navigator.clipboard.writeText(app.folder).then(() => toast("Folder path copied"), () => toast("Couldn't copy path")));
  }
  async function previewFolderFile(app, name){
    const box = $("#filePreview");
    if (box) box.innerHTML = `<p class="hint">Reading ${esc(name)}…</p>`;
    try{
      const dir = await getAppDirRead(app.folder);
      const file = await (await dir.getFileHandle(name)).getFile();
      const text = await extractResumeFromFile(file);     // .docx/.pdf/.txt/.md
      if (!box || !box.isConnected) return;
      box.innerHTML = `<div class="file-preview"><div class="file-preview-head">${esc(name)}</div><div class="doc-preview">${escapeHtml(text)}</div></div>`;
    }catch(e){
      console.error(e);
      if (box && box.isConnected) box.innerHTML = `<p class="hint">Couldn't preview ${esc(name)} — it may be an unsupported or empty file.</p>`;
    }
  }
  async function downloadFolderFile(app, name){
    try{
      const dir = await getAppDirRead(app.folder);
      const file = await (await dir.getFileHandle(name)).getFile();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    }catch(e){ console.error(e); toast("Couldn't download that file."); }
  }

  // Read application.json for an app and render its JD + tailored text inline (read-only).
  async function populateAppDocs(app){
    const host = $("#appDocs");
    if (!host) return;
    const data = await readAppData(app);
    if (!host.isConnected) return;   // modal may have closed while reading
    if (!data){
      host.innerHTML = `<p class="hint">No captured documents yet. Run the <strong>Tailor</strong> with this application linked to save its job description and tailored resume/cover letter here.</p>`;
      return;
    }
    const block = (label, text) => text
      ? `<details class="appdoc"><summary>${label}</summary><div class="doc-preview">${escapeHtml(text)}</div></details>` : "";
    const meta = [
      data.savedAt ? `saved ${esc(fmtWhen(data.savedAt))}` : "",
      data.source ? esc(data.source) : "",
      (data.matchScore!=null && data.matchScore!=="") ? `match ${esc(String(data.matchScore))}/100` : "",
    ].filter(Boolean).join(" · ");
    host.innerHTML = `
      ${meta ? `<p class="hint">${meta}</p>` : ""}
      ${block("Job description", data.jobDescription)}
      ${block("Tailored resume", data.tailoredResume)}
      ${block("Cover letter", data.coverLetter)}
      ${!(data.jobDescription||data.tailoredResume||data.coverLetter) ? `<p class="hint">The saved file has no document text yet.</p>` : ""}`;
  }

  async function saveAppForm(a, editing){
    snapshot();
    const prevStatus = a.status;
    const val = (id) => $(id) ? $(id).value.trim() : "";
    a.role = val("#f_role");
    a.location = val("#f_location");
    a.status = val("#f_status");
    a.dateApplied = val("#f_dateApplied");
    a.followUpDate = val("#f_followUpDate");
    a.source = val("#f_source");
    a.salaryRange = val("#f_salary");
    a.url = val("#f_url");

    // company: existing selection or new name
    let companyId = $("#f_company").value;
    const newCo = val("#f_newco");
    if (newCo){
      const existing = State.data.companies.find(c => c.name.toLowerCase() === newCo.toLowerCase());
      if (existing){ companyId = existing.id; }
      else {
        const c = { id: uid("co"), name: newCo, website:"", notes:"", contacts:[] };
        State.data.companies.push(c);
        companyId = c.id;
      }
    }
    a.companyId = companyId;

    if (!a.role && !companyId){ alert("Add at least a role or a company."); return; }

    // append a new note if one was typed (after validation so a failed save can't double-add)
    const newNote = val("#f_newNote");
    if (newNote){
      if (!Array.isArray(a.notesLog)) a.notesLog = [];
      a.notesLog.push({ id: uid("n"), ts: new Date().toISOString(), text: newNote });
    }

    // folder: explicit, or auto-generate
    let folder = val("#f_folder");
    if (!folder){
      folder = buildFolderName(companyName(companyId), a.role, a.dateApplied);
    }
    a.folder = folder;

    // status history: seed initial stage for new apps; record a change for edits
    if (!editing || a.status !== prevStatus) recordStatus(a, a.status);

    if (!editing) State.data.applications.push(a);

    if (State.dirHandle){
      await createFolderOnDisk(folder);
    }

    markDirty();
    closeModal();
    render();
  }

  function deleteApp(id){
    const a = State.data.applications.find(x => x.id === id);
    if (!a) return;
    snapshot();
    State.data.applications = State.data.applications.filter(x => x.id !== id);
    State.data.trash.push({
      kind:"application", item: clone(a), deletedAt: new Date().toISOString(),
      label: (a.role || "Untitled role") + (companyName(a.companyId) ? " · " + companyName(a.companyId) : ""),
    });
    markDirty(); render();
    toast("Application moved to recycle bin", "Undo", undo);
  }

  // ============================================================
  //  COMPANY FORM (add / edit / delete)
  // ============================================================
  function openCoForm(coId){
    const editing = !!coId;
    const c = editing ? State.data.companies.find(x => x.id === coId)
                      : { id: uid("co"), name:"", website:"", notes:"", contacts:[] };
    const contacts = JSON.parse(JSON.stringify(c.contacts || []));

    openModal(`
      <div class="modal-head">
        <h2>${editing?"Edit company":"New company"}</h2>
        <button class="modal-close" data-close>&times;</button>
      </div>
      <div class="field"><label>Name</label><input id="c_name" value="${esc(c.name)}" placeholder="Company name" /></div>
      <div class="field"><label>Website</label><input id="c_website" value="${esc(c.website)}" placeholder="https://…" /></div>
      <div class="field"><label>Notes</label><textarea id="c_notes" placeholder="What you know about them…">${esc(c.notes)}</textarea></div>
      <div class="field">
        <label>Contacts</label>
        <div id="c_contacts"></div>
        <button class="btn btn-quiet" id="c_addContact" style="margin-top:6px">Add contact</button>
      </div>
      <div class="modal-foot">
        ${editing?`<button class="btn icon-btn danger" id="c_del" style="margin-right:auto">Delete</button>`:""}
        <button class="btn btn-quiet" data-close>Cancel</button>
        <button class="btn btn-primary" id="c_save">${editing?"Save changes":"Add company"}</button>
      </div>
    `);

    function renderContacts(){
      $("#c_contacts").innerHTML = contacts.map((ct,i) => `
        <div class="contact-block">
          <button class="icon-btn danger" data-rmc="${i}">remove</button>
          <div class="field-row">
            <div class="field" style="margin:0 0 8px"><label>Name</label><input data-cf="name" data-ci="${i}" value="${esc(ct.name)}" /></div>
            <div class="field" style="margin:0 0 8px"><label>Role</label><input data-cf="role" data-ci="${i}" value="${esc(ct.role)}" /></div>
          </div>
          <div class="field-row">
            <div class="field" style="margin:0"><label>Email</label><input data-cf="email" data-ci="${i}" value="${esc(ct.email)}" /></div>
            <div class="field" style="margin:0"><label>Phone</label><input data-cf="phone" data-ci="${i}" value="${esc(ct.phone)}" /></div>
          </div>
        </div>`).join("") || `<p class="hint">No contacts yet.</p>`;

      $$('#c_contacts [data-cf]').forEach(inp => inp.addEventListener("input", e => {
        contacts[+e.target.dataset.ci][e.target.dataset.cf] = e.target.value;
      }));
      $$('#c_contacts [data-rmc]').forEach(b => b.addEventListener("click", e => {
        contacts.splice(+e.target.dataset.rmc, 1); renderContacts();
      }));
    }
    renderContacts();

    $("#c_addContact").addEventListener("click", () => {
      contacts.push({ id: uid("ct"), name:"", role:"", email:"", phone:"" }); renderContacts();
    });
    $("#c_save").addEventListener("click", () => {
      const name = $("#c_name").value.trim();
      if (!name){ alert("Company needs a name."); return; }
      snapshot();
      c.name = name;
      c.website = $("#c_website").value.trim();
      c.notes = $("#c_notes").value.trim();
      c.contacts = contacts;
      if (!editing) State.data.companies.push(c);
      markDirty(); closeModal(); render();
    });
    $("#c_del")?.addEventListener("click", () => { if (confirmDeleteCompany(c.id)) { deleteCompany(c.id); closeModal(); } });
    $$("[data-close]").forEach(b => b.addEventListener("click", closeModal));
  }

  function deleteCompany(id){
    const c = State.data.companies.find(x => x.id === id);
    if (!c) return;
    snapshot();
    const linkedAppIds = State.data.applications.filter(a => a.companyId === id).map(a => a.id);
    State.data.companies = State.data.companies.filter(x => x.id !== id);
    State.data.applications.forEach(a => { if (a.companyId === id) a.companyId = ""; });
    State.data.trash.push({
      kind:"company", item: clone(c), linkedAppIds, deletedAt: new Date().toISOString(),
      label: c.name || "Untitled company",
    });
    markDirty(); render();
    toast("Company moved to recycle bin — applications unlinked", "Undo", undo);
  }

  function confirmDelete(){ return confirm("Move this application to the recycle bin? You can restore it (kept 30 days) or undo immediately."); }
  function confirmDeleteCompany(id){
    const n = State.data.applications.filter(a => a.companyId === id).length;
    const tail = " It goes to the recycle bin (kept 30 days); restoring re-links them.";
    return confirm((n ? `Move this company to the recycle bin? ${n} application(s) will be unlinked (not deleted).` : "Move this company to the recycle bin?") + tail);
  }

  function esc(s){ return String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

  // ============================================================
  //  PIPELINE STATUS EDITOR (add / rename / reorder / delete + type)
  // ============================================================
  function addStatus(name, type){
    name = (name||"").trim();
    if (!name){ alert("Status needs a name."); return false; }
    if (State.data.meta.statuses.includes(name)){ alert("That status already exists."); return false; }
    snapshot();
    State.data.meta.statuses.push(name);
    State.data.meta.statusMeta[name] = type || "active";
    markDirty(); return true;
  }

  function renameStatus(oldName, newName){
    newName = (newName||"").trim();
    if (!newName || newName === oldName) return false;
    if (State.data.meta.statuses.includes(newName)){ alert("That status name already exists."); return false; }
    const i = State.data.meta.statuses.indexOf(oldName);
    if (i < 0) return false;
    snapshot();
    State.data.meta.statuses[i] = newName;
    State.data.meta.statusMeta[newName] = State.data.meta.statusMeta[oldName] || "active";
    delete State.data.meta.statusMeta[oldName];
    // migrate every application currently at the old name
    State.data.applications.forEach(a => { if (a.status === oldName) a.status = newName; });
    markDirty(); return true;
  }

  function setStatusType(name, type){
    if (!State.data.meta.statuses.includes(name)) return;
    snapshot();
    State.data.meta.statusMeta[name] = type;
    markDirty();
  }

  function moveStatus(name, dir){ // dir = -1 up, +1 down
    const arr = State.data.meta.statuses;
    const i = arr.indexOf(name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    snapshot();
    [arr[i], arr[j]] = [arr[j], arr[i]];
    markDirty();
  }

  function deleteStatus(name){
    const arr = State.data.meta.statuses;
    if (arr.length <= 1){ alert("You need at least one status."); return; }
    const used = State.data.applications.filter(a => a.status === name);
    let target = null;
    if (used.length){
      // require reassignment — never orphan applications
      const others = arr.filter(s => s !== name);
      target = prompt(
        `${used.length} application(s) use "${name}". Reassign them to which status?\n\nType one of: ${others.join(", ")}`,
        others[0]
      );
      if (target === null) return;            // cancelled
      if (!arr.includes(target)){ alert("That isn't an existing status — nothing deleted."); return; }
    }
    snapshot();   // after all guards, before mutating, so a cancel doesn't disturb undo/redo
    if (target) State.data.applications.forEach(a => { if (a.status === name) a.status = target; });
    State.data.meta.statuses = arr.filter(s => s !== name);
    delete State.data.meta.statusMeta[name];
    markDirty();
  }

  // ============================================================
  //  DASHBOARD STATS
  // ============================================================
  function computeStats(){
    const apps = State.data.applications || [];
    const statuses = State.data.meta.statuses;
    const today = new Date().toISOString().slice(0,10);
    const firstName = statuses[0]; // the "not yet applied" stage (e.g. Wishlist)

    const byStatus = {};
    statuses.forEach(s => byStatus[s] = 0);
    apps.forEach(a => { const s = a.status||firstName; byStatus[s] = (byStatus[s]||0)+1; });

    // "applied" = past the first (wishlist-like) stage; "heard back" = any responded-type status.
    const reachedApplied = apps.filter(a => (a.status||firstName) !== firstName).length;
    const heardBack = apps.filter(a => isResponded(a.status)).length;
    const offers = byStatus["Offer"] || 0;
    const active = apps.filter(a => !isTerminal(a.status||firstName)).length;

    const responseRate = reachedApplied ? Math.round((heardBack / reachedApplied) * 100) : 0;
    const offerRate = reachedApplied ? Math.round((offers / reachedApplied) * 100) : 0;

    const followups = apps
      .filter(a => a.followUpDate && !isTerminal(a.status||firstName))
      .sort((x,y) => x.followUpDate.localeCompare(y.followUpDate));
    const overdue = followups.filter(a => a.followUpDate < today).length;
    const dueToday = followups.filter(a => a.followUpDate === today).length;

    const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };
    const last7  = apps.filter(a => a.dateApplied && a.dateApplied >= daysAgo(7)).length;
    const last30 = apps.filter(a => a.dateApplied && a.dateApplied >= daysAgo(30)).length;

    // --- time-in-stage (avg days spent in each status, from completed transitions) ---
    const durations = {};   // status -> [days, …]
    apps.forEach(a => {
      const h = a.statusHistory || [];
      for (let i = 0; i < h.length - 1; i++){
        const d = (Date.parse(h[i+1].ts) - Date.parse(h[i].ts)) / 86400000;
        if (isFinite(d) && d >= 0) (durations[h[i].status] || (durations[h[i].status] = [])).push(d);
      }
    });
    const timeInStage = statuses.map(st => {
      const arr = durations[st] || [];
      const avg = arr.length ? arr.reduce((x,y)=>x+y,0) / arr.length : null;
      return { status: st, avgDays: avg, samples: arr.length };
    });
    // "stalled" = the non-terminal stage with the highest average dwell time
    const stalled = timeInStage
      .filter(t => t.avgDays != null && !isTerminal(t.status))
      .sort((a,b) => b.avgDays - a.avgDays)[0] || null;

    // --- weekly trend: applications by dateApplied over the last 8 rolling 7-day windows ---
    const WEEKS = 8;
    const iso = (d) => d.toISOString().slice(0,10);
    const weekly = [];
    for (let w = WEEKS - 1; w >= 0; w--){
      const end = new Date();   end.setDate(end.getDate() - w*7);
      const start = new Date(end); start.setDate(start.getDate() - 6);
      const s0 = iso(start), e0 = iso(end);
      weekly.push({ start:s0, end:e0, count: apps.filter(a => a.dateApplied && a.dateApplied >= s0 && a.dateApplied <= e0).length });
    }

    return { apps, statuses, today, byStatus, reachedApplied, heardBack,
             offers, active, responseRate, offerRate, followups, overdue, dueToday, last7, last30,
             timeInStage, stalled, weekly };
  }

  // Tiny inline-SVG sparkline (no charting lib). values: number[].
  function sparkline(values, w = 168, h = 38){
    const n = values.length;
    if (!n) return "";
    const max = Math.max(1, ...values);
    const xy = (v, i) => {
      const x = n > 1 ? (i/(n-1))*(w-6)+3 : w/2;
      const y = h - 3 - (v/max)*(h-8);
      return [x, y];
    };
    const pts = values.map((v,i) => xy(v,i).map(z => z.toFixed(1)).join(",")).join(" ");
    const dots = values.map((v,i) => { const [x,y] = xy(v,i); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.7" fill="var(--seal)"/>`; }).join("");
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" role="img" aria-label="weekly trend">
      <polyline points="${pts}" fill="none" stroke="var(--seal)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>`;
  }

  // ============================================================
  //  PIPELINE BOARD — drag & drop (native + pointer fallback)
  // ============================================================
  function moveCard(appId, newStatus){
    const a = State.data.applications.find(x => x.id === appId);
    if (!a || a.status === newStatus) return;
    snapshot();
    a.status = newStatus;
    recordStatus(a, newStatus);     // time-in-stage analytics
    markDirty();
    render();
  }

  function bindBoard(){
    let draggingId = null;

    // --- native HTML5 DnD (mouse/trackpad) ---
    $$(".card").forEach(card => {
      card.addEventListener("dragstart", (e) => {
        draggingId = card.dataset.card;
        card.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", draggingId);
      });
      card.addEventListener("dragend", () => {
        draggingId = null;
        card.classList.remove("dragging");
        $$(".col-body").forEach(b => b.classList.remove("drop-hot"));
      });
      // click-to-edit (suppressed if a drag happened)
      let downX, downY;
      card.addEventListener("pointerdown", e => { downX=e.clientX; downY=e.clientY; });
      card.addEventListener("click", e => {
        if (downX!=null && Math.abs(e.clientX-downX)<5 && Math.abs(e.clientY-downY)<5){
          openAppForm(card.dataset.card);
        }
      });
    });

    $$(".col-body").forEach(body => {
      body.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        body.classList.add("drop-hot");
      });
      body.addEventListener("dragleave", () => body.classList.remove("drop-hot"));
      body.addEventListener("drop", (e) => {
        e.preventDefault();
        body.classList.remove("drop-hot");
        const id = e.dataTransfer.getData("text/plain") || draggingId;
        if (id) moveCard(id, body.dataset.dropcol);
      });
    });

    // --- pointer fallback for touch devices ---
    bindTouchDrag();
  }

  function bindTouchDrag(){
    let ghost=null, srcId=null, lastCol=null;
    $$(".card").forEach(card => {
      card.addEventListener("touchstart", (e) => {
        srcId = card.dataset.card;
        const t = e.touches[0];
        ghost = card.cloneNode(true);
        Object.assign(ghost.style, {position:"fixed",pointerEvents:"none",opacity:"0.85",
          width:card.offsetWidth+"px",left:t.clientX-40+"px",top:t.clientY-20+"px",zIndex:"99",
          boxShadow:"0 6px 18px rgba(0,0,0,.25)"});
        document.body.appendChild(ghost);
        card.classList.add("dragging");
      }, {passive:true});
      card.addEventListener("touchmove", (e) => {
        if (!ghost) return;
        const t = e.touches[0];
        ghost.style.left = t.clientX-40+"px";
        ghost.style.top  = t.clientY-20+"px";
        const el = document.elementFromPoint(t.clientX, t.clientY);
        const col = el && el.closest ? el.closest(".col-body") : null;
        $$(".col-body").forEach(b => b.classList.remove("drop-hot"));
        if (col){ col.classList.add("drop-hot"); lastCol = col.dataset.dropcol; }
        else lastCol = null;
      }, {passive:true});
      card.addEventListener("touchend", () => {
        if (ghost){ ghost.remove(); ghost=null; }
        card.classList.remove("dragging");
        $$(".col-body").forEach(b => b.classList.remove("drop-hot"));
        if (srcId && lastCol) moveCard(srcId, lastCol);
        srcId=null; lastCol=null;
      });
    });
  }

  function renderTailorResult(r, key){
    key = key || "r";
    const sev = (s) => s === "missing" ? "gap-missing" : "gap-weak";
    const gaps = (r.gaps||[]).map(g =>
      `<li><span class="gap-tag ${sev(g.severity)}">${g.severity||"note"}</span>
        <span><strong>${esc(g.item)||""}</strong>${g.note?` — ${esc(g.note)}`:""}</span></li>`).join("") || `<li class="empty">No significant gaps flagged.</li>`;
    const score = Math.max(0, Math.min(100, parseInt(r.matchScore,10) || 0));

    return `
    <div class="panel result" data-result="${key}">
      <div class="tabs">
        <button class="tab is-active" data-tab="match">Match</button>
        <button class="tab" data-tab="gaps">Gaps</button>
        <button class="tab" data-tab="resume">Resume</button>
        <button class="tab" data-tab="cover">Cover letter</button>
      </div>

      <div class="tabpane is-active" data-pane="match">
        <div class="score-badge"><span class="score-num">${score}</span><span class="score-max">/ 100</span></div>
        <div class="meter"><div class="meter-fill" style="width:${score}%"></div></div>
        <p style="font-size:14.5px;line-height:1.6;margin:0">${esc(r.rationale)||""}</p>
      </div>

      <div class="tabpane" data-pane="gaps">
        <ul class="gap-list">${gaps}</ul>
      </div>

      <div class="tabpane" data-pane="resume">
        <div class="doc-preview">${escapeHtml(r.tailoredResume||"")}</div>
        <button class="btn btn-primary" data-save-doc="resume" data-key="${key}" style="margin-top:12px">Save resume .docx</button>
        <span class="hint" data-where="resume-${key}"></span>
      </div>

      <div class="tabpane" data-pane="cover">
        <div class="doc-preview">${escapeHtml(r.coverLetter||"")}</div>
        <button class="btn btn-primary" data-save-doc="cover" data-key="${key}" style="margin-top:12px">Save cover letter .docx</button>
        <span class="hint" data-where="cover-${key}"></span>
      </div>
    </div>`;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  }

  // wire up interactive bits after each render (views are re-rendered wholesale)
  function bindViewEvents(){
    // cross-cutting actions (onboarding card + empty-state buttons can appear on several views)
    $("[data-ob-dismiss]")?.addEventListener("click", dismissOnboarding);
    $("[data-ob-connect]")?.addEventListener("click", () => { (State._savedDir && !State.dirHandle) ? reconnectSaved() : connectFolder(); });
    $("[data-ob-profile]")?.addEventListener("click", () => setView("profile"));
    $$("[data-ob-newapp],[data-go-newapp]").forEach(b => b.addEventListener("click", () => openAppForm()));
    $$("[data-go-companies]").forEach(b => b.addEventListener("click", () => setView("companies")));

    if (State.view === "applications"){
      $("#btnNewApp")?.addEventListener("click", () => openAppForm());
      $$("[data-edit-app]").forEach(b => b.addEventListener("click", () => openAppForm(b.dataset.editApp)));
      $$("[data-del-app]").forEach(b => b.addEventListener("click", () => {
        if (confirmDelete()) deleteApp(b.dataset.delApp);
      }));
      // search: re-render but preserve focus + caret
      const q = $("#fltQ");
      if (q){
        q.addEventListener("input", e => {
          State.filter.q = e.target.value;
          const pos = e.target.selectionStart;
          render();
          const again = $("#fltQ");
          if (again){ again.focus(); try{ again.setSelectionRange(pos,pos); }catch{} }
        });
      }
      $("#fltStatus")?.addEventListener("change", e => { State.filter.status = e.target.value; render(); });
      $("#fltCompany")?.addEventListener("change", e => { State.filter.companyId = e.target.value; render(); });
      const clearFilters = () => { State.filter = { q:"", status:"", companyId:"" }; render(); };
      $("#fltClear")?.addEventListener("click", clearFilters);
      $("#fltClear2")?.addEventListener("click", clearFilters);
    }

    if (State.view === "dashboard"){
      $$("[data-open-app]").forEach(el => el.addEventListener("click", () => openAppForm(el.dataset.openApp)));
    }

    if (State.view === "companies"){
      $("#btnNewCo")?.addEventListener("click", () => openCoForm());
      $("#btnNewCo2")?.addEventListener("click", () => openCoForm());
      $$("[data-edit-co]").forEach(b => b.addEventListener("click", () => openCoForm(b.dataset.editCo)));
      $$("[data-del-co]").forEach(b => b.addEventListener("click", () => {
        if (confirmDeleteCompany(b.dataset.delCo)) deleteCompany(b.dataset.delCo);
      }));
    }

    if (State.view === "pipeline"){
      bindBoard();
    }

    if (State.view === "tailor"){
      const jd = $("#tailorJD");
      if (jd) jd.addEventListener("input", e => State.tailor.jdText = e.target.value);
      const appSel = $("#tailorApp");
      if (appSel) appSel.addEventListener("change", async (e) => {
        State.tailor.appId = e.target.value;
        await maybeRestoreTailor();   // bring back this app's saved run (Chrome/Edge)
      });

      $("#provGemini")?.addEventListener("change", e => { State.tailor.providers.gemini = e.target.checked; render(); });
      $("#provPaste")?.addEventListener("change", e => { State.tailor.providers.paste = e.target.checked; render(); });

      $("#btnRunGemini")?.addEventListener("click", runGemini);
      $("#btnCopyPrompt")?.addEventListener("click", copyPrompt);
      $("#btnPasteToggle")?.addEventListener("click", () => {
        const b = $("#pasteBox"); if (b) b.style.display = b.style.display==="none" ? "block" : "none";
      });
      $("#btnApplyPaste")?.addEventListener("click", () => applyPastedResponse($("#tailorPaste").value));
      $("#btnMerge")?.addEventListener("click", mergeResults);
      $("#btnClearTailor")?.addEventListener("click", clearTailor);
      renderTailorStatus();
      bindResultTabs();
    }

    if (State.view === "profile"){
      $("#resumeDrop")?.addEventListener("click", () => $("#resumeFile").click());
      $("#resumeFile")?.addEventListener("change", async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try{
          const text = await extractResumeFromFile(f);
          snapshot();
          State.data.profile.masterResume = text;
          markDirty(); render();
        }catch(err){ alert(err.message); }
        e.target.value = "";
      });
      $("#btnRemoveResume")?.addEventListener("click", () => {
        snapshot();
        State.data.profile.masterResume = "";
        markDirty(); render();
      });
      $("#btnSaveProfile")?.addEventListener("click", () => {
        snapshot();
        const p = State.data.profile;
        p.masterResume = $("#resumeText").value.trim();
        p.name = $("#p_name").value.trim();
        p.email = $("#p_email").value.trim();
        p.phone = $("#p_phone").value.trim();
        p.location = $("#p_location").value.trim();
        p.linkedin = $("#p_linkedin").value.trim();
        p.portfolio = $("#p_portfolio").value.trim();
        markDirty(); render();
        const st = $("#profileStatus"); if (st) st.textContent = "Saved.";
      });
    }

    if (State.view === "settings"){
      $("#modelSel")?.addEventListener("change", e => { State.data.config.model = e.target.value; markDirty(); });
      $("#btnSaveKey")?.addEventListener("click", async () => { await saveConfigKey($("#apiKey").value); render(); });
      $("#btnClearKey")?.addEventListener("click", async () => { await saveConfigKey(""); render(); });
      $("#btnSaveGemini")?.addEventListener("click", async () => { await saveGeminiKey($("#geminiKey").value); render(); });
      $("#btnClearGemini")?.addEventListener("click", async () => { await saveGeminiKey(""); render(); });
      $("#btnExport")?.addEventListener("click", async () => {
        const st = $("#dataStatus"); if (st) st.textContent = "Building export…";
        const ok = await exportEverything();
        if (st) st.textContent = ok ? "Export downloaded." : "Export failed.";
      });
      $("#btnExportICS")?.addEventListener("click", () => {
        const st = $("#dataStatus");
        const ok = exportICS();
        if (st) st.textContent = ok ? "Calendar (.ics) downloaded." : "No upcoming follow-ups to export.";
      });
      $("#btnBackupNow")?.addEventListener("click", async () => {
        const st = $("#dataStatus"); if (st) st.textContent = "Backing up…";
        const ok = await backupNow();
        if (st) st.textContent = ok ? "Backup written to data.backups/." : "Backup failed.";
      });

      // pipeline status editor
      $("#btnAddStatus")?.addEventListener("click", () => {
        if (addStatus($("#newStatusName").value, $("#newStatusType").value)) render();
      });
      $$("[data-smove]").forEach(b => b.addEventListener("click", () => { moveStatus(b.dataset.name, +b.dataset.smove); render(); }));
      $$("[data-sdelete]").forEach(b => b.addEventListener("click", () => { deleteStatus(b.dataset.sdelete); render(); }));
      $$("[data-stype]").forEach(sel => sel.addEventListener("change", e => { setStatusType(sel.dataset.stype, e.target.value); render(); }));
      $$("[data-rename]").forEach(inp => inp.addEventListener("change", e => {
        const oldName = inp.dataset.rename, newName = e.target.value;
        if (renameStatus(oldName, newName)) render(); else render();
      }));

      // appearance / theme
      $$("[data-theme-set]").forEach(b => b.addEventListener("click", () => setThemeMode(b.dataset.themeSet)));

      // data integrity
      $("#btnScan")?.addEventListener("click", () => {
        State.integrity = checkIntegrity();
        render();
        toast(State.integrity.length ? `Found ${State.integrity.length} issue type(s)` : "No issues found");
      });
      $("#btnRepair")?.addEventListener("click", repairAll);

      // CSV import
      $("#btnImportCSV")?.addEventListener("click", () => $("#csvFile").click());
      $("#csvFile")?.addEventListener("change", (e) => {
        const f = e.target.files[0]; if (f) importCSVFile(f);
        e.target.value = "";
      });

      // recycle bin
      $$("[data-restore]").forEach(b => b.addEventListener("click", () => restoreFromTrash(+b.dataset.restore)));
      $$("[data-purge]").forEach(b => b.addEventListener("click", () => {
        if (confirm("Permanently delete this item? This can only be reversed with an immediate undo.")) purgeTrashItem(+b.dataset.purge);
      }));
      $("#btnEmptyTrash")?.addEventListener("click", () => {
        if (confirm("Permanently empty the recycle bin?")) emptyTrash();
      });
    }
  }

  function bindResultTabs(){
    // scope tab switching to each result panel independently
    $$(".panel.result").forEach(panel => {
      panel.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
        panel.querySelectorAll(".tab").forEach(x => x.classList.remove("is-active"));
        panel.querySelectorAll(".tabpane").forEach(x => x.classList.remove("is-active"));
        t.classList.add("is-active");
        panel.querySelector(`.tabpane[data-pane="${t.dataset.tab}"]`)?.classList.add("is-active");
      }));
    });
    // per-panel save buttons
    $$("[data-save-doc]").forEach(btn => btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      const which = btn.dataset.saveDoc; // resume | cover
      const res = State.tailor.results[key];
      if (!res) return;
      const app = State.data.applications.find(a => a.id === State.tailor.appId);
      const text = which === "resume" ? res.tailoredResume : res.coverLetter;
      const fn = `${which === "resume" ? "resume" : "cover-letter"}_${slug(app)}${key!=="merged"?"_"+key:""}.docx`;
      const out = await saveDocx(text, fn, app);
      const where = panelWhere(btn, which, key);
      if (where) where.textContent = " → " + out.where;
    }));
  }

  function panelWhere(btn, which, key){
    const panel = btn.closest(".panel.result");
    return panel ? panel.querySelector(`[data-where="${which}-${key}"]`) : null;
  }

  function slug(app){
    if (app && app.role) return app.role.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40);
    return new Date().toISOString().slice(0,10);
  }

  function render(){
    // Settings & Tailor are usable before a folder is connected — seed empty data so they work.
    if (!State.data && (State.view === "settings" || State.view === "tailor" || State.view === "profile")){
      State.data = structuredClone(EMPTY);
    }
    const v = Views[State.view];
    $("#viewTitle").textContent = v.title;
    $("#viewSub").textContent = v.sub;
    $("#viewBody").innerHTML = State.data ? v.render() : noDataNotice();
    bindViewEvents();
  }

  function noDataNotice(){
    if (shouldShowOnboarding()) return renderOnboarding();
    if (HAS_FS && State._savedDir && !State.dirHandle){
      return `<div class="panel"><div class="placeholder">
        Your folder is remembered. Click <strong>Reconnect folder</strong> (left) to resume — your data and auto-save pick up where you left off.
      </div></div>`;
    }
    return `<div class="panel"><div class="placeholder">
      ${HAS_FS
        ? "Click <strong>Connect folder</strong> and choose your Velae folder to begin. Changes save automatically."
        : "Click <strong>Load file</strong> to open your data.json, or start fresh and use <strong>Save</strong> to download it into your folder."}
    </div></div>`;
  }

  // ---------- first-run onboarding ----------
  function onboardingState(){
    const connected = HAS_FS ? !!State.dirHandle : !!State.data;
    const p = State.data && State.data.profile;
    const hasResume = !!(p && p.masterResume);
    const hasApp = !!(State.data && State.data.applications && State.data.applications.length);
    return { connected, hasResume, hasApp, done: connected && hasResume && hasApp };
  }
  function onboardingDismissed(){ try { return localStorage.getItem("velae_onboard") === "done"; } catch { return false; } }
  function dismissOnboarding(){ try { localStorage.setItem("velae_onboard", "done"); } catch {} render(); }
  function shouldShowOnboarding(){ return !onboardingState().done && !onboardingDismissed(); }
  function renderOnboarding(){
    const s = onboardingState();
    const step = (done, n, title, desc, btn) => `
      <li class="ob-step ${done?"is-done":""}">
        <span class="ob-num">${done?"✓":n}</span>
        <div class="ob-text">
          <p class="ob-title">${title}</p>
          <p class="ob-desc">${desc}</p>
          ${(!done && btn) ? `<div class="ob-act">${btn}</div>` : ""}
        </div>
      </li>`;
    return `<div class="panel onboarding">
      <div class="ob-head"><h2>Welcome to Velae Lite</h2><button class="btn btn-quiet" data-ob-dismiss>Dismiss</button></div>
      <p class="hint">Three quick steps to get going. This card disappears once you're set up.</p>
      <ul class="ob-list">
        ${step(s.connected, 1, "Connect your folder",
            HAS_FS ? "Pick your Velae folder once — your data then auto-saves to it." : "Use Save / Load to manage your data.json by hand.",
            HAS_FS ? `<button class="btn btn-primary" data-ob-connect>${(State._savedDir && !State.dirHandle) ? "Reconnect folder" : "Connect folder"}</button>` : "")}
        ${step(s.hasResume, 2, "Add your master resume",
            "On the Profile page — it's stored once and reused for every tailoring.",
            `<button class="btn" data-ob-profile>Go to Profile</button>`)}
        ${step(s.hasApp, 3, "Add your first application",
            "Track a role; your dashboard, pipeline, and analytics fill in from there.",
            `<button class="btn" data-ob-newapp>New application</button>`)}
      </ul>
    </div>`;
  }

  // on-brand empty state (guiding-star mark + title + hint + optional action)
  function emptyStatePanel(title, desc, actionHtml){
    return `<div class="panel"><div class="empty-state">
      <span class="empty-mark" aria-hidden="true"><svg viewBox="0 0 72 72" width="32" height="32"><path d="M36 4 L39.5 32.5 L68 36 L39.5 39.5 L36 68 L32.5 39.5 L4 36 L32.5 32.5 Z" fill="currentColor"/></svg></span>
      <p class="empty-title">${title}</p>
      <p class="empty-desc">${desc}</p>
      ${actionHtml || ""}
    </div></div>`;
  }

  // ---------- nav ----------
  function setView(view){
    if (!view) return;
    State.view = view;
    $$(".nav-item").forEach(b => b.classList.toggle("is-active", b.dataset.view === view));
    render();
  }
  function bindNav(){
    $$(".nav-item").forEach(btn => {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    });
  }

  // ---------- command palette (⌘K / Ctrl+K) ----------
  function commandRegistry(){
    const go = (v) => () => setView(v);
    const cmds = [
      { label:"Go to Dashboard",    run: go("dashboard") },
      { label:"Go to Applications", run: go("applications") },
      { label:"Go to Pipeline",     run: go("pipeline") },
      { label:"Go to Companies",    run: go("companies") },
      { label:"Go to Tailor",       run: go("tailor") },
      { label:"Go to Profile",      run: go("profile") },
      { label:"Go to Settings",     run: go("settings") },
      { label:"New application",            run: () => openAppForm() },
      { label:"New tailoring",              run: go("tailor") },
      { label:"Export everything (.zip)",   run: () => exportEverything() },
      { label:"Export follow-ups (.ics)",   run: () => exportICS() },
      { label:"Toggle dark / light theme",  run: () => toggleTheme() },
      { label:"Undo last change",           run: () => undo() },
      { label:"Redo",                       run: () => redo() },
    ];
    if (State.dirHandle) cmds.push({ label:"Back up now", run: async () => {
      const ok = await backupNow(); toast(ok ? "Backup written to data.backups/." : "Backup failed.");
    }});
    if (HAS_FS) cmds.push({
      label: State.dirHandle ? "Connect a different folder" : (State._savedDir ? "Reconnect folder" : "Connect folder"),
      run: () => { (State._savedDir && !State.dirHandle) ? reconnectSaved() : connectFolder(); },
    });
    return cmds;
  }

  function openCommandPalette(){
    if ($("#cmdPalette")) return;                 // already open
    const cmds = commandRegistry();
    openModal(`<div class="cmdp" id="cmdPalette">
      <input id="cmdInput" class="cmd-input" type="text" placeholder="Type a command…" autocomplete="off" spellcheck="false" />
      <ul class="cmd-list" id="cmdList"></ul>
    </div>`);
    const inputEl = $("#cmdInput"), listEl = $("#cmdList");
    let filtered = cmds, sel = 0;
    const draw = () => {
      listEl.innerHTML = filtered.length
        ? filtered.map((c,i) => `<li class="cmd-item ${i===sel?"is-sel":""}" data-i="${i}">${esc(c.label)}</li>`).join("")
        : `<li class="cmd-empty">No matching command</li>`;
      listEl.querySelector(".is-sel")?.scrollIntoView({ block:"nearest" });
    };
    const run = (i) => { const c = filtered[i]; closeModal(); if (c) c.run(); };
    inputEl.addEventListener("input", e => {
      const q = e.target.value.trim().toLowerCase();
      filtered = q ? cmds.filter(c => c.label.toLowerCase().includes(q)) : cmds;
      sel = 0; draw();
    });
    inputEl.addEventListener("keydown", e => {
      if (e.key === "ArrowDown"){ e.preventDefault(); sel = Math.min(sel+1, filtered.length-1); draw(); }
      else if (e.key === "ArrowUp"){ e.preventDefault(); sel = Math.max(sel-1, 0); draw(); }
      else if (e.key === "Enter"){ e.preventDefault(); run(sel); }
      // Escape is handled by openModal's document-level handler
    });
    listEl.addEventListener("click", e => {
      const li = e.target.closest("[data-i]"); if (li) run(+li.dataset.i);
    });
    draw();
    inputEl.focus();
  }

  // ---------- global keyboard: undo / redo ----------
  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z or Ctrl+Y = redo. Skip when the user is
  // typing in a field so the browser's native text-undo still works there.
  function isEditingField(){
    const el = document.activeElement;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }
  function modalOpen(){ return !!$("#modalHost").innerHTML; }
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey){
      const k = (e.key || "").toLowerCase();
      if (k === "k"){ e.preventDefault(); if (!modalOpen()) openCommandPalette(); return; }   // ⌘K / Ctrl+K
      if (k === "z"){ if (isEditingField()) return; e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (k === "y"){ if (isEditingField()) return; e.preventDefault(); redo(); return; }   // Windows redo
      return;
    }
    if (e.altKey) return;
    // ---- plain-key navigation (only when not typing and no modal open) ----
    if (isEditingField() || modalOpen()) return;
    const k = e.key;
    if (k === "/"){
      e.preventDefault();
      if (State.view !== "applications") setView("applications");
      $("#fltQ")?.focus();
    } else if (k === "n" || k === "N"){
      e.preventDefault();
      openAppForm();
    } else if (/^[1-9]$/.test(k)){
      const item = $$(".nav-item")[parseInt(k,10)-1];
      if (item){ e.preventDefault(); setView(item.dataset.view); }
    }
  });

  // ---------- boot ----------
  // ---------- theme (light / dark / system) ----------
  function themeMode(){
    try { const ls = localStorage.getItem("velae_theme"); if (ls) return ls; } catch {}
    return (State.data && State.data.config && State.data.config.theme) || "system";
  }
  function resolveTheme(mode){
    if (mode === "dark" || mode === "light") return mode;
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }
  function applyTheme(){ document.documentElement.dataset.theme = resolveTheme(themeMode()); }
  function setThemeMode(mode){
    try { localStorage.setItem("velae_theme", mode); } catch {}
    if (State.data){ if (!State.data.config) State.data.config = {}; State.data.config.theme = mode; markDirty(); }
    applyTheme();
    render();
  }
  function toggleTheme(){ setThemeMode(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); }

  function boot(){
    // surface the version in the tab title and sidebar
    document.title = "Velae Lite v" + APP_VERSION;
    const ver = $("#appVersion"); if (ver) ver.textContent = "Lite · v" + APP_VERSION;

    applyTheme();   // honor saved choice / system preference before first paint
    if (window.matchMedia){
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (themeMode() === "system") applyTheme();
      });
    }

    bindNav();

    $("#btnConnect").addEventListener("click", () => {
      // if a saved handle is waiting, reconnect it; otherwise pick fresh
      if (State._savedDir && !State.dirHandle) reconnectSaved();
      else connectFolder();
    });
    $("#btnSave").addEventListener("click", downloadData);
    $("#btnLoad").addEventListener("click", loadFromFile);
    $("#fileInput").addEventListener("change", onFilePicked);

    if (HAS_FS){
      $("#storageNote").innerHTML = "Chrome/Edge detected — auto-save to your folder is available.";
      $("#btnConnect").style.display = "";
      setSeal("is-none", "No folder");
    } else {
      $("#storageNote").innerHTML = "Safari/Firefox — use Load &amp; Save to manage data.json manually.";
      $("#btnConnect").style.display = "none";
      setSeal("is-none", "No file");
    }

    render(); // shows the no-data notice until connected/loaded
    tryRestoreFolder(); // offer one-click reconnect if a folder was used before
  }

  // expose markDirty for later stages
  // exposed for debugging; Velae is the current name, JobTracker kept as alias
  window.Velae = { markDirty, render, State, undo, redo, checkIntegrity };
  window.JobTracker = window.Velae;

  boot();
})();
