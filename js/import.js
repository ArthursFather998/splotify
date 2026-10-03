/* Splotify import — Files app picker → metadata parse → IndexedDB. */
const Importer = (() => {
  const picker = () => document.getElementById('filepicker');
  const zippicker = () => document.getElementById('zippicker');
  let busy = false;
  const AUDIO_IN_ZIP = /\.(mp3|m4a|m4b|aac|wav|flac|ogg|oga|opus|aiff|aif)$/i;
  // A single pathological file must never wedge the whole import: race slow ops against a timeout.
  function withTimeout(p, ms, label) {
    let t;
    const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout: ' + (label || 'op'))), ms); });
    return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), to]);
  }

  function baseTitle(name) {
    return name.replace(/\.[a-z0-9]{2,5}$/i, '');
  }
  function splitArtistTitle(name) {
    const c = fileNameCandidates(name).list[0];
    if (c) return { artist: c.artist, title: c.title };
    const b = baseTitle(name || '').trim();
    return { artist: 'Unknown Artist', title: b || 'Unknown Title' };
  }
  // v7.8 filename parser rewrite: real-world file names are feral, so the
  // old single "Artist - Title" regex misread most of them. This builds
  // scored parse candidates instead of one guess:
  //   "01. Artist - Title", "Artist_-_Title", "[SPOTIFY-DOWNLOADER] A - T",
  //   "Title - Artist" (reversed — wins only when tag hints agree),
  //   folder paths (".../Withered Deluxe/02 - Title.flac" → album),
  //   leading track numbers, feat. artists.
  // Audio qualifiers ("(Sped Up)", "(Remix)", "(Live)") are PRESERVED in
  // titles — only downloader/video junk is stripped, so a stripped query
  // can never propose dropping a qualifier the v7.2 gates protect.
  // A candidate seeds an audit query only when it carries BOTH artist and
  // title (v7.2 safety rule): an artist-less file name ("Track 01.mp3")
  // must never seed a query.
  const FOLDER_JUNK = /^(downloads?|music|audio|mp3s?|flacs?|m4as?|songs?|tracks?|new folder|untitled|various( artists)?|my music|itunes|library)$/i;
  function stripFileJunk(s) {
    return (s || '')
      .replace(/\[[^\]]*(spotify.downloader|downloader|free download|320\s?kbps|\bmp3\b|\bflac\b|\bm4a\b)[^\]]*\]/gi, '')
      .replace(/[\[\(]\s*(official\s+(audio|video|music\s+video)|lyrics?|audio|video|hd|4k|hq|mv)\s*[\]\)]/gi, '')
      .replace(/[\[\(]\s*(19|20)\d{2}\s*[\]\)]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  function parseFeat(title) {
    const m = (title || '').match(/[\[\(]\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[\]\)]/i);
    return m ? m[1].trim() : '';
  }
  function fileNameCandidates(name, folderPath, hints) {
    const out = { list: [], album: null, trackNo: 0 };
    let b = baseTitle(name || '').replace(/_+/g, ' ').replace(/\.{2,}/g, ' ');
    b = stripFileJunk(b);
    const ln = b.match(/^\s*0*(\d{1,3})\s*[.\-–—)\]:]\s+/);
    if (ln && b.slice(ln[0].length).trim()) { out.trackNo = parseInt(ln[1], 10); b = b.slice(ln[0].length).trim(); }
    if (folderPath) {
      const parts = String(folderPath).split(/[\\/]/).filter(p => p && p.trim());
      const folder = (parts[parts.length - 1] || '').trim();
      const fm = folder.match(/^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/);
      const alb = (fm ? fm[2] : folder).trim();
      if (alb && alb.length >= 2 && !FOLDER_JUNK.test(alb)) out.album = alb;
    }
    const ha = hints && hints.artist && hints.artist !== 'Unknown Artist' ? hints.artist : '';
    const ht = hints && hints.title && hints.title !== 'Unknown Title' ? hints.title : '';
    const seen = new Set();
    const push = (artist, title, score) => {
      artist = (artist || '').replace(/\s+/g, ' ').trim();
      title = (title || '').replace(/\s+/g, ' ').trim();
      if (!artist || !title || /^unknown (artist|title)$/i.test(artist) || /^unknown (artist|title)$/i.test(title)) return;
      const k = artist.toLowerCase() + '|||' + title.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      let s = score;
      if (ha || ht) s += 0.5 * strSim(artist, ha) + 0.5 * strSim(title, ht);
      out.list.push({ artist, title, score: s, feat: parseFeat(title), trackNo: out.trackNo, album: out.album });
    };
    const m = b.match(/^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/);
    if (m) {
      push(m[1], m[2], 1.0);  // forward
      push(m[2], m[1], 0.55); // reversed — wins only when tag hints agree
    }
    out.list.sort((x, y) => y.score - x.score);
    return out;
  }
  function fmtDur(s) {
    if (!s || !isFinite(s)) return '';
    s = Math.round(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  // Curated metadata fixes (js/custom-art/meta.js, built from custom_meta.json):
  // repair known-mangled tags, e.g. "Celeste (Demo - Unfinished).mp3" split on " - ".
  function metaFixFor(artist, title) {
    const list = window.CUSTOM_META || [];
    if (!list.length) return null;
    const a = String(artist || '').trim().toLowerCase();
    const t = String(title || '').trim().toLowerCase();
    for (const m of list) { if (m.a === a && m.t === t) return m; }
    return null;
  }
  async function fetchJSON(url, ms) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 12000);
    try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) return null; return await r.json(); }
    catch (e) { return null; } finally { clearTimeout(t); }
  }
  // v7.8 polite concurrency: the parallel fix pool fires many fixes at once.
  // MusicBrainz keeps its own strict 1 req/sec pacing (mbSearchRecording);
  // Apple/Deezer catalog + artwork queries share this 3-in-flight gate so
  // the pool can't hammer the APIs. No gated call nests inside another.
  function makeGate(max) {
    let inFlight = 0;
    const waiters = [];
    const pump = () => {
      while (inFlight < max && waiters.length) {
        const w = waiters.shift();
        inFlight++;
        w();
      }
    };
    return function gate(fn) {
      return new Promise((resolve, reject) => {
        waiters.push(() => {
          Promise.resolve().then(fn).then(
            v => { inFlight--; pump(); resolve(v); },
            e => { inFlight--; pump(); reject(e); }
          );
        });
        pump();
      });
    };
  }
  const catalogGate = makeGate(3);
  function needsFix(tr) {
    return tr.album === 'Unknown Album' || !tr.art || tr.artist === 'Unknown Artist' || !tr.title || tr.title === 'Unknown Title';
  }
  // Fill in missing tags from Apple's music catalog (song/artist name only —
  // audio never leaves the device). Strictly fill-only: fields that already
  // have values are never overwritten here; corrections go through the
  // scored audit proposals instead. Tries the tag query first, then the
  // file-name query (mangled tags poison the first, the file name often
  // still holds "Artist - Title").
  const TAG_MISSING = v => !v || v === 'Unknown Album' || v === 'Unknown Artist' || v === 'Unknown Title';
  async function autoTag(tr, opts) {
    opts = opts || {};
    if (!needsFix(tr) && !opts.fillAny) return false;
    const queries = [];
    if (tr.title && tr.title !== 'Unknown Title') {
      queries.push({ a: tr.artist && tr.artist !== 'Unknown Artist' ? tr.artist : '', t: tr.title });
    }
    try {
      // v7.8: every scored filename candidate seeds its own query — more
      // candidates, better recall. The parser only emits candidates with
      // both artist and title, so the v7.2 artist-less safety rule holds.
      const pc = fileNameCandidates(tr.fileName || '', tr.filePath || '', { artist: tr.artist, title: tr.title });
      for (const c of pc.list.slice(0, 4)) {
        const q = { a: c.artist, t: c.title };
        if (!queries.some(x => x.a === q.a && x.t === q.t)) queries.push(q);
      }
      // Fill-only extras from the filename: folder album and leading track
      // number. Never overwrite anything present.
      if (TAG_MISSING(tr.album) && pc.album) tr.album = pc.album;
      if (!tr.trackNo && pc.trackNo) tr.trackNo = pc.trackNo;
    } catch (e) {}
    let filled = false;
    for (const q of queries) {
      try { if (await autoTagQuery(tr, q)) { filled = true; break; } } catch (e) {}
    }
    // Artwork fallback chain: Apple first (inside autoTagQuery), then
    // Deezer gets its turn when Apple had no art.
    if (!tr.art && !tr.artManual) {
      for (const q of queries) {
        try { if (await autoTagDeezerArt(tr, q)) { filled = true; break; } } catch (e) {}
      }
    }
    // v7.7: extended art chain (Spotify oEmbed → Cover Art Archive →
    // fanart.tv) when Apple and Deezer both came up empty.
    if (!tr.art && !tr.artManual) {
      try { if (await artChainExtra(tr)) filled = true; } catch (e) {}
    }
    return filled;
  }
  // Deezer artwork fill (v7.6): when Apple had no art, Deezer's cover_xl
  // gets its turn. Blob first (works offline); the URL string as fallback.
  async function autoTagDeezerArtUngated(tr, q) {
    const qs = ((q.a ? q.a + ' ' : '') + q.t).trim();
    if (!qs || tr.art || tr.artManual) return false;
    const d = await fetchJSON('https://api.deezer.com/search?q=' + encodeURIComponent(qs) + '&limit=6', 12000);
    if (!d || !d.total || !d.data) return false;
    const na = norm(q.a);
    for (const r of d.data) {
      const ra = norm((r.artist && r.artist.name) || '');
      const artistOK = !na || na === 'unknown artist' || ra === na || ra.indexOf(na) !== -1 || na.indexOf(ra) !== -1;
      if (titleMatches(q.t, r.title || '', false) && artistOK) {
        const au = (r.album && r.album.cover_xl) || '';
        if (au) {
          let blob = null;
          try {
            const c = new AbortController(); const tm = setTimeout(() => c.abort(), 6000);
            const rr = await fetch(au, { signal: c.signal }); clearTimeout(tm);
            if (rr.ok) { const b = await rr.blob(); if (b && b.size > 1000) blob = b; }
          } catch (e) {}
          tr.art = blob || au;
          tr.artSource = 'Deezer';
          tr.tagsVia = (tr.tagsVia ? tr.tagsVia + '+' : '') + 'Deezer';
          tr.tagged = true;
          return true;
        }
      }
    }
    return false;
  }
  // Fetch an artwork URL with a 6s timeout. Returns the Blob, false when
  // the URL definitively has no image (404 — try the next candidate), or
  // null when the fetch flaked (the URL string is still a viable fallback).
  async function artBlob(url) {
    try {
      const c = new AbortController(); const tm = setTimeout(() => c.abort(), 6000);
      const rr = await fetch(url, { signal: c.signal }); clearTimeout(tm);
      if (rr.status === 404) return false;
      if (rr.ok) { const b = await rr.blob(); if (b && b.size > 1000) return b; }
    } catch (e) {}
    return null;
  }
  // v7.7 extended artwork chain. Runs when Apple and Deezer found no art.
  // Sources: Spotify oEmbed (imported tracks carry a spotifyId — no auth),
  // Cover Art Archive (via the MusicBrainz release id), fanart.tv (needs
  // the key stored in Settings → Metadata). Candidates are tried highest
  // resolution first; the winner's source is recorded on tr.artSource.
  // Never touches existing or hand-set art.
  async function artChainExtra(tr) {
    if (tr.art || tr.artManual) return false;
    const cands = [];
    if (tr.spotifyId) {
      try {
        const o = await fetchJSON('https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/track/' + tr.spotifyId), 8000);
        if (o && o.thumbnail_url) cands.push({ url: o.thumbnail_url, w: o.thumbnail_width || 640, source: 'Spotify' });
      } catch (e) {}
    }
    // Cover Art Archive + fanart.tv need a MusicBrainz release id. The MB
    // lookup is cached and polite (1/sec), so a repeat query costs nothing.
    // v7.9: a fingerprinted track already knows its release MBID — go
    // straight to Cover Art Archive without spending the MB search.
    let releaseId = tr.mbReleaseId || null;
    try {
      let artistId = null;
      if (!releaseId) {
        const recs = await mbSearchRecording(tr.title, tr.artist);
        const pick = mbPick(recs, tr);
        const rel = pick && (pick.releases || [])[0];
        const ac = pick && (pick['artist-credit'] || [])[0];
        artistId = ac && ac.artist && ac.artist.id;
        releaseId = (rel && rel.id) || null;
      }
      let fkey = null;
      try { fkey = await DB.kvGet('fanartKey', null); } catch (e) {}
      if (releaseId) {
        cands.push({ url: 'https://coverartarchive.org/release/' + releaseId + '/front', w: 1400, source: 'Cover Art Archive' });
        if (fkey) {
          try {
            const f = await fetchJSON('https://webservice.fanart.tv/v3/music/albums/' + releaseId + '?api_key=' + encodeURIComponent(fkey), 8000);
            const alb = f && f.albums && f.albums[releaseId];
            const covers = alb && alb.albumcover;
            if (covers && covers.length && covers[0].url) cands.push({ url: covers[0].url, w: 1000, source: 'fanart.tv' });
          } catch (e) {}
        }
      }
      if (fkey && artistId) {
        try {
          const f = await fetchJSON('https://webservice.fanart.tv/v3/music/' + artistId + '?api_key=' + encodeURIComponent(fkey), 8000);
          const thumbs = f && f.artistthumb;
          if (thumbs && thumbs.length && thumbs[0].url) cands.push({ url: thumbs[0].url, w: 1000, source: 'fanart.tv' });
        } catch (e) {}
      }
    } catch (e) {}
    if (!cands.length) return false;
    cands.sort((a, b) => b.w - a.w);
    for (const cd of cands) {
      const blob = await artBlob(cd.url);
      if (blob === false) continue; // definitively missing — try the next
      tr.art = blob || cd.url;
      tr.artSource = cd.source;
      tr.tagsVia = (tr.tagsVia ? tr.tagsVia + '+' : '') + cd.source;
      tr.tagged = true;
      return true;
    }
    return false;
  }
  // v7.7 calibration signals: every review approve/skip (and approve-all)
  // is logged per source + confidence bucket into the tagMemory store.
  // Thresholds stay fixed this version — v7.8 adapts them from these.
  async function logCalib(source, confidence, approved) {
    try {
      const bucket = Math.round((confidence || 0) * 20) / 20; // 0.05 steps
      const src = source || 'unknown';
      const key = 'calib:' + src + ':' + bucket.toFixed(2);
      const rec = (await DB.memGet(key)) || { key, approved: 0, total: 0 };
      rec.approved += approved ? 1 : 0;
      rec.total += 1;
      await DB.memPut(rec);
      // v7.8: per-source bucket index so the adaptive thresholds can
      // enumerate buckets without scanning the whole tagMemory store.
      const ik = 'calibidx:' + src;
      const idx = (await DB.memGet(ik)) || { key: ik, buckets: {} };
      idx.buckets[bucket.toFixed(2)] = true;
      await DB.memPut(idx);
    } catch (e) {}
  }
  // v7.8 adaptive confidence thresholds. Per source, the auto-apply
  // threshold becomes the lowest confidence bucket with approval rate ≥ 95%
  // and at least 10 samples. Clamped: never auto below 0.60, never above
  // the 0.88 default. With insufficient data the fixed 0.88 behavior holds
  // exactly. The review floor (0.55) is unchanged, and the title-only album
  // cap stays a hard safety rule outside this.
  async function autoThresholdFor(source) {
    const DEF = 0.88, FLOOR = 0.60;
    try {
      const src = source || 'unknown';
      const idx = await DB.memGet('calibidx:' + src);
      const buckets = idx && idx.buckets ? Object.keys(idx.buckets).map(Number).sort((a, b) => a - b) : [];
      let thr = DEF;
      for (const b of buckets) {
        const rec = await DB.memGet('calib:' + src + ':' + b.toFixed(2));
        if (rec && rec.total >= 10 && rec.approved / rec.total >= 0.95) { thr = b; break; }
      }
      return Math.min(DEF, Math.max(FLOOR, thr));
    } catch (e) { return DEF; }
  }
  async function autoTagQueryUngated(tr, q) {
    const qs = ((q.a ? q.a + ' ' : '') + q.t).trim();
    if (!qs) return false;
    const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(qs) + '&media=music&entity=song&limit=6', 12000);
    if (!d || !d.resultCount) return false;
    const na = norm(q.a);
    let best = null;
    for (const r of d.results) {
      const ra = norm(r.artistName);
      const artistOK = !na || na === 'unknown artist' || ra === na || ra.indexOf(na) !== -1 || na.indexOf(ra) !== -1;
      if (titleMatches(q.t, r.trackName, false) && artistOK) { best = r; break; }
    }
    if (!best) return false;
    if (TAG_MISSING(tr.title)) tr.title = best.trackName || tr.title;
    if (TAG_MISSING(tr.artist)) tr.artist = best.artistName || tr.artist;
    if (TAG_MISSING(tr.album)) tr.album = best.collectionName || tr.album;
    if (!tr.genre) tr.genre = best.primaryGenreName || tr.genre;
    if (!tr.year) tr.year = (best.releaseDate || '').slice(0, 4) || tr.year;
    if (!tr.trackNo) tr.trackNo = best.trackNumber || tr.trackNo;
    tr.tagsVia = tr.tagsVia || 'Apple Music';
    // v7.7: 1200px art (was 600) — crisp on retina, still cheap to store.
    const au = (best.artworkUrl100 || '').replace('100x100bb', '1200x1200bb');
    // Never overwrite hand-set artwork. Blob first (works offline); the URL
    // string as fallback so art still displays if the download flakes.
    if (au && !tr.art && !tr.artManual) {
      let blob = null;
      try {
        const c = new AbortController(); const tm = setTimeout(() => c.abort(), 6000);
        const rr = await fetch(au, { signal: c.signal }); clearTimeout(tm);
        if (rr.ok) { const b = await rr.blob(); if (b && b.size > 1000) blob = b; }
      } catch (e) {}
      tr.art = blob || au;
      tr.artSource = 'Apple Music';
    }
    tr.tagged = true;
    return true;
  }
  async function parseOne(file) {
    let common = {}, format = {};
    let diag = 'reader-ok';
    try {
      if (window.mm && window.mm.parseBlob) {
        const md = await window.mm.parseBlob(file, { duration: true });
        common = md.common || {}; format = md.format || {};
      } else {
        diag = 'reader-missing (window.mm.parseBlob not found)';
      }
    } catch (e) { diag = 'parse-error: ' + ((e && e.message) || String(e)); console.warn('parse failed for', file.name, e); }
    const fb = splitArtistTitle(file.name);
    let art = null;
    const pic = common.picture && common.picture[0];
    if (pic && pic.data) {
      try { art = new Blob([pic.data], { type: pic.format || 'image/jpeg' }); } catch (e) {}
    }
    const artist0 = (common.artist || common.albumartist || fb.artist || 'Unknown Artist').toString();
    const title0 = (common.title || fb.title || 'Unknown Title').toString();
    // Curated metadata fixes: repair known-mangled tags at import time.
    let artist = artist0, title = title0, tagsVia = null;
    const mf = metaFixFor(artist0, title0);
    if (mf) {
      if (mf.fa) artist = mf.fa;
      if (mf.ft) title = mf.ft;
      tagsVia = 'Curated';
    }
    const tagged = !!(common.title || common.artist || common.albumartist || common.album || pic);
    return {
      title, artist, tagsVia,
      album: (common.album || 'Unknown Album').toString(),
      albumArtist: (common.albumartist || artist).toString(),
      genre: (common.genre && common.genre[0]) || '',
      year: common.year || (common.date || '').toString().slice(0, 4) || '',
      trackNo: (common.track && common.track.no) || 0,
      discNo: (common.disk && common.disk.no) || 0,
      duration: format.duration || 0,
      fileName: file.name, fileSize: file.size,
      file, art, tagged, diag,
      dateAdded: Date.now(),
    };
  }

  async function run(files, total, opts) {
    opts = opts || {};
    total = total || (files && files.length) || 0;
    if (busy || !total) return;
    busy = true;
    const prog = document.getElementById('import-progress');
    const fill = document.getElementById('ip-fill');
    const count = document.getElementById('ip-count');
    document.getElementById('ip-title').textContent = 'Adding music…';
    prog.classList.remove('hidden');
    let added = 0, skipped = 0, refreshed = 0, taggedCount = 0, fixed = 0;
    const parserOK = !!(window.mm && window.mm.parseBlob);
    const batch = [];
    let batchBytes = 0, saveError = null;
    const isQuota = e => !!e && (e.name === 'QuotaExceededError' || /quota|storage.*full/i.test(String(e.message || e)));
    // A failed save must never kill the whole import: retry once, then drop the chunk.
    // Songs only count as "added" after IndexedDB confirms the write, and
    // large files are flushed in small byte-bounded batches so one giant
    // transaction cannot sink the whole import on a phone.
    async function flush() {
      if (!batch.length) return 'saved';
      const chunk = batch.splice(0);
      batchBytes = 0;
      try { await DB.addTracks(chunk); added += chunk.length; return 'saved'; }
      catch (e) {
        console.warn('import flush failed, retrying once', e);
        if (isQuota(e)) { saveError = e; skipped += chunk.length; return 'quota'; }
        try { await DB.addTracks(chunk); added += chunk.length; return 'saved'; }
        catch (e2) {
          console.warn('import flush failed twice, dropping', chunk.length, e2);
          saveError = e2; skipped += chunk.length;
          return isQuota(e2) ? 'quota' : 'dropped';
        }
      }
    }
    try {
    const existing = await DB.allTracks();
    const byKey = new Map(existing.map(t => [t.fileName + '|' + t.fileSize, t]));
    const seen = new Set(byKey.keys());
    let i = 0;
    for await (const f of files) {
      i++;
      count.textContent = `${i} of ${total}`;
      fill.style.width = Math.round((i / total) * 100) + '%';
      const key = f.name + '|' + f.size;
      if (seen.has(key)) {
        // ZIP imports skip library dupes outright; the Files picker refreshes their metadata.
        if (opts.skipExisting) { skipped++; continue; }
        // Already in library: re-parse and refresh its metadata instead of ignoring it.
        try {
          const tr = await withTimeout(parseOne(f), 30000, 'parse ' + f.name);
          const cur = byKey.get(key);
          if (tr.tagged) taggedCount++;
          if (await autoTag(tr)) fixed++;
          await DB.updateTrack(cur.id, {
            title: tr.title, artist: tr.artist, album: tr.album, albumArtist: tr.albumArtist,
            genre: tr.genre, year: tr.year, trackNo: tr.trackNo, discNo: tr.discNo,
            duration: tr.duration || cur.duration, art: tr.art, file: tr.file,
            tagged: tr.tagged, tagsVia: tr.tagsVia || cur.tagsVia, diag: tr.diag,
          });
          refreshed++;
        } catch (e) { console.warn('refresh failed', f.name, e); skipped++; }
        continue;
      }
      try {
        const tr = await withTimeout(parseOne(f), 30000, 'parse ' + f.name);
        if (tr.tagged) taggedCount++;
        if (await autoTag(tr)) fixed++;
        batch.push(tr);
        batchBytes += tr.fileSize || f.size || 0;
        seen.add(key);
      } catch (e) { console.warn('import failed', f.name, e); skipped++; }
      if (batch.length >= 4 || batchBytes >= 128 * 1024 * 1024) {
        if (await flush() === 'quota') break;
      }
    }
    await flush();
    } catch (e) {
      console.warn('import run aborted', e);
      skipped++;
    } finally {
      prog.classList.add('hidden');
      busy = false;
    }
    picker().value = '';
    App.onLibraryChanged();
    const parts = [];
    if (added) parts.push(`Added ${added} song${added === 1 ? '' : 's'}`);
    if (refreshed) parts.push(`refreshed ${refreshed}`);
    if (fixed) parts.push(`fixed tags for ${fixed}`);
    if (skipped) parts.push(`${skipped} skipped`);
    if (saveError) parts.push(isQuota(saveError) ? 'Splotify storage is full — free up space or import smaller zips' : 'some songs could not be saved');
    let msg = parts.length ? parts.join(', ') : 'Nothing new to add';
    if (!parserOK) msg += ' — tag reader unavailable, used filenames';
    else if ((added || refreshed) && !taggedCount && !fixed) msg += ' — no tags found, used filenames';
    App.toast(msg);
  }

  // Import ZIP: pull the audio files out of a zip and run each through the
  // normal import pipeline. Large archives are read as slices from the file
  // on disk instead of being loaded whole into memory, which crashed iOS
  // Safari on multi-GB zips.
  function audioType(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ({
      mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
      wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
      opus: 'audio/opus', aiff: 'audio/aiff', aif: 'audio/aiff',
    })[ext] || 'audio/mpeg';
  }
  async function blobArrayBuffer(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(blob);
    });
  }
  async function readBytes(blob) { return new Uint8Array(await blobArrayBuffer(blob)); }
  function u64(dv, off) {
    if (dv.getBigUint64) {
      const v = dv.getBigUint64(off, true);
      return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
    }
    return dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 4294967296;
  }
  function decodeZipName(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); }
    catch (e) { return Array.from(bytes, b => String.fromCharCode(b)).join(''); }
  }
  function applyZip64(extra, vals) {
    const dv = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
    let pos = 0;
    while (pos + 4 <= extra.length) {
      const id = dv.getUint16(pos, true);
      const len = dv.getUint16(pos + 2, true);
      pos += 4;
      if (id === 1) {
        let p = pos;
        const read = () => { const v = u64(dv, p); p += 8; return v; };
        if (vals.uncomp === 0xffffffff) vals.uncomp = read();
        if (vals.comp === 0xffffffff) vals.comp = read();
        if (vals.offset === 0xffffffff) vals.offset = read();
        if (vals.disk === 0xffff) vals.disk = read();
      }
      pos += len;
    }
  }
  async function zip64Directory(zipFile, tail, eocdPos) {
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const locPos = eocdPos - 20;
    if (locPos < 0 || dv.getUint32(locPos, true) !== 0x07064b50) throw new Error('zip64 locator missing');
    const rec = await readBytes(zipFile.slice(u64(dv, locPos + 8), u64(dv, locPos + 8) + 56));
    const rd = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    if (rd.getUint32(0, true) !== 0x06064b50) throw new Error('zip64 directory missing');
    return { count: u64(rd, 32), cdSize: u64(rd, 40), cdOffset: u64(rd, 48) };
  }
  async function zipEntryBlob(zipFile, entry) {
    if (entry.method !== 0 && entry.method !== 8) throw new Error('unsupported zip compression ' + entry.method);
    const head = await readBytes(zipFile.slice(entry.offset, entry.offset + 30));
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 30 || hv.getUint32(0, true) !== 0x04034b50) throw new Error('bad local zip header');
    const start = entry.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    const compressed = zipFile.slice(start, start + entry.compSize);
    if (entry.method === 0) return compressed;
    if (typeof DecompressionStream === 'undefined') throw new Error('deflate unsupported in this browser');
    const stream = compressed.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    if (typeof Response !== 'undefined') {
      try { return await new Response(stream).blob(); } catch (e) {}
    }
    const reader = stream.getReader();
    const chunks = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
    }
    return new Blob(chunks, { type: audioType(entry.name) });
  }
  async function parseZipEntries(zipFile) {
    const tailSize = Math.min(zipFile.size, 70000);
    const tail = await readBytes(zipFile.slice(zipFile.size - tailSize));
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let info = null;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) !== 0x06054b50) continue;
      if (i + 22 + dv.getUint16(i + 20, true) !== tail.length) continue;
      const count = dv.getUint16(i + 10, true);
      const cdSize = dv.getUint32(i + 12, true) >>> 0;
      const cdOffset = dv.getUint32(i + 16, true) >>> 0;
      info = (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
        ? await zip64Directory(zipFile, tail, i)
        : { count, cdSize, cdOffset };
      break;
    }
    if (!info) throw new Error('zip directory not found');
    if (info.cdOffset + info.cdSize > zipFile.size) throw new Error('zip directory out of range');
    const cd = await readBytes(zipFile.slice(info.cdOffset, info.cdOffset + info.cdSize));
    const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const entries = [];
    let off = 0;
    while (off + 46 <= cd.length) {
      if (view.getUint32(off, true) !== 0x02014b50) break;
      const flags = view.getUint16(off + 8, true);
      const method = view.getUint16(off + 10, true);
      const vals = {
        comp: view.getUint32(off + 20, true) >>> 0,
        uncomp: view.getUint32(off + 24, true) >>> 0,
        offset: view.getUint32(off + 42, true) >>> 0,
        disk: view.getUint16(off + 34, true),
      };
      const nameLen = view.getUint16(off + 28, true);
      const extraLen = view.getUint16(off + 30, true);
      const commentLen = view.getUint16(off + 32, true);
      const nameStart = off + 46;
      const extraStart = nameStart + nameLen;
      const name = decodeZipName(cd.slice(nameStart, extraStart));
      applyZip64(cd.slice(extraStart, extraStart + extraLen), vals);
      if (!name.endsWith('/') && !(flags & 1)) {
        const entry = { name, method, compSize: vals.comp, offset: vals.offset };
        entries.push({ name, size: vals.uncomp, blob: () => zipEntryBlob(zipFile, entry) });
      }
      off = extraStart + extraLen + commentLen;
    }
    return entries;
  }
  async function runZip(zipFile) {
    if (busy) return;
    let entries = null;
    try {
      entries = await parseZipEntries(zipFile);
    } catch (e) {
      console.warn('streaming zip read failed, falling back to JSZip', e);
      if (!window.JSZip) { App.toast('Could not read that zip file'); return; }
      try {
        const zip = await window.JSZip.loadAsync(zipFile);
        entries = Object.values(zip.files)
          .filter(f => !f.dir)
          .map(f => ({ name: f.name, blob: () => f.async('blob') }));
      } catch (e2) {
        console.warn('zip read failed', e2);
        App.toast('Could not read that zip file');
        return;
      }
    }
    entries = entries.filter(f => AUDIO_IN_ZIP.test(f.name));
    if (!entries.length) { App.toast('No audio files found in the zip'); return; }
    App.toast(`Unzipping ${entries.length} song${entries.length === 1 ? '' : 's'}…`);
    let bad = 0;
    async function* gen() {
      for (const e of entries) {
        try {
          const raw = await e.blob();
          const base = (e.name.split('/').pop() || 'track').trim() || 'track';
          // Snapshot normal-sized songs into their own bytes before saving.
          // A stored ZIP entry can start life as a slice into the 2.4 GB
          // archive; persisting that slice directly is fragile on iOS, so
          // the library gets a standalone file instead of a range reference.
          const part = raw.size <= 268435456 ? await raw.arrayBuffer() : raw;
          yield new File([part], base, { type: audioType(base) });
        } catch (err) {
          // One corrupt entry must not kill the other songs in a big archive.
          console.warn('zip entry unreadable, skipping:', e.name, err);
          bad++;
        }
      }
    }
    await run(gen(), entries.length, { skipExisting: true });
    if (bad) App.toast(`${bad} file${bad === 1 ? '' : 's'} in the zip were unreadable and skipped`);
  }

  function bind() {
    picker().addEventListener('change', e => run([...e.target.files]));
    zippicker().addEventListener('change', e => { const f = e.target.files[0]; zippicker().value = ''; if (f) runZip(f); });
  }
  async function persistFix(id, tr) {
    await DB.updateTrack(id, {
      title: tr.title, artist: tr.artist, album: tr.album, albumArtist: tr.albumArtist,
      genre: tr.genre, year: tr.year, trackNo: tr.trackNo, discNo: tr.discNo,
      art: tr.art, tagged: tr.tagged, tagsVia: tr.tagsVia, diag: tr.diag,
      // Winning artwork source (v7.7): only written when present, so a
      // fixer pass never clears it with an undefined write.
      ...(tr.artSource !== undefined ? { artSource: tr.artSource } : {}),
      // Hand-set artwork flag: only written when explicitly present, so a
      // fixer pass never accidentally clears it with an undefined write.
      ...(tr.artManual !== undefined ? { artManual: tr.artManual } : {}),
    });
  }
  // Manual album fix: look up the whole album, apply proper tags + track order.
  const compact = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Title matching: normalized compare, plus a spaceless compare so glued
  // filenames ("Retardedfeatvesson") match spaced catalog titles.
  function titleMatches(a, b, exactOnly) {
    const nt = norm(a), rt = norm(b);
    if (!exactOnly && (rt === nt || rt.indexOf(nt) !== -1 || nt.indexOf(rt) !== -1)) return true;
    const cn = compact(a), ct = compact(b);
    if (!cn || !ct) return false;
    if (exactOnly) return ct === cn;
    return cn.length >= 6 && ct.length >= 6 && (ct === cn || ct.indexOf(cn) !== -1 || cn.indexOf(ct) !== -1);
  }
  const listingCache = new Map();
  // Fetch a full track listing straight from a collection id (lookup is not
  // subject to the search index's quirks).
  async function listingFromCollectionId(colId, skipArt) {
    try {
      const ld = await fetchJSON('https://itunes.apple.com/lookup?id=' + colId + '&entity=song&limit=200', 12000);
      if (!ld || !ld.results) return null;
      const col = ld.results.find(r => r.wrapperType === 'collection') || {};
      const songs = ld.results.filter(r => r.wrapperType === 'track');
      if (!songs.length) return null;
      // v7.7: 1200px (was 600). v8.1: art fetch is lazy for candidate
      // listings — most are only ever matched against, never displayed.
      const artUrl = (col.artworkUrl100 || '').replace('100x100bb', '1200x1200bb') || null;
      let art = null;
      if (artUrl && !skipArt) art = await fetchArtBlob(artUrl);
      return { col, songs, art, artUrl, artFetched: !skipArt };
    } catch (e) { return null; }
  }
  // Blob-first artwork fetch with URL fallback (v7.4 pattern), shared.
  async function fetchArtBlob(au) {
    try {
      const c = new AbortController(); const tm = setTimeout(() => c.abort(), 6000);
      const rr = await fetch(au, { signal: c.signal }); clearTimeout(tm);
      if (rr.ok) { const b = await rr.blob(); if (b && b.size > 1000) return b; }
    } catch (e) {}
    return au || null; // URL string still displays if the download flaked
  }
  // Fetch a listing's artwork on demand (for alt listings that skipped it).
  async function ensureListingArt(l) {
    if (!l || l.artFetched) return l ? l.art : null;
    l.artFetched = true;
    if (l.artUrl && !l.art) l.art = await fetchArtBlob(l.artUrl);
    return l.art;
  }
  // Resolve an album to its Apple Music track listing (cached per run).
  // Find the album via a song search (entity=album search is unreliable); the
  // song result carries the collectionId, then lookup?id=&entity=song lists it.
  async function albumTrackListing(albumName, artistName) {
    const ck = (artistName || '') + '|||' + albumName;
    if (listingCache.has(ck)) return listingCache.get(ck);
    let out = null;
    try {
      const q = (artistName ? artistName + ' ' : '') + albumName;
      const sd = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&entity=song&limit=10', 12000);
      if (sd && sd.resultCount) {
        const na = norm(albumName), nar = norm(artistName);
        let colId = 0;
        for (const r of sd.results) {
          const rn = norm(r.collectionName), ra = norm(r.artistName);
          const nameOK = rn === na || rn.indexOf(na) !== -1 || na.indexOf(rn) !== -1;
          const artOK = !nar || ra === nar || ra.indexOf(nar) !== -1 || nar.indexOf(ra) !== -1;
          if (r.collectionId && nameOK && artOK) { colId = r.collectionId; break; }
        }
        if (colId) out = await listingFromCollectionId(colId);
      }
    } catch (e) {}
    listingCache.set(ck, out);
    return out;
  }
  // Gather candidate album listings from every angle that avoids the flaky
  // text search: named albums resolve by id lookup, and known artists expand
  // to their full catalogs (every collection id found under the artist name),
  // which surfaces even tracks the search index suppresses.
  // v8.1: artist -> [listings], shared across album clusters in a run.
  const artistListingsCache = new Map();
  async function candidateListings(seedAlbums, seedArtists) {
    const out = [];
    const seenCol = new Set();
    const push = l => {
      const id = l && l.col && l.col.collectionId;
      if (l && id && !seenCol.has(id)) { seenCol.add(id); out.push(l); }
    };
    for (const a of (seedAlbums || [])) {
      if (!a || !a.name || a.name === 'Unknown Album') continue;
      push(await albumTrackListing(a.name, a.artist));
    }
    for (const ar of (seedArtists || [])) {
      if (!ar || ar === 'Unknown Artist') continue;
      // v8.1: cross-cluster cache — the full-library pass used to re-fetch
      // the same artist catalogs once per album cluster.
      if (artistListingsCache.has(ar)) { artistListingsCache.get(ar).forEach(push); continue; }
      const got = [];
      try {
        const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(ar) + '&entity=song&limit=200', 12000);
        if (d && d.resultCount) {
          const nar = norm(ar);
          const mine = d.results.filter(r => {
            const ra = norm(r.artistName);
            return ra === nar || ra.indexOf(nar) !== -1 || nar.indexOf(ra) !== -1;
          });
          const ids = [...new Set(mine.map(r => r.collectionId).filter(Boolean))].slice(0, 6);
          for (const id of ids) {
            const l = await listingFromCollectionId(id, true); // art lazy
            if (l && l.col && l.col.collectionId && !seenCol.has(l.col.collectionId)) { seenCol.add(l.col.collectionId); out.push(l); got.push(l); }
          }
        }
      } catch (e) {}
      artistListingsCache.set(ar, got);
    }
    // Full albums before single releases: a track on both gets album tagging.
    out.sort((a, b) => b.songs.length - a.songs.length);
    return out;
  }
  function matchListingTitle(title, songs, used, exactOnly) {
    for (const s of songs) {
      if (used.has(s.trackId)) continue;
      if (titleMatches(title, s.trackName, exactOnly)) { used.add(s.trackId); return s; }
    }
    return null;
  }
  // Singles shelf: Skyler's real discography, bundled in js/discography.json
  // (pulled from his Spotify artist page — Apple Music's catalog was missing
  // most of his singles). A local track appears under a single when its title
  // resembles the single's track title and the 8s duration veto passes.
  // Callers must run this after titles are fixed.
  let discoCache = null, discoOrderMap = null, discoArtMap = null, discoData = null;
  async function loadDiscography() {
    if (!discoCache) discoCache = fetch('js/discography.json')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        discoOrderMap = {};
        discoArtMap = {};
        ((d && d.singles) || []).forEach((s, i) => {
          discoOrderMap[s.name] = i;
          if (s.art) discoArtMap[s.name] = s.art;
        });
        discoData = d;
        return d;
      })
      .catch(() => null);
    return discoCache;
  }
  // Bundled cover path for a single release (e.g. 'js/disco-art/Harlot.jpg'),
  // or null. The singles' real Spotify covers live in the app bundle; the
  // album's rose is never used for a single.
  function singleArt(name) {
    return (discoArtMap && discoArtMap[name]) || null;
  }
  // Sync lookup of his bundled single art by song title (for the artwork
  // fallback and his-song repair). Null until the discography has loaded.
  function mySingleArt(title) {
    if (!discoData || !title) return null;
    for (const s of (discoData.singles || [])) {
      for (const st of (s.tracks || [])) {
        if (titleSimilar(title, st.title)) return singleArt(s.name);
      }
    }
    return null;
  }
  // Best discography single/track for one of his songs (ordinal hint from
  // the file name, duration tiebreak). Null when nothing matches.
  function matchMySingle(t, disco) {
    if (!disco || !disco.singles) return null;
    const bySingle = new Map();
    for (const s of disco.singles) {
      (s.tracks || []).forEach((st, idx) => {
        if (!titleSimilar(t.title, st.title)) return;
        if (!bySingle.has(s.name)) bySingle.set(s.name, { s, cands: [] });
        bySingle.get(s.name).cands.push({ st, idx });
      });
    }
    if (!bySingle.size) return null;
    const { s, cands } = bySingle.values().next().value;
    const tracks = s.tracks || [];
    let pick = cands[0];
    // "TimeBSideSkylerGreen" resembles "Time" but means "Time II": an
    // a-side/b-side (or part 1/2) hint names the position in the single.
    const hint = ordinalHint(t.fileName || t.title);
    if (hint != null && hint < tracks.length) {
      pick = { st: tracks[hint], idx: hint };
    } else if (cands.length > 1) {
      const dur = t.duration || 0;
      let best = null, bestD = 61;
      for (const c of cands) {
        const sd = (c.st.duration_ms || 0) / 1000;
        const d = dur > 0 && sd > 0 ? Math.abs(dur - sd) : 61;
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best) pick = best;
    }
    return { s, st: pick.st, idx: pick.idx };
  }
  // Does the named artist's catalog actually contain this title? Tells his
  // mislabeled songs apart from genuinely other-artist songs.
  async function artistHasSong(artist, title) {
    try {
      if (!artist || !title || title === 'Unknown Title') return false;
      const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(artist + ' ' + title) + '&media=music&entity=song&limit=8', 12000);
      if (!d || !d.resultCount) return false;
      for (const r of d.results) {
        if (strSim(r.trackName, title) * 0.6 + strSim(r.artistName, artist) * 0.4 >= 0.8) return true;
      }
    } catch (e) {}
    return false;
  }
  // Is this a real catalog artist at all? An unknown-to-Apple artist proves
  // nothing either way, so the ambiguous-claim below requires a known one.
  async function artistKnown(artist) {
    try {
      if (!artist || artist === 'Unknown Artist') return false;
      const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(artist) + '&media=music&entity=musicArtist&limit=5', 12000);
      if (!d || !d.resultCount) return false;
      for (const r of d.results) {
        if (strSim(r.artistName || '', artist) >= 0.8) return true;
      }
    } catch (e) {}
    return false;
  }
  // His album cover ("I Left The Roses Out Too Long"): every one of his
  // album tracks wears it, like Spotify.
  const MY_ALBUM_ART = 'js/disco-art/roses-album.jpg';
  // His songs, fully repaired from the bundled discography (ground truth —
  // the store catalogs never carry his unreleased music, and must not get
  // a chance to misidentify them). Repairs tags AND artwork, even when a
  // wrong cover is already present. Never touches hand-set artwork.
  // Returns a fixTrack-style result, or null when this isn't his song.
  // His album on Apple Music, cached per run. The song search inside
  // albumTrackListing is the reliable path (entity=album search is flaky).
  let myAlbumListingCache = 'pending';
  async function myAlbumListing() {
    if (myAlbumListingCache === 'pending') {
      try { myAlbumListingCache = await albumTrackListing('I Left The Roses Out Too Long', 'Skyler Green'); }
      catch (e) { myAlbumListingCache = null; }
    }
    return myAlbumListingCache;
  }
  // His music, repaired from Apple Music (his album is on all platforms, so
  // the catalog path recognizes it like any other artist's) and the bundled
  // discography (for singles Apple lacks). Returns null when this isn't his
  // song; {done:true} when fully handled; {done:false} when the artist was
  // repaired but the normal Apple song search should take it from here.
  async function fixMyTrack(t) {
    const disco = await loadDiscography();
    const artistName = (disco && disco.artist) || 'Skyler Green';
    const a = norm(t.artist || '');
    const saysHim = a.indexOf('skyler green') !== -1;
    const noArtist = !a || a === 'unknown artist';
    const ms = matchMySingle(t, disco);
    let mine = saysHim || (noArtist && !!ms);
    if (!mine && ms && a) {
      // Title matches his discography but the artist tag names someone else
      // (a past fixer run mislabeled some of his songs as d4vd). Claim it
      // only when the named artist is catalog-known yet has no such song —
      // an obscure artist proves nothing either way, so those stay manual.
      try { mine = (await artistKnown(t.artist)) && !(await artistHasSong(t.artist, t.title)); } catch (e) {}
    }
    if (!mine && !ms && a) {
      // Not a single title — maybe an album track with a mangled artist.
      // The file name is free evidence; Apple confirms before claiming.
      const fn = (t.fileName || '').toLowerCase();
      if (fn.indexOf('skyler') !== -1) {
        try { mine = await artistHasSong('Skyler Green', t.title); } catch (e) {}
      }
    }
    if (!mine) return null;
    const tr = { ...t };
    const notes = [];
    const saveMy = async () => {
      tr.tagged = true;
      await persistFix(t.id, tr);
      Object.assign(t, {
        title: tr.title, artist: tr.artist, album: tr.album, albumArtist: tr.albumArtist,
        genre: tr.genre, year: tr.year, trackNo: tr.trackNo, discNo: tr.discNo,
        art: tr.art, tagged: tr.tagged, tagsVia: tr.tagsVia,
        ...(tr.artSource !== undefined ? { artSource: tr.artSource } : {}),
      });
    };
    // The artist is always his.
    if (tr.artist !== artistName) { notes.push('Artist: ' + (tr.artist || '—') + ' → ' + artistName); tr.artist = artistName; }
    tr.albumArtist = artistName;
    // 1. His Apple Music album: match by title against the real 12-track
    //    listing. This pulls stolen album tracks back home and tags
    //    everything (title/album/track#/year/art) from Apple data.
    try {
      const listing = await myAlbumListing();
      if (listing) {
        const m = matchTrackMulti(tr, listing.songs, new Set());
        if (m) {
          const changed = applyListing(tr, m, listing.col, listing.art || MY_ALBUM_ART);
          if (!listing.art) tr.artSource = 'bundled'; // his rose, not Apple's
          await saveMy();
          const didChange = changed || notes.length > 0;
          if (didChange) notes.push('matched Apple Music album');
          return { done: true, mine: true, fixed: didChange ? 1 : 0, note: notes.join('; ') };
        }
      }
    } catch (e) {}
    // 2. His singles (not on the album): tag the single, but ONLY when the
    //    album tag is missing — never steal a real album tag.
    if (ms && (!tr.album || tr.album === 'Unknown Album')) {
      if (tr.title !== ms.st.title) { notes.push('Title: ' + (tr.title || '—') + ' → ' + ms.st.title); tr.title = ms.st.title; }
      notes.push('Album: ' + (tr.album || '—') + ' → ' + ms.s.name);
      tr.album = ms.s.name;
      if (!tr.year) tr.year = (ms.s.date || '').slice(0, 4) || tr.year;
      tr.trackNo = ms.idx + 1; tr.discNo = 1;
      if (!tr.artManual) {
        const want = singleArt(ms.s.name);
        if (want && tr.art !== want) { tr.art = want; tr.artSource = 'bundled'; notes.push('artwork restored'); }
      }
      tr.tagsVia = 'Spotify';
      await saveMy();
      return { done: true, mine: true, fixed: 1, note: notes.join('; ') };
    }
    // 3. Single art fill for his single-titled tracks that already have a
    //    real album tag (nothing else to do here).
    if (ms && !tr.art && !tr.artManual) {
      const want = singleArt(ms.s.name);
      if (want) { tr.art = want; tr.artSource = 'bundled'; notes.push('artwork restored'); }
    }
    if (notes.length) {
      tr.tagsVia = tr.tagsVia || 'Spotify';
      await saveMy();
    }
    // Not fully handled: the normal Apple song search takes it from here
    // (with the now-correct artist, Apple recognizes his released music).
    return { done: false, mine: true, note: notes.join('; ') };
  }
  // Newest-first position of a single release (for shelf ordering); unknown
  // names sort last.
  function singleOrder(name) {
    return (discoOrderMap && discoOrderMap[name] != null) ? discoOrderMap[name] : 1e9;
  }
  function singleHitsFor(t, disco) {
    const hits = [];
    for (const s of ((disco && disco.singles) || [])) {
      for (const st of (s.tracks || [])) {
        // No duration veto here: the discography holds his own song titles, so
        // resemblance is high-precision, and his local versions may run longer
        // or shorter than the Spotify masters. (The 8s veto stays on the
        // Apple-catalog path, where the false-positive class was observed.)
        if (titleSimilar(t.title, st.title)) { if (!hits.includes(s.name)) hits.push(s.name); break; }
      }
    }
    return hits;
  }
  // Ordinal hint from a filename or title: a-side -> 0, b-side -> 1, part
  // 1/2, trailing 1/2 or i/ii. Null when there is no hint.
  function ordinalHint(name) {
    const c = compact(name || '');
    if (c.indexOf('bside') !== -1) return 1;
    if (c.indexOf('aside') !== -1) return 0;
    const n = ' ' + norm(name) + ' ';
    const m = n.match(/\b(?:part|pt|disc)\s*([12])\b/) || n.match(/\b([12]|i|ii)\s*$/);
    if (m) return (m[1] === '1' || m[1] === 'i') ? 0 : 1;
    return null;
  }
  // Match leftover tracks against the bundled Spotify discography. Apple Music
  // doesn't carry some of his singles (Harlot, Time, Time II), so the catalog
  // passes above can never tag them. Applies the disco title, his artist name,
  // and the single name as the album. Returns the number of tracks fixed.
  async function discoFixTracks(leftovers) {
    const disco = await loadDiscography();
    if (!disco || !disco.singles || !disco.singles.length) return 0;
    const artist = disco.artist || 'Skyler Green';
    let fixed = 0;
    for (let i = leftovers.length - 1; i >= 0; i--) {
      const t = leftovers[i];
      const m = matchMySingle(t, disco);
      if (!m) continue;
      const { s } = m, pick = { st: m.st, idx: m.idx };
      const tr = { ...t };
      const before = [tr.title, tr.artist, tr.album, tr.albumArtist, tr.trackNo].join('|');
      tr.title = pick.st.title || tr.title;
      tr.artist = artist;
      tr.album = s.name;
      tr.albumArtist = artist;
      tr.trackNo = pick.idx + 1;
      tr.discNo = 1;
      tr.year = (s.date || '').slice(0, 4) || tr.year;
      tr.tagged = true;
      tr.tagsVia = 'Spotify';
      const changed = before !== [tr.title, tr.artist, tr.album, tr.albumArtist, tr.trackNo].join('|');
      // Single-only tracks carry no embedded art and Apple doesn't list
      // them, so they reference their single's real bundled cover by path.
      // A plain path (not a Blob) sidesteps the fetch->blob->IndexedDB
      // round-trip that produced the broken-image art in v2.1. The album's
      // rose is never used here: it belongs to the album alone.
      let artSet = false;
      if (!tr.art && !tr.artManual) {
        const p = singleArt(s.name);
        if (p) { tr.art = p; tr.artSource = 'bundled'; artSet = true; }
      }
      try {
        await persistFix(t.id, tr);
        Object.assign(t, {
          title: tr.title, artist: tr.artist, album: tr.album, albumArtist: tr.albumArtist,
          genre: tr.genre, year: tr.year, trackNo: tr.trackNo, discNo: tr.discNo,
          art: tr.art, tagged: tr.tagged, tagsVia: tr.tagsVia, diag: tr.diag,
          ...(tr.artSource !== undefined ? { artSource: tr.artSource } : {}),
        });
        if (changed || artSet) fixed++;
      } catch (e) {}
      leftovers.splice(i, 1);
    }
    return fixed;
  }
  // MusicBrainz fallback: the largest open music database (what the Picard
  // tagger uses). Consulted for tracks Apple Music can't identify. Free, no
  // API key — politeness is 1 request/sec, enforced below, with an in-memory
  // cache so a repeated title/artist costs nothing.
  const mbCache = new Map();
  let mbLastReq = 0;
  // v7.8: strict 1/sec pacing, serialized across concurrent callers (the
  // parallel fix pool). Each call waits for the previous call's slot, so
  // MusicBrainz never sees concurrent requests no matter the pool size.
  let mbPace = Promise.resolve();
  async function mbSearchRecording(title, artist) {
    const key = norm(title) + '|||' + norm(artist);
    if (mbCache.has(key)) return mbCache.get(key);
    let release;
    const slot = new Promise(res => { release = res; });
    const prev = mbPace;
    mbPace = slot;
    await prev;
    try {
      return await mbSearchRecordingInner(title, artist);
    } finally {
      release();
    }
  }
  async function mbSearchRecordingInner(title, artist) {
    const key = norm(title) + '|||' + norm(artist);
    if (mbCache.has(key)) return mbCache.get(key); // re-check after the wait
    // v7.0: 1 req/sec politeness + 503 backoff (up to 3 tries). Failures are
    // never cached — a throttled lookup must not poison later tracks.
    let out = null, backoff = 2000;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = 1100 - (Date.now() - mbLastReq);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      mbLastReq = Date.now();
      try {
        let q = 'recording:"' + String(title || '').replace(/"/g, '') + '"';
        if (artist && artist !== 'Unknown Artist') q += ' AND artist:"' + String(artist).replace(/"/g, '') + '"';
        const c = new AbortController(); const t = setTimeout(() => c.abort(), 15000);
        const r = await fetch('https://musicbrainz.org/ws/2/recording/?query=' + encodeURIComponent(q) + '&fmt=json&limit=8', {
          signal: c.signal, headers: { 'User-Agent': 'Splotify/7.0 (personal music library)' },
        });
        clearTimeout(t);
        if (r.status === 503) { await new Promise(rr => setTimeout(rr, backoff)); backoff *= 2; continue; }
        if (r.ok) {
          const d = await r.json();
          out = (d.recordings || []).filter(x => x && (x.score || 0) >= 60);
        }
        break;
      } catch (e) { break; /* offline: skip */ }
    }
    if (out) mbCache.set(key, out);
    return out;
  }
  function mbPick(recs, t) {
    if (!recs || !recs.length) return null;
    const dur = t.duration || 0;
    let best = null, bestScore = -1;
    for (const rec of recs) {
      if (!titleSimilar(t.title, rec.title) && (rec.score || 0) < 85) continue;
      let s = rec.score || 0;
      const rlen = rec.length || 0;
      if (dur > 0 && rlen > 0) {
        const d = Math.abs(dur - rlen / 1000);
        if (d > 20) continue;
        s += 20 - d;
      }
      if (s > bestScore) { bestScore = s; best = rec; }
    }
    return best;
  }
  async function mbFixTracks(leftovers) {
    let fixed = 0, matched = 0;
    for (let i = leftovers.length - 1; i >= 0; i--) {
      const t = leftovers[i];
      if (!t.title || t.title === 'Unknown Title') continue;
      let recs = null;
      try { recs = await mbSearchRecording(t.title, t.artist); } catch (e) { continue; }
      const pick = mbPick(recs, t);
      if (!pick) continue;
      matched++;
      const tr = { ...t };
      const before = [tr.title, tr.artist, tr.album, tr.albumArtist].join('|');
      tr.title = pick.title || tr.title;
      const mbArtist = (pick['artist-credit'] || []).map(a => (a.name || '') + (a.joinphrase || '')).join('').trim();
      if (mbArtist) tr.artist = mbArtist;
      const rel = (pick.releases || [])[0];
      if (rel && rel.title) tr.album = rel.title;
      if (!tr.albumArtist || tr.albumArtist === 'Unknown Artist') tr.albumArtist = tr.artist;
      tr.tagged = true;
      tr.tagsVia = 'MusicBrainz';
      const changed = before !== [tr.title, tr.artist, tr.album, tr.albumArtist].join('|');
      try {
        await persistFix(t.id, tr);
        Object.assign(t, {
          title: tr.title, artist: tr.artist, album: tr.album, albumArtist: tr.albumArtist,
          genre: tr.genre, year: tr.year, trackNo: tr.trackNo, discNo: tr.discNo,
          art: tr.art, tagged: tr.tagged, tagsVia: tr.tagsVia,
        });
        if (changed) fixed++;
      } catch (e) {}
      leftovers.splice(i, 1);
    }
    return { fixed, matched };
  }
  /* v7.0 correction audit: identify AND correct wrong tags, not just fill
     gaps. Sources in order: artist roster, Apple Music, MusicBrainz, his
     discography. Confident proposals auto-apply; uncertain ones return in
     the review queue for the user to approve. */
  function strSim(a, b) {
    a = (a || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    b = (b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!a || !b) return 0;
    if (a === b) return 1;
    const la = a.length, lb = b.length;
    let prev = new Array(lb + 1), cur = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= lb; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
      const t = prev; prev = cur; cur = t;
    }
    return 1 - prev[lb] / Math.max(la, lb);
  }
  // Roster pass: the canonical artist list corrects misspelled artist tags.
  function rosterProposal(t, roster) {
    const ta = (t.artist || '').trim();
    if (!ta || ta === 'Unknown Artist') return null;
    const nta = ta.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const r of roster) {
      if ((r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === nta) return null; // already canonical
    }
    let best = null, bestSim = 0;
    for (const r of roster) {
      const s = strSim(r.name, ta);
      if (s > bestSim) { bestSim = s; best = r; }
    }
    if (best && bestSim >= 0.8 && bestSim < 1) {
      return { field: 'artist', from: ta, to: best.name, confidence: 0.5 + bestSim * 0.45, source: 'artist roster' };
    }
    return null;
  }
  // Apple pass: search the catalog; when it confidently identifies the song
  // but our tags differ, propose the correction. Returns {proposals, verified}:
  // verified means Apple confidently identified the song even if nothing
  // needed changing (so callers can skip slower sources).
  // v7.8: tag query first, then every scored filename candidate (best
  // first, reversed included — the gates compare each catalog hit against
  // its own query text, so a wrong-order candidate can't propose bogus
  // corrections). Candidates always carry both artist and title (v7.2 rule).
  // 'Unknown Artist' is cleaned to '' so the title-only path (stricter bar,
  // never-auto album cap) works as designed instead of being poisoned.
  function auditQueries(t) {
    const queries = [];
    const tagQ = ((t.artist && t.artist !== 'Unknown Artist') ? t.artist + ' ' : '') + (t.title || '');
    if (tagQ.trim()) queries.push({ qs: tagQ.trim(), a: (t.artist && t.artist !== 'Unknown Artist') ? t.artist : '', t: t.title || '' });
    try {
      const pc = fileNameCandidates(t.fileName || '', t.filePath || '', { artist: t.artist, title: t.title });
      for (const c of pc.list.slice(0, 4)) {
        const qs = (c.artist + ' ' + c.title).trim();
        if (qs && !queries.some(q => q.qs === qs)) queries.push({ qs, a: c.artist, t: c.title });
      }
    } catch (e) {}
    return queries;
  }
  async function appleAudit(t) {
    const queries = auditQueries(t);
    for (const qq of queries) {
      try {
        const r = await appleAuditQuery(qq, t);
        if (r && (r.proposals.length || r.verified)) return r;
      } catch (e) {}
    }
    return { proposals: [], verified: false };
  }
  async function appleAuditQueryUngated(qq, t) {
    const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(qq.qs) + '&media=music&entity=song&limit=8', 12000);
    if (!d || !d.resultCount) return null;
    let best = null, bestScore = 0;
    for (const r of d.results) {
      const ts = strSim(r.trackName, qq.t);
      const as = strSim(r.artistName, qq.a);
      // Title-only query (no artist): score on the title alone, stricter bar.
      const score = qq.a ? ts * 0.6 + as * 0.4 : ts;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    const threshold = qq.a ? 0.75 : 0.85;
    if (!best || bestScore < threshold) return null;
    const out = [];
    const conf = 0.55 + bestScore * 0.4; // 0.85..0.95 at high similarity
    // Gates compare the catalog hit against the QUERY's title/artist (which
    // is what actually matched), not the current tags — so a filename query
    // can correct fully-mangled tags, while a mere qualifier difference
    // ("(Sped Up)") never triggers a rewrite.
    if (strSim(best.trackName, qq.t) >= 0.9 && best.trackName !== t.title && norm(best.trackName) !== norm(t.title)) {
      out.push({ field: 'title', from: t.title, to: best.trackName, confidence: Math.min(conf, 0.92), source: 'Apple Music' });
    }
    if (qq.a && strSim(best.artistName, qq.a) >= 0.85 && best.artistName !== t.artist && norm(best.artistName) !== norm(t.artist)) {
      out.push({ field: 'artist', from: t.artist, to: best.artistName, confidence: Math.min(conf, 0.9), source: 'Apple Music' });
    }
    if (best.collectionName && best.collectionName !== t.album && norm(best.collectionName) !== norm(t.album || '') && strSim(best.trackName, qq.t) >= 0.9) {
      // Title-only matches can't tell which artist's song this is, so an
      // album change from one always goes to review, never auto-applies.
      // (Explicit flag now — v7.8's adaptive thresholds could otherwise
      // auto-apply it. This is a safety rule, not a threshold.)
      const albumConf = qq.a ? Math.min(conf - 0.05, 0.88) : Math.min(conf - 0.05, 0.87);
      out.push({ field: 'album', from: t.album || 'Unknown Album', to: best.collectionName, confidence: albumConf, source: 'Apple Music', ...(qq.a ? {} : { titleOnlyAlbum: true }) });
    }
    return { proposals: out, verified: bestScore >= (qq.a ? 0.85 : 0.92) };
  }
  // Back-compat: anything still calling appleProposal gets the proposals.
  async function appleProposal(t) { const r = await appleAudit(t); return r.proposals; }
  // Deezer pass: second catalog in the fallback chain. Free, no key, and it
  // carries artwork (cover_xl) — consulted when Apple Music doesn't
  // recognize the song. Same scoring and gates as the Apple pass.
  async function deezerAudit(t) {
    const queries = auditQueries(t);
    for (const qq of queries) {
      try {
        const r = await deezerAuditQuery(qq, t);
        if (r && (r.proposals.length || r.verified)) return r;
      } catch (e) {}
    }
    return { proposals: [], verified: false };
  }
  async function deezerAuditQueryUngated(qq, t) {
    const d = await fetchJSON('https://api.deezer.com/search?q=' + encodeURIComponent(qq.qs) + '&limit=8', 12000);
    if (!d || !d.total || !d.data || !d.data.length) return null;
    let best = null, bestScore = 0;
    for (const r of d.data) {
      const ts = strSim(r.title || '', qq.t);
      const as = strSim((r.artist && r.artist.name) || '', qq.a);
      const score = qq.a ? ts * 0.6 + as * 0.4 : ts;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    const threshold = qq.a ? 0.75 : 0.85;
    if (!best || bestScore < threshold) return null;
    const out = [];
    const conf = 0.55 + bestScore * 0.4; // 0.85..0.95 at high similarity
    const bTitle = best.title || '', bArtist = (best.artist && best.artist.name) || '';
    const bAlbum = (best.album && best.album.title) || '';
    if (strSim(bTitle, qq.t) >= 0.9 && bTitle !== t.title && norm(bTitle) !== norm(t.title)) {
      out.push({ field: 'title', from: t.title, to: bTitle, confidence: Math.min(conf, 0.92), source: 'Deezer' });
    }
    if (qq.a && strSim(bArtist, qq.a) >= 0.85 && bArtist !== t.artist && norm(bArtist) !== norm(t.artist)) {
      out.push({ field: 'artist', from: t.artist, to: bArtist, confidence: Math.min(conf, 0.9), source: 'Deezer' });
    }
    if (bAlbum && bAlbum !== t.album && norm(bAlbum) !== norm(t.album || '') && strSim(bTitle, qq.t) >= 0.9) {
      // Same title-only album safety rule as the Apple pass (explicit flag —
      // v7.8's adaptive thresholds could otherwise auto-apply it).
      const albumConf = qq.a ? Math.min(conf - 0.05, 0.88) : Math.min(conf - 0.05, 0.87);
      out.push({ field: 'album', from: t.album || 'Unknown Album', to: bAlbum, confidence: albumConf, source: 'Deezer', ...(qq.a ? {} : { titleOnlyAlbum: true }) });
    }
    return { proposals: out, verified: bestScore >= (qq.a ? 0.85 : 0.92) };
  }
  // MusicBrainz pass (rate-limited): same idea, open database.
  async function mbProposal(t) {
    let recs = null;
    try { recs = await mbSearchRecording(t.title, t.artist); } catch (e) { return []; }
    const pick = mbPick(recs, t);
    if (!pick) return [];
    const out = [];
    const mbArtist = (pick['artist-credit'] || []).map(a => (a.name || '') + (a.joinphrase || '')).join('').trim();
    const ts = strSim(pick.title, t.title), as = mbArtist ? strSim(mbArtist, t.artist) : 0;
    if (ts < 0.8 || (mbArtist && as < 0.7)) return [];
    const conf = 0.5 + (ts * 0.6 + as * 0.4) * 0.35; // caps ~0.85 → review tier
    if (pick.title && pick.title !== t.title && norm(pick.title) !== norm(t.title) && ts >= 0.9) {
      out.push({ field: 'title', from: t.title, to: pick.title, confidence: conf, source: 'MusicBrainz' });
    }
    if (mbArtist && mbArtist !== t.artist && norm(mbArtist) !== norm(t.artist) && as >= 0.85) {
      out.push({ field: 'artist', from: t.artist, to: mbArtist, confidence: conf, source: 'MusicBrainz' });
    }
    const rel = (pick.releases || [])[0];
    if (rel && rel.title && rel.title !== t.album && norm(rel.title) !== norm(t.album || '') && ts >= 0.9) {
      out.push({ field: 'album', from: t.album || 'Unknown Album', to: rel.title, confidence: conf - 0.05, source: 'MusicBrainz' });
    }
    return out;
  }
  // Tag memory (v7.6): remembers corrections the fixer got right — auto-
  // applied, review-approved, or hand-edited — so the next run just knows.
  // Two keys per fix: the file itself (survives re-tagging) and the
  // broken-tags fingerprint (catches a different rip of the same song with
  // the same mangled tags). Lives in the tagMemory store (DB v3).
  function memKeyFile(t) { return 'f:' + (t.fileName || '') + '::' + (t.fileSize || 0); }
  function memKeyTags(title, artist, album) {
    return 't:' + norm(title || '') + '|' + norm(artist || '') + '|' + norm(album || '');
  }
  function memFixOf(t) {
    return {
      title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist,
      genre: t.genre, year: t.year, trackNo: t.trackNo, discNo: t.discNo, art: t.art,
    };
  }
  async function learnFix(before, after) {
    try {
      const fix = memFixOf(after), b = memFixOf(before);
      const changed = ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNo', 'discNo', 'art']
        .some(k => String(fix[k] == null ? '' : fix[k]) !== String(b[k] == null ? '' : b[k]));
      if (!changed) return;
      const rec = { fix, learnedAt: Date.now() };
      await DB.memPut({ key: memKeyFile(after), ...rec });
      const brokenKey = memKeyTags(b.title, b.artist, b.album);
      if (brokenKey !== memKeyTags(fix.title, fix.artist, fix.album)) {
        await DB.memPut({ key: brokenKey, ...rec });
      }
    } catch (e) {}
  }
  async function recallFix(t) {
    try {
      let rec = await DB.memGet(memKeyFile(t));
      if (!rec) rec = await DB.memGet(memKeyTags(t.title, t.artist, t.album));
      return (rec && rec.fix) || null;
    } catch (e) { return null; }
  }
  async function memCount() {
    try { return await DB.memCount(); } catch (e) { return 0; }
  }
  // Apply a remembered fix. Never overwrites hand-set artwork with a
  // remembered one — a newer hand-set always wins. Returns true on change.
  async function applyMemFix(t, fix) {
    const tr = { ...t };
    let changed = false;
    for (const k of ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNo', 'discNo']) {
      if (fix[k] !== undefined && fix[k] !== null && fix[k] !== '' && tr[k] !== fix[k]) { tr[k] = fix[k]; changed = true; }
    }
    if (fix.art !== undefined && !tr.artManual && tr.art !== fix.art) { tr.art = fix.art; changed = true; }
    if (!changed) return false;
    tr.tagged = true;
    tr.tagsVia = (tr.tagsVia ? tr.tagsVia + '+' : '') + 'memory';
    await persistFix(t.id, tr);
    Object.assign(t, {
      title: tr.title, artist: tr.artist, album: tr.album, albumArtist: tr.albumArtist,
      genre: tr.genre, year: tr.year, trackNo: tr.trackNo, discNo: tr.discNo,
      art: tr.art, tagged: tr.tagged, tagsVia: tr.tagsVia,
      ...(tr.artSource !== undefined ? { artSource: tr.artSource } : {}),
    });
    return true;
  }
  // v7.9: acoustic fingerprinting, the last-resort ID for tracks the
  // catalog chain can't recognize (the "No match" tier). The fingerprint
  // is computed on-device from the audio (vendored chromaprint wasm,
  // js/vendor/ — audio never leaves the phone); only the fingerprint +
  // duration go to AcoustID for lookup.
  //
  // KEY HANDLING (fanart.tv pattern): the AcoustID client key lives
  // device-local only — Settings > Metadata input -> DB.kvGet/kvSet
  // ('acoustidKey'). Never hardcoded, never committed, never in chat.
  // With no key set, fingerprinting is skipped silently and the track
  // stays "No match" exactly as before.
  //
  // Safety: fixMyTrack runs first, and looksLikeHis() below is a
  // belt-and-braces guard — his songs (including unreleased ones,
  // which AcoustID could never know) never get fingerprinted. A false
  // match there would be a corruption bug, not a miss.
  async function acoustidLookupUngated(fp, durSec) {
    let key = null;
    try { key = await DB.kvGet('acoustidKey', null); } catch (e) {}
    if (!key) return null;
    // POST: long fingerprints choke GET URLs.
    const body = 'client=' + encodeURIComponent(key) +
      '&fingerprint=' + encodeURIComponent(fp) +
      '&duration=' + Math.max(1, Math.round(durSec || 0)) +
      '&meta=recordings+releasegroups';
    let d = null;
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 15000);
      const r = await fetch('https://api.acoustid.org/v2/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body, signal: c.signal,
      });
      clearTimeout(t);
      if (r.ok) d = await r.json();
    } catch (e) {}
    if (!d || !d.results || !d.results.length) return null;
    // Best recording across all results, highest AcoustID score wins.
    let best = null;
    for (const res of d.results) {
      const s = Number(res.score || 0);
      for (const rec of (res.recordings || [])) {
        if (!best || s > best.score) best = { score: s, rec };
      }
    }
    return best;
  }
  async function looksLikeHis(t) {
    try {
      const a = norm(t.artist || '');
      if (a.indexOf('skyler green') !== -1) return true;
      const disco = await loadDiscography();
      if (disco && matchMySingle(t, disco)) return true;
    } catch (e) {}
    return false;
  }
  // Returns { proposals, releaseId } or null. Proposals flow through the
  // same auto/review split as every other source, with confidence derived
  // from the AcoustID score. The album proposal is always review-tier
  // (titleOnlyAlbum): the fingerprint IDs the song, not its release.
  async function fingerprintTrack(t, opts) {
    opts = opts || {};
    try { if (await looksLikeHis(t)) return null; } catch (e) { return null; }
    let key = null;
    try { key = await DB.kvGet('acoustidKey', null); } catch (e) {}
    if (!key) return null;
    const fpMod = (typeof window !== 'undefined' && window.SplotifyFingerprint) || null;
    if (!fpMod || !fpMod.compute) return null;
    const file = t.file;
    if (!file || !file.size) return null;
    let fp = null, dur = 0;
    try {
      if (opts.onFingerprint) { try { opts.onFingerprint(t); } catch (e) {} }
      const r = await withTimeout(fpMod.compute(file, { maxSeconds: 60 }), 90000, 'fingerprint ' + (t.fileName || 'track'));
      fp = r && r.fingerprint; dur = (r && r.duration) || 0;
    } catch (e) { return null; }
    if (!fp) return null;
    let hit = null;
    try { hit = await acoustidQuery(fp, dur); } catch (e) {}
    if (!hit || !hit.rec) return null;
    const rec = hit.rec;
    const score = hit.score;
    // Duration veto: the match's recording must be near the file's length.
    const recDur = Number(rec.duration || 0);
    const fileDur = Number(dur || t.duration || 0);
    if (recDur > 0 && fileDur > 0 && Math.abs(recDur - fileDur) > Math.max(10, 0.2 * fileDur)) return null;
    const artists = (rec.artists || []).map(a => a && a.name).filter(Boolean).join(', ');
    const rel = (rec.releasegroups || [])[0] || null;
    const conf = Math.min(0.99, Math.max(0, Number(score) || 0));
    const out = [];
    if (rec.title && rec.title !== t.title && norm(rec.title) !== norm(t.title)) {
      out.push({ field: 'title', from: t.title, to: rec.title, confidence: Math.min(conf, 0.92), source: 'AcoustID' });
    }
    if (artists && artists !== t.artist && norm(artists) !== norm(t.artist)) {
      out.push({ field: 'artist', from: t.artist, to: artists, confidence: Math.min(conf, 0.9), source: 'AcoustID' });
    }
    if (rel && rel.title && rel.title !== t.album && norm(rel.title) !== norm(t.album || '')) {
      out.push({ field: 'album', from: t.album || 'Unknown Album', to: rel.title, confidence: Math.min(conf, 0.87), source: 'AcoustID', titleOnlyAlbum: true });
    }
    if (!out.length) return null;
    return { proposals: out, releaseId: (rel && rel.id) || null };
  }
  async function auditTrack(t, roster) {
    const proposals = [];
    let verified = false;
    try {
      const rp = rosterProposal(t, roster || []);
      if (rp) proposals.push(rp);
    } catch (e) {}
    // Only consult the network when the roster didn't already settle it and
    // the track has something to search with. The fallback chain is Apple
    // Music → Deezer → MusicBrainz: when one doesn't recognize the song,
    // the next gets its turn. MusicBrainz is skipped when an earlier source
    // already confidently identified it — no need to burn the 1/sec budget
    // re-verifying a known-good track. Proposals from every consulted source
    // compete per field, most confident wins.
    if (t.title && t.title !== 'Unknown Title') {
      try {
        const ar = await appleAudit(t);
        proposals.push(...ar.proposals);
        verified = ar.verified;
      } catch (e) {}
      if (!verified) {
        try {
          const dr = await deezerAudit(t);
          proposals.push(...dr.proposals);
          verified = verified || dr.verified;
        } catch (e) {}
      }
      if (!verified) { try { proposals.push(...await mbProposal(t)); } catch (e) {} }
    }
    // One proposal per field: keep the most confident.
    const byField = new Map();
    for (const p of proposals) {
      const cur = byField.get(p.field);
      if (!cur || p.confidence > cur.confidence) byField.set(p.field, p);
    }
    return { proposals: [...byField.values()], verified };
  }
  async function applyAuditProposal(t, p) {
    const tr = { ...t, [p.field]: p.to };
    tr.tagsVia = (t.tagsVia ? t.tagsVia + '+' : '') + 'audit(' + p.source + ')';
    tr.tagged = true;
    await persistFix(t.id, tr);
    Object.assign(t, { [p.field]: p.to, tagsVia: tr.tagsVia, tagged: true });
    // v7.7 calibration: remember what the fixer auto-set and how sure it
    // was, so a later hand-edit can log a rejection signal (in-memory only).
    t.autoConf = { ...(t.autoConf || {}), [p.field]: p.confidence };
    t.autoSource = { ...(t.autoSource || {}), [p.field]: p.source };
  }
  /* One song, fully fixed — the single engine behind the utag fixer.
     1. Scored corrections (roster → Apple → MusicBrainz, filename fallback).
     2. Fill for anything still missing (Apple, fill-only).
     3. His discography as the last resort for his own tracks.
     Confident corrections auto-apply (v7.8: per-source adaptive threshold,
     default 0.88); uncertain ones (0.55–threshold) return queued for the
     review screen. Title-only album changes never auto-apply (safety rule).
     Never touches correct tags. */
  const FIX_LABEL = { title: 'Title', artist: 'Artist', album: 'Album', albumArtist: 'Album artist', genre: 'Genre' };
  async function fixTrack(t, roster, opts) {
    opts = opts || {};
    const notes = [];
    let fixed = 0;
    const queued = [];
    let verified = false;
    const before = memFixOf(t);
    // v7.8: per-source adaptive auto-apply thresholds, cached for the run.
    const thrCache = new Map();
    const thrFor = async (source) => {
      if (!thrCache.has(source)) thrCache.set(source, await autoThresholdFor(source));
      return thrCache.get(source);
    };
    // Route scored proposals through the same auto/review split for every
    // source (roster/Apple/Deezer/MusicBrainz/AcoustID). Title-only album
    // changes never auto-apply: a safety rule, not a threshold.
    const routeProposals = async (proposals) => {
      for (const p of proposals) {
        const thr = await thrFor(p.source);
        if (p.confidence >= thr && !(p.field === 'album' && p.titleOnlyAlbum)) {
          try {
            await applyAuditProposal(t, p);
            fixed++;
            notes.push((FIX_LABEL[p.field] || p.field) + ': ' + p.from + ' → ' + p.to);
          } catch (e) {}
        } else if (p.confidence >= 0.55) {
          queued.push({ trackId: t.id, title: t.title, artist: t.artist, proposal: p });
        }
      }
    };
    // Tag memory first: if we've fixed this song before, just apply what we
    // already know is correct — no searching needed.
    try {
      const remembered = await recallFix(t);
      if (remembered) {
        if (await applyMemFix(t, remembered)) { fixed++; notes.push('remembered fix'); }
        return { fixed, queued, verified: true, note: notes.join('; '), status: fixed ? 'fixed' : 'ok' };
      }
    } catch (e) {}
    // His music first: artist repair, then his Apple Music album, then his
    // singles. A full match returns done; otherwise the catalog passes below
    // take it from here — with the now-correct artist, Apple recognizes his
    // released music like any other artist's.
    try {
      const my = await fixMyTrack(t);
      if (my) {
        if (my.note) notes.push(my.note);
        if (my.done) {
          fixed += my.fixed || 0;
          if (fixed > 0) { try { await learnFix(before, t); } catch (e) {} }
          return { fixed, queued, verified: true, note: notes.join('; '), status: fixed ? 'fixed' : 'ok' };
        }
      }
    } catch (e) {}
    try {
      const ar = await auditTrack(t, roster);
      verified = ar.verified;
      await routeProposals(ar.proposals);
    } catch (e) {}
    // Fill pass for anything still missing.
    // autoTag is fill-only, so present-but-wrong fields are never clobbered,
    // and hand-set artwork is never overwritten.
    if (needsFix(t)) {
      const tr = { ...t };
      try {
        if (await autoTag(tr)) {
          const upd = {};
          ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNo', 'discNo', 'art', 'artSource'].forEach(f => {
            if (tr[f] !== undefined && String(tr[f] !== null ? tr[f] : '') !== String(t[f] !== null && t[f] !== undefined ? t[f] : '')) upd[f] = tr[f];
          });
          if (Object.keys(upd).length) {
            upd.tagged = true;
            upd.tagsVia = tr.tagsVia || t.tagsVia;
            await persistFix(t.id, { ...t, ...upd });
            Object.assign(t, upd);
            fixed++;
            const filledNames = Object.keys(upd).filter(f => f !== 'tagged' && f !== 'tagsVia').map(f => FIX_LABEL[f] || f);
            if (filledNames.length) notes.push('filled ' + filledNames.join(', '));
          }
        }
      } catch (e) {}
    }
    let status = fixed ? 'fixed' : queued.length ? 'review' : verified ? 'ok' : 'nomatch';
    // v7.9: acoustic fingerprinting, last resort. Runs ONLY on tracks that
    // reached the "No match" tier — never speculatively (it's CPU-heavy).
    // His songs never get here: fixMyTrack claimed them first, and
    // fingerprintTrack re-checks with looksLikeHis().
    if (status === 'nomatch') {
      try {
        const fg = await fingerprintTrack(t, opts);
        if (fg && fg.proposals && fg.proposals.length) {
          await routeProposals(fg.proposals);
          status = fixed ? 'fixed' : queued.length ? 'review' : 'nomatch';
          // The release MBID feeds the v7.7 artwork chain (Cover Art
          // Archive) — wired through mbReleaseId so the MB search is
          // skipped. Hand-set art stays untouched.
          if (status !== 'nomatch' && !t.art && !t.artManual && fg.releaseId) {
            try {
              const tr = { ...t, mbReleaseId: fg.releaseId };
              if (await artChainExtra(tr)) {
                const upd = { art: tr.art, artSource: tr.artSource, tagged: true, tagsVia: tr.tagsVia };
                await persistFix(t.id, { ...t, ...upd });
                Object.assign(t, upd);
                fixed++;
                notes.push('artwork: ' + (tr.artSource || 'Cover Art Archive'));
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    const note = notes.join('; ');
    // Remember what we got right, so next time we just know.
    if (fixed > 0) { try { await learnFix(before, t); } catch (e) {} }
    return { fixed, queued, verified, note, status };
  }
  // Full-library audit. Confident corrections auto-apply (v7.8 adaptive
  // per-source thresholds); the rest return for the review screen.
  // Re-verifies previously tagged tracks too.
  async function auditLibrary(roster, onProgress) {
    const tracks = await DB.allTracks();
    const review = [];
    let fixed = 0, scanned = 0, autoCount = 0;
    const thrCache = new Map();
    const thrFor = async (source) => {
      if (!thrCache.has(source)) thrCache.set(source, await autoThresholdFor(source));
      return thrCache.get(source);
    };
    for (const t of tracks) {
      scanned++;
      if (onProgress) { try { onProgress(scanned, tracks.length, t); } catch (e) {} }
      let ar = { proposals: [], verified: false };
      try { ar = await auditTrack(t, roster); } catch (e) { continue; }
      for (const p of ar.proposals) {
        const thr = await thrFor(p.source);
        if (p.confidence >= thr && !(p.field === 'album' && p.titleOnlyAlbum)) {
          try { await applyAuditProposal(t, p); fixed++; autoCount++; } catch (e) {}
        } else if (p.confidence >= 0.55) {
          review.push({ trackId: t.id, title: t.title, artist: t.artist, proposal: p });
        }
      }
    }
    // v7.8 review triage: highest confidence first.
    review.sort((a, b) => ((b.proposal || {}).confidence || 0) - ((a.proposal || {}).confidence || 0));
    return { scanned, fixed, auto: autoCount, review };
  }
  // Remember single releases on the track record. The bundled discography is
  // the complete source of truth, so this recomputes from scratch (replacing
  // any stale Apple-era "X - Single" names) and writes only the
  // singleReleases field, so fixed tags are never clobbered. Returns the
  // number of tracks changed.
  async function recordSingles(tracks) {
    const disco = await loadDiscography();
    if (!disco) return 0;
    let changed = 0;
    for (const t of (tracks || [])) {
      // Only his own tracks can be his singles. Imported songs from other
      // artists (e.g. Spotify playlist downloads) must never be tagged as
      // one of his single releases, even when a title matches.
      const mine = norm(t.artist || '').indexOf('skyler green') !== -1;
      const hits = mine ? singleHitsFor(t, disco) : [];
      const cur = Array.isArray(t.singleReleases) ? t.singleReleases : [];
      if (cur.length === hits.length && cur.every((n, i) => n === hits[i])) continue;
      try { await DB.updateTrack(t.id, { singleReleases: hits }); } catch (e) {}
      Object.assign(t, { singleReleases: hits });
      changed++;
    }
    return changed;
  }
  // Title resemblance without any catalog search: normalized and spaceless compare.
  function titleSimilar(a, b) {
    const nt = norm(a), rt = norm(b);
    if (rt === nt || rt.indexOf(nt) !== -1 || nt.indexOf(rt) !== -1) return true;
    const cn = compact(a), ct = compact(b);
    return cn.length >= 6 && ct.length >= 6 && (ct === cn || ct.indexOf(cn) !== -1 || cn.indexOf(ct) !== -1);
  }
  // Leading track number from a filename ("07 - Title.mp3" -> 7).
  function leadNumber(name) {
    const b = (name || '').split('/').pop();
    const m = b.match(/^\s*0*(\d{1,3})\b/);
    return m ? parseInt(m[1], 10) : 0;
  }
  // Reject a candidate when both durations are known and far apart.
  function durationVeto(t, s) {
    const dur = t.duration || 0, sdur = (s.trackTimeMillis || 0) / 1000;
    return dur > 0 && sdur > 0 && Math.abs(dur - sdur) > 8;
  }
  // Multi-signal match of a local track against a catalog track listing:
  // title resemblance first, then filename track-number + duration.
  // Uses the listing (fetched by album id, unaffected by search quirks).
  function matchTrackMulti(t, songs, used) {
    const num = leadNumber(t.fileName);
    for (const s of songs) {
      if (used.has(s.trackId)) continue;
      if (durationVeto(t, s)) continue;
      if (titleSimilar(t.title, s.trackName)) { used.add(s.trackId); return s; }
    }
    for (const s of songs) {
      if (used.has(s.trackId)) continue;
      if (durationVeto(t, s)) continue;
      const sdur = (s.trackTimeMillis || 0) / 1000, dur = t.duration || 0;
      if (num > 0 && s.trackNumber === num && (s.discNumber || 1) === (t.discNo || 1) &&
          dur > 0 && sdur > 0 && Math.abs(dur - sdur) <= 6) {
        used.add(s.trackId); return s;
      }
    }
    return null;
  }
  // Apply a catalog track to a local track record. Returns true if anything changed.
  function applyListing(tr, s, col, art) {
    const before = [tr.title, tr.artist, tr.album, tr.albumArtist, tr.genre, tr.year, tr.trackNo, tr.discNo, !!tr.art].join('|');
    tr.title = s.trackName || tr.title;
    tr.artist = s.artistName || tr.artist;
    tr.album = col.collectionName || tr.album;
    tr.albumArtist = col.artistName || tr.albumArtist;
    tr.genre = s.primaryGenreName || col.primaryGenreName || tr.genre;
    tr.year = (col.releaseDate || '').slice(0, 4) || tr.year;
    tr.trackNo = s.trackNumber || tr.trackNo;
    tr.discNo = s.discNumber || tr.discNo;
    tr.tagsVia = 'Apple Music';
    // Take the listing's artwork: listings are tried albums-first, so an
    // album track gets the album art (like Spotify), not a stale single cover.
    // Hand-set artwork is never overwritten.
    if (art && !tr.artManual) { tr.art = art; if (!tr.artSource) tr.artSource = 'Apple Music'; }
    tr.tagged = true;
    if ((tr.diag || '').indexOf('fix v') === 0) tr.diag = 'reader-ok';
    return [tr.title, tr.artist, tr.album, tr.albumArtist, tr.genre, tr.year, tr.trackNo, tr.discNo, !!tr.art].join('|') !== before;
  }
  async function fixAlbum(tracks, knownAlbums, knownArtists) {
    tracks = (tracks || []).filter(Boolean);
    if (!tracks.length) return { fixed: 0, total: 0, matched: 0, found: false, via: { apple: 0, musicbrainz: 0, spotify: 0 } };
    const albumName = tracks[0].album || '';
    const artistName = tracks[0].albumArtist && tracks[0].albumArtist !== 'Unknown Artist' ? tracks[0].albumArtist
      : (tracks[0].artist && tracks[0].artist !== 'Unknown Artist' ? tracks[0].artist : '');
    const trackArtist = t => (t.albumArtist && t.albumArtist !== 'Unknown Artist' ? t.albumArtist
      : (t.artist && t.artist !== 'Unknown Artist' ? t.artist : ''));
    // Unknown album: per-track fix first; anything identified reveals its
    // album/artist, then every candidate listing (named albums + full artist
    // catalogs, all via id lookup) is matched by title/duration signals.
    if (!albumName || albumName === 'Unknown Album') {
      let fixed = 0, matched = 0, attempted = 0;
      const via = { apple: 0, musicbrainz: 0, spotify: 0 };
      const leftover = [];
      for (const t of tracks) {
        const tr = { ...t };
        if (!needsFix(tr)) continue;
        attempted++;
        try {
          if (await autoTag(tr)) {
            await persistFix(t.id, tr);
            Object.assign(t, {
              title: tr.title, artist: tr.artist, album: tr.album, albumArtist: tr.albumArtist,
              genre: tr.genre, year: tr.year, trackNo: tr.trackNo, discNo: tr.discNo,
              art: tr.art, tagged: tr.tagged, tagsVia: tr.tagsVia,
              ...(tr.artSource !== undefined ? { artSource: tr.artSource } : {}),
            });
            fixed++; matched++; via.apple++; continue;
          }
        } catch (e) {}
        leftover.push(t);
      }
      let note = `fix v13: tried ${attempted}, seedAlbums 0, seedArtists 0, listings 0, still ${leftover.length}`;
      if (leftover.length) {
        const seedAlbums = [];
        const seenA = new Set();
        const addAlbum = (name, artist) => {
          if (!name || name === 'Unknown Album') return;
          const k = (artist || '') + '|||' + name;
          if (!seenA.has(k)) { seenA.add(k); seedAlbums.push({ name, artist }); }
        };
        (knownAlbums || []).forEach(a => addAlbum(a.name, a.artist));
        tracks.forEach(t => addAlbum(t.album, trackArtist(t)));
        const seedArtists = new Set();
        (knownArtists || []).forEach(a => { if (a && a !== 'Unknown Artist') seedArtists.add(a); });
        tracks.forEach(t => { const a = trackArtist(t); if (a) seedArtists.add(a); });
        const listings = await candidateListings(seedAlbums, [...seedArtists]);
        note = `fix v13: tried ${attempted}, seedAlbums ${seedAlbums.length}, seedArtists ${seedArtists.size}, listings ${listings.length}, still ${leftover.length}`;
        for (const listing of listings) {
          const used = new Set();
          for (let i = leftover.length - 1; i >= 0; i--) {
            const t = leftover[i];
            const m = matchTrackMulti(t, listing.songs, used);
            if (!m) continue;
            const tr = { ...t };
            const changed = applyListing(tr, m, listing.col, listing.art);
            try { await persistFix(t.id, tr); Object.assign(t, tr); matched++; if (changed) { fixed++; via.apple++; } } catch (e) {}
            leftover.splice(i, 1);
          }
          if (!leftover.length) break;
        }
        note = `fix v13: tried ${attempted}, seedAlbums ${seedAlbums.length}, seedArtists ${seedArtists.size}, listings ${listings.length}, still ${leftover.length}`;
        // MusicBrainz pass: anything Apple couldn't identify gets a shot
        // against the open database before falling through to his own
        // discography singles.
        const mb = await mbFixTracks(leftover);
        fixed += mb.fixed; matched += mb.matched; via.musicbrainz += mb.fixed;
        // Spotify discography pass: Apple Music doesn't carry some of his
        // singles (Harlot, Time, Time II), so the catalog passes above can
        // never tag them. This matches leftovers against his Spotify releases.
        const discoFixed = await discoFixTracks(leftover);
        fixed += discoFixed; matched += discoFixed; via.spotify += discoFixed;
        await recordSingles(tracks);
        for (const t of leftover) {
          try { await persistFix(t.id, { ...t, diag: note }); } catch (e) {}
        }
      }
      return { fixed, total: tracks.length, matched, found: attempted > 0, via };
    }
    // Known album: match each track against the album's own listing plus the
    // artist's other releases, with full albums tried before single releases.
    // A track that lives on both an album and a single gets the album tagging,
    // so albums stay complete instead of fragmenting into stray singles.
    const primary = await albumTrackListing(albumName, artistName);
    const artistSeeds = new Set();
    if (artistName) artistSeeds.add(artistName);
    tracks.forEach(t => { const a = trackArtist(t); if (a) artistSeeds.add(a); });
    const alts = await candidateListings([], [...artistSeeds]);
    const seenCol = new Set();
    // v8.1 two-pass: every track tries the primary listing first; only the
    // misses pay for the alt-catalog expansion (now cross-cluster cached).
    // Primary always won per-track before too, so results are identical.
    if (!primary && !alts.length) return { fixed: 0, total: tracks.length, matched: 0, found: false, notFound: true, via: { apple: 0, musicbrainz: 0, spotify: 0 } };
    let fixed = 0, matched = 0;
    const matchedIds = []; // v7.8: lets the album-first pass tell matched-but-correct from unmatched
    const via = { apple: 0, musicbrainz: 0, spotify: 0 };
    const applyMatch = async (t, m, listing) => {
      matched++;
      matchedIds.push(t.id);
      const art = await ensureListingArt(listing);
      const tr = { ...t };
      const changed = applyListing(tr, m, listing.col, art);
      try { await persistFix(t.id, tr); Object.assign(t, tr); if (changed) { fixed++; via.apple++; } } catch (e) {}
    };
    const usedPrimary = new Set();
    const stillUnmatched = [];
    if (primary && primary.col && primary.col.collectionId) {
      for (const t of tracks) {
        const m = matchTrackMulti(t, primary.songs, usedPrimary);
        if (m) await applyMatch(t, m, primary);
        else stillUnmatched.push(t);
      }
    } else {
      stillUnmatched.push(...tracks);
    }
    if (stillUnmatched.length && alts.length) {
      const ordered = [];
      const seenCol = new Set(primary && primary.col ? [primary.col.collectionId] : []);
      for (const l of alts) {
        const id = l && l.col && l.col.collectionId;
        if (l && id && !seenCol.has(id)) { seenCol.add(id); ordered.push(l); }
      }
      ordered.sort((a, b) => b.songs.length - a.songs.length);
      const usedBy = new Map();
      for (const t of stillUnmatched) {
        let best = null, bestListing = null;
        for (const listing of ordered) {
          let used = usedBy.get(listing);
          if (!used) { used = new Set(); usedBy.set(listing, used); }
          const m = matchTrackMulti(t, listing.songs, used);
          if (m) { best = m; bestListing = listing; break; }
        }
        if (!best) continue;
        await applyMatch(t, best, bestListing);
      }
    }
    await recordSingles(tracks);
    const albumLabel = primary ? primary.col.collectionName
      : (ordered[0] && ordered[0].col ? ordered[0].col.collectionName : '');
    return { fixed, total: tracks.length, matched, matchedIds, found: true, album: albumLabel, via };
  }
  // v7.8 album-first pass: cluster named-album tracks and resolve each
  // cluster with one album-listing lookup (the existing fixAlbum machinery),
  // instead of auditing every song individually. One listing lookup
  // identifies the whole album, which also kills most "title-only match
  // can't tell which artist's song this is" review items — inside a listing
  // there is no ambiguity. Memory-known tracks skip the network entirely.
  // Returns whatever the album pass didn't resolve for the per-song path.
  // onTrack(t, status, note) paints rows as they resolve: 'scanning' is
  // transient; every track gets exactly one terminal status.
  const FP_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNo', 'discNo'];
  const fpOf = t => FP_FIELDS.map(f => t[f]).join('|') + '|' + (!!t.art) + '|' + (t.artSource || '');
  async function fixAlbumClusters(tracks, knownAlbums, knownArtists, onTrack, opts) {
    opts = opts || {};
    const clusterTimeoutMs = opts.clusterTimeoutMs || 120000;
    const list = tracks || [];
    const clusters = new Map();
    const leftover0 = [];
    for (const t of list) {
      const alb = t.album;
      if (!alb || alb === 'Unknown Album') { leftover0.push(t); continue; }
      const aa = t.albumArtist && t.albumArtist !== 'Unknown Artist' ? t.albumArtist
        : (t.artist && t.artist !== 'Unknown Artist' ? t.artist : '');
      const k = alb + '|||' + aa;
      if (!clusters.has(k)) clusters.set(k, []);
      clusters.get(k).push(t);
    }
    const resolved = new Set();
    const paint = (t, status, note) => { try { if (onTrack) onTrack(t, status, note); } catch (e) {} };
    for (const members of clusters.values()) {
      const rest = [];
      for (const t of members) {
        paint(t, 'scanning');
        let recalled = false;
        try {
          const rec = await recallFix(t);
          if (rec && await applyMemFix(t, rec)) recalled = true;
        } catch (e) {}
        if (recalled) { resolved.add(t.id); paint(t, 'fixed', 'remembered fix'); }
        else rest.push(t);
      }
      if (!rest.length) continue;
      const before = new Map(rest.map(t => [t.id, fpOf(t)]));
      let res = null;
      // v8.1: a single slow cluster must never wedge the whole run — 120s
      // cap, then its tracks fall through to the per-song pass.
      try { res = await withTimeout(fixAlbum(rest, knownAlbums || [], knownArtists || []), clusterTimeoutMs, 'album cluster ' + (rest[0] && rest[0].album)); }
      catch (e) { console.warn('album cluster timed out/failed', rest[0] && rest[0].album, e && e.message); }
      const matched = res && res.matchedIds ? new Set(res.matchedIds) : new Set();
      for (const t of rest) {
        if (fpOf(t) !== before.get(t.id)) {
          resolved.add(t.id);
          paint(t, 'fixed', 'album: ' + (t.album || ''));
        } else if (matched.has(t.id)) {
          resolved.add(t.id);
          paint(t, 'ok', 'album tags already correct');
        }
        // Unmatched tracks stay unresolved → fall through to per-song fix.
      }
    }
    return { leftover: list.filter(t => !resolved.has(t.id)), resolved: resolved.size };
  }
  // v7.8 parallel fix pool for the per-song path: N concurrent fixTrack
  // calls (default 5, hard cap 6). MusicBrainz keeps its own 1/sec pacing;
  // Apple/Deezer share the 3-slot catalog gate. DB writes stay per-track.
  // onStart/onDone paint rows — each track fires exactly one terminal onDone.
  async function fixTrackPool(tracks, roster, opts) {
    opts = opts || {};
    const list = tracks || [];
    const n = Math.max(1, Math.min(opts.concurrency || 5, 6));
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= list.length) return;
        const t = list[i];
        if (opts.onStart) { try { opts.onStart(t); } catch (e) {} }
        let res = null;
        try { res = await fixTrack(t, roster, opts); } catch (e) { res = null; }
        if (opts.onDone) { try { opts.onDone(t, res); } catch (e) {} }
      }
    };
    const ws = [];
    for (let k = 0; k < Math.min(n, list.length); k++) ws.push(worker());
    await Promise.all(ws);
    return { total: list.length };
  }
  // Fix tags on tracks already in the library (runs quietly on launch).
  async function healLibrary() {
    let fixed = 0, touched = 0;
    const parserOK = !!(window.mm && window.mm.parseBlob);
    try {
      await loadDiscography();
      const tracks = await DB.allTracks();
      for (const t of tracks) {
        // Curated metadata fixes: repair known-mangled tags on existing records.
        const mf = metaFixFor(t.artist, t.title);
        if (mf && ((mf.fa && t.artist !== mf.fa) || (mf.ft && t.title !== mf.ft))) {
          try {
            const upd = { tagsVia: 'Curated' };
            if (mf.fa) { upd.artist = mf.fa; t.artist = mf.fa; }
            if (mf.ft) { upd.title = mf.ft; t.title = mf.ft; }
            t.tagsVia = 'Curated';
            await DB.updateTrack(t.id, upd); touched++;
          } catch (e) {}
        }
        if (!t.diag) {
          // Records imported before diagnostics existed: backfill the Reader row
          // so Track Info is truthful. Never clobbers fixer notes (set below).
          const d = parserOK ? 'reader-ok' : 'reader-missing (window.mm.parseBlob not found)';
          try { await DB.updateTrack(t.id, { diag: d }); t.diag = d; touched++; } catch (e) {}
        }
        if (t.tagsVia === 'Spotify' && t.album) {
          // Single-only releases (Harlot, Intervals) reference their real
          // bundled cover by path. This also repairs the broken blob art
          // v2.1 wrote via the fetch->blob->IndexedDB round-trip: the path
          // renders exactly like the working Singles shelf.
          const want = singleArt(t.album);
          if (want && t.art !== want && !t.artManual) {
            try { await DB.updateTrack(t.id, { art: want }); t.art = want; touched++; } catch (e) {}
          }
        }
        if (!needsFix(t)) continue;
        const tr = { ...t };
        try { if (await autoTag(tr)) {
          await DB.updateTrack(t.id, {
            title: tr.title, artist: tr.artist, album: tr.album, albumArtist: tr.albumArtist,
            genre: tr.genre, year: tr.year, trackNo: tr.trackNo, discNo: tr.discNo,
            art: tr.art, tagged: tr.tagged, tagsVia: tr.tagsVia,
          });
          fixed++;
        } } catch (e) { console.warn('heal failed', t.fileName, e); }
      }
    } catch (e) { console.warn('healLibrary failed', e); }
    return { fixed, changed: fixed + touched };
  }
  // v7.8: the parallel fix pool shares one 3-in-flight gate across every
  // Apple/Deezer catalog + artwork query. MusicBrainz keeps its own 1/sec
  // pacing inside mbSearchRecording.
  const autoTagDeezerArt = (tr, q) => catalogGate(() => autoTagDeezerArtUngated(tr, q));
  const autoTagQuery = (tr, q) => catalogGate(() => autoTagQueryUngated(tr, q));
  const appleAuditQuery = (qq, t) => catalogGate(() => appleAuditQueryUngated(qq, t));
  const deezerAuditQuery = (qq, t) => catalogGate(() => deezerAuditQueryUngated(qq, t));
  // AcoustID shares the 3-in-flight gate: polite under the parallel pool.
  const acoustidQuery = (fp, dur) => catalogGate(() => acoustidLookupUngated(fp, dur));
  return { bind, open: () => { if (!busy) picker().click(); }, openZip: () => { if (!busy) zippicker().click(); }, fmtDur, healLibrary, fixAlbum, recordSingles, singleOrder, singleArt, mySingleArt, parseOne, auditLibrary, fixTrack, fingerprintTrack, learnFix, memCount, logCalib, artChainExtra, fixAlbumClusters, fixTrackPool, fileNameCandidates, autoThresholdFor };
})();
