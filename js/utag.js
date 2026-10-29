/* UTAG client for Splotify (v9.0).
   Splotify has no metadata engine of its own: it asks the UTAG database.
   Lookup order: local UTAG cache (on-device) -> UTAG database (public read).
   Verified / highly confident records apply. Records UTAG is still working
   on come back as review proposals. Unknowns are submitted to UTAG for
   Hermes to research (queued on-device until the submissions table exists,
   then drained automatically). Hand edits are submitted as corrections. */
const UTAG = (() => {
  const BASE = 'https://akusfgoeplfqwrrrywfl.supabase.co/rest/v1';
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrdXNmZ29lcGxmcXdycnJ5d2ZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0Mjg5OTUsImV4cCI6MjEwNzAwNDk5NX0.Hrgft3FuI5DRZsYe8fFdvCZhiXtRMBDPNUP6aJkShvg';
  const FN_URL = 'https://akusfgoeplfqwrrrywfl.supabase.co/functions/v1/utag-control';
  const UTAG_SITE = 'https://arthursfather998.github.io/utag';
  const LABEL = { title: 'Title', artist: 'Artist', album: 'Album', year: 'Year', genre: 'Genre' };
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const keyFor = (a, t) => norm(a) + '|' + norm(t);
  const memKeyFile = t => 'f:' + (t.fileName || '') + '::' + (t.fileSize || 0);

  async function fetchJSON(url, ms) {
    const c = new AbortController();
    const tm = setTimeout(() => c.abort(), ms || 9000);
    try {
      const r = await fetch(url, { signal: c.signal, headers: { apikey: ANON, Authorization: 'Bearer ' + ANON } });
      if (!r.ok) throw new Error('UTAG ' + r.status);
      return await r.json();
    } finally { clearTimeout(tm); }
  }

  const cacheKey = (a, t) => 'c:' + keyFor(a, t);
  async function cacheGet(a, t) {
    try { const r = await DB.utagGet(cacheKey(a, t)); return (r && r.hit) || null; } catch (e) { return null; }
  }
  async function cachePut(a, t, hit) {
    try { await DB.utagPut({ key: cacheKey(a, t), hit, ts: Date.now() }); } catch (e) {}
  }

  /* One verified-or-pending record for (artist, title), or null.
     Hit: { title, artist, album, year, art, confidence, lyrics, lyricsSynced,
       lyricsSource, lyricsStatus, source: 'cache'|'utag' }.
     A cached hit without lyricsStatus is never returned early: the database
     is checked so pre-lyrics cache entries do not hide lyrics forever. */
  async function lookup(artist, title) {
    const cached = await cacheGet(artist, title);
    if (cached && cached.lyricsStatus) return { ...cached, source: 'cache' };
    let artists = [];
    try {
      artists = await fetchJSON(BASE + '/artists?select=id,canonical_name&canonical_name=ilike.' + encodeURIComponent(artist || ''), 9000);
    } catch (e) { return cached ? { ...cached, source: 'cache' } : null; }
    if (!artists || !artists.length) return cached ? { ...cached, source: 'cache' } : null;
    const aid = artists[0].id;
    let tracks = [];
    try {
      tracks = await fetchJSON(BASE + '/tracks?select=id,title,confidence,releases!inner(id,title,edition,release_year,artwork(source_url,stored_path,role))&artist_id=eq.' + aid + '&limit=500', 9000);
    } catch (e) { return cached ? { ...cached, source: 'cache' } : null; }
    const want = norm(title);
    const bare = want.replace(/ *\([^)]*\) */g, ' ').trim();
    let best = null;
    for (const tr of tracks || []) {
      const nt = norm(tr.title);
      if (nt === want || nt === bare) { best = tr; break; }
    }
    if (!best) return cached ? { ...cached, source: 'cache' } : null;
    const rel = best.releases || {};
    const arts = rel.artwork || [];
    const canon = arts.find(a => a.role === 'canonical') || arts[0];
    let art = '';
    if (canon) {
      art = canon.stored_path
        ? 'https://akusfgoeplfqwrrrywfl.supabase.co/storage/v1/object/public/artwork/' + canon.stored_path
        : (canon.source_url || '');
    }
    let lyrics = null;
    try {
      const rows = await fetchJSON(BASE + '/track_lyrics?select=plain_text,synced_text,source,status&track_id=eq.' + best.id, 9000);
      if (rows && rows.length) lyrics = rows[0];
    } catch (e) { /* track_lyrics table not migrated yet: no lyrics, not a failure */ }
    const hit = {
      title: best.title, artist: artists[0].canonical_name,
      album: rel.title || '', year: rel.release_year || null,
      art, confidence: best.confidence || rel.confidence || 'unknown',
      lyrics: lyrics ? (lyrics.plain_text || '') : '',
      lyricsSynced: lyrics ? (lyrics.synced_text || '') : '',
      lyricsSource: lyrics ? (lyrics.source || '') : '',
      lyricsStatus: lyrics ? (lyrics.status || '') : '',
    };
    await cachePut(artist, title, hit);
    return { ...hit, source: 'utag' };
  }

  async function artBlob(url) {
    try {
      const c = new AbortController();
      const tm = setTimeout(() => c.abort(), 8000);
      const r = await fetch(url, { signal: c.signal }); clearTimeout(tm);
      if (r.ok) { const b = await r.blob(); if (b && b.size > 1000) return b; }
    } catch (e) {}
    return null;
  }

  /* Apply a UTAG hit to a track. fillOnly: never overwrite a present field
     (import path). Otherwise verified data corrects fields. Hand-set art is
     never touched. Returns the list of changed field names. */
  async function applyHit(t, hit, opts) {
    opts = opts || {};
    const changed = [];
    const set = (f, v) => {
      if (v === undefined || v === null || v === '') return;
      if (opts.fillOnly && t[f] && t[f] !== 'Unknown Album' && t[f] !== 'Unknown Artist' && t[f] !== 'Unknown Title') return;
      if (String(t[f] == null ? '' : t[f]) !== String(v)) { t[f] = v; changed.push(f); }
    };
    set('title', hit.title);
    set('artist', hit.artist);
    set('album', hit.album);
    if (hit.year && (!opts.fillOnly || !t.year)) { if (t.year !== hit.year) { t.year = hit.year; changed.push('year'); } }
    set('lyrics', hit.lyrics);
    set('lyricsSynced', hit.lyricsSynced);
    set('lyricsSource', hit.lyricsSource);
    set('lyricsStatus', hit.lyricsStatus);
    if (hit.art && !t.artManual && (opts.fillOnly ? !t.art : true)) {
      const blob = await artBlob(hit.art);
      const val = blob || hit.art;
      if (t.art !== val) { t.art = val; t.artSource = 'UTAG'; changed.push('art'); }
    }
    if (changed.length) {
      t.tagged = true;
      t.tagsVia = (t.tagsVia ? t.tagsVia + '+' : '') + 'UTAG';
      if (opts.persist && t.id != null) {
        try {
          const upd = {
            title: t.title, artist: t.artist, album: t.album, year: t.year,
            art: t.art, artSource: t.artSource, tagged: true, tagsVia: t.tagsVia,
          };
          if (changed.includes('lyrics')) upd.lyrics = t.lyrics;
          if (changed.includes('lyricsSynced')) upd.lyricsSynced = t.lyricsSynced;
          if (changed.includes('lyricsSource')) upd.lyricsSource = t.lyricsSource;
          if (changed.includes('lyricsStatus')) upd.lyricsStatus = t.lyricsStatus;
          await DB.updateTrack(t.id, upd);
        } catch (e) {}
      }
    }
    return changed;
  }

  async function isSkipped(t) {
    try { const rec = await DB.memGet(memKeyFile(t)); return !!(rec && rec.skip); } catch (e) { return false; }
  }

  /* The one entry point the UTAG screen and per-track action use.
     Pass 1: check the UTAG database. Pass 2: every DB miss runs the UTAG
     site's fixer engine automatically (same chain as uploading the audio
     file on the UTAG fixer, headless). -> { fixed, queued, status, note }
     with status in fixed | ok | review | sent | skipped */
  async function fixTrack(t, opts) {
    opts = opts || {};
    if (await isSkipped(t)) return { fixed: 0, queued: [], status: 'skipped', note: 'Skipped' };
    const hit = await lookup(t.artist, t.title);
    if (!hit) return autoFix(t, opts);
    if (hit.confidence === 'verified' || hit.confidence === 'high_confidence') {
      const before = { title: t.title, artist: t.artist, album: t.album, year: t.year };
      const changed = await applyHit(t, hit, { persist: true });
      const notes = changed.filter(f => f !== 'art').map(f => LABEL[f] + ': ' + (before[f] || '—') + ' → ' + (t[f] || '—'));
      if (changed.includes('art')) notes.push('Artwork: UTAG');
      return { fixed: changed.length, queued: [], status: changed.length ? 'fixed' : 'ok', note: notes.join('; ') || 'Checked against UTAG' };
    }
    const conf = hit.confidence === 'conflicting' ? 0.4 : 0.5;
    const queued = [];
    for (const f of ['title', 'artist', 'album', 'year']) {
      const to = f === 'year' ? hit.year : hit[f];
      if (to && String(t[f] == null ? '' : t[f]) !== String(to)) {
        queued.push({ trackId: t.id, title: t.title, artist: t.artist, proposal: { field: f, from: t[f] || '', to, source: 'UTAG', confidence: conf } });
      }
    }
    return { fixed: 0, queued, status: 'review', note: 'UTAG is still verifying' };
  }

  /* ---- pass 2: the UTAG fixer engine, called from the website ----
     The engine lives ONLY on the UTAG site (fixer.js). Splotify loads it
     live at runtime — never duplicated here. API keys are read by the
     engine from this origin's localStorage (utag_acoustid_key /
     utag_fanart_key), set in Splotify's settings. */
  let enginePromise = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector('script[data-utagfx="' + src + '"]')) return res();
      const s = document.createElement('script');
      s.src = src; s.dataset.utagfx = src;
      s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function ensureEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = (async () => {
      if (!window.mm || !window.mm.parseBlob) await loadScript('vendor/mm.js');
      await loadScript('vendor/chromaprint-shim.js');
      await loadScript(UTAG_SITE + '/fixer.js');
      if (!window.UtagFixer) throw new Error('UtagFixer engine did not load');
      return window.UtagFixer;
    })();
    return enginePromise;
  }

  /* UTAG site password (device-local). utag-control gates every write on
     it; without it Splotify can only read the database. */
  function utagPassword() {
    try { return localStorage.getItem('splotify_utag_pw') || ''; } catch (e) { return ''; }
  }
  function setUtagPassword(v) {
    try { localStorage.setItem('splotify_utag_pw', (v || '').trim()); } catch (e) {}
  }

  /* Call the UTAG site's control function (fixer_save / fixer_log). */
  async function fnCall(payload) {
    const c = new AbortController();
    const tm = setTimeout(() => c.abort(), 25000);
    try {
      const r = await fetch(FN_URL, {
        method: 'POST', signal: c.signal,
        headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        const e = data.error;
        throw new Error(typeof e === 'string' && e ? e : 'UTAG library call failed (HTTP ' + r.status + ')');
      }
      return data;
    } finally { clearTimeout(tm); }
  }
  /* Best-effort Activity-tab logging. Needs the site password; without it
     there is nothing to log to, so it silently no-ops. */
  async function fixerLog(op, data) {
    const pw = utagPassword();
    if (!pw) return null;
    try { return await fnCall({ action: 'fixer_log', op, password: pw, ...(data || {}) }); }
    catch (e) { return null; }
  }

  function missPayload(t) {
    return { artist: t.artist || '', title: t.title || '', album: t.album || '', fileName: t.fileName || '', fileSize: t.fileSize || 0 };
  }

  /* Pass 2: every DB miss runs the fixer engine automatically and fully
     automatically applies what it finds — the same function as uploading
     the audio file on the UTAG fixer. Updates the Splotify track AND the
     UTAG library; every step is logged to the fixer's Activity tab. */
  const AUTO_FIELDS = ['title', 'artist', 'album', 'genre', 'year'];
  async function autoFix(t, opts) {
    opts = opts || {};
    const jobId = opts.jobId || null;
    const log = (level, event, message) => fixerLog('event', { job_id: jobId, level, event, message });
    const file = (t.file && t.file.size) ? t.file : null;
    if (!file) {
      await submit('miss', missPayload(t));
      return { fixed: 0, queued: [], status: 'sent', note: 'Sent to UTAG' };
    }
    let eng;
    try { eng = await ensureEngine(); }
    catch (e) {
      await log('error', 'fixer:auto', '"' + (t.title || 'Unknown Title') + '": fixer engine failed to load — queued for Hermes.');
      await submit('miss', missPayload(t));
      return { fixed: 0, queued: [], status: 'sent', note: 'Sent to UTAG' };
    }
    let info, audit;
    try {
      const f = file.name ? file : new File([file], t.fileName || 'track.mp3', { type: file.type || 'audio/mpeg' });
      info = await eng.parseFile(f);
      audit = await eng.auditFile(info, [], () => {});
    } catch (e) {
      await log('error', 'fixer:auto', '"' + (t.title || 'Unknown Title') + '": engine error — queued for Hermes.');
      await submit('miss', missPayload(t));
      return { fixed: 0, queued: [], status: 'sent', note: 'Sent to UTAG' };
    }
    const proposals = (audit && audit.proposals) || [];
    if (!proposals.length && !(audit && audit.art) && !(audit && audit.lyrics)) {
      await log('warn', 'fixer:auto', '"' + (info.title || t.title) + '" by ' + (info.artist || t.artist) + ': engine found nothing — queued for Hermes.');
      await submit('miss', missPayload(t));
      return { fixed: 0, queued: [], status: 'sent', note: 'Sent to UTAG' };
    }
    /* Fully automatic: every proposal applies. */
    const before = {};
    AUTO_FIELDS.forEach(f => { before[f] = t[f] || ''; });
    const changed = [];
    for (const p of proposals) {
      if (!AUTO_FIELDS.includes(p.field) || p.to === undefined || p.to === null || p.to === '') continue;
      if (String(t[p.field] == null ? '' : t[p.field]) !== String(p.to)) {
        t[p.field] = p.to;
        changed.push(p.field);
      }
    }
    if (audit && audit.art && audit.art.blob && !t.artManual) {
      t.art = audit.art.blob;
      t.artSource = audit.art.source || 'utag fixer';
      changed.push('art');
    }
    let auditLyrics = null;
    if (audit && audit.lyrics && (audit.lyrics.plain || audit.lyrics.synced || audit.lyrics.status === 'instrumental')) {
      auditLyrics = audit.lyrics;
      t.lyrics = auditLyrics.plain || '';
      t.lyricsSynced = auditLyrics.synced || '';
      t.lyricsSource = auditLyrics.source || '';
      t.lyricsStatus = auditLyrics.status || '';
      changed.push('lyrics');
    }
    const notes = changed.filter(f => f !== 'art' && f !== 'lyrics').map(f => LABEL[f] + ': ' + (before[f] || '-') + ' → ' + (t[f] || '-'));
    if (changed.includes('art')) notes.push('Artwork: utag fixer');
    if (changed.includes('lyrics')) notes.push('Lyrics: ' + (auditLyrics && auditLyrics.source ? auditLyrics.source : 'utag fixer'));
    if (changed.length) {
      t.tagged = true;
      t.tagsVia = (t.tagsVia ? t.tagsVia + '+' : '') + 'Fixer';
      if (t.id != null) {
        try {
          const upd = { title: t.title, artist: t.artist, album: t.album, year: t.year, tagged: true, tagsVia: t.tagsVia };
          if (changed.includes('genre')) upd.genre = t.genre;
          if (changed.includes('art')) { upd.art = t.art; upd.artSource = t.artSource; }
          if (changed.includes('lyrics')) { upd.lyrics = t.lyrics; upd.lyricsSynced = t.lyricsSynced; upd.lyricsSource = t.lyricsSource; upd.lyricsStatus = t.lyricsStatus; }
          await DB.updateTrack(t.id, upd);
        } catch (e) {}
      }
    }
    /* The phone's result joins the UTAG library, so the database learns it. */
    const payload = {
      artist: t.artist || '', title: t.title || '', album: t.album || '',
      year: t.year || '', genre: t.genre || '',
      track_no: (info && info.trackNo) || null, disc_no: (info && info.discNo) || 1,
      duration_ms: info && info.duration ? Math.round(info.duration * 1000) : null,
      verified: !!(audit && audit.verified),
      art_url: (audit && audit.art && audit.art.url) || '',
      art_source: (audit && audit.art && audit.art.source) || '',
      lyrics_plain: auditLyrics ? (auditLyrics.plain || '') : '',
      lyrics_synced: auditLyrics ? (auditLyrics.synced || '') : '',
      lyrics_source: auditLyrics ? (auditLyrics.source || '') : '',
      lyrics_status: auditLyrics ? (auditLyrics.status || '') : '',
      fileName: t.fileName || '', fileSize: t.fileSize || 0,
    };
    let savedUtag = false, queuedUtag = false;
    const pw = utagPassword();
    if (pw) {
      try { await fnCall({ action: 'fixer_save', password: pw, ...payload }); savedUtag = true; }
      catch (e) { await submit('fixer_save', payload); queuedUtag = true; }
    } else {
      await submit('fixer_save', payload);
      queuedUtag = true;
    }
    /* Teach the on-device cache too, so pass 1 hits next time. */
    try {
      await cachePut(t.artist, t.title, {
        title: t.title, artist: t.artist, album: t.album || '',
        year: t.year || null, art: '', confidence: 'verified',
        lyrics: t.lyrics || '', lyricsSynced: t.lyricsSynced || '',
        lyricsSource: t.lyricsSource || '', lyricsStatus: t.lyricsStatus || '',
      });
    } catch (e) {}
    const note = (notes.join('; ') || 'Checked by utag fixer') +
      (savedUtag ? ' · saved to UTAG' : queuedUtag ? ' · UTAG save queued' : '');
    await log(changed.length ? 'success' : 'info', 'fixer:auto',
      '"' + t.title + '" by ' + t.artist + ': ' + (changed.length ? changed.length + ' field' + (changed.length === 1 ? '' : 's') + ' fixed' : 'already correct') +
      (savedUtag ? ', saved to UTAG library.' : ', UTAG save queued.'));
    return { fixed: changed.length, queued: [], status: changed.length ? 'fixed' : 'ok', note };
  }

  /* Lyrics only, on demand. Never runs on track change; callers (the Now
     Playing lyrics button, the lyrics backfill) trigger it explicitly.
     Order: UTAG database first, then the UTAG site engine's LRCLIB path.
     A miss is recorded locally only, unless opts.recordMissing (backfill)
     says UTAG may record it too. */
  async function persistLyrics(t) {
    if (t.id != null) {
      try {
        await DB.updateTrack(t.id, {
          lyrics: t.lyrics || '', lyricsSynced: t.lyricsSynced || '',
          lyricsSource: t.lyricsSource || '', lyricsStatus: t.lyricsStatus || '',
        });
      } catch (e) {}
    }
    try {
      const cached = await cacheGet(t.artist, t.title);
      if (cached) {
        await cachePut(t.artist, t.title, {
          ...cached,
          lyrics: t.lyrics || '', lyricsSynced: t.lyricsSynced || '',
          lyricsSource: t.lyricsSource || '', lyricsStatus: t.lyricsStatus || '',
        });
      }
    } catch (e) {}
  }
  async function saveLyricsToUtag(t, ly) {
    const payload = {
      artist: t.artist || '', title: t.title || '', album: t.album || '',
      year: t.year || '',
      lyrics_plain: ly.plain || '', lyrics_synced: ly.synced || '',
      lyrics_source: ly.source || '', lyrics_status: ly.status || '',
      fileName: t.fileName || '', fileSize: t.fileSize || 0,
    };
    const pw = utagPassword();
    if (pw) {
      try { await fnCall({ action: 'fixer_save', password: pw, ...payload }); }
      catch (e) { await submit('fixer_save', payload); }
    } else {
      await submit('fixer_save', payload);
    }
  }
  async function ensureLyrics(t, opts) {
    opts = opts || {};
    if (!opts.force) {
      if (t.lyrics) return { status: 'already', found: true };
      if (t.lyricsStatus === 'found' || t.lyricsStatus === 'instrumental') return { status: 'already', found: true };
    }
    try {
      const hit = await lookup(t.artist, t.title);
      if (hit && (hit.lyrics || hit.lyricsStatus === 'found' || hit.lyricsStatus === 'instrumental')) {
        t.lyrics = hit.lyrics || '';
        t.lyricsSynced = hit.lyricsSynced || '';
        t.lyricsSource = hit.lyricsSource || '';
        t.lyricsStatus = hit.lyricsStatus || 'found';
        await persistLyrics(t);
        return { status: t.lyricsStatus, found: true };
      }
    } catch (e) {}
    try {
      const eng = await ensureEngine();
      if (eng && eng.parseFile && t.file && t.file.size) {
        const f = t.file.name ? t.file : new File([t.file], t.fileName || 'track.mp3', { type: t.file.type || 'audio/mpeg' });
        const info = await eng.parseFile(f);
        if (info && info.lyrics && (info.lyrics.plain || info.lyrics.synced)) {
          const ly = info.lyrics;
          t.lyrics = ly.plain || '';
          t.lyricsSynced = ly.synced || '';
          t.lyricsSource = ly.source || 'embedded';
          t.lyricsStatus = ly.status || 'found';
          await persistLyrics(t);
          await saveLyricsToUtag(t, ly);
          return { status: t.lyricsStatus, found: true };
        }
      }
      if (eng && eng.lrclibLyrics) {
        const ly = await eng.lrclibLyrics({ title: t.title, artist: t.artist, album: t.album, duration: t.duration });
        if (ly && (ly.plain || ly.synced || ly.status === 'instrumental')) {
          t.lyrics = ly.plain || '';
          t.lyricsSynced = ly.synced || '';
          t.lyricsSource = ly.source || '';
          t.lyricsStatus = ly.status || 'found';
          await persistLyrics(t);
          await saveLyricsToUtag(t, ly);
          return { status: t.lyricsStatus, found: true };
        }
      }
    } catch (e) {}
    t.lyrics = '';
    t.lyricsSynced = '';
    t.lyricsSource = t.lyricsSource || '';
    t.lyricsStatus = 'missing';
    await persistLyrics(t);
    if (opts.recordMissing) {
      try { await saveLyricsToUtag(t, { plain: '', synced: '', source: '', status: 'missing' }); } catch (e) {}
    }
    return { status: 'missing', found: false };
  }

  /* Import path: fill missing fields only. Misses are submitted once. */
  async function enrich(tr) {
    const hit = await lookup(tr.artist, tr.title);
    if (!hit) {
      await submit('miss', { artist: tr.artist || '', title: tr.title || '', album: tr.album || '', fileName: tr.fileName || '', fileSize: tr.fileSize || 0 });
      return false;
    }
    if (hit.confidence !== 'verified' && hit.confidence !== 'high_confidence') return false;
    const changed = await applyHit(tr, hit, { fillOnly: true, persist: false });
    return changed.length > 0;
  }

  /* ---- submissions: on-device outbox, drained when UTAG accepts them ---- */
  let draining = false;
  async function submit(kind, payload) {
    try {
      const key = kind + ':' + keyFor(payload.artist, payload.title) + ':' + (payload.fileName || '');
      const all = await DB.outAll();
      if ((all || []).some(r => r.key === key)) { drain(); return; }
      await DB.outAdd({ key, kind, payload, ts: Date.now() });
    } catch (e) {}
    drain();
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      const all = await DB.outAll();
      for (const r of all || []) {
        /* Queued UTAG-library saves from the auto fixer: applied the moment
           the site password exists. */
        if (r.kind === 'fixer_save') {
          const pw = utagPassword();
          if (!pw) break;
          try {
            await fnCall({ action: 'fixer_save', password: pw, ...(r.payload || {}) });
            await DB.outDel(r.id);
          } catch (e) { break; }
          continue;
        }
        try {
          const c = new AbortController();
          const tm = setTimeout(() => c.abort(), 9000);
          const res = await fetch(BASE + '/submissions', {
            method: 'POST', signal: c.signal,
            headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ kind: r.kind, payload: r.payload }),
          });
          clearTimeout(tm);
          if (res.status === 201) await DB.outDel(r.id);
          else break; // table not there yet or refused: keep the queue
        } catch (e) { break; }
      }
    } catch (e) {}
    draining = false;
  }

  /* A hand edit or an approved review item is a human ruling: it goes to
     UTAG as a correction and into the local UTAG cache as verified. */
  async function learn(before, after) {
    try {
      const fields = ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNo', 'discNo'];
      const b = {}, a = {};
      let changed = false;
      for (const f of fields) {
        b[f] = before[f] == null ? '' : before[f];
        a[f] = after[f] == null ? '' : after[f];
        if (String(b[f]) !== String(a[f])) changed = true;
      }
      if (!changed) return;
      await cachePut(after.artist, after.title, {
        title: after.title, artist: after.artist, album: after.album || '',
        year: after.year || null, art: '', confidence: 'verified',
      });
      await submit('correction', { before: b, after: a, fileName: after.fileName || '', fileSize: after.fileSize || 0 });
    } catch (e) {}
  }

  /* One-time: the old tag memory's learned fixes become UTAG submissions,
     so the phone's knowledge joins the database instead of dying here. */
  async function migrate() {
    try {
      if (await DB.kvGet('utagMig1', '')) return;
      const all = await DB.memAll();
      for (const rec of all || []) {
        if (rec && rec.fix && (rec.fix.title || rec.fix.artist)) {
          const fix = { ...rec.fix };
          delete fix.art; // blobs cannot travel; the ruling text can
          await submit('learned_fix', { key: rec.key, fix });
        }
      }
      await DB.kvSet('utagMig1', '1');
    } catch (e) {}
  }

  async function stats() {
    let cached = 0, waiting = 0;
    try { cached = await DB.utagCount(); } catch (e) {}
    try { waiting = await DB.outCount(); } catch (e) {}
    return { cached, waiting };
  }

  /* DATUM / SDB: list audio linked to UTAG tracks (track_audio table).
     Returns null when the table is not migrated yet or UTAG is
     unreachable, so the SDB view can say so instead of crashing.
     Audio bytes are never listed here, only metadata and paths. */
  async function listAudio() {
    try {
      const rows = await fetchJSON(BASE + '/track_audio?select=id,storage_path,file_name,source,created_at,tracks(title,artists(canonical_name))&order=created_at.desc&limit=200', 12000);
      return (rows || []).map(r => ({
        id: r.id, storage_path: r.storage_path, file_name: r.file_name || '',
        source: r.source || 'datum', created_at: r.created_at || '',
        title: (r.tracks && r.tracks.title) || '',
        artist: (r.tracks && r.tracks.artists && r.tracks.artists.canonical_name) || '',
      }));
    } catch (e) { return null; }
  }

  /* DATUM / SDB: signed URL for one track_audio row, via utag-control.
     Gated by the UTAG site password already stored on this iPhone.
     Without it, or before utag-control is redeployed with audio_url,
     this throws a readable error for the SDB view to show. */
  async function audioUrl(audioId) {
    const pw = utagPassword();
    if (!pw) throw new Error('Add the UTAG site password in utag fixer keys first');
    const data = await fnCall({ action: 'audio_url', password: pw, audio_id: audioId });
    if (!data.signed_url) throw new Error('UTAG did not return a download link');
    return data.signed_url;
  }

  try { window.addEventListener('online', () => drain()); } catch (e) {}
  return { lookup, fixTrack, enrich, ensureLyrics, learn, submit, drain, migrate, stats, norm, fixerLog, setUtagPassword, utagPassword, listAudio, audioUrl };
})();
