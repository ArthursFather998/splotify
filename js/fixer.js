/* UTAG Fixer engine — ported from the Splotify v7/v8 catalog fixer.
   No AI. Sources, in order: library roster → Apple Music → Deezer →
   MusicBrainz → AcoustID fingerprint. Artwork: Apple → Deezer →
   Cover Art Archive → fanart.tv. Lyrics: embedded tags first, then
   LRCLIB. No lyrics-site scraping.
   Reads tags in-browser (vendored music-metadata). Returns scored
   proposals; the caller reviews and applies. Nothing is written
   anywhere until the user approves. */
window.UtagFixer = (() => {
  "use strict";

  /* ---------------- string helpers ---------------- */
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const compact = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  function strSim(a, b) {
    a = compact(a); b = compact(b);
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
  function titleMatches(a, b, exactOnly) {
    const nt = norm(a), rt = norm(b);
    if (!exactOnly && (rt === nt || rt.indexOf(nt) !== -1 || nt.indexOf(rt) !== -1)) return true;
    const cn = compact(a), ct = compact(b);
    if (!cn || !ct) return false;
    if (exactOnly) return ct === cn;
    return cn.length >= 6 && ct.length >= 6 && (ct === cn || ct.indexOf(cn) !== -1 || cn.indexOf(ct) !== -1);
  }
  function titleSimilar(a, b) { return titleMatches(a, b, false); }

  /* ---------------- fetch + pacing ---------------- */
  async function fetchJSON(url, ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms || 12000);
    try {
      const r = await fetch(url, { signal: c.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
    finally { clearTimeout(t); }
  }
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

  /* ---------------- filename parsing ---------------- */
  function baseTitle(name) { return (name || "").replace(/\.[a-z0-9]{2,5}$/i, ""); }
  const FOLDER_JUNK = /^(downloads?|music|audio|mp3s?|flacs?|m4as?|songs?|tracks?|new folder|untitled|various( artists)?|my music|itunes|library)$/i;
  function stripFileJunk(s) {
    return (s || "")
      .replace(/\[[^\]]*(spotify.downloader|downloader|free download|320\s?kbps|\bmp3\b|\bflac\b|\bm4a\b)[^\]]*\]/gi, "")
      .replace(/[\[\(]\s*(official\s+(audio|video|music\s+video)|lyrics?|audio|video|hd|4k|hq|mv)\s*[\]\)]/gi, "")
      .replace(/[\[\(]\s*(19|20)\d{2}\s*[\]\)]/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  function parseFeat(title) {
    const m = (title || "").match(/[\[\(]\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[\]\)]/i);
    return m ? m[1].trim() : "";
  }
  function fileNameCandidates(name, hints) {
    const out = { list: [], trackNo: 0 };
    let b = baseTitle(name || "").replace(/_+/g, " ").replace(/\.{2,}/g, " ");
    b = stripFileJunk(b);
    const ln = b.match(/^\s*0*(\d{1,3})\s*[.\-–—)\]:]\s+/);
    if (ln && b.slice(ln[0].length).trim()) { out.trackNo = parseInt(ln[1], 10); b = b.slice(ln[0].length).trim(); }
    const ha = hints && hints.artist && hints.artist !== "Unknown Artist" ? hints.artist : "";
    const ht = hints && hints.title && hints.title !== "Unknown Title" ? hints.title : "";
    const seen = new Set();
    const push = (artist, title, score) => {
      artist = (artist || "").replace(/\s+/g, " ").trim();
      title = (title || "").replace(/\s+/g, " ").trim();
      if (!artist || !title || /^unknown (artist|title)$/i.test(artist) || /^unknown (artist|title)$/i.test(title)) return;
      const k = artist.toLowerCase() + "|||" + title.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      let s = score;
      if (ha || ht) s += 0.5 * strSim(artist, ha) + 0.5 * strSim(title, ht);
      out.list.push({ artist, title, score: s, feat: parseFeat(title), trackNo: out.trackNo });
    };
    const m = b.match(/^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/);
    if (m) {
      push(m[1], m[2], 1.0);
      push(m[2], m[1], 0.55);
    }
    out.list.sort((x, y) => y.score - x.score);
    return out;
  }

  /* ---------------- lyrics ---------------- */
  function parseLrc(lrc) {
    const out = [];
    for (const raw of String(lrc || "").split(/\r?\n/)) {
      let line = raw;
      const times = [];
      let m;
      while ((m = line.match(/^\s*\[(\d+):(\d+(?:\.\d+)?)\]/))) {
        times.push(parseInt(m[1], 10) * 60 + parseFloat(m[2]));
        line = line.slice(m[0].length);
      }
      if (!times.length) continue;
      const text = line.trim();
      if (!text) continue;
      for (const t of times) out.push({ t, text });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
  function stripLrc(lrc) {
    const lines = [];
    for (const raw of String(lrc || "").split(/\r?\n/)) {
      if (/^\s*\[[a-z][a-z0-9_-]*:/i.test(raw) && !/^\s*\[\d+:/.test(raw)) continue;
      const line = raw.replace(/^\s*(?:\[\d+:\d+(?:\.\d+)?\])+/g, "").replace(/<\d+:\d+(?:\.\d+)?>/g, "").trim();
      if (line) lines.push(line);
    }
    return lines.join("\n");
  }
  function lrcTime(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = (s % 60).toFixed(2).padStart(5, "0");
    return "[" + mm + ":" + ss + "]";
  }
  function lyricsValueToText(v, depth) {
    if (!v || depth > 3) return null;
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      if (v.length && v.every(x => x && typeof x === "object" &&
          typeof (x.text || x.lyric) === "string" &&
          (x.timestamp !== undefined || x.time !== undefined || x.t !== undefined))) {
        const lines = v.map(x => ({ t: Number(x.timestamp !== undefined ? x.timestamp : (x.time !== undefined ? x.time : x.t)), text: String(x.text || x.lyric) }))
          .filter(x => isFinite(x.t) && x.text);
        lines.sort((a, b) => a.t - b.t);
        return lines.map(x => lrcTime(x.t) + x.text).join("\n");
      }
      return v.map(x => lyricsValueToText(x, depth + 1)).filter(Boolean).join("\n") || null;
    }
    if (typeof v === "object") {
      const ts = v.timestamp !== undefined ? v.timestamp : (v.time !== undefined ? v.time : v.t);
      if (ts !== undefined && typeof (v.text || v.lyric) === "string") return lrcTime(ts) + String(v.text || v.lyric);
      if (typeof v.text === "string") return v.text;
      if (typeof v.lyrics === "string") return v.lyrics;
      if (typeof v.lyric === "string") return v.lyric;
    }
    return null;
  }
  function extractEmbeddedLyrics(common) {
    if (!common || typeof common !== "object") return null;
    const texts = [];
    for (const k of Object.keys(common)) {
      if (!/lyric/i.test(k)) continue;
      const txt = lyricsValueToText(common[k], 0);
      if (txt && txt.trim()) texts.push(txt);
    }
    if (!texts.length) return null;
    let synced = null, plain = null;
    for (const txt of texts) {
      if (!synced && /\[\d+:\d+(?:\.\d+)?\]/.test(txt)) synced = txt;
      if (!plain && !/\[\d+:\d+(?:\.\d+)?\]/.test(txt)) plain = txt;
    }
    if (synced && !plain) plain = stripLrc(synced);
    if (!synced && !plain) return null;
    return { plain: plain || null, synced: synced || null, source: "embedded", status: "found" };
  }
  function lrclibValidate(d, t) {
    if (!d || typeof d !== "object") return false;
    if (strSim(d.trackName || "", t.title || "") < 0.8) return false;
    const artist = (t.artist || "").trim();
    if (artist && artist !== "Unknown Artist" && d.artistName && strSim(d.artistName, artist) < 0.7) return false;
    const dd = Number(d.duration), td = Number(t.duration);
    if (dd > 0 && td > 0 && Math.abs(dd - td) > Math.max(10, 0.15 * td)) return false;
    return true;
  }
  function normalizeLrclib(d) {
    if (!d) return null;
    if (d.instrumental) return { plain: null, synced: null, source: "LRCLIB", status: "instrumental" };
    const synced = d.syncedLyrics ? String(d.syncedLyrics) : null;
    let plain = d.plainLyrics ? String(d.plainLyrics) : null;
    if (!plain && synced) plain = stripLrc(synced);
    if (!plain && !synced) return null;
    return { plain: plain || null, synced: synced || null, source: "LRCLIB", status: "found" };
  }
  async function lrclibLyrics(t) {
    try { if (looksLikeHis(t)) return null; } catch (e) { return null; }
    if (!t || !t.title || t.title === "Unknown Title") return null;
    const artist = (t.artist && t.artist !== "Unknown Artist") ? t.artist : "";
    const album = (t.album && t.album !== "Unknown Album") ? t.album : "";
    const dur = t.duration ? Math.round(Number(t.duration)) : null;
    const base = "https://lrclib.net/api";
    const qGet = "artist_name=" + encodeURIComponent(artist) + "&track_name=" + encodeURIComponent(t.title) +
      (album ? "&album_name=" + encodeURIComponent(album) : "") + (dur ? "&duration=" + dur : "");
    const qSearch = "artist_name=" + encodeURIComponent(artist) + "&track_name=" + encodeURIComponent(t.title) +
      (album ? "&album_name=" + encodeURIComponent(album) : "");
    try {
      const d = await fetchJSON(base + "/get?" + qGet, 12000);
      if (d && lrclibValidate(d, t)) { const n = normalizeLrclib(d); if (n) return n; }
    } catch (e) {}
    try {
      const list = await fetchJSON(base + "/search?" + qSearch, 12000);
      if (Array.isArray(list)) {
        for (const d of list) {
          if (lrclibValidate(d, t)) { const n = normalizeLrclib(d); if (n) return n; }
        }
      }
    } catch (e) {}
    return null;
  }

  /* ---------------- tag reading ---------------- */
  async function parseFile(file) {
    let common = {}, format = {};
    try {
      if (window.mm && window.mm.parseBlob) {
        const md = await window.mm.parseBlob(file, { duration: true });
        common = md.common || {}; format = md.format || {};
      }
    } catch (e) { /* fall through to filename */ }
    const fb = (() => {
      const c = fileNameCandidates(file.name).list[0];
      return c ? { artist: c.artist, title: c.title } : { artist: "Unknown Artist", title: baseTitle(file.name).trim() || "Unknown Title" };
    })();
    let art = null;
    const pic = common.picture && common.picture[0];
    if (pic && pic.data) {
      try { art = new Blob([pic.data], { type: pic.format || "image/jpeg" }); } catch (e) {}
    }
    const artist = (common.artist || common.albumartist || fb.artist || "Unknown Artist").toString();
    const title = (common.title || fb.title || "Unknown Title").toString();
    let lyrics = null;
    try { lyrics = extractEmbeddedLyrics(common); } catch (e) { lyrics = null; }
    return {
      file, fileName: file.name, fileSize: file.size,
      title, artist, lyrics,
      album: (common.album || "Unknown Album").toString(),
      genre: (common.genre && common.genre[0]) || "",
      year: (common.year || (common.date || "").toString().slice(0, 4) || "").toString(),
      trackNo: (common.track && common.track.no) || 0,
      discNo: (common.disk && common.disk.no) || 0,
      duration: format.duration || 0,
      art,
    };
  }

  /* ---------------- device-local API keys ---------------- */
  const getKey = n => { try { return localStorage.getItem("utag_" + n + "_key") || ""; } catch (e) { return ""; } };
  const setKey = (n, v) => { try { localStorage.setItem("utag_" + n + "_key", (v || "").trim()); } catch (e) {} };

  /* ---------------- audit passes ---------------- */
  function rosterProposal(t, roster) {
    const ta = (t.artist || "").trim();
    if (!ta || ta === "Unknown Artist") return null;
    const nta = compact(ta);
    for (const r of roster) {
      if (compact(r.name) === nta) return null;
    }
    let best = null, bestSim = 0;
    for (const r of roster) {
      const s = strSim(r.name, ta);
      if (s > bestSim) { bestSim = s; best = r; }
    }
    if (best && bestSim >= 0.8 && bestSim < 1) {
      return { field: "artist", from: ta, to: best.name, confidence: 0.5 + bestSim * 0.45, source: "library roster" };
    }
    return null;
  }

  function auditQueries(t) {
    const queries = [];
    const tagQ = ((t.artist && t.artist !== "Unknown Artist") ? t.artist + " " : "") + (t.title || "");
    if (tagQ.trim()) queries.push({ qs: tagQ.trim(), a: (t.artist && t.artist !== "Unknown Artist") ? t.artist : "", t: t.title || "" });
    try {
      const pc = fileNameCandidates(t.fileName || "", { artist: t.artist, title: t.title });
      for (const c of pc.list.slice(0, 4)) {
        const qs = (c.artist + " " + c.title).trim();
        if (qs && !queries.some(q => q.qs === qs)) queries.push({ qs, a: c.artist, t: c.title });
      }
    } catch (e) {}
    return queries;
  }

  async function appleAuditQueryUngated(qq, t) {
    const d = await fetchJSON("https://itunes.apple.com/search?term=" + encodeURIComponent(qq.qs) + "&media=music&entity=song&limit=8", 12000);
    if (!d || !d.resultCount) return null;
    let best = null, bestScore = 0;
    for (const r of d.results) {
      const ts = strSim(r.trackName, qq.t);
      const as = strSim(r.artistName, qq.a);
      const score = qq.a ? ts * 0.6 + as * 0.4 : ts;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    const threshold = qq.a ? 0.75 : 0.85;
    if (!best || bestScore < threshold) return null;
    const out = [];
    const conf = 0.55 + bestScore * 0.4;
    const verified = bestScore >= (qq.a ? 0.85 : 0.92);
    /* When the song itself is confidently identified, the catalog's artist
       is the truth even under a heavier misspelling — the review screen
       is the safety net. */
    const artistGate = verified ? 0.7 : 0.85;
    if (strSim(best.trackName, qq.t) >= 0.9 && best.trackName !== t.title && norm(best.trackName) !== norm(t.title)) {
      out.push({ field: "title", from: t.title, to: best.trackName, confidence: Math.min(conf, 0.92), source: "Apple Music" });
    }
    if (qq.a && strSim(best.artistName, qq.a) >= artistGate && best.artistName !== t.artist && norm(best.artistName) !== norm(t.artist)) {
      out.push({ field: "artist", from: t.artist, to: best.artistName, confidence: Math.min(conf, 0.9), source: "Apple Music" });
    }
    if (best.collectionName && best.collectionName !== t.album && norm(best.collectionName) !== norm(t.album || "") && strSim(best.trackName, qq.t) >= 0.9) {
      const albumConf = qq.a ? Math.min(conf - 0.05, 0.88) : Math.min(conf - 0.05, 0.87);
      out.push({ field: "album", from: t.album || "Unknown Album", to: best.collectionName, confidence: albumConf, source: "Apple Music", ...(qq.a ? {} : { titleOnlyAlbum: true }) });
    }
    if (!t.genre && best.primaryGenreName) {
      out.push({ field: "genre", from: "", to: best.primaryGenreName, confidence: Math.min(conf, 0.85), source: "Apple Music" });
    }
    if (!t.year && best.releaseDate) {
      out.push({ field: "year", from: "", to: best.releaseDate.slice(0, 4), confidence: Math.min(conf, 0.85), source: "Apple Music" });
    }
    if (!t.trackNo && best.trackNumber) {
      out.push({ field: "trackNo", from: "", to: String(best.trackNumber), confidence: Math.min(conf, 0.85), source: "Apple Music" });
    }
    const artUrl = (best.artworkUrl100 || "").replace("100x100bb", "1200x1200bb") || null;
    return { proposals: out, verified, artUrl, artSource: artUrl ? "Apple Music" : null };
  }
  const appleAuditQuery = (qq, t) => catalogGate(() => appleAuditQueryUngated(qq, t));
  async function appleAudit(t) {
    const queries = auditQueries(t);
    let artUrl = null, artSource = null;
    for (const qq of queries) {
      try {
        const r = await appleAuditQuery(qq, t);
        if (r && (r.proposals.length || r.verified)) {
          if (r.artUrl && !artUrl) { artUrl = r.artUrl; artSource = r.artSource; }
          return { proposals: r.proposals, verified: r.verified, artUrl, artSource };
        }
      } catch (e) {}
    }
    return { proposals: [], verified: false, artUrl, artSource };
  }

  async function deezerAuditQueryUngated(qq, t) {
    const d = await fetchJSON("https://api.deezer.com/search?q=" + encodeURIComponent(qq.qs) + "&limit=8", 12000);
    if (!d || !d.total || !d.data || !d.data.length) return null;
    let best = null, bestScore = 0;
    for (const r of d.data) {
      const ts = strSim(r.title || "", qq.t);
      const as = strSim((r.artist && r.artist.name) || "", qq.a);
      const score = qq.a ? ts * 0.6 + as * 0.4 : ts;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    const threshold = qq.a ? 0.75 : 0.85;
    if (!best || bestScore < threshold) return null;
    const out = [];
    const conf = 0.55 + bestScore * 0.4;
    const verified = bestScore >= (qq.a ? 0.85 : 0.92);
    const artistGate = verified ? 0.7 : 0.85;
    const bTitle = best.title || "", bArtist = (best.artist && best.artist.name) || "";
    const bAlbum = (best.album && best.album.title) || "";
    if (strSim(bTitle, qq.t) >= 0.9 && bTitle !== t.title && norm(bTitle) !== norm(t.title)) {
      out.push({ field: "title", from: t.title, to: bTitle, confidence: Math.min(conf, 0.92), source: "Deezer" });
    }
    if (qq.a && strSim(bArtist, qq.a) >= artistGate && bArtist !== t.artist && norm(bArtist) !== norm(t.artist)) {
      out.push({ field: "artist", from: t.artist, to: bArtist, confidence: Math.min(conf, 0.9), source: "Deezer" });
    }
    if (bAlbum && bAlbum !== t.album && norm(bAlbum) !== norm(t.album || "") && strSim(bTitle, qq.t) >= 0.9) {
      const albumConf = qq.a ? Math.min(conf - 0.05, 0.88) : Math.min(conf - 0.05, 0.87);
      out.push({ field: "album", from: t.album || "Unknown Album", to: bAlbum, confidence: albumConf, source: "Deezer", ...(qq.a ? {} : { titleOnlyAlbum: true }) });
    }
    const artUrl = (best.album && (best.album.cover_xl || best.album.cover_big)) || null;
    return { proposals: out, verified, artUrl, artSource: artUrl ? "Deezer" : null };
  }
  const deezerAuditQuery = (qq, t) => catalogGate(() => deezerAuditQueryUngated(qq, t));
  async function deezerAudit(t) {
    const queries = auditQueries(t);
    for (const qq of queries) {
      try {
        const r = await deezerAuditQuery(qq, t);
        if (r && (r.proposals.length || r.verified)) return r;
      } catch (e) {}
    }
    return { proposals: [], verified: false, artUrl: null, artSource: null };
  }

  /* MusicBrainz: strict 1 req/sec, 503 backoff, never cache failures. */
  const mbCache = new Map();
  let mbPace = Promise.resolve(), mbLastReq = 0;
  async function mbSearchRecording(title, artist) {
    const key = norm(title) + "|||" + norm(artist);
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
    const key = norm(title) + "|||" + norm(artist);
    if (mbCache.has(key)) return mbCache.get(key);
    let out = null, backoff = 2000;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = 1100 - (Date.now() - mbLastReq);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      mbLastReq = Date.now();
      try {
        let q = 'recording:"' + String(title || "").replace(/"/g, "") + '"';
        if (artist && artist !== "Unknown Artist") q += ' AND artist:"' + String(artist).replace(/"/g, "") + '"';
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 15000);
        const r = await fetch("https://musicbrainz.org/ws/2/recording/?query=" + encodeURIComponent(q) + "&fmt=json&limit=8", { signal: c.signal });
        clearTimeout(t);
        if (r.status === 503) { await new Promise(rr => setTimeout(rr, backoff)); backoff *= 2; continue; }
        if (r.ok) {
          const d = await r.json();
          out = (d.recordings || []).filter(x => x && (x.score || 0) >= 60);
        }
        break;
      } catch (e) { break; }
    }
    if (out) mbCache.set(key, out);
    return out;
  }
  function mbPick(recs, t) {
    if (!recs || !recs.length) return null;
    let best = null, bestScore = -1;
    for (const rec of recs) {
      if (!titleSimilar(t.title, rec.title) && (rec.score || 0) < 85) continue;
      const s = rec.score || 0;
      if (s > bestScore) { bestScore = s; best = rec; }
    }
    return best;
  }
  async function mbProposal(t) {
    let recs = null;
    try { recs = await mbSearchRecording(t.title, t.artist); } catch (e) { return { proposals: [], releaseId: null, artistId: null }; }
    const pick = mbPick(recs, t);
    if (!pick) return { proposals: [], releaseId: null, artistId: null };
    const out = [];
    const mbArtist = (pick["artist-credit"] || []).map(a => (a.name || "") + (a.joinphrase || "")).join("").trim();
    const ts = strSim(pick.title, t.title), as = mbArtist ? strSim(mbArtist, t.artist) : 0;
    if (ts < 0.8 || (mbArtist && as < 0.7)) return { proposals: [], releaseId: null, artistId: null };
    const conf = 0.5 + (ts * 0.6 + as * 0.4) * 0.35;
    if (pick.title && pick.title !== t.title && norm(pick.title) !== norm(t.title) && ts >= 0.9) {
      out.push({ field: "title", from: t.title, to: pick.title, confidence: conf, source: "MusicBrainz" });
    }
    if (mbArtist && mbArtist !== t.artist && norm(mbArtist) !== norm(t.artist) && as >= 0.85) {
      out.push({ field: "artist", from: t.artist, to: mbArtist, confidence: conf, source: "MusicBrainz" });
    }
    const rel = (pick.releases || [])[0];
    if (rel && rel.title && rel.title !== t.album && norm(rel.title) !== norm(t.album || "") && ts >= 0.9) {
      out.push({ field: "album", from: t.album || "Unknown Album", to: rel.title, confidence: conf - 0.05, source: "MusicBrainz" });
    }
    const ac = (pick["artist-credit"] || [])[0];
    return { proposals: out, releaseId: (rel && rel.id) || null, artistId: (ac && ac.artist && ac.artist.id) || null };
  }

  /* AcoustID fingerprint. Never runs on his own songs. */
  const acoustidQuery = (fp, dur) => catalogGate(() => acoustidLookupUngated(fp, dur));
  async function acoustidLookupUngated(fp, durSec) {
    const key = getKey("acoustid");
    if (!key) return null;
    const body = "client=" + encodeURIComponent(key) +
      "&fingerprint=" + encodeURIComponent(fp) +
      "&duration=" + Math.max(1, Math.round(durSec || 0)) +
      "&meta=recordings+releasegroups";
    let d = null;
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 15000);
      const r = await fetch("https://api.acoustid.org/v2/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body, signal: c.signal,
      });
      clearTimeout(t);
      if (r.ok) d = await r.json();
    } catch (e) {}
    if (!d || !d.results || !d.results.length) return null;
    let best = null;
    for (const res of d.results) {
      const s = Number(res.score || 0);
      for (const rec of (res.recordings || [])) {
        if (!best || s > best.score) best = { score: s, rec };
      }
    }
    return best;
  }
  function looksLikeHis(t) {
    const a = norm(t.artist || "");
    return a.indexOf("skyler green") !== -1;
  }
  async function fingerprintProposal(t, onFingerprint) {
    try { if (looksLikeHis(t)) return null; } catch (e) { return null; }
    if (!getKey("acoustid")) return null;
    const fpMod = (typeof window !== "undefined" && window.SplotifyFingerprint) || null;
    if (!fpMod || !fpMod.compute) return null;
    const file = t.file;
    if (!file || !file.size) return null;
    let fp = null, dur = 0;
    try {
      if (onFingerprint) { try { onFingerprint(); } catch (e) {} }
      const r = await fpMod.compute(file, { maxSeconds: 60 });
      fp = r && r.fingerprint; dur = (r && r.duration) || 0;
    } catch (e) { return null; }
    if (!fp) return null;
    let hit = null;
    try { hit = await acoustidQuery(fp, dur); } catch (e) {}
    if (!hit || !hit.rec) return null;
    const rec = hit.rec;
    const score = hit.score;
    const recDur = Number(rec.duration || 0);
    const fileDur = Number(dur || t.duration || 0);
    if (recDur > 0 && fileDur > 0 && Math.abs(recDur - fileDur) > Math.max(10, 0.2 * fileDur)) return null;
    const artists = (rec.artists || []).map(a => a && a.name).filter(Boolean).join(", ");
    const rel = (rec.releasegroups || [])[0] || null;
    const conf = Math.min(0.99, Math.max(0, Number(score) || 0));
    const out = [];
    if (rec.title && rec.title !== t.title && norm(rec.title) !== norm(t.title)) {
      out.push({ field: "title", from: t.title, to: rec.title, confidence: Math.min(conf, 0.92), source: "AcoustID" });
    }
    if (artists && artists !== t.artist && norm(artists) !== norm(t.artist)) {
      out.push({ field: "artist", from: t.artist, to: artists, confidence: Math.min(conf, 0.9), source: "AcoustID" });
    }
    if (rel && rel.title && rel.title !== t.album && norm(rel.title) !== norm(t.album || "")) {
      out.push({ field: "album", from: t.album || "Unknown Album", to: rel.title, confidence: Math.min(conf, 0.87), source: "AcoustID", titleOnlyAlbum: true });
    }
    if (!out.length) return null;
    return { proposals: out, releaseGroupId: (rel && rel.id) || null };
  }

  /* Artwork chain: Apple/Deezer hits first, then Cover Art Archive, then fanart.tv. */
  async function fetchArtBlob(url) {
    try {
      const c = new AbortController();
      const tm = setTimeout(() => c.abort(), 8000);
      const rr = await fetch(url, { signal: c.signal });
      clearTimeout(tm);
      if (rr.ok) { const b = await rr.blob(); if (b && b.size > 1000) return b; }
    } catch (e) {}
    return null;
  }
  async function artChain(t, mbReleaseId, mbArtistId, appleArt, deezerArt, rgId) {
    const cands = [];
    if (appleArt) cands.push({ url: appleArt, w: 1200, source: "Apple Music" });
    if (deezerArt) cands.push({ url: deezerArt, w: 1000, source: "Deezer" });
    const fkey = getKey("fanart");
    if (mbReleaseId) {
      cands.push({ url: "https://coverartarchive.org/release/" + mbReleaseId + "/front", w: 1400, source: "Cover Art Archive" });
      if (fkey) {
        try {
          const f = await fetchJSON("https://webservice.fanart.tv/v3/music/albums/" + mbReleaseId + "?api_key=" + encodeURIComponent(fkey), 8000);
          const alb = f && f.albums && f.albums[mbReleaseId];
          const covers = alb && alb.albumcover;
          if (covers && covers.length && covers[0].url) cands.push({ url: covers[0].url, w: 1000, source: "fanart.tv" });
        } catch (e) {}
      }
    }
    if (fkey && mbArtistId) {
      try {
        const f = await fetchJSON("https://webservice.fanart.tv/v3/music/" + mbArtistId + "?api_key=" + encodeURIComponent(fkey), 8000);
        const thumbs = f && f.artistthumb;
        if (thumbs && thumbs.length && thumbs[0].url) cands.push({ url: thumbs[0].url, w: 1000, source: "fanart.tv" });
      } catch (e) {}
    }
    if (rgId) {
      /* AcoustID gives a release-group id — different CAA endpoint. */
      cands.push({ url: "https://coverartarchive.org/release-group/" + rgId + "/front", w: 1350, source: "Cover Art Archive" });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.w - a.w);
    for (const cd of cands) {
      const blob = await fetchArtBlob(cd.url);
      if (blob) return { blob, url: cd.url, source: cd.source };
    }
    return null;
  }

  /* ---------------- orchestration ---------------- */
  async function auditFile(t, roster, onProgress) {
    const prog = onProgress || (() => {});
    const proposals = [];
    let appleArt = null, deezerArt = null, mbReleaseId = null, mbArtistId = null, rgId = null;
    let verified = false;

    try {
      const rp = rosterProposal(t, roster || []);
      if (rp) proposals.push(rp);
    } catch (e) {}

    if (t.title && t.title !== "Unknown Title") {
      prog("Apple Music…");
      try {
        const ar = await appleAudit(t);
        proposals.push(...ar.proposals);
        verified = ar.verified;
        if (ar.artUrl) appleArt = ar.artUrl;
      } catch (e) {}
      if (!verified) {
        prog("Deezer…");
        try {
          const dr = await deezerAudit(t);
          proposals.push(...dr.proposals);
          verified = verified || dr.verified;
          if (dr.artUrl) deezerArt = dr.artUrl;
        } catch (e) {}
      }
      if (!verified) {
        prog("MusicBrainz…");
        try {
          const mb = await mbProposal(t);
          proposals.push(...mb.proposals);
          if (mb.releaseId) mbReleaseId = mb.releaseId;
          if (mb.artistId) mbArtistId = mb.artistId;
        } catch (e) {}
      }
    }
    if (getKey("acoustid")) {
      prog("Fingerprinting…");
      try {
        const fp = await fingerprintProposal(t, () => prog("Fingerprinting…"));
        if (fp) {
          proposals.push(...fp.proposals);
          if (fp.releaseGroupId && !rgId) rgId = fp.releaseGroupId;
        }
      } catch (e) {}
    }

    /* One proposal per field: most confident wins. */
    const byField = new Map();
    for (const p of proposals) {
      const cur = byField.get(p.field);
      if (!cur || p.confidence > cur.confidence) byField.set(p.field, p);
    }

    prog("Artwork…");
    let art = null;
    try { art = await artChain(t, mbReleaseId, mbArtistId, appleArt, deezerArt, rgId); } catch (e) {}

    prog("Lyrics…");
    let lyrics = null;
    try {
      if (t.lyrics && t.lyrics.status === "found" && (t.lyrics.plain || t.lyrics.synced)) lyrics = t.lyrics;
      else lyrics = await lrclibLyrics(t);
    } catch (e) { lyrics = null; }

    prog("Done.");
    return { proposals: [...byField.values()], verified, art, artSource: art ? art.source : null, lyrics: lyrics || null };
  }

  return { parseFile, auditFile, parseLrc, stripLrc, lrclibLyrics, getKey, setKey, fmtDur: s => {
    if (!s || !isFinite(s)) return "";
    s = Math.round(s);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  } };
})();
