// ==UserScript==
// @name         WhatsApp Web JSON Exporter
// @namespace    https://github.com/kryptokommunist/whatsappexporter
// @version      0.2.7
// @description  Export all WhatsApp Web chats as JSON (ZIP) or by automating WhatsApp's native per-chat export.
// @author       I771869
// @icon         https://raw.githubusercontent.com/kryptokommunist/whatsappexporter/main/docs/logo.png
// @match        https://web.whatsapp.com/*
// @run-at       document-idle
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_getResourceText
// @grant        unsafeWindow
// @resource     JSZIP https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @noframes
// ==/UserScript==

/* eslint-disable no-empty */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Page scope. With @grant set, the userscript runs in an isolated sandbox
  // whose `window` is a wrapper — WhatsApp's `require`, webpack chunk, and
  // __debug live on the REAL page window, exposed as `unsafeWindow`. Reach the
  // page through PAGE; fall back to window if unsafeWindow is unavailable
  // (e.g. @grant none sandbox, where window already IS the page).
  // ---------------------------------------------------------------------------
  const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

  // ---------------------------------------------------------------------------
  // Config & known module names (patch here if WhatsApp renames internals)
  // ---------------------------------------------------------------------------
  const CONFIG = {
    pageSleepMs: 250,       // delay between history page loads (rate limit)
    chatSleepMs: 120,       // delay between chats
    pageTimeoutMs: 15000,   // per-page load timeout
    maxPagesPerChat: 100000,
    stagnantLimit: 2,       // identical-count passes before giving up
  };

  const KNOWN_NAMES = {
    collections: 'WAWebCollections',
    loadMessages: 'WAWebChatLoadMessages',
    cmd: 'WAWebCmd',
  };

  const VERSION = '0.2.7';
  const DEV = /[?#&]waexport=dev/.test(location.href);
  const FORCE = (location.href.match(/[?#&]waexport=(raid|dom)/) || [])[1] || null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  // ---------------------------------------------------------------------------
  // DOM automation primitives (native-export mode). WhatsApp Web renders a
  // virtualized chat list and ignores bare .click(), so these drive the real
  // UI the way a user would: wait for an element to appear, then fire a full
  // pointer+mouse event sequence. They match elements by stable test-ids,
  // ARIA labels, and visible text — never by obfuscated CSS class hashes.
  // ---------------------------------------------------------------------------
  const waitFor = (fn, timeoutMs = 6000, every = 150) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      let v = null;
      try { v = fn(); } catch {}
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, every);
    })();
  });

  const clickReal = (el) => {
    if (!el) return false;
    const opts = { bubbles: true, cancelable: true, view: PAGE };
    for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        const Ev = /^pointer/.test(type) && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ev(type, opts));
      } catch {}
    }
    return true;
  };

  const dispatchKey = (key = 'Escape') => {
    for (const target of [document.activeElement, document.body]) {
      if (!target) continue;
      for (const type of ['keydown', 'keyup']) {
        try { target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true })); } catch {}
      }
    }
  };

  const isVisible = (el) => !!el && el.offsetParent !== null;

  // Nearest clickable ancestor (or self) for an element matched by its text —
  // WhatsApp wraps labels in <span>s whose real button is a div[role=button].
  const clickable = (el) => (el && (el.closest('[role="button"],[role="menuitem"],button,[data-testid]') || el)) || null;

  // Visible actionable element whose text matches `text`. Prefers an EXACT
  // (trimmed, ci) match over a substring one, so "Export" doesn't accidentally
  // return the "Export chat" row. Returns the nearest clickable ancestor.
  const findByText = (text, roots = [document], { exact = false } = {}) => {
    const needle = String(text).toLowerCase();
    const sel = '[role="button"],[role="menuitem"],button,li,span,div[data-testid]';
    let substr = null;
    for (const root of roots) {
      if (!root || typeof root.querySelectorAll !== 'function') continue;
      for (const n of root.querySelectorAll(sel)) {
        if (!isVisible(n)) continue;
        const t = (n.textContent || '').trim().toLowerCase();
        if (t === needle) return clickable(n);
        if (!exact && !substr && t.includes(needle)) substr = clickable(n);
      }
    }
    return exact ? null : substr;
  };

  // ---------------------------------------------------------------------------
  // Logger. Keeps an in-memory ring buffer (→ _log.txt in the ZIP on a clean
  // finish) AND periodically flushes its tail to GM storage, which survives a
  // tab crash / reload. So even if a run dies mid-way, the last snapshot is
  // recoverable: Save log reads the persisted tail and merges it in, and on
  // startup an unfinished log is surfaced for download.
  // ---------------------------------------------------------------------------
  const LOG_STORE_KEY = 'lastlog';
  const Log = (() => {
    let sink = null;
    const buffer = [];
    const MAX_LINES = 50000;      // ring buffer cap so a huge run can't OOM the tab
    const PERSIST_TAIL = 5000;    // lines kept in crash-safe GM storage
    const FLUSH_EVERY_MS = 4000;  // time-throttle for periodic flush
    const FLUSH_EVERY_LINES = 100;// line-throttle: flush at least this often
    let dirtySince = 0;
    let lastFlush = 0;

    const persist = (force) => {
      if (!buffer.length) return;
      const now = Date.now();
      if (!force && dirtySince < FLUSH_EVERY_LINES && (now - lastFlush) < FLUSH_EVERY_MS) return;
      lastFlush = now; dirtySince = 0;
      const tail = buffer.slice(-PERSIST_TAIL).join('\n') + '\n';
      try { if (typeof GM_setValue === 'function') GM_setValue('waexport_' + LOG_STORE_KEY, tail); } catch {}
    };

    const emit = (level, args) => {
      const ts = new Date().toISOString();
      const text = args.map(stringify).join(' ');
      buffer.push(`${ts} [${level.toUpperCase()}] ${text}`);
      if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
      dirtySince++;
      const line = `[${new Date().toLocaleTimeString()}] ${text}`;
      if (sink) sink(level, line);
      if (DEV || level === 'error') console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log']('[wa-export]', ...args);
      // Errors flush immediately — they're the thing you most want to survive a crash.
      persist(level === 'error');
    };
    const stringify = (a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'object' ? safeJson(a) : String(a));
    return {
      setSink: (fn) => { sink = fn; },
      info: (...a) => emit('info', a),
      warn: (...a) => emit('warn', a),
      error: (...a) => emit('error', a),
      getText: () => buffer.join('\n') + '\n',
      lineCount: () => buffer.length,
      flush: () => persist(true),
      // Pull the crash-safe tail persisted by a prior/current run.
      getPersisted: () => {
        try { if (typeof GM_getValue === 'function') return GM_getValue('waexport_' + LOG_STORE_KEY, '') || ''; } catch {}
        return '';
      },
      clearPersisted: () => {
        try { if (typeof GM_setValue === 'function') GM_setValue('waexport_' + LOG_STORE_KEY, ''); } catch {}
      },
    };
  })();

  const safeJson = (o) => { try { return JSON.stringify(o); } catch { return String(o); } };

  // ---------------------------------------------------------------------------
  // Tier A — modern named modules
  // ---------------------------------------------------------------------------
  function safeRequire(req, name) {
    try { return req(name); } catch { return null; }
  }

  function tryNamedModules() {
    const req = PAGE.require;
    if (typeof req !== 'function') return null;
    const col = safeRequire(req, KNOWN_NAMES.collections);
    if (!col || !col.Chat || typeof col.Chat.getModelsArray !== 'function') return null;

    const pagerMod = safeRequire(req, KNOWN_NAMES.loadMessages);
    const loadEarlierMsgs = pagerMod && typeof pagerMod.loadEarlierMsgs === 'function'
      ? pagerMod.loadEarlierMsgs
      : null;

    const cmdMod = safeRequire(req, KNOWN_NAMES.cmd);

    return {
      source: 'named',
      Chat: col.Chat,
      Msg: col.Msg,
      Contact: col.Contact,
      GroupMetadata: col.GroupMetadata,
      loadEarlierMsgs,
      pagerMod,
      Cmd: cmdMod && cmdMod.Cmd ? cmdMod.Cmd : null,
      req,
    };
  }

  // ---------------------------------------------------------------------------
  // Tier B — moduleRaid: enumerate webpack modules, match by shape
  // ---------------------------------------------------------------------------
  function buildModuleRaid() {
    const modules = {};
    const chunkName = 'webpackChunkwhatsapp_web_client';

    if (Array.isArray(PAGE[chunkName])) {
      const id = 'waExporter_' + Date.now();
      try {
        PAGE[chunkName].push([[id], {}, (req) => {
          for (const k in req.m) {
            try { modules[k] = req(k); } catch {}
          }
        }]);
      } catch (e) { Log.warn('moduleRaid push failed', e); }
    }

    // Older builds expose a debug module map.
    if (!Object.keys(modules).length && PAGE.__debug && PAGE.__debug.modulesMap) {
      for (const k in PAGE.__debug.modulesMap) {
        try {
          const m = PAGE.__debug.modulesMap[k];
          modules[k] = (m && m.defaultExport) ? m.defaultExport : m;
        } catch {}
      }
    }

    const all = Object.values(modules).filter(Boolean);
    const findModule = (pred) => all.filter((m) => { try { return pred(m); } catch { return false; } });
    return { all, findModule };
  }

  const firstModel = (c) => {
    try { return c.getModelsArray()[0]; } catch { return null; }
  };
  const has = (obj, keys) => obj && keys.some((k) => k in obj);
  const hasAll = (obj, keys) => obj && keys.every((k) => k in obj);
  const isCollection = (c) =>
    c && typeof c.getModelsArray === 'function' && (Array.isArray(c._models) || Array.isArray(c.models));

  function tryModuleRaid() {
    const mR = buildModuleRaid();
    if (!mR.all.length) return null;

    const chatCol = mR.findModule((c) => isCollection(c) && has(firstModel(c), ['isGroup', 'msgs']))[0];
    const msgCol = mR.findModule((c) => isCollection(c) && hasAll(firstModel(c), ['t', 'type']))[0];
    const contactCol = mR.findModule((c) => isCollection(c) && has(firstModel(c), ['isMe', 'isWAContact']))[0];
    const groupCol = mR.findModule((c) => isCollection(c) && has(firstModel(c), ['participants']))[0];
    const pagerMod = mR.findModule((m) => typeof m.loadEarlierMsgs === 'function')[0];
    const cmdMod = mR.findModule((m) => m && m.Cmd && m.CmdImpl)[0];

    if (!chatCol || !msgCol) return null;

    return {
      source: 'moduleRaid',
      Chat: chatCol,
      Msg: msgCol,
      Contact: contactCol || null,
      GroupMetadata: groupCol || null,
      loadEarlierMsgs: pagerMod ? pagerMod.loadEarlierMsgs : null,
      pagerMod: pagerMod || null,
      Cmd: cmdMod ? cmdMod.Cmd : null,
      req: PAGE.require,
    };
  }

  function resolveStore() {
    if (FORCE === 'dom') return null;
    if (FORCE === 'raid') return tryModuleRaid();
    return tryNamedModules() || tryModuleRaid() || null;
  }

  // ---------------------------------------------------------------------------
  // Readiness: store present AND logged in
  // ---------------------------------------------------------------------------
  function isLoggedIn(store) {
    try {
      return store && store.Chat.getModelsArray().length >= 0 && !!store.Chat.getModelsArray;
    } catch { return false; }
  }

  function readinessPoll({ timeout = 120000, every = 500 } = {}) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        const store = resolveStore();
        if (store && isLoggedIn(store)) {
          // Require at least the login screen to be gone: chats collection reachable.
          return resolve(store);
        }
        if (Date.now() - t0 > timeout) return reject(new Error('store not ready / not logged in'));
        setTimeout(tick, every);
      })();
    });
  }

  // ---------------------------------------------------------------------------
  // WID / id helpers
  // ---------------------------------------------------------------------------
  const widStr = (wid) => {
    if (!wid) return null;
    if (typeof wid === 'string') return wid;
    if (wid._serialized) return wid._serialized;
    if (typeof wid.toString === 'function') { const s = wid.toString(); if (s && s !== '[object Object]') return s; }
    return null;
  };

  const msgKeyStr = (id) => {
    if (!id) return null;
    if (typeof id === 'string') return id;
    if (id._serialized) return id._serialized;
    const remote = widStr(id.remote);
    if (id.fromMe != null && remote && id.id) return `${id.fromMe}_${remote}_${id.id}`;
    return widStr(id);
  };

  // ---------------------------------------------------------------------------
  // Model mappers
  // ---------------------------------------------------------------------------
  function msgToJSON(m) {
    const t = typeof m.t === 'number' ? m.t : null;
    const out = {
      id: msgKeyStr(m.id),
      timestamp: t,
      isoTime: t ? new Date(t * 1000).toISOString() : null,
      from: widStr(m.from),
      to: widStr(m.to),
      author: widStr(m.author),
      fromMe: !!m.id && (m.id.fromMe != null ? !!m.id.fromMe : !!m.fromMe),
      type: m.type || 'chat',
      subtype: m.subtype || null,
      body: m.body != null ? m.body : (m.text != null ? m.text : null),
      caption: m.caption != null ? m.caption : null,
      quotedMsgId: m.quotedStanzaID || (m.quotedMsg && msgKeyStr(m.quotedMsg.id)) || null,
      mentionedIds: Array.isArray(m.mentionedJidList) ? m.mentionedJidList.map(widStr).filter(Boolean) : [],
      ack: typeof m.ack === 'number' ? m.ack : null,
      star: !!m.star,
    };

    const MEDIA_TYPES = ['image', 'video', 'ptt', 'audio', 'document', 'sticker', 'location', 'vcard', 'multi_vcard'];
    if (MEDIA_TYPES.includes(out.type)) {
      out.media = {
        mimetype: m.mimetype || null,
        filename: m.filename || null,
        size: typeof m.size === 'number' ? m.size : null,
        mediaKeyPresent: !!m.mediaKey,
        isViewOnce: !!m.isViewOnce,
        duration: m.duration != null ? m.duration : null,
        location: (out.type === 'location' && (m.lat != null || m.lng != null))
          ? { lat: m.lat != null ? m.lat : null, lng: m.lng != null ? m.lng : null, name: m.loc || null }
          : null,
      };
    }
    return out;
  }

  function chatToMeta(chat, store) {
    const id = widStr(chat.id);
    const isGroup = !!chat.isGroup;
    const meta = {
      id,
      name: chat.formattedTitle || chat.name || (chat.contact && chat.contact.name) || id,
      isGroup,
      archived: !!chat.archive,
      pinned: !!chat.pin,
      unreadCount: typeof chat.unreadCount === 'number' ? chat.unreadCount : 0,
      participants: [],
    };

    if (isGroup && store.GroupMetadata) {
      try {
        const gm = store.GroupMetadata.get(chat.id) || store.GroupMetadata.find(chat.id);
        const parts = gm && (gm.participants && (gm.participants.getModelsArray ? gm.participants.getModelsArray() : gm.participants));
        if (Array.isArray(parts)) {
          meta.participants = parts.map((p) => ({
            id: widStr(p.id),
            isAdmin: !!p.isAdmin,
            isSuperAdmin: !!p.isSuperAdmin,
          }));
        }
      } catch (e) { Log.warn('group metadata failed for', meta.name, e); }
    }
    return meta;
  }

  // ---------------------------------------------------------------------------
  // Pagination: load full history for one chat
  // ---------------------------------------------------------------------------
  function msgArray(chat) {
    try {
      const col = chat.msgs;
      if (col && typeof col.getModelsArray === 'function') return col.getModelsArray();
    } catch {}
    return [];
  }

  async function pageOnce(chat, store) {
    const col = chat.msgs;
    const mod = store.pagerMod || null;
    const fn = store.loadEarlierMsgs || null;
    const run = async () => {
      // Current WhatsApp Web: the loader lives on a module and reads
      // chat.msgs.msgLoadState internally, so it must be called *bound to its
      // module* (an unbound detached fn loses `this` and throws on
      // `pendingInitialLoading`). Try the most correct shapes in order.
      // 1) chat model's own method (most stable across builds)
      if (typeof chat.loadEarlierMsgs === 'function') return chat.loadEarlierMsgs();
      // 2) module function, correctly bound, taking the chat model
      if (mod && typeof mod.loadEarlierMsgs === 'function') return mod.loadEarlierMsgs.call(mod, chat);
      // 3) detached fn (fallback; may work on older builds)
      if (fn) return fn(chat);
      // 4) collection method
      if (col && typeof col.loadEarlierMsgs === 'function') return col.loadEarlierMsgs();
      throw new Error('no pager available');
    };
    // Race the page load against a timeout.
    return Promise.race([
      run(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('page timeout')), CONFIG.pageTimeoutMs)),
    ]);
  }

  let pagerProbed = false;
  function probePager(chat, store) {
    if (pagerProbed) return;
    pagerProbed = true;
    try {
      const col = chat.msgs;
      Log.info('[probe] chat methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(chat) || {})
        .filter((k) => /load|msg|earlier|fetch/i.test(k)).join(','));
      Log.info('[probe] chat.loadEarlierMsgs is', typeof chat.loadEarlierMsgs);
      Log.info('[probe] chat.msgs is', col ? col.constructor && col.constructor.name : 'none',
        '| msgLoadState:', col && col.msgLoadState ? safeJson(col.msgLoadState) : 'undefined');
      Log.info('[probe] col.loadEarlierMsgs is', col && typeof col.loadEarlierMsgs);
      Log.info('[probe] store.pagerMod keys:', store.pagerMod
        ? Object.keys(store.pagerMod).join(',') : 'none');
      Log.info('[probe] store.loadEarlierMsgs is', typeof store.loadEarlierMsgs);
    } catch (e) { Log.warn('[probe] failed', e); }
  }

  async function loadFullHistory(chat, store, onProgress) {
    probePager(chat, store);
    let prevCount = -1;
    let stagnant = 0;
    let pages = 0;
    let noPager = false;

    while (pages < CONFIG.maxPagesPerChat) {
      const count = msgArray(chat).length;
      onProgress(count);

      // (1) explicit flag that there are no earlier messages
      const col = chat.msgs;
      const noEarlier =
        (col && col.msgLoadState && col.msgLoadState.noEarlierMsgs === true) ||
        (typeof chat.hasEarlierMsgs === 'function' && chat.hasEarlierMsgs() === false);
      if (noEarlier) break;

      // (2) stagnation
      if (count === prevCount) {
        if (++stagnant >= CONFIG.stagnantLimit) break;
      } else {
        stagnant = 0;
      }
      prevCount = count;

      try {
        await pageOnce(chat, store);
      } catch (e) {
        if (/no pager/.test(e.message)) { noPager = true; break; }
        Log.warn('pager error (treating as stagnation):', e.message);
        if (++stagnant >= CONFIG.stagnantLimit) break;
      }

      pages++;
      await sleep(CONFIG.pageSleepMs);
    }

    if (noPager) Log.warn('no pager for chat; exporting loaded messages only');
    return msgArray(chat)
      .slice()
      .sort((a, b) => (a.t || 0) - (b.t || 0))
      .map(msgToJSON);
  }

  // ---------------------------------------------------------------------------
  // Filename building
  // ---------------------------------------------------------------------------
  function dateStamp(ts) {
    if (!ts) return '0000-00-00';
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function sanitizeName(name) {
    return (name || 'unknown')
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'unknown';
  }

  function buildFilename(meta, usedNames) {
    const base = `${dateStamp(meta.lastMessageTimestamp)}_${sanitizeName(meta.name)}`;
    let name = `${base}.json`;
    if (usedNames.has(name)) {
      const suffix = (widStr(meta.id) || '').replace(/[^a-z0-9]/gi, '').slice(0, 6) || Math.random().toString(36).slice(2, 8);
      name = `${base}_${suffix}.json`;
    }
    usedNames.add(name);
    return name;
  }

  // ---------------------------------------------------------------------------
  // Downloading
  // ---------------------------------------------------------------------------
  function anchorDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function download(blob, filename, { saveAs = true } = {}) {
    if (typeof GM_download === 'function' && saveAs) {
      const url = URL.createObjectURL(blob);
      try {
        GM_download({
          url,
          name: filename,
          saveAs: true,
          onload: () => URL.revokeObjectURL(url),
          onerror: () => { URL.revokeObjectURL(url); anchorDownload(blob, filename); },
        });
        return;
      } catch { URL.revokeObjectURL(url); }
    }
    // saveAs:false (or no GM_download) → silent anchor download to the default
    // folder, so bulk runs don't stack save dialogs on top of WhatsApp's own.
    anchorDownload(blob, filename);
  }

  // ---------------------------------------------------------------------------
  // Export drivers
  // ---------------------------------------------------------------------------
  function meFromStore(store) {
    try {
      const me = store.Contact && store.Contact.getModelsArray().find((c) => c.isMe);
      return me ? widStr(me.id) : null;
    } catch { return null; }
  }

  async function exportChats(store, chats, ui) {
    if (!JSZipLib) JSZipLib = loadJSZip();
    const zip = new JSZipLib();
    const usedNames = new Set();
    const manifest = {
      exporter: 'WhatsApp Web JSON Exporter',
      version: VERSION,
      exportedAt: nowIso(),
      storeSource: store.source,
      account: meFromStore(store),
      chatCount: chats.length,
      files: {},
    };

    ui.setTotal(chats.length);
    const t0 = Date.now();

    for (let i = 0; i < chats.length && !ui.cancelled; i++) {
      const chat = chats[i];
      let meta;
      try {
        meta = chatToMeta(chat, store);
      } catch (e) {
        Log.warn('chat meta failed, skipping index', i, e);
        continue;
      }
      ui.setChat(i + 1, meta.name);

      try {
        const messages = await loadFullHistory(chat, store, (n) => ui.setMsgCount(n));
        const last = messages.length ? messages[messages.length - 1].timestamp : null;
        meta.lastMessageTimestamp = last;
        meta.messageCount = messages.length;

        const record = { ...meta, messages };
        const filename = buildFilename(meta, usedNames);
        manifest.files[meta.id] = { filename, name: meta.name, messageCount: messages.length, lastMessageTimestamp: last };
        zip.file(filename, JSON.stringify(record, null, 2));
        Log.info(`✓ ${meta.name} (${messages.length} msgs) → ${filename}`);
      } catch (e) {
        Log.warn(`chat failed, skipping: ${meta.name}`, e);
      }

      await sleep(CONFIG.chatSleepMs);
    }

    manifest.exportedChatCount = Object.keys(manifest.files).length;
    manifest.cancelled = ui.cancelled;
    zip.file('_manifest.json', JSON.stringify(manifest, null, 2));

    const secs = Math.round((Date.now() - t0) / 1000);
    Log.info(`Export complete: ${manifest.exportedChatCount} chats, ${secs}s`);

    // Bundle the full run log so the export can be debugged after the fact.
    zip.file('_log.txt', Log.getText());

    ui.setStatus('Building ZIP…');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const stamp = dateStamp(Math.floor(Date.now() / 1000));
    const zipName = `whatsapp-export_${stamp}${ui.cancelled ? '_partial' : ''}.zip`;
    download(blob, zipName);

    ui.setStatus(`Done — ${manifest.exportedChatCount} chats in ${secs}s → ${zipName}`);
    // The full log is now inside the ZIP; a clean finish has nothing left to
    // recover, so drop the crash-safe tail to avoid a stale recovery prompt.
    if (!ui.cancelled) Log.clearPersisted();
  }

  // Count how many of the chats in the store are archived. Archived chats are
  // ordinary models in the Chat collection (archive flag set), so they are
  // already included in getModelsArray() — this is just for a visible count so
  // you can tell whether WhatsApp has synced the archived list into memory yet.
  const archivedCount = (chats) => chats.reduce((n, c) => n + (c.archive ? 1 : 0), 0);

  async function exportAll(store, ui) {
    const chats = store.Chat.getModelsArray().slice();
    const arch = archivedCount(chats);
    Log.info(`Exporting all ${chats.length} chats (${arch} archived)…`);
    if (arch === 0) Log.warn('No archived chats found in the store. If you have archived chats, open WhatsApp\'s "Archived" view once so they sync into memory, then run again.');
    await exportChats(store, chats, ui);
  }

  function activeChat(store) {
    try {
      return store.Chat.getModelsArray().find((c) => c.active === true || c.hasActiveSub === true) || null;
    } catch { return null; }
  }

  async function exportCurrent(store, ui) {
    const chat = activeChat(store);
    if (!chat) { ui.setStatus('No chat is open — click a conversation first.'); return; }
    Log.info('Exporting current chat…');
    await exportChats(store, [chat], ui);
  }

  // ---------------------------------------------------------------------------
  // Native export mode — automate WhatsApp's own per-chat "Export chat" button.
  //
  // Each chat is opened programmatically via Cmd.openChatBottom (so we sidestep
  // the virtualized chat list entirely), then the native Export UI is driven by
  // synthetic clicks. WhatsApp names the resulting ZIP(s) and drops them in the
  // browser's download folder; the page cannot observe download completion, so
  // we pace with a fixed settle delay (the existing rate slider). This sends
  // read receipts for every chat it opens — unavoidable, documented.
  // ---------------------------------------------------------------------------

  // Programmatically open a chat model at the bottom (most-recent) and wait
  // until it is the active chat. Signature drifts between builds, so try both.
  async function openChatModel(store, chat) {
    if (!store.Cmd || typeof store.Cmd.openChatBottom !== 'function') {
      throw new Error('Cmd.openChatBottom unavailable');
    }
    try { await store.Cmd.openChatBottom(chat); }
    catch { await store.Cmd.openChatBottom({ chat }); }
    const want = widStr(chat.id);
    await waitFor(() => {
      const a = activeChat(store);
      return a && widStr(a.id) === want ? a : null;
    }, 8000, 200);
  }

  // Close any open drawer/menu/dialog and wait for it to actually be gone, so a
  // stale drawer from the previous chat can't poison the next chat's lookup.
  async function closeAnyMenu(store) {
    // Dismiss open modals/drawers. Escape twice (dialog, then drawer), plus a
    // click on any visible modal "close" control if present.
    dispatchKey('Escape');
    const closeBtn = document.querySelector('[data-testid="drawer-right"] [data-icon="close"],[data-testid="chat-info-drawer"] [aria-label="Close"]');
    if (closeBtn && isVisible(closeBtn)) clickReal(closeBtn.closest('[role="button"],button') || closeBtn);
    dispatchKey('Escape');
    try { if (store.Cmd && typeof store.Cmd.closeChat === 'function') store.Cmd.closeChat(); } catch {}
    // Wait (briefly) for the drawer + any dialog to disappear. Don't throw if it
    // lingers — just proceed; the per-chat timeout still isolates a bad chat.
    try {
      await waitFor(() => {
        const drawer = document.querySelector('[data-testid="chat-info-drawer"],[data-testid="drawer-right"]');
        const dialog = document.querySelector('[data-testid="export-chat-modal"],[role="dialog"][aria-modal="true"]');
        return (!drawer || !isVisible(drawer)) && (!dialog || !isVisible(dialog)) ? true : null;
      }, 2500, 120);
    } catch { /* lingered; proceed anyway */ }
  }

  // Locate (opening the drawer/menu if needed) the "Export chat" action for the
  // currently-open chat. Cascade: contact-info drawer (where it lives on current
  // builds) → header overflow menu (fallback for other builds).
  // One-shot diagnostic: dump what the automation can actually see, so a failed
  // run tells us the real selectors instead of us guessing. Logged once.
  let domProbes = 0;
  function probeExportDom(where) {
    if (domProbes >= 4) return;
    domProbes++;
    try {
      const header = document.querySelector('header[data-testid="conversation-header"]') || document.querySelector('header');
      const btns = Array.from(document.querySelectorAll('[role="button"],button,[data-testid],[aria-label]'))
        .filter(isVisible)
        .map((n) => ({
          tag: n.tagName.toLowerCase(),
          testid: n.getAttribute('data-testid') || '',
          aria: n.getAttribute('aria-label') || '',
          text: (n.textContent || '').trim().slice(0, 24),
        }))
        .filter((o) => /export|menu|more|profile|info|details|without|with media|media|continue|cancel|modal/i.test(o.testid + o.aria + o.text));
      Log.info(`[probe:${where}] header present: ${!!header}; candidate controls:`, safeJson(btns.slice(0, 25)));
    } catch (e) { Log.warn('[probe] dom dump failed', e); }
  }

  async function findExportEntry() {
    // Export item: stable test-id, else any visible control whose text is "Export chat".
    const findItem = () =>
      document.querySelector('[data-testid="li-export-chat"]') ||
      findByText('export chat') ||
      null;

    // Already visible (drawer/menu open)?
    let hit = findItem();
    if (hit) return hit;

    // (1) Open the contact-info / profile drawer. Try test-id, aria-label, then
    // any visible control that reads "Profile details"/"Contact info" anywhere.
    const header = document.querySelector('header[data-testid="conversation-header"]') || document.querySelector('header');
    const infoOpener =
      (header && (header.querySelector('[data-testid="conversation-info-header"]') ||
                  header.querySelector('[aria-label="Profile details"]') ||
                  header.querySelector('[aria-label*="info" i]') ||
                  header.querySelector('[aria-label*="profile" i]'))) ||
      findByText('contact info') || null;
    if (infoOpener) {
      clickReal(infoOpener);
      // Wait for the drawer to appear, then look for the export row.
      try { return await waitFor(findItem, 3000); } catch {}
      // The "Export chat" row lives near the BOTTOM of the (contact / group /
      // community) info drawer, which WhatsApp lazy-renders — it isn't in the
      // DOM until scrolled into view. Scroll the drawer body down in steps and
      // re-check after each step before concluding there's no export option.
      const drawer = document.querySelector('[data-testid="chat-info-drawer"],[data-testid="drawer-right"],[data-testid="community-tabbed-info-drawer"]');
      if (drawer && isVisible(drawer)) {
        const scroller =
          drawer.querySelector('[data-testid="contact-info-drawer-body"],[data-testid="group-info-drawer-body"],[data-testid="community-tabbed-info-drawer-body"]') ||
          // else the deepest scrollable element inside the drawer
          Array.from(drawer.querySelectorAll('*')).find((n) => n.scrollHeight > n.clientHeight + 20) ||
          drawer;
        for (let step = 0; step < 12; step++) {
          hit = findItem();
          if (hit) return hit;
          const before = scroller.scrollTop;
          scroller.scrollTop = Math.min(scroller.scrollTop + scroller.clientHeight * 0.9 + 400, scroller.scrollHeight);
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          await sleep(180);
          // Reached the bottom and nothing new rendered — stop scrolling.
          if (scroller.scrollTop === before && step > 0) break;
        }
        hit = findItem();
        if (hit) return hit;
        probeExportDom('no-export-in-drawer');
        throw new Error('no "Export chat" option for this chat (likely a system/business chat)');
      }
    }

    // (2) Fallback: header overflow "⋮" menu, then "Export chat" in the popup.
    const menuOpener = header && (
      header.querySelector('[data-testid="menu"]') ||
      header.querySelector('[aria-label="Menu"]') ||
      header.querySelector('[aria-label="More options"]') ||
      header.querySelector('[aria-label*="menu" i]') ||
      header.querySelector('[data-icon="menu"],[data-icon="more-refreshed"]'));
    if (menuOpener) {
      clickReal(menuOpener.closest('[role="button"],button') || menuOpener);
      try { return await waitFor(findItem, 5000); } catch {}
    }

    probeExportDom('entry');
    throw new Error('export entry not found (opened drawer/menu but no "Export chat")');
  }

  // The visible confirmation modal(s). Current builds use
  // [data-testid="export-chat-modal"] inside a [role="dialog"]; we prefer that,
  // then fall back to any visible dialog/popup, then the whole document.
  function exportDialogRoots() {
    const modal = Array.from(document.querySelectorAll('[data-testid="export-chat-modal"]')).filter(isVisible);
    if (modal.length) return modal;
    const d = Array.from(document.querySelectorAll('[role="dialog"],[data-animate-modal-popup]')).filter(isVisible);
    return d.length ? d : [document];
  }

  // Find the confirm/proceed control inside a dialog. The date-range modal's
  // footer has two <button>s — "Cancel" and "Export" (label nested in <span>s);
  // a later media prompt may offer "Without media"/"With media"/"Continue".
  // Prefer a media choice when present, else the exact "Export" button, never
  // "Cancel", and never the "Export chat" row (that's the opener, not a dialog).
  function findConfirmButton(roots) {
    return (
      findByText('without media', roots) ||
      findByText('with media', roots) ||
      findByText('continue', roots, { exact: true }) ||
      findByText('export', roots, { exact: true }) ||
      null
    );
  }

  // Drive the native export for the chat that is already open on screen.
  async function nativeExportOpenChat() {
    const entry = await findExportEntry();
    clickReal(entry);

    // Step 1: the primary confirmation modal (date-range → "Export", or a
    // direct media choice depending on the build).
    let choice;
    try {
      choice = await waitFor(() => findConfirmButton(exportDialogRoots()), 8000);
    } catch (e) {
      probeExportDom('export-dialog');
      throw new Error('export confirm button ("Export"/"Without media") not found');
    }
    const firstLabel = (choice.textContent || '').trim().toLowerCase();
    clickReal(choice);

    // Step 2 (optional): if the first click was a plain "Export"/"Continue",
    // some builds then show a media-choice dialog. Wait briefly for it; if it
    // appears, click a media option. If nothing new appears, the download has
    // already started (single-step build) — that's fine, not an error.
    if (!/media/.test(firstLabel)) {
      try {
        const media = await waitFor(() => {
          const b = findByText('without media', exportDialogRoots()) ||
                    findByText('with media', exportDialogRoots());
          // Only treat as a real second step if it's a different control.
          return b && b !== choice ? b : null;
        }, 2500);
        clickReal(media);
      } catch { /* no second dialog — single-step build, download already started */ }
    }

    // The download is not observable from the page — settle, then move on.
    await sleep(CONFIG.pageSleepMs);
  }

  async function exportChatsNative(store, chats, ui) {
    Log.warn('Native export opens each chat and SENDS READ RECEIPTS; WhatsApp names the ZIPs in your downloads folder.');
    Log.warn('IMPORTANT: turn OFF Chrome → Settings → Downloads → "Ask where to save each file before downloading", or every ZIP opens a Save dialog that pauses the run.');
    ui.setTotal(chats.length);
    const t0 = Date.now();
    const index = {
      exporter: 'WhatsApp Web JSON Exporter',
      version: VERSION,
      mode: 'native',
      exportedAt: nowIso(),
      note: 'WhatsApp names the actual ZIP files in your browser download folder; this index only records which chats were triggered.',
      account: meFromStore(store),
      chats: [],
    };

    for (let i = 0; i < chats.length && !ui.cancelled; i++) {
      const chat = chats[i];
      let name;
      try { name = chatToMeta(chat, store).name; } catch { name = widStr(chat.id) || `chat-${i}`; }
      ui.setChat(i + 1, name);
      const rec = { id: widStr(chat.id), name, isGroup: !!chat.isGroup, archived: !!chat.archive, status: 'triggered', ts: nowIso() };

      try {
        await openChatModel(store, chat);
        await nativeExportOpenChat();
        Log.info(`✓ ${name} → native export triggered`);
      } catch (e) {
        rec.status = `skipped:${e.message}`;
        Log.warn(`native export skipped: ${name}`, e.message);
      } finally {
        index.chats.push(rec);
        await closeAnyMenu(store);
        await sleep(CONFIG.chatSleepMs);
      }
    }

    index.cancelled = ui.cancelled;
    index.triggeredCount = index.chats.filter((c) => c.status === 'triggered').length;
    index.archivedCount = index.chats.filter((c) => c.archived).length;
    const secs = Math.round((Date.now() - t0) / 1000);
    Log.info(`Native export complete: ${index.triggeredCount}/${chats.length} triggered, ${secs}s`);

    const stamp = nowIso().replace(/[:.]/g, '-');
    download(new Blob([JSON.stringify(index, null, 2)], { type: 'application/json' }),
      `whatsapp-native-export-index${ui.cancelled ? '_partial' : ''}_${stamp}.json`, { saveAs: false });
    ui.setStatus(`Native export: ${index.triggeredCount}/${chats.length} chats in ${secs}s. Check your downloads folder.`);
    if (!ui.cancelled) Log.clearPersisted();
  }

  async function exportAllNative(store, ui) {
    if (!store.Cmd || typeof store.Cmd.openChatBottom !== 'function') {
      ui.setStatus('Native "all" needs WhatsApp\'s Cmd module (not found). Open a chat and use "Export current" instead.');
      Log.warn('Cmd module unavailable — cannot iterate all chats for native export.');
      return;
    }
    const chats = store.Chat.getModelsArray().slice();
    const arch = archivedCount(chats);
    Log.info(`Native-exporting all ${chats.length} chats (${arch} archived)…`);
    if (arch === 0) Log.warn('No archived chats found in the store. If you have archived chats, open WhatsApp\'s "Archived" view once so they sync into memory, then run again.');
    await exportChatsNative(store, chats, ui);
  }

  async function exportCurrentNative(store, ui) {
    const chat = activeChat(store);
    if (!chat) { ui.setStatus('No chat is open — click a conversation first.'); return; }
    Log.info('Native-exporting current chat…');
    await exportChatsNative(store, [chat], ui);
  }

  // ---------------------------------------------------------------------------
  // UI panel (shadow DOM)
  // ---------------------------------------------------------------------------
  function Panel() {
    const host = document.createElement('div');
    host.id = 'wa-export-host';
    host.style.cssText = 'position:fixed;z-index:2147483647;top:80px;right:16px;';
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>
        :host { all: initial; }
        .panel { font-family: -apple-system, Segoe UI, Roboto, sans-serif; width: 290px;
          background:#111b21; color:#e9edef; border:1px solid #2a3942; border-radius:10px;
          box-shadow:0 8px 30px rgba(0,0,0,.5); overflow:hidden; }
        .hdr { display:flex; align-items:center; gap:8px; padding:10px 12px; background:#202c33; cursor:move; }
        .hdr h1 { font-size:13px; margin:0; font-weight:600; flex:1; }
        .badge { font-size:10px; padding:2px 6px; border-radius:10px; background:#005c4b; color:#d9fdd3; }
        .badge.dom { background:#6b4a00; color:#ffe9b3; }
        .badge.none { background:#5c0b0b; color:#ffd3d3; }
        .collapse { cursor:pointer; background:none; border:none; color:#8696a0; font-size:16px; line-height:1; }
        .body { padding:12px; display:flex; flex-direction:column; gap:10px; }
        .body.hidden { display:none; }
        button.act { font:inherit; font-size:13px; padding:9px; border-radius:7px; border:none; cursor:pointer;
          background:#2a3942; color:#e9edef; }
        button.act.primary { background:#00a884; color:#111b21; font-weight:600; }
        button.act:hover { filter:brightness(1.1); }
        button.act:disabled { opacity:.5; cursor:not-allowed; }
        .row { display:flex; gap:8px; }
        .row button { flex:1; }
        .rate { font-size:11px; color:#8696a0; display:flex; flex-direction:column; gap:4px; }
        .rate input { width:100%; }
        .dbg { font-size:11px; color:#8696a0; display:flex; align-items:center; gap:6px; cursor:pointer; }
        .dbg input { margin:0; }
        .status { font-size:12px; color:#8696a0; min-height:16px; }
        .prog { font-size:12px; }
        .log { font-size:10px; font-family:ui-monospace,Menlo,monospace; background:#0b141a; border-radius:6px;
          padding:6px; height:84px; overflow:auto; white-space:pre-wrap; color:#8696a0; }
        .log .warn { color:#ffcf6b; } .log .error { color:#ff8a8a; }
      </style>
      <div class="panel">
        <div class="hdr">
          <h1>WA Exporter</h1>
          <span class="badge" id="badge">…</span>
          <button class="collapse" id="collapse" title="Collapse">–</button>
        </div>
        <div class="body" id="body">
          <button class="act primary" id="all">Export all chats</button>
          <button class="act" id="current">Export current chat</button>
          <div class="row">
            <button class="act" id="cancel" disabled>Cancel</button>
            <button class="act" id="savelog" title="Download the run log so far (also bundled as _log.txt in each export)">Save log</button>
          </div>
          <label class="dbg" title="Auto-download the run log whenever a run finishes, is cancelled, or crashes.">
            <input type="checkbox" id="debug"> Debug: auto-save log on every run
          </label>
          <label class="dbg" title="Instead of building JSON, automate WhatsApp's own per-chat Export (downloads native ZIPs). Sends read receipts.">
            <input type="checkbox" id="native"> Use WhatsApp native export (ZIPs)
          </label>
          <label class="rate">Rate limit between pages: <span id="rateval">250</span> ms
            <input type="range" id="rate" min="0" max="1500" step="50" value="250">
          </label>
          <div class="prog" id="prog"></div>
          <div class="status" id="status">Ready.</div>
          <div class="log" id="log"></div>
        </div>
      </div>`;

    const $ = (id) => root.getElementById(id);
    const el = {
      badge: $('badge'), body: $('body'), collapse: $('collapse'),
      all: $('all'), current: $('current'), cancel: $('cancel'), savelog: $('savelog'),
      rate: $('rate'), rateval: $('rateval'), debug: $('debug'), native: $('native'),
      prog: $('prog'), status: $('status'), log: $('log'),
    };

    const state = { cancelled: false, running: false, total: 0, chatIdx: 0, chatName: '', msgCount: 0, t0: 0, timer: null };

    const ui = {
      get cancelled() { return state.cancelled; },
      setTotal(n) { state.total = n; this._renderProg(); },
      setChat(i, name) { state.chatIdx = i; state.chatName = name; state.msgCount = 0; this._renderProg(); },
      setMsgCount(n) { state.msgCount = n; this._renderProg(); },
      setStatus(s) { el.status.textContent = s; },
      _renderProg() {
        if (!state.total) { el.prog.textContent = ''; return; }
        el.prog.textContent = `Chat ${state.chatIdx}/${state.total} — ${state.chatName}\nmessages: ${state.msgCount}`;
      },
    };

    Log.setSink((level, line) => {
      const div = document.createElement('div');
      if (level !== 'info') div.className = level;
      div.textContent = line;
      el.log.appendChild(div);
      el.log.scrollTop = el.log.scrollHeight;
      while (el.log.childElementCount > 200) el.log.removeChild(el.log.firstChild);
    });

    // Rate control
    const savedRate = Number(gmGet('rateMs', CONFIG.pageSleepMs));
    CONFIG.pageSleepMs = savedRate;
    el.rate.value = savedRate; el.rateval.textContent = savedRate;
    el.rate.addEventListener('input', () => {
      CONFIG.pageSleepMs = Number(el.rate.value);
      el.rateval.textContent = el.rate.value;
      gmSet('rateMs', CONFIG.pageSleepMs);
    });

    // Debug toggle: when on, the log is auto-downloaded at the end of every run
    // (finish, cancel, or crash). Forced on by #waexport=dev. Persisted.
    state.debug = DEV || Boolean(gmGet('debug', false));
    el.debug.checked = state.debug;
    el.debug.addEventListener('change', () => {
      state.debug = el.debug.checked;
      gmSet('debug', state.debug);
    });

    // Native-export mode: re-targets the two export buttons to drive WhatsApp's
    // own per-chat Export instead of building JSON. Persisted.
    el.native.checked = Boolean(gmGet('native', false));
    el.native.addEventListener('change', () => gmSet('native', el.native.checked));

    // Download the run log, merging any crash-safe persisted tail from a prior
    // run that isn't already in this session's live buffer. Shared by the
    // Save-log button and the Debug auto-save.
    const saveLog = (tag) => {
      const stamp = nowIso().replace(/[:.]/g, '-');
      const live = Log.getText();
      const persisted = Log.getPersisted();
      let text = live;
      if (persisted && !live.includes(persisted.trim().split('\n').pop())) {
        text = `===== recovered from crash-safe storage (previous/partial run) =====\n${persisted}\n===== current session =====\n${live}`;
      }
      const blob = new Blob([text], { type: 'text/plain' });
      download(blob, `wa-export-log${tag ? '_' + tag : ''}_${stamp}.txt`);
      return Log.lineCount();
    };

    // Collapse
    let collapsed = gmGet('collapsed', false);
    const applyCollapse = () => { el.body.classList.toggle('hidden', collapsed); el.collapse.textContent = collapsed ? '+' : '–'; };
    applyCollapse();
    el.collapse.addEventListener('click', () => { collapsed = !collapsed; applyCollapse(); gmSet('collapsed', collapsed); });

    // Dragging
    (() => {
      const hdr = root.querySelector('.hdr');
      let sx, sy, ox, oy, dragging = false;
      hdr.addEventListener('mousedown', (e) => {
        if (e.target === el.collapse) return;
        dragging = true; sx = e.clientX; sy = e.clientY;
        const r = host.getBoundingClientRect(); ox = r.left; oy = r.top;
        host.style.right = 'auto';
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        host.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
        host.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return; dragging = false;
        gmSet('pos', { left: host.style.left, top: host.style.top });
      });
      const pos = gmGet('pos', null);
      if (pos && pos.left) { host.style.left = pos.left; host.style.top = pos.top; host.style.right = 'auto'; }
    })();

    const setRunning = (on) => {
      state.running = on;
      el.all.disabled = on; el.current.disabled = on; el.cancel.disabled = !on;
    };

    const wrap = (fn) => async () => {
      if (state.running) return;
      state.cancelled = false; setRunning(true);
      state.t0 = Date.now();
      // Flush the log to crash-safe storage on a timer, independent of logging
      // activity — so a HUNG run (no new lines) still leaves a fresh snapshot.
      const flushTimer = setInterval(() => Log.flush(), 3000);
      let failed = false;
      try { await fn(); }
      catch (e) { failed = true; Log.error('Export failed:', e); ui.setStatus('Failed: ' + e.message); }
      finally {
        clearInterval(flushTimer); Log.flush(); setRunning(false);
        // Auto-save the log on every run end when Debug is on — covers a clean
        // finish, a Cancel, and a crash, since all three land here.
        if (state.debug) {
          const tag = failed ? 'crash' : state.cancelled ? 'cancelled' : 'done';
          try { saveLog(tag); } catch (e) { Log.warn('auto-save log failed', e); }
        }
      }
    };

    return {
      host, ui, el,
      setBadge(source) {
        const map = { named: ['badge', 'store: named'], moduleRaid: ['badge', 'store: moduleRaid'], dom: ['badge dom', 'DOM fallback'] };
        const [cls, text] = map[source] || ['badge none', 'no store'];
        el.badge.className = cls; el.badge.textContent = text;
      },
      bind({ onAll, onCurrent }) {
        el.all.addEventListener('click', wrap(onAll));
        el.current.addEventListener('click', wrap(onCurrent));
        el.cancel.addEventListener('click', () => { state.cancelled = true; ui.setStatus('Cancelling…'); });
        el.savelog.addEventListener('click', () => {
          const n = saveLog();
          ui.setStatus(`Saved log (${n} lines live).`);
        });
      },
      mountDegraded(msg) {
        el.all.disabled = true; el.current.disabled = true;
        this.setBadge('none');
        ui.setStatus(msg || 'WhatsApp internals not found. Reload the page.');
      },
      // If a prior run left a crash-safe tail (it never reached a clean finish),
      // offer it for download so a hung/crashed previous run stays debuggable.
      offerRecovery() {
        const persisted = Log.getPersisted();
        if (!persisted || !persisted.trim()) return;
        Log.info(`Found a log from a previous unfinished run (${persisted.trim().split('\n').length} lines). Click "Save log" to download it.`);
        if (state.debug) {
          const stamp = nowIso().replace(/[:.]/g, '-');
          try {
            download(new Blob([persisted], { type: 'text/plain' }), `wa-export-log_recovered_${stamp}.txt`);
          } catch (e) { Log.warn('recovery auto-save failed', e); }
        }
        Log.clearPersisted();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // JSZip loader (CSP-proof: eval the bundled @resource, no network at runtime)
  // ---------------------------------------------------------------------------
  function loadJSZip() {
    if (typeof JSZip !== 'undefined') return JSZip;
    if (typeof PAGE !== 'undefined' && PAGE.JSZip) return PAGE.JSZip;
    if (typeof GM_getResourceText !== 'function') {
      throw new Error('JSZip unavailable: grant GM_getResourceText and reinstall the script.');
    }
    const src = GM_getResourceText('JSZIP');
    if (!src) throw new Error('JSZip resource empty — reinstall the script to refetch it.');
    // Run the UMD bundle against a captured fake scope. The wrapper may assign to
    // module.exports, to `this`, or to a global (self/window/globalThis) depending
    // on which branch it detects — so give it a sandbox object as all of those and
    // read JSZip back from whichever one it used.
    const sandbox = {};
    const mod = { exports: {} };
    // JSZip's async engine calls the global `setImmediate` (it only polyfills
    // one when it can see a global to attach it to — which our captured sandbox
    // hides, so generateAsync() would throw "setImmediate is not defined").
    // Inject a browser polyfill into the factory's scope so it resolves.
    const setImmediatePolyfill = (typeof setImmediate === 'function')
      ? setImmediate
      : (fn, ...a) => setTimeout(() => fn(...a), 0);
    const factory = new Function(
      'module', 'exports', 'self', 'window', 'globalThis', 'setImmediate',
      src + '\n;return module.exports && (module.exports.loadAsync || module.exports.prototype) ? module.exports : (this.JSZip || self.JSZip || window.JSZip || globalThis.JSZip || null);'
    );
    const Z = factory.call(sandbox, mod, mod.exports, sandbox, sandbox, sandbox, setImmediatePolyfill)
      || sandbox.JSZip || mod.exports.JSZip || null;
    if (!Z || typeof Z !== 'function') throw new Error('JSZip failed to initialize from resource.');
    return Z;
  }
  let JSZipLib = null;

  // ---------------------------------------------------------------------------
  // GM storage helpers (graceful if not granted)
  // ---------------------------------------------------------------------------
  function gmGet(key, def) {
    try { if (typeof GM_getValue === 'function') return GM_getValue('waexport_' + key, def); } catch {}
    return def;
  }
  function gmSet(key, val) {
    try { if (typeof GM_setValue === 'function') GM_setValue('waexport_' + key, val); } catch {}
  }

  // ---------------------------------------------------------------------------
  // Mount + watchdog
  // ---------------------------------------------------------------------------
  function mount(panel) {
    if (!document.getElementById('wa-export-host')) document.body.appendChild(panel.host);
    const observer = new MutationObserver(() => {
      if (!document.getElementById('wa-export-host')) document.body.appendChild(panel.host);
    });
    observer.observe(document.body, { childList: true });
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  const panel = Panel();
  mount(panel);
  panel.offerRecovery();
  panel.ui.setStatus('Waiting for WhatsApp to load…');

  if (FORCE === 'dom') {
    panel.mountDegraded('DOM fallback forced — not yet implemented in 0.1.0.');
  } else {
    readinessPoll()
      .then((store) => {
        Log.info(`Store ready via "${store.source}".`);
        panel.setBadge(store.source);
        panel.ui.setStatus('Ready. Open a chat for "current", or export all.');
        if (DEV) PAGE.__waExport = { store, exportAll, exportCurrent, exportAllNative, exportCurrentNative, resolveStore };
        panel.bind({
          onAll: () => (panel.el.native.checked ? exportAllNative(store, panel.ui) : exportAll(store, panel.ui)),
          onCurrent: () => (panel.el.native.checked ? exportCurrentNative(store, panel.ui) : exportCurrent(store, panel.ui)),
        });
      })
      .catch((e) => {
        Log.error(e);
        panel.mountDegraded('Could not find WhatsApp internals. Make sure you are logged in, then reload.');
      });
  }
})();
