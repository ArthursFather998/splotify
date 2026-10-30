/* UTAG client for Splotify (v10.5).
   Splotify's fixer engine is in-house (js/fixer.js) since v10.3: it asks
   the UTAG database first, then runs that engine on a miss.
   Lookup order: local UTAG cache (on-device) -> UTAG database (public read).
   Verified / highly confident records apply. Records UTAG is still working
   on come back as review proposals. Unknowns are submitted to UTAG for
   review (queued on-device until the submissions table exists,
   then drained automatically). Hand edits are submitted as corrections. */
const UTAG = (() => {
  const BASE = 'https://akusfgoeplfqwrrrywfl.supabase.co/rest/v1';
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrdXNmZ29lcGxmcXdycnJ5d2ZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0Mjg5OTUsImV4cCI6MjEwNzAwNDk5NX0.Hrgft3FuI5DRZsYe8fFdvCZhiXtRMBDPNUP6aJkShvg';
  const FN_URL = 'https://akusfgoeplfqwrrrywfl.supabase.co/functions/v1/utag-control';
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
      trackId: best.id, artistId: aid, releaseId: rel.id || null,
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
     Pass 1: check the UTAG database. Pass 2: every DB miss runs the
     in-house fixer engine automatically (same chain as uploading the
     audio file on the UTAG fixer, headless). -> { fixed, queued, status, note }
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

  /* ---- pass 2: the fixer engine, in-house since v10.3 ----
     The engine is a single copy in this codebase (js/fixer.js, copied
     from the UTAG site's fixer.js — same chain, same guard, no second
     engine). Splotify loads it locally at runtime. API keys are read by
     the engine from this origin's localStorage (utag_acoustid_key /
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
      await loadScript('js/fixer.js');
      if (!window.UtagFixer) throw new Error('UtagFixer engine did not load');
      return window.UtagFixer;
    })();
    return enginePromise;
  }

  /* Phase 2: unified-platform account session (device-local only).
     Stored in localStorage — never in IndexedDB, never shared. The
     access_token becomes auth_token for edge-function actions. Since
     Phase 5, account auth is the only write credential: the old shared
     site password is gone, and its localStorage key is left unused. */
  const AUTH_URL = 'https://akusfgoeplfqwrrrywfl.supabase.co/auth/v1';
  const SESSION_KEY = 'splotify_account_session';
  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return (s && s.access_token) ? s : null;
    } catch (e) { return null; }
  }
  function setSession(s) {
    try {
      if (!s || !s.access_token) localStorage.removeItem(SESSION_KEY);
      else localStorage.setItem(SESSION_KEY, JSON.stringify({
        access_token: s.access_token,
        refresh_token: s.refresh_token || null,
        expires_at: s.expires_at || null,
        email: s.email || '',
      }));
    } catch (e) {}
  }
  function clearSession() { setSession(null); }
  /* Build a stored session from an Auth response. expires_at from the
     server is epoch seconds; stored as epoch ms for the 60s check below.
     Old sessions without a refresh token keep working until the token
     itself stops working — no refresh is invented for them. */
  function sessionFromAuth(data, fallbackEmail) {
    const d = data || {};
    let expiresAt = null;
    if (d.expires_at) expiresAt = Number(d.expires_at) * 1000;
    else if (d.expires_in) expiresAt = Date.now() + Number(d.expires_in) * 1000;
    return {
      access_token: d.access_token || null,
      refresh_token: d.refresh_token || null,
      expires_at: expiresAt,
      email: (d.user && d.user.email) || fallbackEmail || '',
    };
  }
  /* Refresh only when the token is expired or expires within 60s.
     Invalid/rejected refresh -> session cleared (signed out).
     Network failure -> old session kept, user stays signed in offline. */
  async function refreshSession() {
    const s = getSession();
    if (!s || !s.refresh_token) return s || null;
    if (s.expires_at && Date.now() < Number(s.expires_at) - 60000) return s;
    let r;
    try {
      r = await fetch(AUTH_URL + '/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      });
    } catch (e) { return s; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) { clearSession(); return null; }
    const next = sessionFromAuth(data, s.email);
    if (!next.refresh_token) next.refresh_token = s.refresh_token;
    setSession(next);
    return next;
  }
  async function authRequest(path, email, password) {
    const r = await fetch(AUTH_URL + path, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: (email || '').trim(), password: password || '' }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data && (data.error_description || data.msg || data.message)) || ('Sign-in failed (HTTP ' + r.status + ')');
      throw new Error(String(msg));
    }
    return data;
  }
  async function signIn(email, password) {
    const data = await authRequest('/token?grant_type=password', email, password);
    if (!data.access_token) throw new Error('Sign-in did not return a session');
    const s = sessionFromAuth(data, email);
    setSession(s);
    return s;
  }
  async function signUp(email, password) {
    const data = await authRequest('/signup', email, password);
    if (data.access_token) {
      const s = sessionFromAuth(data, email);
      setSession(s);
      return s;
    }
    // Some projects return a user without a session (email confirmation):
    // a password sign-in right after creation still works when it does not.
    return signIn(email, password);
  }

  /* Call the control function. A stored account session adds auth_token;
     since Phase 5 there is no password path at all — without a session,
     authenticated actions fail with "Sign in first". */
  async function fnCall(payload) {
    const c = new AbortController();
    const tm = setTimeout(() => c.abort(), 25000);
    try {
      const body = { ...(payload || {}) };
      const sess = getSession();
      if (sess && sess.access_token && !body.auth_token) body.auth_token = sess.access_token;
      const r = await fetch(FN_URL, {
        method: 'POST', signal: c.signal,
        headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        const e = data.error;
        throw new Error(typeof e === 'string' && e ? e : 'UTAG library call failed (HTTP ' + r.status + ')');
      }
      return data;
    } finally { clearTimeout(tm); }
  }
  /* Run logging went to the UTAG site's Activity tab, which retired in
     Phase 5 (and the fixer_log action with it). Kept as a no-op so
     existing callers need no changes. */
  async function fixerLog(op, data) {
    return null;
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
      await log('error', 'fixer:auto', '"' + (t.title || 'Unknown Title') + '": fixer engine failed to load — queued for review.');
      await submit('miss', missPayload(t));
      return { fixed: 0, queued: [], status: 'sent', note: 'Sent to UTAG' };
    }
    let info, audit;
    try {
      const f = file.name ? file : new File([file], t.fileName || 'track.mp3', { type: file.type || 'audio/mpeg' });
      info = await eng.parseFile(f);
      audit = await eng.auditFile(info, [], () => {});
    } catch (e) {
      await log('error', 'fixer:auto', '"' + (t.title || 'Unknown Title') + '": engine error — queued for review.');
      await submit('miss', missPayload(t));
      return { fixed: 0, queued: [], status: 'sent', note: 'Sent to UTAG' };
    }
    const proposals = (audit && audit.proposals) || [];
    if (!proposals.length && !(audit && audit.art) && !(audit && audit.lyrics)) {
      await log('warn', 'fixer:auto', '"' + (info.title || t.title) + '" by ' + (info.artist || t.artist) + ': engine found nothing — queued for review.');
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
    if (getSession()) {
      try { await fnCall({ action: 'fixer_save', ...payload }); savedUtag = true; }
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
     Order: UTAG database first, then the in-house engine's LRCLIB path.
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
    if (getSession()) {
      try { await fnCall({ action: 'fixer_save', ...payload }); }
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
           an account session exists (the server requires an admin role). */
        if (r.kind === 'fixer_save') {
          if (!getSession()) break;
          try {
            await fnCall({ action: 'fixer_save', ...(r.payload || {}) });
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

  /* DATUM / SDB: list audio linked to UTAG tracks (track_audio_public
     view: the track_audio columns minus mega_url). Returns null when
     the view is not there yet or UTAG is unreachable, so the SDB view
     can say so instead of crashing. Audio bytes are never listed here,
     only metadata and paths. The view carries no foreign-key metadata,
     so titles are fetched in a second query instead of an embedded join. */
  async function listAudio() {
    try {
      const rows = await fetchJSON(BASE + '/track_audio_public?select=id,storage_path,file_name,source,created_at,track_id&order=created_at.desc&limit=200', 12000);
      const list = (rows || []).map(r => ({
        id: r.id, storage_path: r.storage_path, file_name: r.file_name || '',
        source: r.source || 'datum', created_at: r.created_at || '',
        title: '', artist: '',
      }));
      const tids = [...new Set((rows || []).map(r => r.track_id).filter(Boolean))];
      if (tids.length) {
        try {
          const trs = await fetchJSON(BASE + '/tracks?select=id,title,artists(canonical_name)&id=in.(' + tids.map(encodeURIComponent).join(',') + ')', 12000);
          const byId = new Map((trs || []).map(t => [String(t.id), t]));
          const tByRow = new Map((rows || []).map(r => [String(r.id), r.track_id]));
          for (const item of list) {
            const t = byId.get(String(tByRow.get(String(item.id)) || ''));
            if (t) {
              item.title = t.title || '';
              item.artist = (t.artists && t.artists.canonical_name) || '';
            }
          }
        } catch (e) { /* titles stay blank; the audio list still works */ }
      }
      return list;
    } catch (e) { return null; }
  }

  /* DATUM / SDB: signed URL for one track_audio row, via utag-control.
     Gated by the account session: the server returns audio only to its
     owner or an admin. Without a session this throws a readable error
     for the SDB view to show. */
  async function audioUrl(audioId) {
    if (!getSession()) throw new Error('Sign in first');
    const data = await fnCall({ action: 'audio_url', audio_id: audioId });
    if (!data.signed_url && !data.mega_url) throw new Error('UTAG did not return a download link');
    return data.mega_url || data.signed_url;
  }

  /* DATUM / SDB: download bytes for one track_audio row, as a Blob.
     Supabase rows: plain fetch of the signed URL, as before.
     Mega rows: a Mega link is NOT a direct file URL, so fetch()
     would just return a web page. Instead, megajs downloads the
     encrypted chunks and decrypts them in the browser, and the
     decrypted bytes become the Blob that Importer.importFiles
     saves to SDB. After that import, playback is local, so the
     Mega download delay is paid once per song, not on every play.
     megajs is loaded lazily from a CDN only when a Mega row is
     actually imported, so Supabase imports never load it. This
     path is written, not yet phone-tested: it needs a real Mega
     link from a real Mega upload before it can be claimed live. */
  async function audioBlob(audioId) {
    if (!getSession()) throw new Error('Sign in first');
    const data = await fnCall({ action: 'audio_url', audio_id: audioId });
    if (data.mega_url) {
      try {
        const mega = await import('https://esm.sh/megajs');
        const file = mega.File.fromURL(data.mega_url);
        const buf = await file.downloadBuffer();
        return new Blob([buf], { type: 'audio/mpeg' });
      } catch (e) { throw new Error('Mega download failed: ' + (e && e.message ? e.message : 'unknown error')); }
    }
    if (!data.signed_url) throw new Error('UTAG did not return a download link');
    const r = await fetch(data.signed_url);
    if (!r.ok) throw new Error('UTAG download failed');
    return await r.blob();
  }

  /* Mega folder import (SDB > Import from Mega folder). No Mega login
     needed: a public folder link pasted once, stored only
     on this device. The link must include the key part after #, otherwise
     Mega cannot decrypt names. Listing is recursive at any depth, so the
     album-only layout and the reorganized Artist/Album/Song layout both
     work. Link the DATUM/SSDB folder, not the empty root SSDB folder.
     Songs download one at a time with megajs, decrypted in the browser,
     like the per-track Mega path in audioBlob; playback stays local after
     import. Written, not yet phone-tested: needs a real folder link first. */
  const MEGA_AUDIO = /\.(mp3|m4a|m4b|aac|wav|flac|ogg|oga|opus|aiff|aif)$/i;
  function megaFolderLink() {
    try { return localStorage.getItem('splotify_mega_folder') || ''; } catch (e) { return ''; }
  }
  function setMegaFolderLink(v) {
    try { localStorage.setItem('splotify_mega_folder', (v || '').trim()); } catch (e) {}
  }
  function megaAudioType(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', aiff: 'audio/aiff', aif: 'audio/aiff' })[ext] || 'audio/mpeg';
  }
  async function listMegaFolder(url) {
    const link = (url || '').trim();
    if (!link) throw new Error('Paste a Mega folder link first');
    if (link.indexOf('/folder/') === -1) throw new Error('That is not a Mega folder link');
    if (link.indexOf('#') === -1) throw new Error('That folder link has no decryption key - copy the full link including the part after #');
    let mega;
    try { mega = await import(['https:', '', 'esm.sh', 'megajs'].join('/')); }
    catch (e) { throw new Error('Could not load the Mega library'); }
    let root;
    try { root = mega.File.fromURL(link); }
    catch (e) { throw new Error('Could not read that Mega folder link'); }
    let selected = root;
    try {
      const loaded = await root.loadAttributes();
      if (loaded) selected = loaded;
    } catch (e) { throw new Error('Could not open that Mega folder: ' + (e && e.message ? e.message : 'unknown error')); }
    if (!selected) selected = root;
    const kids0 = selected.children || [];
    if (!kids0.length && selected.name && !selected.directory) throw new Error('That link points to a single file, not a folder - paste the folder link');
    if (!kids0.length && !selected.name) throw new Error('Could not open that Mega folder - check the link includes the full key after #');
    const out = [];
    async function walk(node, prefix) {
      let kids = node.children || [];
      if (!kids.length && node.directory) {
        try {
          const loaded = await node.loadAttributes();
          if (loaded && loaded.children) kids = loaded.children;
          else if (node.children) kids = node.children;
        } catch (e) {}
      }
      for (const child of kids) {
        if (!child || !child.name) continue;
        if (child.directory || (child.children && child.children.length)) { await walk(child, prefix + child.name + '/'); continue; }
        if (MEGA_AUDIO.test(child.name)) out.push({ name: child.name, path: prefix + child.name, size: child.size || 0, megaFile: child });
      }
    }
    await walk(selected, '');
    out.sort((a, b) => (a.path < b.path ? -1 : (a.path > b.path ? 1 : 0)));
    return out;
  }
  async function megaFolderBlob(entry) {
    try {
      const buf = await entry.megaFile.downloadBuffer();
      return new Blob([buf], { type: megaAudioType(entry.name) });
    } catch (e) { throw new Error('Mega download failed: ' + (e && e.message ? e.message : 'unknown error')); }
  }

  /* ---- Phase 2: shared catalog search + per-user DATUM queue ----
     Reads shared metadata only; audio is never shared. A catalog failure
     throws, and callers fail soft (local results are never broken by it). */
  const ARTWORK_PUBLIC = 'https://akusfgoeplfqwrrrywfl.supabase.co/storage/v1/object/public/artwork/';
  function catalogArt(rel) {
    const arts = (rel && rel.artwork) || [];
    const canon = arts.find(a => a.role === 'canonical') || arts[0];
    if (!canon) return '';
    return canon.stored_path ? ARTWORK_PUBLIC + canon.stored_path : (canon.source_url || '');
  }
  function catalogSongFromRow(tr) {
    const rel = tr.releases || {};
    return {
      id: tr.id, title: tr.title || '',
      artist: (tr.artists && tr.artists.canonical_name) || '',
      artistId: tr.artist_id || null,
      releaseId: tr.release_id || rel.id || null,
      album: rel.title || '', year: rel.release_year || null,
      art: catalogArt(rel),
    };
  }
  function escLikePattern(s) {
    return String(s || '').replace(/[%_\\]/g, '\\$&');
  }
  const CATALOG_TRACK_SELECT = 'id,title,artist_id,release_id,artists(canonical_name),releases(title,release_year,artwork(source_url,stored_path,role))';
  async function catalogSearch(query) {
    const q = String(query || '').trim();
    if (!q) return { songs: [], artists: [] };
    const pattern = '*' + escLikePattern(q) + '*';
    // Settled, not all-or-nothing: one failed query must not discard
    // the other side's results (fail soft is the whole point here).
    const [aRes, tRes] = await Promise.allSettled([
      fetchJSON(BASE + '/artists?select=id,canonical_name&canonical_name=ilike.' + encodeURIComponent(pattern) + '&order=canonical_name&limit=20', 9000),
      fetchJSON(BASE + '/tracks?select=' + encodeURIComponent(CATALOG_TRACK_SELECT) + '&title=ilike.' + encodeURIComponent(pattern) + '&limit=50', 9000),
    ]);
    const artistRows = aRes.status === 'fulfilled' ? aRes.value : [];
    const trackRows = tRes.status === 'fulfilled' ? tRes.value : [];
    return {
      artists: (artistRows || []).slice(0, 20).map(a => ({ id: a.id, name: a.canonical_name || '' })).filter(a => a.name),
      songs: (trackRows || []).slice(0, 50).map(catalogSongFromRow),
    };
  }
  async function catalogArtistSongs(artistId) {
    if (!artistId) return [];
    const rows = await fetchJSON(BASE + '/tracks?select=' + encodeURIComponent(CATALOG_TRACK_SELECT) + '&artist_id=eq.' + encodeURIComponent(artistId) + '&limit=200', 9000);
    return (rows || []).map(catalogSongFromRow).sort((a, b) =>
      ((b.year || 0) - (a.year || 0)) || String(a.title).localeCompare(String(b.title))).slice(0, 100);
  }
  /* A catalog song is playable when a local SDB track is that exact
     catalog track (utagTrackId stamp from a Get-audio upload) or matches
     it on normalized artist + title (UTAG.norm, same as lookup). */
  function matchLocal(song, local) {
    if (!song || !local) return false;
    if (local.utagTrackId && song.id && String(local.utagTrackId) === String(song.id)) return true;
    return keyFor(song.artist, song.title) === keyFor(local.artist, local.title);
  }
  function findLocal(song, localTracks) {
    const list = localTracks || [];
    const byId = list.find(t => t && t.utagTrackId && song && song.id && String(t.utagTrackId) === String(song.id));
    if (byId) return byId;
    return list.find(t => matchLocal(song, t)) || null;
  }
  /* Queue a DATUM rip for one exact catalog track, owned by the caller.
     Throws when not signed in; the UI shows the account sheet first. */
  async function queueDatumRip(song) {
    if (!getSession()) throw new Error('Sign in first');
    if (!song || !song.id) throw new Error('Missing catalog track');
    return fnCall({
      action: 'datum_queue',
      artist: song.artist || '', title: song.title || '',
      album: song.album || '', release_year: song.year || null,
      utag_track_id: song.id,
    });
  }

  /* ---- Phase 3: Settings upload review + submit (in-house fixer) ----
     uploadReview(t): UTAG lookup first, then the in-house engine on a
     DB miss — the same order as fixTrack/autoFix. A catalog record
     (verified or still under review) is never overwritten by an engine
     run. Returns before/after, a short change list, and the catalog
     ids needed to submit. Nothing here writes to the catalog or
     changes the local track; submitUpload does that, only on success.
     Genre/art/lyrics are shown in review, but the Phase 1 proposal
     handler has no editable field for them on a track, so a standard
     user's proposals carry only the editable fields (artist name,
     release title/year, track title). */
  function disp(v) { return (v === undefined || v === null || v === '') ? '—' : String(v); }
  function pushChange(changes, field, from, to) {
    if (String(from == null ? '' : from) !== String(to == null ? '' : to)) changes.push({ field, from: disp(from), to: disp(to) });
  }
  async function uploadReview(t) {
    const before = { title: t.title || '', artist: t.artist || '', album: t.album || '', year: t.year || '', genre: t.genre || '' };
    const base = { trackId: t.id != null ? t.id : null, fileName: t.fileName || '', fileSize: t.fileSize || 0, before, after: { ...before }, changes: [], artBlob: null, artUrl: '', artSource: '', lyrics: null, info: { trackNo: t.trackNo || 0, discNo: t.discNo || 1, durationMs: t.duration ? Math.round(t.duration * 1000) : null } };
    const hit = await lookup(t.artist, t.title);
    if (hit) {
      const after = { title: hit.title, artist: hit.artist, album: hit.album || '', year: hit.year || '', genre: before.genre };
      const changes = [];
      pushChange(changes, 'title', before.title, after.title);
      pushChange(changes, 'artist', before.artist, after.artist);
      pushChange(changes, 'album', before.album, after.album);
      pushChange(changes, 'year', before.year, after.year);
      let artUrl = '';
      if (hit.art && !t.artManual && t.art !== hit.art) {
        artUrl = hit.art;
        changes.push({ field: 'art', from: t.art ? 'Current artwork' : '—', to: 'New artwork' });
      }
      let lyrics = null;
      if ((hit.lyrics || hit.lyricsStatus === 'found' || hit.lyricsStatus === 'instrumental') &&
          (hit.lyrics !== (t.lyrics || '') || hit.lyricsSynced !== (t.lyricsSynced || ''))) {
        lyrics = { plain: hit.lyrics || '', synced: hit.lyricsSynced || '', source: hit.lyricsSource || '', status: hit.lyricsStatus || 'found' };
        changes.push({ field: 'lyrics', from: t.lyrics ? 'Saved lyrics' : '—', to: lyrics.source || 'Found lyrics' });
      }
      return { ...base, after, changes, artUrl, artSource: artUrl ? 'UTAG' : '', lyrics,
        catalog: { exists: true, trackId: hit.trackId || null, artistId: hit.artistId || null, releaseId: hit.releaseId || null, artistExists: !!hit.artistId, releaseExists: !!hit.releaseId },
        source: 'utag', verified: hit.confidence === 'verified' || hit.confidence === 'high_confidence' };
    }
    const file = (t.file && t.file.size) ? t.file : null;
    if (!file) {
      return { ...base, catalog: { exists: false, trackId: null, artistId: null, releaseId: null, artistExists: false, releaseExists: false }, source: 'engine', verified: false, engineFailed: 'No audio file attached to this track' };
    }
    let eng, info, audit;
    try {
      eng = await ensureEngine();
      const f = file.name ? file : new File([file], t.fileName || 'track.mp3', { type: file.type || 'audio/mpeg' });
      info = await eng.parseFile(f);
      audit = await eng.auditFile(info, [], () => {});
    } catch (e) {
      return { ...base, catalog: { exists: false, trackId: null, artistId: null, releaseId: null, artistExists: false, releaseExists: false }, source: 'engine', verified: false, engineFailed: (e && e.message) || 'Fixer engine failed' };
    }
    const after = {
      title: info.title || before.title,
      artist: info.artist || before.artist,
      album: (info.album && info.album !== 'Unknown Album') ? info.album : before.album,
      year: info.year || before.year,
      genre: info.genre || before.genre,
    };
    for (const p of (audit && audit.proposals) || []) {
      if (['title', 'artist', 'album', 'genre', 'year'].includes(p.field) && p.to !== undefined && p.to !== null && p.to !== '') after[p.field] = p.to;
    }
    const changes = [];
    pushChange(changes, 'title', before.title, after.title);
    pushChange(changes, 'artist', before.artist, after.artist);
    pushChange(changes, 'album', before.album, after.album);
    pushChange(changes, 'year', before.year, after.year);
    pushChange(changes, 'genre', before.genre, after.genre);
    let artBlob = null, artUrl = '';
    if (audit && audit.art && audit.art.blob && !t.artManual) {
      artBlob = audit.art.blob; artUrl = audit.art.url || '';
      changes.push({ field: 'art', from: t.art ? 'Current artwork' : '—', to: 'New artwork' });
    }
    let lyrics = null;
    if (audit && audit.lyrics && (audit.lyrics.plain || audit.lyrics.synced || audit.lyrics.status === 'instrumental')) {
      lyrics = { plain: audit.lyrics.plain || '', synced: audit.lyrics.synced || '', source: audit.lyrics.source || '', status: audit.lyrics.status || 'found' };
      changes.push({ field: 'lyrics', from: t.lyrics ? 'Saved lyrics' : '—', to: lyrics.source || 'Found lyrics' });
    }
    // Catalog existence for a miss, best-effort and fail-soft: exact
    // artist name, then a track or a release with the proposed album.
    const catalog = { exists: false, trackId: null, artistId: null, releaseId: null, artistExists: false, releaseExists: false };
    try {
      if (after.artist && after.artist !== 'Unknown Artist') {
        const res = await catalogSearch(after.artist);
        const artistRow = (res.artists || []).find(a => norm(a.name) === norm(after.artist));
        if (artistRow) {
          catalog.artistExists = true; catalog.artistId = artistRow.id;
          const songs = await catalogArtistSongs(artistRow.id);
          const song = songs.find(s => norm(s.title) === norm(after.title));
          if (song) {
            catalog.exists = true; catalog.trackId = song.id;
            catalog.artistId = song.artistId || artistRow.id; catalog.releaseId = song.releaseId || null;
          } else if (after.album && after.album !== 'Unknown Album') {
            const relSong = songs.find(s => norm(s.album) === norm(after.album));
            if (relSong) { catalog.releaseExists = true; catalog.releaseId = relSong.releaseId || null; }
          }
        }
      }
    } catch (e) { /* unknown catalog state: proposals below stay conservative */ }
    return { ...base, after, changes, artBlob, artUrl, artSource: artBlob ? (audit.art.source || 'fixer') : '', lyrics,
      catalog, source: 'engine', verified: !!(audit && audit.verified),
      info: { trackNo: (info && info.trackNo) || t.trackNo || 0, discNo: (info && info.discNo) || t.discNo || 1, durationMs: (info && info.duration) ? Math.round(info.duration * 1000) : base.info.durationMs } };
  }

  /* Role for a catalog submit, via the Phase 1 `me` action. The session
     decides by profile role; with no session there is no role. */
  async function getRole() {
    if (getSession()) {
      const data = await fnCall({ action: 'me' });
      const role = data && data.profile && data.profile.role;
      return { kind: role === 'admin' ? 'admin' : 'standard', role: role || 'standard' };
    }
    return { kind: 'none', role: null };
  }
  function localPatchFromReview(review) {
    const patch = {};
    const has = {};
    (review.changes || []).forEach(c => { has[c.field] = true; });
    if (has.title) patch.title = review.after.title;
    if (has.artist) patch.artist = review.after.artist;
    if (has.album) patch.album = review.after.album;
    if (has.year) patch.year = review.after.year;
    if (has.genre) patch.genre = review.after.genre;
    if (has.art) { patch.art = review.artBlob || review.artUrl || ''; patch.artSource = review.artSource || ''; }
    if (has.lyrics && review.lyrics) {
      patch.lyrics = review.lyrics.plain || ''; patch.lyricsSynced = review.lyrics.synced || '';
      patch.lyricsSource = review.lyrics.source || ''; patch.lyricsStatus = review.lyrics.status || '';
    }
    return patch;
  }
  /* Submit a reviewed upload. Admin (session role)
     saves direct via fixer_save; a standard user gets one
     metadata_proposal per catalog entity touched, editable fields
     only. A throw leaves the SDB file and its local metadata exactly
     as they were — nothing is applied locally until every submit
     succeeds. A new track whose release does not exist yet cannot be
     proposed (the approve handler needs a release_id): its release
     proposal goes in, the track proposal is deferred, and the result
     says so — no chained API is invented. */
  async function submitUpload(review) {
    const role = await getRole();
    if (role.kind === 'none') throw new Error('Sign in first');
    const after = review.after || {};
    if (role.kind === 'admin') {
      const body = {
        action: 'fixer_save',
        artist: after.artist || '', title: after.title || '', album: after.album || '',
        year: after.year || '', genre: after.genre || '',
        track_no: (review.info && review.info.trackNo) || null,
        disc_no: (review.info && review.info.discNo) || 1,
        duration_ms: (review.info && review.info.durationMs) || null,
        verified: !!review.verified,
        art_url: review.artUrl || '', art_source: review.artSource || '',
        lyrics_plain: review.lyrics ? (review.lyrics.plain || '') : '',
        lyrics_synced: review.lyrics ? (review.lyrics.synced || '') : '',
        lyrics_source: review.lyrics ? (review.lyrics.source || '') : '',
        lyrics_status: review.lyrics ? (review.lyrics.status || '') : '',
        fileName: review.fileName || '', fileSize: review.fileSize || 0,
      };
      await fnCall(body);
      const patch = localPatchFromReview(review);
      if (Object.keys(patch).length && review.trackId != null) { try { await DB.updateTrack(review.trackId, patch); } catch (e) {} }
      return { toast: 'Saved to the catalog', role: role.kind, submitted: ['fixer_save'], deferred: false };
    }
    const cat = review.catalog || {};
    const has = {};
    (review.changes || []).forEach(c => { has[c.field] = true; });
    const validArtist = after.artist && after.artist !== 'Unknown Artist';
    const validAlbum = after.album && after.album !== 'Unknown Album';
    const proposals = [];
    if (cat.exists) {
      if (has.artist && validArtist && cat.artistId) proposals.push({ entity_type: 'artist', entity_id: cat.artistId, fields: { canonical_name: after.artist } });
      const rFields = {};
      if (has.album && validAlbum) rFields.title = after.album;
      if (has.year && after.year) rFields.release_year = Number(after.year) || after.year;
      if (Object.keys(rFields).length && cat.releaseId) proposals.push({ entity_type: 'release', entity_id: cat.releaseId, fields: rFields });
      if (has.title && cat.trackId) proposals.push({ entity_type: 'track', entity_id: cat.trackId, fields: { title: after.title } });
    } else {
      if (!cat.artistExists && validArtist) proposals.push({ entity_type: 'artist', entity_id: null, fields: { canonical_name: after.artist } });
      if (!cat.releaseExists && validAlbum) proposals.push({ entity_type: 'release', entity_id: null, fields: { title: after.album, ...(cat.artistId ? { artist_id: cat.artistId } : { artist_name: after.artist }) } });
      else if (cat.releaseExists && cat.releaseId) proposals.push({ entity_type: 'track', entity_id: null, fields: { title: after.title, release_id: cat.releaseId } });
    }
    const trackSubmitted = proposals.some(p => p.entity_type === 'track');
    const deferred = !cat.exists && !trackSubmitted;
    if (!proposals.length) return { toast: 'No editable changes to submit', role: 'standard', submitted: [], deferred, nothing: true };
    for (const p of proposals) {
      await fnCall({ action: 'metadata_proposal_create', entity_type: p.entity_type, entity_id: p.entity_id, fields: p.fields, reason: 'Settings upload' });
    }
    const patch = localPatchFromReview(review);
    if (Object.keys(patch).length && review.trackId != null) { try { await DB.updateTrack(review.trackId, patch); } catch (e) {} }
    return { toast: 'Submitted for review', role: 'standard', submitted: proposals.map(p => p.entity_type), deferred };
  }

  /* ---- Phase 4: Activity + account management (Settings) ----
     All reads go through the Phase 1 edge-function actions, which scope
     standard users to their own rows server-side. fnCall throws on a
     failed action, so callers surface the server message as a toast. */
  async function activityData() {
    if (!getSession()) return { signedIn: false };
    const me = await fnCall({ action: 'me' });
    const profile = (me && me.profile) || null;
    const isAdmin = !!(profile && profile.role === 'admin');
    const [mineRes, jobsRes, eventsRes, reviewRes] = await Promise.allSettled([
      fnCall({ action: 'metadata_proposal_list_mine' }),
      fnCall({ action: 'datum_list' }),
      fnCall({ action: 'activity_list' }),
      isAdmin ? fnCall({ action: 'metadata_proposal_list_all' }) : Promise.resolve(null),
    ]);
    return {
      signedIn: true, profile, isAdmin,
      mine: mineRes.status === 'fulfilled' ? ((mineRes.value && mineRes.value.proposals) || []) : [],
      jobs: jobsRes.status === 'fulfilled' ? ((jobsRes.value && jobsRes.value.jobs) || []) : [],
      events: eventsRes.status === 'fulfilled' ? ((eventsRes.value && eventsRes.value.events) || []) : [],
      review: reviewRes.status === 'fulfilled' && reviewRes.value ? ((reviewRes.value && reviewRes.value.proposals) || []) : [],
    };
  }
  async function approveProposal(id) { return fnCall({ action: 'metadata_proposal_approve', proposal_id: id }); }
  async function rejectProposal(id, note) { return fnCall({ action: 'metadata_proposal_reject', proposal_id: id, review_note: note || null }); }
  async function retryDatumJob(id) { return fnCall({ action: 'datum_retry', job_id: id }); }
  async function adminUsers() {
    const data = await fnCall({ action: 'list_users' });
    return (data && data.users) || [];
  }
  async function setUserRole(id, role) { return fnCall({ action: 'set_role', target_user_id: id, role }); }

  /* ---- Phase 6: per-user cloud data via direct PostgREST ----
     Per-user tables carry owner-only RLS, so a signed-in user's own
     token is the credential — no Edge Function action is involved.
     Local SDB ids are numbers; cloud rows need catalog UUIDs, so only
     catalog-linked tracks (utagTrackId stamp) can migrate. Anything
     without a catalog link is counted as skipped, never invented. */
  function jwtSub(token) {
    try {
      const part = String(token || '').split('.')[1];
      if (!part) return null;
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(Array.prototype.map.call(atob(b64), c =>
        '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return (JSON.parse(json) || {}).sub || null;
    } catch (e) { return null; }
  }
  async function pgAuth(table, method, body, query) {
    const s = getSession();
    if (!s || !s.access_token) throw new Error('Sign in first');
    const url = BASE + '/' + table + (query ? '?' + query : '');
    const r = await fetch(url, {
      method,
      headers: {
        apikey: ANON, Authorization: 'Bearer ' + s.access_token,
        'Content-Type': 'application/json', Prefer: 'return=representation',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error((data && data.message) || ('PostgREST ' + r.status));
      e.status = r.status; throw e;
    }
    return data;
  }
  async function pgAuthGet(table, query) {
    const data = await pgAuth(table, 'GET', undefined, query);
    return Array.isArray(data) ? data : [];
  }
  /* One listening-history row per play, best-effort: any failure is
     swallowed here so a history write can never interrupt playback. */
  async function logHistory(catalogTrackId) {
    try {
      const s = getSession();
      if (!s || !s.access_token || !catalogTrackId) return;
      const uid = jwtSub(s.access_token);
      if (!uid) return;
      await pgAuth('listening_history', 'POST', {
        user_id: uid, track_id: catalogTrackId,
        played_at: new Date().toISOString(), source: 'splotify',
      });
    } catch (e) { /* fail soft by design */ }
  }
  async function resolveArtistId(name) {
    const rows = await fetchJSON(BASE + '/artists?select=id,canonical_name&canonical_name=ilike.' +
      encodeURIComponent('*' + escLikePattern(name) + '*') + '&limit=20', 9000);
    const matches = (rows || []).filter(a => norm(a.canonical_name) === norm(name));
    return matches.length === 1 ? matches[0].id : null;
  }
  /* One-time local -> account migration. Input is already mapped to
     catalog UUIDs by the caller (playlists: [{name, trackIds}]);
     unmapped local items never reach this function and are counted
     by the caller instead. Idempotent: existing cloud rows are read
     first and skipped; a reused playlist (same name) only gains the
     tracks it does not already have, appended after its last item.
     Local data is never deleted, whatever happens here. */
  async function migrateLocalData(input, onProgress) {
    const s = getSession();
    if (!s || !s.access_token) throw new Error('Sign in first');
    const uid = jwtSub(s.access_token);
    if (!uid) throw new Error('Sign in first');
    const inData = input || {};
    const counts = {
      playlists: { created: 0, reused: 0 }, items: { migrated: 0, skipped: 0 },
      liked: { migrated: 0, skipped: 0 }, library: { migrated: 0, skipped: 0 },
      follows: { migrated: 0, skipped: 0, unresolved: 0 }, failed: 0, error: null,
    };
    const report = () => { try { if (onProgress) onProgress(counts); } catch (e) {} };
    const insertSkipDup = async (table, row, bucket) => {
      try { await pgAuth(table, 'POST', row); bucket.migrated++; }
      catch (e) { if (e && e.status === 409) bucket.skipped++; else { counts.failed++; counts.error = e.message || String(e); } }
      report();
    };
    const enc = v => encodeURIComponent(v);
    // Library + liked: dedupe against existing cloud rows first.
    const libExisting = new Set((await pgAuthGet('user_library', 'select=track_id')).map(r => r.track_id));
    for (const tid of (inData.library || [])) {
      if (libExisting.has(tid)) { counts.library.skipped++; report(); continue; }
      await insertSkipDup('user_library', { user_id: uid, track_id: tid }, counts.library);
    }
    const likedExisting = new Set((await pgAuthGet('user_liked', 'select=track_id')).map(r => r.track_id));
    for (const tid of (inData.liked || [])) {
      if (likedExisting.has(tid)) { counts.liked.skipped++; report(); continue; }
      await insertSkipDup('user_liked', { user_id: uid, track_id: tid }, counts.liked);
    }
    // Follows: resolve each local name to exactly one catalog artist.
    const folExisting = new Set((await pgAuthGet('user_follows', 'select=artist_id')).map(r => r.artist_id));
    for (const name of (inData.followed || [])) {
      let aid = null;
      try { aid = await resolveArtistId(name); } catch (e) { aid = null; }
      if (!aid) { counts.follows.unresolved++; report(); continue; }
      if (folExisting.has(aid)) { counts.follows.skipped++; report(); continue; }
      await insertSkipDup('user_follows', { user_id: uid, artist_id: aid }, counts.follows);
    }
    // Playlists: reuse by name (case-insensitive), else create.
    const cloudPls = await pgAuthGet('user_playlists', 'select=id,name');
    for (const pl of (inData.playlists || [])) {
      const name = String(pl.name || '').trim();
      if (!name) continue;
      let cloudId = null;
      const found = cloudPls.find(p => norm(p.name) === norm(name));
      if (found) { cloudId = found.id; counts.playlists.reused++; }
      else {
        try {
          const created = await pgAuth('user_playlists', 'POST', { user_id: uid, name });
          cloudId = created && created[0] && created[0].id;
          if (!cloudId) throw new Error('Playlist create returned no id');
          cloudPls.push({ id: cloudId, name });
          counts.playlists.created++;
        } catch (e) { counts.failed++; counts.error = e.message || String(e); report(); continue; }
      }
      report();
      const items = await pgAuthGet('user_playlist_items',
        'select=track_id,position&playlist_id=eq.' + enc(cloudId) + '&order=position&limit=1000');
      // Skip only tracks already in the cloud playlist (pre-existing
      // set). Newly inserted ids are NOT added here, so a local list
      // that repeats a track keeps both copies at distinct positions;
      // a second migration run re-reads the cloud rows and skips them.
      const have = new Set(items.map(i => i.track_id));
      let pos = items.reduce((m, i) => Math.max(m, Number(i.position) || 0), -1) + 1;
      for (const tid of (pl.trackIds || [])) {
        if (have.has(tid)) { counts.items.skipped++; report(); continue; }
        await insertSkipDup('user_playlist_items',
          { playlist_id: cloudId, track_id: tid, position: pos++ }, counts.items);
      }
    }
    report();
    return counts;
  }

  try { window.addEventListener('online', () => drain()); } catch (e) {}
  return { lookup, fixTrack, enrich, ensureLyrics, learn, submit, drain, migrate, stats, norm, fixerLog, listAudio, audioUrl, audioBlob, megaFolderLink, setMegaFolderLink, listMegaFolder, megaFolderBlob, getSession, setSession, clearSession, signIn, signUp, catalogSearch, catalogArtistSongs, matchLocal, findLocal, queueDatumRip, uploadReview, submitUpload, getRole, activityData, approveProposal, rejectProposal, retryDatumJob, adminUsers, setUserRole, refreshSession, logHistory, migrateLocalData };
})();
