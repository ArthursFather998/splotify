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
  // v8.3: IndexedDB can stall indefinitely on iOS (a wedged transaction
  // blocks every later op on its store). The fixer must never hang on the
  // database — bound every DB op in its path; all callers already treat a
  // DB failure as "skip and continue".
  const dbOp = (p, ms, label) => withTimeout(p, ms || 10000, 'db:' + (label || 'op'));

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
  // v9.0: curated fixes live in the UTAG database now (UTAG.lookup / enrich).
  async function fetchJSON(url, ms) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 12000);
    try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) return null; return await r.json(); }
    catch (e) { return null; } finally { clearTimeout(t); }
  }
  // v9.0: a track needs a UTAG check when any core field is missing.
  function needsFix(tr) {
    return tr.album === 'Unknown Album' || !tr.art || tr.artist === 'Unknown Artist' || !tr.title || tr.title === 'Unknown Title';
  }
  // Fill in missing tags from Apple's music catalog (song/artist name only —
  // audio never leaves the device). Strictly fill-only: fields that already
  // have values are never overwritten here; corrections go through the
  // scored audit proposals instead. Tries the tag query first, then the
  // file-name query (mangled tags poison the first, the file name often
  // still holds "Artist - Title").
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
    // v9.0: no curated fixes on-device anymore. The UTAG database holds
    // every ruling; imports ask UTAG instead (see UTAG.enrich in run()).
    let artist = artist0, title = title0, tagsVia = null;
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
          if (await UTAG.enrich(tr)) fixed++;
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
        if (await UTAG.enrich(tr)) fixed++;
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
  let discoCache = null, discoOrderMap = null, discoArtMap = null, discoData = null;
  async function loadDiscography() {
    // v8.4: the bare fetch could stall forever (and the cache would wedge
    // every later caller) — bound it; a timeout retries fresh next call.
    if (!discoCache) discoCache = withTimeout(
      fetch('js/discography.json')
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
        .catch(() => null),
      15000, 'discography'
    ).catch(() => { discoCache = null; return null; });
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
  function singleOrder(name) {
    return (discoOrderMap && discoOrderMap[name] != null) ? discoOrderMap[name] : 1e9;
  }
  function memKeyFile(t) { return 'f:' + (t.fileName || '') + '::' + (t.fileSize || 0); }
  const skipKeyFor = t => memKeyFile(t);
  async function recallSkip(t) {
    try {
      const rec = await dbOp(DB.memGet(memKeyFile(t)), 10000, 'skip-get');
      return !!(rec && rec.skip);
    } catch (e) { return false; }
  }
  async function skipTrack(t) {
    try {
      const k = memKeyFile(t);
      const rec = (await dbOp(DB.memGet(k), 10000, 'skip-read')) || {};
      rec.key = k; rec.skip = true; rec.when = Date.now();
      await dbOp(DB.memPut(rec), 10000, 'skip-put');
    } catch (e) {}
  }
  async function unskipTrack(t) {
    try {
      const k = memKeyFile(t);
      const rec = await dbOp(DB.memGet(k), 10000, 'unskip-read');
      if (rec && rec.skip) { delete rec.skip; await dbOp(DB.memPut(rec), 10000, 'unskip-put'); }
    } catch (e) {}
  }
  async function memCount() {
    try { return await DB.memCount(); } catch (e) { return 0; }
  }
  // Apply a remembered fix. Never overwrites hand-set artwork with a
  // remembered one — a newer hand-set always wins. Returns true on change.
  async function looksLikeHis(t) {
    try {
      const a = norm(t.artist || '');
      if (a.indexOf('skyler green') !== -1) return true;
      const disco = await loadDiscography();
      if (disco && matchMySingle(t, disco)) return true;
    } catch (e) {}
    return false;
  }
  // Register his singles from the bundled discography at launch.
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
  async function healLibrary() {
    let touched = 0;
    const parserOK = !!(window.mm && window.mm.parseBlob);
    try {
      await loadDiscography();
      const tracks = await DB.allTracks();
      for (const t of tracks) {
        if (!t.diag) {
          // Records imported before diagnostics existed: backfill the Reader row
          // so Track Info is truthful.
          const d = parserOK ? 'reader-ok' : 'reader-missing (window.mm.parseBlob not found)';
          try { await DB.updateTrack(t.id, { diag: d }); t.diag = d; touched++; } catch (e) {}
        }
        if (t.tagsVia === 'Spotify' && t.album) {
          // Single-only releases (Harlot, Intervals) reference their real
          // bundled cover by path.
          const want = singleArt(t.album);
          if (want && t.art !== want && !t.artManual) {
            try { await DB.updateTrack(t.id, { art: want }); t.art = want; touched++; } catch (e) {}
          }
        }
      }
    } catch (e) { console.warn('healLibrary failed', e); }
    return { fixed: 0, changed: touched };
  }
  return { bind, open: () => { if (!busy) picker().click(); }, openZip: () => { if (!busy) zippicker().click(); }, fmtDur, healLibrary, recordSingles, singleOrder, singleArt, mySingleArt, parseOne, needsFix, memAll: () => DB.memAll(), memCount, skipKeyFor, recallSkip, skipTrack, unskipTrack, fileNameCandidates };
})();