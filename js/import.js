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
    const b = baseTitle(name);
    const m = b.match(/^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/);
    if (m) return { artist: m[1].trim(), title: m[2].trim() };
    return { artist: 'Unknown Artist', title: b.trim() || 'Unknown Title' };
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
  function needsFix(tr) {
    return tr.album === 'Unknown Album' || !tr.art || tr.artist === 'Unknown Artist' || !tr.title || tr.title === 'Unknown Title';
  }
  // Fill in missing tags from Apple's music catalog (song/artist name only — audio never leaves the device).
  async function autoTag(tr) {
    if (!needsFix(tr)) return false;
    const q = (tr.artist && tr.artist !== 'Unknown Artist' ? tr.artist + ' ' + tr.title : tr.title || '').trim();
    if (!q || q === 'Unknown Title') return false;
    const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&media=music&entity=song&limit=6', 12000);
    if (!d || !d.resultCount) return false;
    const nt = norm(tr.title), na = norm(tr.artist);
    let best = null;
    for (const r of d.results) {
      const ra = norm(r.artistName);
      const artistOK = !na || na === 'unknown artist' || ra === na || ra.indexOf(na) !== -1 || na.indexOf(ra) !== -1;
      if (titleMatches(tr.title, r.trackName, false) && artistOK) { best = r; break; }
    }
    if (!best) return false;
    tr.title = best.trackName || tr.title;
    tr.artist = best.artistName || tr.artist;
    tr.album = best.collectionName || tr.album;
    tr.genre = best.primaryGenreName || tr.genre;
    tr.year = (best.releaseDate || '').slice(0, 4) || tr.year;
    tr.trackNo = best.trackNumber || tr.trackNo;
    tr.tagsVia = 'Apple Music';
    const au = (best.artworkUrl100 || '').replace('100x100bb', '600x600bb');
    if (au && !tr.art) {
      try {
        const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
        const rr = await fetch(au, { signal: c.signal }); clearTimeout(t);
        if (rr.ok) { const b = await rr.blob(); if (b && b.size > 1000) tr.art = b; }
      } catch (e) {}
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
  async function listingFromCollectionId(colId) {
    try {
      const ld = await fetchJSON('https://itunes.apple.com/lookup?id=' + colId + '&entity=song&limit=200', 12000);
      if (!ld || !ld.results) return null;
      const col = ld.results.find(r => r.wrapperType === 'collection') || {};
      const songs = ld.results.filter(r => r.wrapperType === 'track');
      if (!songs.length) return null;
      let art = null;
      const au = (col.artworkUrl100 || '').replace('100x100bb', '600x600bb');
      if (au) {
        try {
          const c = new AbortController(); const tm = setTimeout(() => c.abort(), 12000);
          const rr = await fetch(au, { signal: c.signal }); clearTimeout(tm);
          if (rr.ok) { const b = await rr.blob(); if (b && b.size > 1000) art = b; }
        } catch (e) {}
      }
      return { col, songs, art };
    } catch (e) { return null; }
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
      try {
        const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(ar) + '&entity=song&limit=200', 12000);
        if (!d || !d.resultCount) continue;
        const nar = norm(ar);
        const mine = d.results.filter(r => {
          const ra = norm(r.artistName);
          return ra === nar || ra.indexOf(nar) !== -1 || nar.indexOf(ra) !== -1;
        });
        const ids = [...new Set(mine.map(r => r.collectionId).filter(Boolean))].slice(0, 6);
        for (const id of ids) push(await listingFromCollectionId(id));
      } catch (e) {}
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
  let discoCache = null, discoOrderMap = null, discoArtMap = null;
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
      const bySingle = new Map();
      for (const s of disco.singles) {
        (s.tracks || []).forEach((st, idx) => {
          if (!titleSimilar(t.title, st.title)) return;
          if (!bySingle.has(s.name)) bySingle.set(s.name, { s, cands: [] });
          bySingle.get(s.name).cands.push({ st, idx });
        });
      }
      if (!bySingle.size) continue;
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
      if (!tr.art) {
        const p = singleArt(s.name);
        if (p) { tr.art = p; artSet = true; }
      }
      try {
        await persistFix(t.id, tr);
        Object.assign(t, {
          title: tr.title, artist: tr.artist, album: tr.album, albumArtist: tr.albumArtist,
          genre: tr.genre, year: tr.year, trackNo: tr.trackNo, discNo: tr.discNo,
          art: tr.art, tagged: tr.tagged, tagsVia: tr.tagsVia, diag: tr.diag,
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
  async function mbSearchRecording(title, artist) {
    const key = norm(title) + '|||' + norm(artist);
    if (mbCache.has(key)) return mbCache.get(key);
    const wait = 1100 - (Date.now() - mbLastReq);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    mbLastReq = Date.now();
    let out = null;
    try {
      let q = 'recording:"' + String(title || '').replace(/"/g, '') + '"';
      if (artist && artist !== 'Unknown Artist') q += ' AND artist:"' + String(artist).replace(/"/g, '') + '"';
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 15000);
      const r = await fetch('https://musicbrainz.org/ws/2/recording/?query=' + encodeURIComponent(q) + '&fmt=json&limit=8', { signal: c.signal });
      clearTimeout(t);
      if (r.ok) {
        const d = await r.json();
        out = (d.recordings || []).filter(x => x && (x.score || 0) >= 60);
      }
    } catch (e) { /* offline or throttled: skip */ }
    mbCache.set(key, out);
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
    if (art) tr.art = art;
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
    const ordered = [];
    for (const l of [primary, ...alts]) {
      const id = l && l.col && l.col.collectionId;
      if (l && id && !seenCol.has(id)) { seenCol.add(id); ordered.push(l); }
    }
    ordered.sort((a, b) => b.songs.length - a.songs.length);
    if (!ordered.length) return { fixed: 0, total: tracks.length, matched: 0, found: false, notFound: true, via: { apple: 0, musicbrainz: 0, spotify: 0 } };
    const usedBy = new Map();
    let fixed = 0, matched = 0;
    const via = { apple: 0, musicbrainz: 0, spotify: 0 };
    for (const t of tracks) {
      let best = null, bestListing = null;
      for (const listing of ordered) {
        let used = usedBy.get(listing);
        if (!used) { used = new Set(); usedBy.set(listing, used); }
        const m = matchTrackMulti(t, listing.songs, used);
        if (m) { best = m; bestListing = listing; break; }
      }
      if (!best) continue;
      matched++;
      const tr = { ...t };
      const changed = applyListing(tr, best, bestListing.col, bestListing.art);
      try { await persistFix(t.id, tr); Object.assign(t, tr); if (changed) { fixed++; via.apple++; } } catch (e) {}
    }
    await recordSingles(tracks);
    const albumLabel = primary ? primary.col.collectionName
      : (ordered[0] && ordered[0].col ? ordered[0].col.collectionName : '');
    return { fixed, total: tracks.length, matched, found: true, album: albumLabel, via };
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
          if (want && t.art !== want) {
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
  return { bind, open: () => { if (!busy) picker().click(); }, openZip: () => { if (!busy) zippicker().click(); }, fmtDur, healLibrary, fixAlbum, recordSingles, singleOrder, singleArt, parseOne };
})();
