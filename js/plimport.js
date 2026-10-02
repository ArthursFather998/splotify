/* Spotify playlist -> dub batch -> realtime per-track import.
 *
 * Flow: paste a playlist link in Settings. Splotify asks dub (your converter)
 * to read the playlist and match each song to a YouTube audio/lyric upload
 * (dub's matcher already skips music videos). Confident matches are approved
 * automatically, the batch starts, and every finished song is pulled into the
 * library the moment it is ready — the queue can read "1/100" and that one
 * song is already playable in Splotify. The job survives app restarts.
 */
const PlImport = (() => {
  const DUB = 'https://getdub.vercel.app';
  const POLL_MS = 8000;
  let timer = null;
  let starting = false;
  let busy = false; // a poll importing songs is still running: don't pile on
  let libKeys = null; // fileName|fileSize dedupe set, built lazily per session
  let paceHist = [];  // {t, c} server-completed samples for the adaptive ETA
  let detailsOpen = false;
  let lastPollAt = 0;
  const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function jget(path) {
    const r = await fetch(DUB + path);
    const t = await r.text();
    let b = null;
    try { b = JSON.parse(t); } catch (e) {}
    return { ok: r.ok, status: r.status, body: b };
  }
  async function jpost(path, body) {
    const r = await fetch(DUB + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const t = await r.text();
    let b = null;
    try { b = JSON.parse(t); } catch (e) {}
    return { ok: r.ok, status: r.status, body: b };
  }
  async function get() { try { return await DB.kvGet('plImport', null); } catch (e) { return null; } }
  async function set(s) { try { await DB.kvSet('plImport', s); } catch (e) {} }

  async function settingsLine() {
    const st = await get();
    if (!st) return 'Turn a playlist into library downloads';
    if (st.done) return st.summary || 'Last import finished';
    return `${st.playlistName || 'Playlist'}: ${st.imported.length} of ${st.total} in your library`;
  }

  async function startFromUI() {
    const inp = document.getElementById('plimport-input');
    const url = (inp && inp.value || '').trim();
    if (!url) { App.toast('Paste a Spotify playlist link first'); return; }
    if (starting) return;
    const cur = await get();
    if (cur && !cur.done) { App.toast('An import is already running'); return; }
    starting = true;
    try {
      const r = await jpost('/api/dub/spotify/import', { input: url });
      if (!r.ok || !r.body || !r.body.batch_id) {
        throw new Error((r.body && r.body.error) || 'Could not read that playlist');
      }
      libKeys = null;
      await set({
        batchId: r.body.batch_id,
        playlistName: r.body.playlist_name || 'Spotify playlist',
        total: r.body.track_count || 0,
        imported: [], started: false, done: false,
        summary: '', note: '',
      });
      App.toast('Playlist found, finding the songs…');
      ensureLoop();
    } catch (e) {
      App.toast((e && e.message) || 'Import failed to start');
    }
    starting = false;
    paint();
  }

  async function cancel() {
    const st = await get();
    stopLoop();
    if (st && !st.done) {
      st.done = true;
      st.summary = `Stopped — ${st.imported.length} of ${st.total} songs kept in your library`;
      await set(st);
      // Best effort: tell the converter to stop working on it.
      jpost(`/api/dub/spotify/batch/${st.batchId}/abort`, {}).catch(() => {});
    }
    paint();
  }

  async function reset() {
    stopLoop();
    try { await DB.kvSet('plImport', null); } catch (e) {}
    libKeys = null;
    paint();
  }

  async function resumeStopped() {
    const st = await get();
    if (!st || !st.done) return;
    st.done = false;
    st.started = true;
    st.summary = '';
    st.diag = '';
    await set(st);
    ensureLoop();
    paint();
    App.toast('Import resumed');
  }

  function ensureLoop() {
    if (timer) return;
    timer = setInterval(poll, POLL_MS);
    poll();
  }
  function stopLoop() { if (timer) { clearInterval(timer); timer = null; } }

  async function resume() {
    const st = await get();
    if (st && !st.done) ensureLoop();
  }

  // One-shot reconcile for a parked job: if the converter moved on without
  // us (approved/started in dub, or we parked too early), pick it back up.
  async function reconcileParked(st) {
    if (!st || !st.done || !/confidently matched/.test(st.summary || '')) return;
    try {
      const r = await jget(`/api/dub/spotify/batch/${st.batchId}?pageSize=1`);
      const phase = (r.ok && r.body && r.body.batch && r.body.batch.phase) || '';
      if (phase === 'downloading' || phase === 'zipping' || phase === 'complete') {
        st.started = true;
        st.done = false;
        st.summary = '';
        await set(st);
        ensureLoop();
        paint();
      }
    } catch (e) {}
  }

  async function poll() {
    if (busy) return; // previous poll still saving songs: skip this tick
    busy = true;
    try {
    let st = await get();
    if (!st) { stopLoop(); return; }
    let data;
    try {
      const r = await jget(`/api/dub/spotify/batch/${st.batchId}?pageSize=1`);
      if (!r.ok || !r.body) return;
      data = r.body;
    } catch (e) { return; } // transient network blip: retry next poll
    const phase = (data.batch && data.batch.phase) || '';
    const prog = data.progress || {};
    // Reconcile: the batch may have moved on without us — the user may have
    // approved/started it in dub, or we parked too early. If the converter is
    // actively working (or finished), never sit on a stale dead-end: pick the
    // import back up and pull whatever is ready.
    if (phase === 'downloading' || phase === 'zipping' || phase === 'complete') {
      if (!st.started || (st.done && /confidently matched/.test(st.summary || ''))) {
        st.started = true;
        st.done = false;
        st.summary = '';
        await set(st);
      }
    }
    if (st.done) { stopLoop(); return; }
    // Remember match progress for the status line.
    st._matching = { done: prog.matching_done || 0, total: prog.matching_total || 0 };
    st._current = '';
    // Pace tracking: rolling server-side completion rate for the adaptive ETA.
    try {
      const cc = (prog && prog.counts) || {};
      const now = Date.now();
      paceHist.push({ t: now, c: cc.completed || 0 });
      paceHist = paceHist.filter(s => now - s.t <= 30 * 60 * 1000);
      st._counts = cc;
      lastPollAt = now;
    } catch (e) {}
    // Honest total: only tracks that can actually arrive (not no-match / dupes).
    try {
      const cc = (prog && prog.counts) || {};
      const honest = (cc.completed || 0) + (cc.approved || 0) + (cc.downloading || 0);
      if (honest > 0 && honest !== st.total) { st.total = honest; }
    } catch (e) {}
    await set(st);
    try {
      // Only approve + start once matching is FULLY done (review phase).
      // Approving mid-matching would start the batch early and strand the
      // tracks that had not been matched yet.
      if (phase === 'review' && !st.started) {
        await jpost(`/api/dub/spotify/batch/${st.batchId}/review`, { action: 'approve_high' });
        const rs = await jpost(`/api/dub/spotify/batch/${st.batchId}/start`, { quality_kbps: 320 });
        if (rs.ok) {
          st.started = true;
          await set(st);
        } else if (rs.body && /approv/i.test(rs.body.error || '')) {
          // Matching finished and truly nothing was confident: genuine dead end.
          st.done = true;
          st.summary = 'No songs could be confidently matched. Open the playlist in dub to review matches by hand.';
          await set(st);
          stopLoop(); paint(); return;
        }
        // Any other start error is transient: keep polling, try again.
      }
      if (phase === 'downloading' || phase === 'zipping' || phase === 'complete') {
        const r1 = await jget(`/api/dub/spotify/batch/${st.batchId}?pageSize=100`);
        const totalPages = (r1.ok && r1.body && r1.body.totalPages) || 1;
        let curTitle = '';
        for (let p = 1; p <= totalPages; p++) {
          let pg = (p === 1 && r1.ok && r1.body) ? r1.body : null;
          if (!pg) {
            const rp = await jget(`/api/dub/spotify/batch/${st.batchId}?pageSize=100&page=${p}`);
            if (!rp.ok || !rp.body) continue;
            pg = rp.body;
          }
          for (const t of (pg.tracks || [])) {
            // Remember which song the converter is working on right now.
            if (!curTitle && t.status === 'downloading') {
              const sp = t.spotify || {};
              const ar = (sp.artists || []).join(', ');
              curTitle = (ar ? ar + ' - ' : '') + (sp.name || ('track ' + t.pos));
            }
            // file_pos dupes share another position's file: import once.
            if (t.status === 'completed' && !t.file_pos && st.imported.indexOf(t.pos) === -1) {
              await importTrack(st, t);
            }
          }
        }
        if (curTitle) st._current = curTitle;
      }
      if (phase === 'complete' || phase === 'aborted') {
        const counts = (data.progress && data.progress.counts) || {};
        const failed = counts.failed || 0;
        st.done = true;
        st.summary = `Finished: ${st.imported.length} of ${st.total} songs in your library` +
          (failed ? `, ${failed} could not be downloaded` : '');
        await set(st);
        stopLoop();
        App.toast('Playlist import finished');
      }
    } catch (e) { /* transient: retry next poll */ }
    paint();
    } finally { busy = false; }
  }

  async function ensureKeys() {
    if (!libKeys) {
      const all = await DB.allTracks();
      libKeys = new Set(all.map(x => (x.fileName || '') + '|' + (x.fileSize || 0)));
    }
    return libKeys;
  }

  // One-time repair: tracks saved by older builds as "track-N.mp3" get their
  // real Spotify title/artist/album from the batch. Runs once per import.
  async function repairDubTags(st, tracks) {
    let all;
    try { all = await DB.allTracks(); } catch (e) { return; }
    const bad = (all || []).filter(x => x && x.tagsVia === 'dub' && /^track-\d+\.mp3$/i.test(x.fileName || ''));
    if (bad.length) {
    const byPos = new Map((tracks || []).map(t => [t.pos, t]));
    const clean = s => String(s).replace(/[\\/:"*?<>|]/g, '').trim();
    let fixed = 0;
    for (const x of bad) {
      const m = /track-(\d+)\.mp3$/i.exec(x.fileName || '');
      const bt = m && byPos.get(Number(m[1]));
      const sp = bt && bt.spotify;
      if (!sp || !sp.name) continue;
      const sTitle = sp.name.toString().trim();
      const sArtist = (sp.artists || []).join(', ').toString().trim();
      const sAlbum = (sp.album || '').toString().trim();
      try {
        const patch = {
          title: sTitle || x.title,
          artist: sArtist || x.artist,
          albumArtist: sArtist || x.albumArtist,
          album: sAlbum || x.album,
          fileName: (sArtist && sTitle) ? `${clean(sArtist)} - ${clean(sTitle)}.mp3` : x.fileName,
          tagged: true, diag: 'tags from Spotify',
          dubBatch: st.batchId, dubPos: Number(m[1]),
        };
        const vid = bt && bt.selected && bt.selected.video_id;
        if (vid) patch.dubVideo = vid;
        await DB.updateTrack(x.id, patch);
        fixed++;
      } catch (e) {}
    }
    if (fixed) { try { App.onLibraryChanged(); } catch (e) {} }
    }
    // Dedupe: the pre-v2.5 pileup could save the same song twice. Dub tracks
    // with identical size + title + artist are the same download: keep one.
    try {
      const fresh = await DB.allTracks();
      const seen = new Map();
      let dropped = 0;
      for (const x of (fresh || [])) {
        if (!x || x.tagsVia !== 'dub') continue;
        const k = (x.fileSize || 0) + '|' + (x.title || '') + '|' + (x.artist || '');
        if (seen.has(k)) { try { await DB.delTrack(x.id); dropped++; } catch (e) {} }
        else seen.set(k, 1);
      }
      if (dropped) { try { App.onLibraryChanged(); } catch (e) {} }
    } catch (e) {}
    // Artwork backfill: songs saved before the cover fallback existed can
    // show a blank cover even though the MP3 carries one. Scan the stored
    // file's ID3 tag directly; fall back to the YouTube thumbnail.
    try {
      const lib = await DB.allTracks();
      const vids = new Map((tracks || []).map(t => [t.pos, t.selected && t.selected.video_id]));
      let artFixed = 0;
      for (const x of (lib || [])) {
        if (!x || x.tagsVia !== 'dub' || x.art) continue;
        let art = null;
        if (x.file) { try { art = await extractApic(x.file); } catch (e) {} }
        if (!art) {
          const vid = x.dubVideo || (x.dubPos && vids.get(x.dubPos));
          if (vid) art = 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg';
        }
        if (art) { try { await DB.updateTrack(x.id, { art }); artFixed++; } catch (e) {} }
      }
      if (artFixed) { try { App.onLibraryChanged(); } catch (e) {} }
    } catch (e) {}
  }

  // Manual ID3 APIC scan: pulls the embedded cover straight out of the MP3
  // bytes without depending on the metadata parser. Returns a Blob or null.
  async function extractApic(file) {
    const buf = new Uint8Array(await file.slice(0, 524288).arrayBuffer());
    if (buf.length < 20 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null;
    const major = buf[3];
    const ssz = o => ((buf[o] << 21) | (buf[o + 1] << 14) | (buf[o + 2] << 7) | buf[o + 3]) >>> 0;
    const tagEnd = Math.min(10 + ssz(6), buf.length);
    let pos = 10;
    while (pos + 10 <= tagEnd) {
      const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
      if (id.charCodeAt(0) === 0) break;
      let size = (((buf[pos + 4] << 24) | (buf[pos + 5] << 16) | (buf[pos + 6] << 8) | buf[pos + 7]) >>> 0);
      if (major === 4) size = ssz(pos + 4); // v2.4 uses synchsafe frame sizes
      if (size <= 0 || pos + 10 + size > buf.length) break;
      if (id === 'APIC') {
        let p = pos + 11; // skip header + encoding byte
        while (p < pos + 10 + size && buf[p] !== 0) p++; // MIME
        let mime = '';
        try { mime = String.fromCharCode.apply(null, Array.from(buf.slice(pos + 11, p))); } catch (e) {}
        p += 2; // null + picture type
        if (buf[pos + 10] === 0 || buf[pos + 10] === 3) { while (p < pos + 10 + size && buf[p] !== 0) p++; p++; }
        else { while (p + 1 < pos + 10 + size && !(buf[p] === 0 && buf[p + 1] === 0)) p += 2; p += 2; }
        const img = buf.slice(p, pos + 10 + size);
        if (img.length > 1000) return new Blob([img], { type: mime || 'image/jpeg' });
        return null;
      }
      pos += 10 + size;
    }
    return null;
  }

  async function importTrack(st, t) {
    const mark = async (msg) => {
      st.diag = msg;
      try { await set(st); } catch (e) {}
      const dEl = document.getElementById('plimport-diag');
      if (dEl) dEl.textContent = msg;
    };
    let r;
    try { r = await fetch(`${DUB}/api/dub/spotify/batch/${st.batchId}/track/${t.pos}`); }
    catch (e) { await mark('A song failed to download (network). Retrying…'); return; }
    if (!r.ok) { await mark(`A song failed to download (server ${r.status}). Retrying…`); return; }
    const blob = await r.blob();
    if (!blob || blob.size < 1000) { await mark('A song arrived empty. Retrying…'); return; }
    // The converter knows the real Spotify title/artist/album: use them
    // directly instead of guessing from the file name.
    const sp = t.spotify || {};
    const sTitle = (sp.name || '').toString().trim();
    const sArtist = (sp.artists || []).join(', ').toString().trim();
    const sAlbum = (sp.album || '').toString().trim();
    const clean = s => s.replace(/[\\/:"*?<>|]/g, '').trim();
    const fname = (sArtist && sTitle) ? `${clean(sArtist)} - ${clean(sTitle)}.mp3`
      : (t.filename || `track-${t.pos}.mp3`);
    const keys = await ensureKeys();
    if (keys.has(fname + '|' + blob.size)) {
      st.imported.push(t.pos); await set(st); return;
    }
    await mark(`Saving song ${st.imported.length + 1} to your library…`);
    try {
      const file = new File([blob], fname, { type: 'audio/mpeg' });
      const tr = await Importer.parseOne(file);
      if (!tr.art) {
        // The MP3 carries the cover, but the parser can miss it on some
        // phones: scan the ID3 tag for the picture by hand.
        try { tr.art = await extractApic(file); } catch (e) {}
      }
      if (!tr.art) {
        // Last resort: the matched YouTube video's thumbnail. Stored as a
        // URL string, which the artwork renderer already supports.
        const vid = t.selected && t.selected.video_id;
        if (vid) tr.art = 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg';
      }
      if (sTitle) tr.title = sTitle;
      if (sArtist) { tr.artist = sArtist; tr.albumArtist = sArtist; }
      if (sAlbum) tr.album = sAlbum;
      if (sTitle || sArtist) { tr.tagged = true; tr.diag = 'tags from Spotify'; }
      tr.tagsVia = 'dub';
      tr.dubBatch = st.batchId;
      tr.dubPos = t.pos;
      if (t.selected && t.selected.video_id) tr.dubVideo = t.selected.video_id;
      await DB.addTracks([tr]);
      keys.add(fname + '|' + blob.size);
      st.imported.push(t.pos);
      await set(st);
      st.diag = '';
      const dEl = document.getElementById('plimport-diag');
      if (dEl) dEl.textContent = '';
      const cEl = document.getElementById('plimport-count');
      if (cEl) cEl.textContent = `${st.imported.length} of ${st.total} in your library`;
      const fEl = document.getElementById('plimport-fill');
      if (fEl && st.total > 0) fEl.style.width = Math.round((st.imported.length / st.total) * 100) + '%';
      App.onLibraryChanged();
    } catch (e) { await mark('A song could not be saved: ' + ((e && e.message) || 'unknown error')); }
  }

  // Adaptive pace: songs converted per hour over the last 30 minutes of
  // server-side progress. Null until there are two samples far enough apart
  // to mean anything.
  function pacePerHour() {
    const h = paceHist;
    if (h.length < 2) return null;
    const a = h[0], b = h[h.length - 1];
    const mins = (b.t - a.t) / 60000;
    if (mins < 1) return null;
    return (b.c - a.c) / (mins / 60);
  }

  // Rough time-to-done that breathes with the real pace: bursts shrink it,
  // throttle waves stretch it. Never a fake-precise number.
  function etaText(st) {
    const cc = st._counts || {};
    const done = cc.completed || 0;
    const total = st.total || 0;
    const left = Math.max(0, total - done);
    if (left <= 0) return 'Finishing up…';
    const p = pacePerHour();
    if (p === null) return 'Finding pace…';
    if (p < 0.5) return 'Paused — waiting on the converter';
    const hours = left / p;
    if (hours < 1) return 'Roughly ' + Math.max(1, Math.round(hours * 60)) + ' min left';
    if (hours < 48) {
      const h = Math.round(hours);
      return 'Roughly ' + h + ' hour' + (h === 1 ? '' : 's') + ' left';
    }
    return 'Roughly ' + (Math.round(hours / 24 * 10) / 10) + ' days left';
  }

  function detailsHtml(st) {
    const cc = st._counts || {};
    const done = cc.completed || 0;
    const queued = (cc.approved || 0) + (cc.downloading || 0);
    const failed = cc.failed || 0;
    const p = pacePerHour();
    const pace = p === null ? 'gathering data…'
      : (p < 0.5 ? 'paused' : '~' + Math.round(p) + ' songs/hour');
    const when = lastPollAt ? new Date(lastPollAt).toLocaleTimeString() : '—';
    const phase = st._phase || '—';
    const cur = st._current ? 'converting: ' + st._current : 'between songs';
    const row = (k, v) =>
      `<div style="display:flex;justify-content:space-between;gap:12px"><span>${k}</span><span style="color:var(--txt);font-weight:600;text-align:right">${v}</span></div>`;
    return row('Converted', escHtml(done + ' of ' + (st.total || 0)))
      + row('Waiting in queue', escHtml(String(queued)))
      + row('Could not download', escHtml(String(failed)))
      + row('In your library', escHtml(String(st.imported.length)))
      + row('Pace (last 30 min)', escHtml(pace))
      + row('Converter is', escHtml(phase + ' — ' + cur))
      + row('Last checked', escHtml(when));
  }

  function toggleDetails() {
    detailsOpen = !detailsOpen;
    paint();
  }

  function phaseText(st, phase) {
    const n = st.imported.length, m = st.total;
    if (phase === 'matching') {
      const g = st._matching || {};
      return (g.total > 0) ? `Finding audio versions… ${g.done} of ${g.total}` : 'Finding audio versions of each song…';
    }
    if (phase === 'review') return 'Matches found, starting the downloads…';
    if (phase === 'downloading') return n === 0 ? 'Converting the first songs…' : `${n} of ${m} songs in your library`;
    if (phase === 'zipping') return `Wrapping up… ${n} of ${m} in your library`;
    return `${n} of ${m} songs in your library`;
  }

  async function paint() {
    const body = document.getElementById('plimport-body');
    if (!body) return;
    const st = await get();
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    if (!st) {
      body.innerHTML = `
        <p style="color:var(--sub);font-size:14px;line-height:1.5">Paste a Spotify playlist link. Each song is matched to an audio or lyric upload (music videos are skipped), converted, and added to your library the moment it is ready.</p>
        <input id="plimport-input" placeholder="open.spotify.com/playlist/…" autocomplete="off" autocapitalize="off" spellcheck="false"
          style="width:100%;box-sizing:border-box;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;color:var(--txt);font-size:15px;margin:8px 0 12px" />
        <button data-act="plimport-start" style="width:100%;background:var(--acc);color:#fff;border:0;border-radius:12px;padding:14px;font-size:15px;font-weight:700">Start import</button>
        <p style="color:var(--sub);font-size:12px;line-height:1.5;margin-top:12px">Songs convert one at a time, so a big playlist takes a while. You can leave and come back — it keeps going.</p>`;
      return;
    }
    if (st.done) {
      const canResume = /^Stopped/.test(st.summary || '');
      body.innerHTML = `
        <div style="background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px">
          <div style="font-weight:700;font-size:16px;margin-bottom:6px">${esc(st.playlistName)}</div>
          <div style="color:var(--sub);font-size:14px;line-height:1.5">${esc(st.summary)}</div>
        </div>
        ${canResume ? '<button data-act="plimport-resume" style="width:100%;margin-top:12px;background:var(--acc);color:#fff;border:0;border-radius:12px;padding:14px;font-size:15px;font-weight:700">Resume import</button>' : ''}
        <button data-act="plimport-again" style="width:100%;margin-top:12px;background:var(--card);color:var(--txt);border:1px solid var(--line);border-radius:12px;padding:14px;font-size:15px;font-weight:700">Import another playlist</button>`;
      reconcileParked(st);
      return;
    }
    const pct = st.total > 0 ? Math.round((st.imported.length / st.total) * 100) : 0;
    const ph = st._phase || '';
    body.innerHTML = `
      <div style="background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px">
        <div style="font-weight:700;font-size:16px;margin-bottom:6px">${esc(st.playlistName)}</div>
        <div id="plimport-status" style="color:var(--sub);font-size:14px;margin-bottom:12px">Checking…</div>
        <div style="height:8px;border-radius:99px;background:var(--line);overflow:hidden">
          <div id="plimport-fill" style="height:100%;width:${pct}%;border-radius:99px;background:var(--acc);transition:width .4s"></div>
        </div>
        <div id="plimport-count" style="margin-top:8px;font-size:13px;color:var(--sub)">${st.imported.length} of ${st.total} in your library</div>
        <div id="plimport-eta" style="margin-top:4px;font-size:13px;color:var(--acc);font-weight:600">${esc(etaText(st))}</div>
        <div id="plimport-diag" style="margin-top:6px;font-size:12px;color:var(--sub)">${esc(st.diag || '')}</div>
      </div>
      <button data-act="plimport-details" style="width:100%;margin-top:12px;background:var(--card);color:var(--txt);border:1px solid var(--line);border-radius:12px;padding:12px;font-size:14px;font-weight:600">${detailsOpen ? 'Hide details' : 'See details'}</button>
      <div id="plimport-details" style="display:${detailsOpen ? 'block' : 'none'};margin-top:12px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;font-size:13px;line-height:2;color:var(--sub)">${detailsHtml(st)}</div>
      <button data-act="plimport-cancel" style="width:100%;margin-top:12px;background:transparent;color:#ff7b7b;border:1px solid var(--line);border-radius:12px;padding:14px;font-size:15px">Stop import</button>`;
    // Fill in the live phase line without a second status fetch.
    try {
      const r = await jget(`/api/dub/spotify/batch/${st.batchId}?pageSize=1`);
      const phase = (r.body && r.body.batch && r.body.batch.phase) || '';
      st._phase = phase;
      const sEl = document.getElementById('plimport-status');
      if (sEl) sEl.textContent = phaseText(st, phase);
    } catch (e) {}
    // One-time repair for this import: fix "track-N" names and drop dupes.
    // Runs when the view opens, even if the import was stopped.
    if (st.batchId && !st._repaired) {
      const rid = st.batchId;
      try {
        const p1 = await jget(`/api/dub/spotify/batch/${rid}?pageSize=100`);
        const tps = (p1.ok && p1.body && p1.body.totalPages) || 1;
        let allT = (p1.ok && p1.body && p1.body.tracks) || [];
        for (let p = 2; p <= tps; p++) {
          const rp = await jget(`/api/dub/spotify/batch/${rid}?pageSize=100&page=${p}`);
          if (rp.ok && rp.body) allT = allT.concat(rp.body.tracks || []);
        }
        await repairDubTags(st, allT);
      } catch (e) {}
      try {
        const fresh = await get();
        if (fresh && fresh.batchId === rid) { fresh._repaired = true; await set(fresh); }
      } catch (e) {}
    }
  }

  return { startFromUI, cancel, reset, resume, resumeStopped, toggleDetails, paint, settingsLine };
})();
