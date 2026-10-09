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
  const LABEL = { title: 'Title', artist: 'Artist', album: 'Album', year: 'Year' };
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
     Hit: { title, artist, album, year, art, confidence, source: 'cache'|'utag' } */
  async function lookup(artist, title) {
    const cached = await cacheGet(artist, title);
    if (cached) return { ...cached, source: 'cache' };
    let artists = [];
    try {
      artists = await fetchJSON(BASE + '/artists?select=id,canonical_name&canonical_name=ilike.' + encodeURIComponent(artist || ''), 9000);
    } catch (e) { return null; }
    if (!artists || !artists.length) return null;
    const aid = artists[0].id;
    let tracks = [];
    try {
      tracks = await fetchJSON(BASE + '/tracks?select=title,confidence,releases!inner(id,title,edition,release_year,artwork(source_url,stored_path,role))&artist_id=eq.' + aid + '&limit=500', 9000);
    } catch (e) { return null; }
    const want = norm(title);
    const bare = want.replace(/ *\([^)]*\) */g, ' ').trim();
    let best = null;
    for (const tr of tracks || []) {
      const nt = norm(tr.title);
      if (nt === want || nt === bare) { best = tr; break; }
    }
    if (!best) return null;
    const rel = best.releases || {};
    const arts = rel.artwork || [];
    const canon = arts.find(a => a.role === 'canonical') || arts[0];
    let art = '';
    if (canon) {
      art = canon.stored_path
        ? 'https://akusfgoeplfqwrrrywfl.supabase.co/storage/v1/object/public/artwork/' + canon.stored_path
        : (canon.source_url || '');
    }
    const hit = {
      title: best.title, artist: artists[0].canonical_name,
      album: rel.title || '', year: rel.release_year || null,
      art, confidence: best.confidence || rel.confidence || 'unknown',
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
          await DB.updateTrack(t.id, {
            title: t.title, artist: t.artist, album: t.album, year: t.year,
            art: t.art, artSource: t.artSource, tagged: true, tagsVia: t.tagsVia,
          });
        } catch (e) {}
      }
    }
    return changed;
  }

  async function isSkipped(t) {
    try { const rec = await DB.memGet(memKeyFile(t)); return !!(rec && rec.skip); } catch (e) { return false; }
  }

  /* The one entry point the UTAG screen and per-track action use.
     -> { fixed, queued, status, note } with status in
        fixed | ok | review | sent | skipped */
  async function fixTrack(t) {
    if (await isSkipped(t)) return { fixed: 0, queued: [], status: 'skipped', note: 'Skipped' };
    const hit = await lookup(t.artist, t.title);
    if (!hit) {
      await submit('miss', { artist: t.artist || '', title: t.title || '', album: t.album || '', fileName: t.fileName || '', fileSize: t.fileSize || 0 });
      return { fixed: 0, queued: [], status: 'sent', note: 'Sent to UTAG' };
    }
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

  try { window.addEventListener('online', () => drain()); } catch (e) {}
  return { lookup, fixTrack, enrich, learn, submit, drain, migrate, stats, norm };
})();
