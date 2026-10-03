/* Splotify app — views, router, artwork, sheets. */
const App = (() => {
  const APP_VERSION = 'v8.4';
  const view = () => document.getElementById('view');
  const S = {
    tracks: [], byId: new Map(),
    tab: 'home', stack: [],
    pill: 'music', query: '',
    artURLs: new Map(), tintCache: new Map(),
    recent: [], notifSeen: true,
    editRecent: false,
    artistFor: '', artistTab: 'music', artistExpanded: false, artistReleasesExpanded: false,
    artistFilter: 'all', followedArtists: new Set(),
    // v7.0: S.tracks/S.byId is the SDB (every song known). S.library is the
    // user's library: an ordered array of saved SDB track IDs (membership
    // list, not a copy). S.artists is the artist roster table cache.
    library: [], artists: new Map(),
    // v7.0 library view state (Spotify-style)
    libChip: 'all', libSort: 'recent', libGrid: false, libSearching: false, libQ: '',
    // v7.0 Spotify transfer state
    spReview: [], spMissed: [], spSummary: null, spBusy: false,
    // v7.0 utag audit state
    tagReview: [], tagAuditRunning: false,
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- SDB (Song DataBase) ---------- */
  // The SDB is every track Splotify knows. S.tracks/S.byId is the in-memory
  // SDB cache and the DB tracks store is its persistence. The library
  // (S.library) is a separate membership list of saved track IDs.
  // New code reads the catalog through SDB.* — when Skyler's SDB server
  // lands, these become its client and the UI does not change.
  const SDB = {
    all: () => S.tracks,
    get: id => S.byId.get(Number(id)),
    has: id => S.byId.has(Number(id)),
    ids: () => S.tracks.map(t => t.id),
  };
  /* ---------- artist roster ---------- */
  // Canonical artist table (v7.0). Seeded from js/placeholder-artists.json;
  // uploads matching a placeholder activate it; the utag fixer treats this
  // as the canonical roster. Follow state lives here (not in kv).
  const artistIdFor = name => 'a_' + normTitle(name);
  async function upsertArtist(name, patch = {}) {
    name = String(name || '').trim();
    if (!name || name === 'Unknown Artist') return null;
    const id = artistIdFor(name);
    if (id === 'a_') return null;
    let rec = S.artists.get(id) || await DB.getArtist(id).catch(() => null);
    if (!rec) rec = { id, name, isPlaceholder: true, followed: false, followedAt: 0, art: null, bio: null, stats: null };
    Object.assign(rec, patch);
    // Never clobber a real display name with a normalized variant.
    if (patch.name) rec.name = patch.name;
    S.artists.set(id, rec);
    try { await DB.putArtist(rec); } catch (e) {}
    return rec;
  }
  async function setArtistFollowed(name, followed) {
    const rec = await upsertArtist(name, {});
    if (!rec) return false;
    rec.followed = !!followed;
    rec.followedAt = followed ? Date.now() : 0;
    S.artists.set(rec.id, rec);
    try { await DB.putArtist(rec); } catch (e) {}
    const k = artistKey(name);
    if (followed) S.followedArtists.add(k); else S.followedArtists.delete(k);
    return followed;
  }
  /* ---------- library membership (v7.0) ---------- */
  // The library is an ordered array of saved SDB track IDs. Uploads never
  // touch it; only explicit saves (+ / heart flows / Spotify transfer) do.
  const libraryHas = id => S.library.includes(Number(id));
  async function libraryAdd(id) {
    id = Number(id);
    if (!id || !S.byId.has(id) || S.library.includes(id)) return false;
    S.library.push(id);
    try { await DB.kvSet('library', S.library); } catch (e) {}
    return true;
  }
  async function libraryRemove(id) {
    id = Number(id);
    const i = S.library.indexOf(id);
    if (i === -1) return false;
    S.library.splice(i, 1);
    try { await DB.kvSet('library', S.library); } catch (e) {}
    return true;
  }

  /* ---------- artwork ---------- */
  // Curated cover-art overrides (v3.9+): proper art for unreleased tracks that
  // have no reliable embedded art. Title/album matched, never touches his singles.
  function normTitle(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function normBase(s) {
    return normTitle(String(s || '').replace(/\s*[\(\[].*?[\)\]]/g, ''));
  }
  function customArtFor(t) {
    try {
      const M = window.CUSTOM_ART;
      if (!M) return null;
      if (normTitle(t.album).indexOf('marcescence') !== -1) return 'js/custom-art/marcescence.jpg';
      // Artist is only enforced when the track has a real artist tag, so
      // untagged files still match by title while another artist's song
      // with the same name can't steal the cover.
      const ta = normTitle(t.artist);
      const pick = k => {
        const e = k && M[k];
        if (!e) return null;
        if (typeof e === 'string') return e;
        if (e.a && ta && ta !== 'unknownartist' && ta.indexOf(e.a) === -1) return null;
        return e.s;
      };
      return pick(normTitle(t.title)) || pick(normBase(t.title));
    } catch (e) {}
    return null;
  }
  function artURL(t) {
    if (!t) return null;
    // Bundled release art for virtual singles (plain path, not a Blob).
    if (typeof t.artSrc === 'string') return t.artSrc;
    // Curated proper covers beat embedded blobs and thumbnails.
    const custom = customArtFor(t);
    if (custom) return custom;
    // Single-only tracks reference their bundled cover by path (v2.2+).
    if (typeof t.art === 'string') return t.art;
    if (t.art) {
      let u = S.artURLs.get(t.id);
      if (!u) { u = URL.createObjectURL(t.art); S.artURLs.set(t.id, u); }
      return u;
    }
    // No art at all: unreleased d4vd tracks fall back to the deluxe cover
    // instead of a blank. His own songs never wear d4vd's cover: they get
    // their bundled single art when the title matches his discography,
    // otherwise a blank placeholder.
    const ta = normTitle(t.artist);
    if (!ta || ta === 'unknownartist' || ta.indexOf('d4vd') !== -1) {
      if (ta.indexOf('d4vd') === -1) {
        try {
          const myArt = (typeof Importer !== 'undefined' && Importer.mySingleArt) ? Importer.mySingleArt(t.title) : null;
          if (myArt) return myArt;
        } catch (e) {}
        return null;
      }
      return 'js/custom-art/marcescence.jpg';
    }
    return null;
  }
  function artImg(t, cls = '', alt = '') {
    const u = artURL(t);
    if (u) return `<img class="${cls}" src="${u}" alt="${esc(alt)}" loading="lazy" onerror="App.artErr(this)">`;
    return `<div class="${cls} art-ph" aria-hidden="true">${icon('note')}</div>`;
  }
  // A dead image must never render the browser's broken-image glyph: swap it
  // for a shimmer skeleton and retry quietly in case it was a blip. If the
  // retries fail too, the skeleton simply stays — never the broken box.
  function artErr(el) {
    try {
      const cls = el.className || '';
      const src = el.getAttribute('src') || '';
      const r = el.getBoundingClientRect();
      const sk = document.createElement('div');
      sk.className = (cls + ' skel').trim();
      if (r.width > 0) sk.style.width = r.width + 'px';
      if (r.height > 0) sk.style.height = r.height + 'px';
      sk.setAttribute('aria-hidden', 'true');
      el.replaceWith(sk);
      if (!src) return;
      let tries = 0;
      const tick = () => {
        if (++tries > 3 || !sk.isConnected) return;
        const im = new Image();
        im.onload = () => {
          if (!sk.isConnected) return;
          const ni = document.createElement('img');
          ni.className = cls;
          ni.alt = '';
          ni.setAttribute('loading', 'lazy');
          ni.src = src;
          ni.onerror = () => artErr(ni);
          sk.replaceWith(ni);
        };
        im.onerror = () => setTimeout(tick, 4000 * tries);
        im.src = src;
      };
      setTimeout(tick, 3000);
    } catch (e) {}
  }
  function tint(t) {
    if (!t || !t.art) return null;
    const c = S.tintCache.get(t.id);
    if (c) return c;
    try {
      const u = artURL(t);
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement('canvas'); cv.width = cv.height = 24;
          const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 24, 24);
          const d = g.getImageData(0, 0, 24, 24).data;
          let r = 0, gg = 0, b = 0, n = 0;
          for (let i = 0; i < d.length; i += 16) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
          r = Math.round(r / n * 0.55); gg = Math.round(gg / n * 0.55); b = Math.round(b / n * 0.55);
          S.tintCache.set(t.id, [r, gg, b]);
          if (Player.current && Player.current.id === t.id) paintNowPlaying();
          paintMini();
        } catch (e) {}
      };
      img.src = u;
    } catch (e) {}
    return null;
  }
  const cssTint = t => { const c = tint(t); return c ? `rgb(${c[0]},${c[1]},${c[2]})` : '#3a3a3a'; };

  /* ---------- derived library ---------- */
  function realAlbums() {
    const m = new Map();
    S.tracks.forEach(t => {
      // Loose songs are not an album: no "Unknown Album" pseudo-group.
      // They live in Songs; Albums only lists real albums.
      if (!t.album || t.album === 'Unknown Album') return;
      const ap = albumArtistPart(t);
      const k = ap + '|||::|||' + t.album;
      if (!m.has(k)) m.set(k, { key: k, name: t.album, artist: ap, tracks: [], art: t });
      const a = m.get(k); a.tracks.push(t);
      if (!a.art.art && t.art) a.art = t;
    });
    return [...m.values()].map(a => {
      a.tracks.sort((x, y) => (x.discNo - y.discNo) || (x.trackNo - y.trackNo) || x.title.localeCompare(y.title));
      return a;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  // Virtual single releases, mirroring the Singles & EPs shelf on his
  // Spotify artist page. A track tagged to an album can still appear as a
  // single without moving.
  function singleAlbums() {
    const sm = new Map();
    S.tracks.forEach(t => {
      (t.singleReleases || []).forEach(n => {
        const ap = albumArtistPart(t);
        const k = ap + '|||::|||' + n + '|||single';
        if (!sm.has(k)) {
          // The single's real Spotify cover from the app bundle. The album's
          // rose never stands in for a single.
          const src = Importer.singleArt(n);
          sm.set(k, { key: k, name: n, artist: ap, tracks: [],
            art: src ? { id: 'discoart:' + n, artSrc: src } : t, single: true });
        }
        const g = sm.get(k);
        if (!g.tracks.includes(t)) g.tracks.push(t);
        if (!g.art.artSrc && !g.art.art && t.art) g.art = t;
      });
    });
    return [...sm.values()].sort((a, b) => (Importer.singleOrder(a.name) - Importer.singleOrder(b.name)) || a.name.localeCompare(b.name));
  }
  function albums() {
    return realAlbums().concat(singleAlbums());
  }
  // A combined credit is not an artist: "d4vd, Lil Nas X", "d4vd & Lil Nas X",
  // "d4vd feat. Lil Nas X" all file the song under each artist separately.
  function splitArtists(s) {
    const raw = String(s || '').trim();
    if (!raw) return ['Unknown Artist'];
    const parts = raw.split(/\s*(?:,|&|\+|\bfeat\.?(?!\w)|\bfeaturing\b|\bft\.?(?!\w)|\bwith\b)\s*|\s+x\s+/i)
      .map(x => x.trim()).filter(Boolean);
    return parts.length ? parts : [raw];
  }
  // Identity of one artist credit: "04. d4vd", "[2024] d4vd" and "@d4vdd" are
  // tag junk around the real name. Display form keeps its case, key is lower.
  function artistDisp(s) {
    const n = String(s || '').trim()
      .replace(/^\[\d{4}\]\s*/, '')
      .replace(/^\d{1,3}\.\s*/, '')
      .replace(/^@+/, '')
      .replace(/\s+/g, ' ').trim();
    return n || 'Unknown Artist';
  }
  // Known aliases: same artist, different tag spelling. Skyler's rule for
  // d4vd is absolute: anything starting with "d4vd" is the same artist.
  const ARTIST_ALIASES = { 'd4vdd': 'd4vd', 'd4vd_': 'd4vd' };
  function artistKey(s) {
    const k = artistDisp(s).toLowerCase();
    if (ARTIST_ALIASES[k]) return ARTIST_ALIASES[k];
    if (k.startsWith('d4vd')) return 'd4vd';
    return k;
  }
  function albumArtistPart(t) {
    const raw = t.albumArtist || t.artist || '';
    return artistKey(raw) === 'd4vd' ? 'd4vd' : raw;
  }
  function albumKeyForTrack(t) {
    return albumArtistPart(t) + '|||::|||' + t.album;
  }
  function trackArtistKeys(t) { return [...new Set(splitArtists(t.artist).map(artistKey))]; }
  function artists() {
    const m = new Map();
    S.tracks.forEach(t => {
      splitArtists(t.artist).forEach(raw => {
        const key = artistKey(raw), disp = artistDisp(raw);
        if (!m.has(key)) m.set(key, { name: disp, tracks: [], art: t, forms: {} });
        const a = m.get(key);
        a.forms[disp] = (a.forms[disp] || 0) + 1;
        if (!a.tracks.includes(t)) a.tracks.push(t);
        if (!a.art.art && t.art) a.art = t;
      });
    });
    // One entry per artist; the name shown is the most common tag form,
    // except d4vd, which always displays as the one canonical profile.
    return [...m.entries()].map(([key, a]) => {
      a.name = key === 'd4vd' ? 'd4vd' : Object.entries(a.forms).sort((x, y) => y[1] - x[1])[0][0];
      delete a.forms;
      return a;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  const albumByKey = k => albums().find(a => a.key === k);
  const artistByName = n => artists().find(a => a.name === n);
  /* v7.0: unified artist view-model. Derived artists (with SDB songs) first;
     roster placeholders (no songs yet) resolve from the artist table so they
     get real pages with follow buttons. */
  function artistViewModel(name) {
    const derived = artistByName(name);
    if (derived) return derived;
    const rec = S.artists.get(artistIdFor(name));
    if (rec) return { name: rec.name, tracks: [], art: null, forms: {}, placeholder: true };
    return null;
  }

  /* ---------- Spotify-style artist pages ---------- */
  const ARTIST_ART = { d4vd: 'js/artist-art/d4vd.jpg' };
  function artistStats(name) {
    const m = window.ARTIST_STATS || {};
    const v = m[artistKey(name)];
    if (!v) return null;
    return { listeners: v[0], rank: v[1], meta: window.ARTIST_STATS_META || {} };
  }
  function fmtListeners(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M monthly listeners';
    if (n >= 1000) return Math.round(n / 1000) + 'K monthly listeners';
    return Number(n || 0).toLocaleString('en-US') + ' monthly listeners';
  }
  const fmtInt = n => Number(n || 0).toLocaleString('en-US');
  function artistHeroSrc(a) {
    return ARTIST_ART[artistKey(a.name)] || artURL(a.art) || '';
  }
  function releaseYear(x) {
    const ys = x.tracks.map(t => parseInt(t.year, 10)).filter(Boolean);
    return ys.length ? Math.max(...ys) : 0;
  }
  function releaseKind(x) {
    if (x.single || x.tracks.length === 1) return 'Single';
    const dur = x.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    return (x.tracks.length >= 7 && dur >= 1800) ? 'Album' : 'EP';
  }
  function releaseGroup(x, akey) {
    const primary = artistKey(x.artist || '');
    const appears = x.tracks.some(t => trackArtistKeys(t).includes(akey));
    if (/greatest|compilation|collection|best of|essential/i.test(x.name) || primary === 'various artists') return 'compilations';
    if (appears && primary !== akey) return 'featured';
    return releaseKind(x) === 'Album' ? 'albums' : 'singles';
  }
  function artistReleases(a) {
    const akey = artistKey(a.name);
    return albums()
      .filter(x => splitArtists(x.artist).some(p => artistKey(p) === akey) || x.tracks.some(t => trackArtistKeys(t).includes(akey)))
      .map(x => ({ ...x, kind: releaseKind(x), group: releaseGroup(x, akey), year: releaseYear(x) }))
      .sort((x, y) => (y.year - x.year) || y.tracks.length - x.tracks.length || x.name.localeCompare(y.name));
  }
  function artistTopTracks(a) {
    const rank = t => [
      Player.isLiked(t.id) ? 0 : 1,
      t.art ? 0 : 1,
      t.album && t.album !== 'Unknown Album' ? 0 : 1,
      t.trackNo || 99,
    ];
    return [...a.tracks].sort((x, y) => {
      const rx = rank(x), ry = rank(y);
      for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) return rx[i] - ry[i];
      return x.title.localeCompare(y.title);
    });
  }
  function artistTrackRow(t, i) {
    const playing = Player.current && Player.current.id === t.id;
    const liked = Player.isLiked(t.id);
    const sub = [t.album && t.album !== 'Unknown Album' ? t.album : '', t.year || ''].filter(Boolean).join(' • ') || (t.duration ? Importer.fmtDur(t.duration) : t.artist);
    return `<div class="trow ax-track${playing ? ' playing' : ''}" data-act="play-track" data-id="${t.id}">
      <span class="ax-rank">${i + 1}</span>${artImg(t, 'art')}
      <div class="tmeta"><div class="ttitle">${esc(t.title)}</div><div class="tsub">${esc(sub)}</div></div>
      ${liked ? `<span class="ax-saved">${icon('check')}</span>` : ''}
      <button class="dotsbtn" data-act="track-menu" data-id="${t.id}" aria-label="More options">${icon('dots')}</button>
    </div>`;
  }
  function releaseRow(x) {
    const sub = `${x.kind}${x.year ? ' • ' + x.year : ''}`;
    return `<div class="ax-release" data-act="open-album" data-id="${esc(x.key)}">${artImg(x.art, 'art')}<div class="tmeta"><div class="ttitle">${esc(x.name)}</div><div class="tsub">${esc(sub)}</div></div><span class="ax-chev">${icon('chevR')}</span></div>`;
  }
  function bindArtistScroll() {
    const v = view();
    const page = v.querySelector('.ax-page');
    v.onscroll = null;
    if (!page) return;
    const top = page.querySelector('.ax-topbar');
    const topName = page.querySelector('.ax-topname');
    const hero = page.querySelector('.ax-hero-img');
    const heroText = page.querySelector('.ax-hero-text');
    const paint = () => {
      const y = Math.max(0, v.scrollTop || 0);
      const p = Math.min(1, y / 250);
      if (top) top.style.background = `rgba(18,18,18,${(p * 0.96).toFixed(2)})`;
      if (topName) topName.style.opacity = p.toFixed(2);
      if (hero) hero.style.transform = `translateY(${Math.min(70, y * 0.22)}px) scale(${1 + Math.min(0.08, y / 5000)})`;
      if (heroText) { heroText.style.opacity = Math.max(0, 1 - p * 1.15).toFixed(2); heroText.style.transform = `translateY(${Math.min(26, y * 0.12)}px)`; }
    };
    v.onscroll = paint;
    paint();
  }

  /* ---------- recents ---------- */
  async function loadRecent() {
    S.recent = await DB.kvGet('recent', []);
    S.notifSeen = await DB.kvGet('notifSeen', true);
    // Per-song play counts + last-played timestamps: the taste signal behind
    // Made by Splotify. Written on every track start, throttled to disk.
    S.playCounts = await DB.kvGet('playCounts', {});
    S.lastPlayed = await DB.kvGet('lastPlayed', {});
  }
  function logRecent(ctx) {
    if (!ctx || ctx.kind === 'single' || ctx.kind === 'search') return;
    S.recent = S.recent.filter(r => !(r.kind === ctx.kind && r.id === ctx.id));
    S.recent.unshift({ kind: ctx.kind, id: ctx.id, ts: Date.now() });
    S.recent = S.recent.slice(0, 20);
    DB.kvSet('recent', S.recent).catch(() => {});
  }
  /* ---------- play counts (Made by Splotify taste signal) ---------- */
  let playSaveT = 0;
  function logPlay(id) {
    id = Number(id);
    if (!id) return;
    S.playCounts[id] = (S.playCounts[id] || 0) + 1;
    S.lastPlayed[id] = Date.now();
    const n = Date.now();
    if (n - playSaveT > 15000) {
      playSaveT = n;
      DB.kvSet('playCounts', S.playCounts).catch(() => {});
      DB.kvSet('lastPlayed', S.lastPlayed).catch(() => {});
    }
  }
  function recentCards() {
    // resolve recents to {name, artTrack, act}
    const out = [];
    for (const r of S.recent) {
      let name = '', t = null, act = '';
      if (r.kind === 'playlist') { const p = S._pls.find(x => x.id === r.id); if (!p) continue; name = p.name; t = p.trackIds.map(id => S.byId.get(id)).find(x => x && x.art) || S.byId.get(p.trackIds[0]); act = `data-act="open-playlist" data-id="${p.id}"`; }
      else if (r.kind === 'album') { const a = albumByKey(r.id); if (!a) continue; name = a.name; t = a.art; act = `data-act="open-album" data-id="${esc(r.id)}"`; }
      else if (r.kind === 'artist') { const a = artistByName(r.id); if (!a) continue; name = a.name; t = a.art; act = `data-act="open-artist" data-id="${esc(r.id)}"`; }
      else if (r.kind === 'liked') { name = 'Liked Songs'; t = { id: 'liked', art: null }; act = `data-act="open-liked"`; }
      else if (r.kind === 'songs') { name = 'Songs'; t = S.tracks.find(x => x.art) || S.tracks[0]; act = `data-act="open-songs"`; }
      else continue;
      out.push({ name, t, act });
      if (out.length >= 8) break;
    }
    return out;
  }

  /* ---------- toast / sheet ---------- */
  let toastT = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 2200);
  }
  function openSheet(html) {
    document.getElementById('sheet-body').innerHTML = html;
    document.getElementById('sheet').classList.remove('hidden');
    document.getElementById('sheet-scrim').classList.remove('hidden');
  }
  function closeSheet() {
    document.getElementById('sheet').classList.add('hidden');
    document.getElementById('sheet-scrim').classList.add('hidden');
    // Drop any staged artwork that was never saved.
    if (S._stagedArt) { try { URL.revokeObjectURL(S._stagedArt.url); } catch (e) {} S._stagedArt = null; }
    S._artRemoved = false;
  }

  /* ---------- track rows ---------- */
  /* ---------- loading skeletons (same shapes as the real views) ---------- */
  function skelTrow() {
    return `<div class="skel-trow"><div class="skel" style="width:48px;height:48px"></div><div style="flex:1;min-width:0"><div class="skel skel-line" style="width:55%"></div><div class="skel skel-line" style="width:35%;margin-top:8px"></div></div></div>`;
  }
  function vSkeletonHome() {
    const rc = `<div class="recent-card"><div class="skel" style="width:56px;height:56px;border-radius:0"></div><div style="flex:1;padding:0 10px"><div class="skel skel-line" style="width:65%"></div></div></div>`;
    const rlc = `<div class="railcard"><div class="skel" style="width:152px;height:152px"></div><div class="skel skel-line" style="width:75%;margin-top:9px"></div><div class="skel skel-line" style="width:50%;margin-top:7px"></div></div>`;
    return `<div class="home-top"><h1>${greeting()}</h1><div class="home-icons"></div></div>
    <div class="pills"><span class="pill on">Music</span><span class="pill">Podcasts &amp; Shows</span><span class="pill">Audiobooks</span></div>
    <div class="recent-grid">${rc.repeat(4)}</div>
    <div class="morelike"><div class="skel" style="width:58px;height:58px;border-radius:50%"></div><div><div class="skel skel-line" style="width:80px"></div><div class="skel skel-line" style="width:150px;height:22px;margin-top:8px"></div></div></div>
    <div class="rail">${rlc.repeat(4)}</div>`;
  }
  function trackRow(t) {
    const playing = Player.current && Player.current.id === t.id;
    return `<div class="trow${playing ? ' playing' : ''}" data-act="play-track" data-id="${t.id}">
      ${artImg(t, 'art')}
      <div class="tmeta"><div class="ttitle">${esc(t.title)}</div><div class="tsub">${esc(t.artist)}</div></div>
      <span class="eq" style="color:var(--pink);width:18px;height:18px">${icon('eq')}</span>
      <button class="dotsbtn" data-act="track-menu" data-id="${t.id}" aria-label="More options">${icon('dots')}</button>
    </div>`;
  }

  /* ================= VIEWS ================= */
  function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }

  function vHome() {
    S.viewCtx = null;
    if (!S.tracks.length) return `<div class="home-top"><h1>${greeting()}</h1><div class="home-icons">${hicons()}</div></div>
      <div class="pills">
        <button class="pill on" data-act="import">Music</button>
        <button class="pill" data-act="import">Podcasts &amp; Shows</button>
        <button class="pill" data-act="import">Audiobooks</button>
      </div>
      <div class="empty">${icon('note', 'width:64px;height:64px;color:var(--pink)')}
      <h3>Your music lives here</h3><p>Import audio files from your iPhone and they'll play here, offline, anytime.</p>
      <button class="bigbtn pink" data-act="import">Add music</button></div>`;
    // v7.0: the SDB is not the library. Empty library gets its own state.
    const libCount = S.library.length + S._pls.length + S.followedArtists.size + Player.state.liked.size;
    if (!libCount) return `<div class="home-top"><h1>${greeting()}</h1><div class="home-icons">${hicons()}</div></div>
      <div class="empty">${icon('heart', 'width:64px;height:64px;color:var(--pink)')}
      <h3>Your library is empty</h3><p>Save the songs you love, or pull in your Spotify collection.</p>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:14px;flex-wrap:wrap"><button class="bigbtn pink" data-act="tab" data-tab="search">Search songs</button><button class="bigbtn" data-act="open-create-sheet">Create a playlist</button></div></div>
      ${madeBySplotify()}`;
    const cards = recentCards();
    // Library-first fallbacks (never the raw SDB).
    const libTracks = S.library.map(id => S.byId.get(id)).filter(Boolean);
    const libAlbumCards = albums()
      .map(a => ({ a, inLib: a.tracks.filter(t => libraryHas(t.id)) }))
      .filter(x => x.inLib.length)
      .slice(0, 8)
      .map(x => ({ name: x.a.name, t: x.a.art, act: `data-act="open-album" data-id="${esc(x.a.key)}"` }));
    const grid = cards.length ? cards : libAlbumCards.length ? libAlbumCards : S._pls.slice(0, 8).map(p => {
      const t = p.trackIds.map(id => S.byId.get(Number(id))).find(x => x && x.art);
      return { name: p.name, t, act: `data-act="open-playlist" data-id="${p.id}"` };
    });
    // more-like: top artist by library song count, else first followed artist.
    const counts = {};
    libTracks.forEach(t => { trackArtistKeys(t).forEach(k => { counts[k] = (counts[k] || 0) + 1; }); });
    const topKey = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
      || [...S.followedArtists][0];
    const ta = topKey ? (artists().find(a => artistKey(a.name) === topKey) || artistViewModel(topKey)) : null;
    const taAlbums = ta ? albums().filter(a => splitArtists(a.artist).some(p => artistKey(p) === topKey)).slice(0, 10) : [];
    return `
    <div class="home-top"><h1>${greeting()}</h1><div class="home-icons">${hicons()}</div></div>
    <div class="pills">
      <button class="pill${S.pill === 'music' ? ' on' : ''}" data-act="pill" data-id="music">Music</button>
      <button class="pill${S.pill === 'podcasts' ? ' on' : ''}" data-act="pill" data-id="podcasts">Podcasts &amp; Shows</button>
      <button class="pill${S.pill === 'audiobooks' ? ' on' : ''}" data-act="pill" data-id="audiobooks">Audiobooks</button>
    </div>
    ${S.pill !== 'music' ? `<div class="empty"><h3>Nothing here yet</h3><p>Your imported audio appears under Music.</p><button class="bigbtn" data-act="import">Add music</button></div>` : `
    <div class="recent-grid">${grid.map(c => `<div class="recent-card" ${c.act}>${artImg(c.t, '')}<span>${esc(c.name)}</span></div>`).join('')}</div>
    ${madeBySplotify()}
    ${ta && taAlbums.length ? `
    <div class="morelike">${artImg(ta.art, '')}<div><div class="k">More like</div><div class="n">${esc(ta.name)}</div></div></div>
    <div class="rail">${taAlbums.map(a => `<div class="railcard" data-act="open-album" data-id="${esc(a.key)}">${artImg(a.art, '')}<div class="t">${esc(a.name)}</div><div class="s">Album • ${esc(a.artist)}</div></div>`).join('')}</div>` : ''}
    <div class="home-spacer"></div>`}`;
  }
  function hicons() {
    return `<button class="iconbtn" data-act="open-notifs" aria-label="Notifications">${icon('bell')}${S.notifSeen ? '' : '<span class="ndot"></span>'}</button>
    <button class="iconbtn" data-act="open-history" aria-label="Listening history">${icon('history')}</button>
    <button class="iconbtn" data-act="open-settings" aria-label="Settings">${icon('gear')}</button>`;
  }

  /* v8.0 Spotify-style search ranking (pure — unit-tested in node).
     Tier: 0 exact, 1 starts-with, 2 word-starts, 3 contains, 4 no match. */
  function searchTier(name, q) {
    const n = String(name || '').toLowerCase().trim();
    if (!n || !q) return 4;
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[^a-z0-9]+/).some(w => w.startsWith(q))) return 2;
    if (n.includes(q)) return 3;
    return 4;
  }
  // list: [{name, key, followed, plays, placeholder}]. Sorted best-first.
  function rankArtistHits(q, list) {
    return [...list]
      .map(h => ({ ...h, tier: searchTier(h.name, q) }))
      .filter(h => h.tier <= 3)
      .sort((x, y) => x.tier - y.tier || (y.followed - x.followed) || y.plays - x.plays || x.name.localeCompare(y.name));
  }
  // list: [{t:{id,title,artist,album}, plays}]. Title match outranks
  // artist/album match; your play counts break ties.
  function rankSongHits(q, list) {
    return [...list]
      .map(e => {
        const tt = searchTier(e.t.title, q), at = searchTier(e.t.artist, q), alt = searchTier(e.t.album, q);
        let tier = 99;
        if (tt <= 3) tier = tt;
        else if (at <= 3) tier = 4 + at;
        else if (alt <= 3) tier = 8 + alt;
        return { ...e, tier };
      })
      .filter(e => e.tier <= 11)
      .sort((x, y) => x.tier - y.tier || y.plays - x.plays || String(x.t.title).localeCompare(String(y.t.title)));
  }
  // Top result: the artist wins when the query names them (exact or
  // starts-with); an exact song-title match with no strong artist match
  // takes it; otherwise the best artist, then the best song.
  function pickTopResult(aHits, sHits) {
    const bestA = aHits[0], bestS = sHits[0];
    if (bestA && bestA.tier <= 1) return { kind: 'artist', a: bestA };
    if (bestS && bestS.tier === 0) return { kind: 'song', s: bestS };
    if (bestA) return { kind: 'artist', a: bestA };
    if (bestS) return { kind: 'song', s: bestS };
    return null;
  }
  function vSearch() {
    const q = S.query.trim().toLowerCase();
    S.viewCtx = { kicker: 'PLAYING FROM SEARCH', name: 'Search', kind: 'search', id: 'search' };
    let body;
    if (!q) {
      const genres = {};
      S.tracks.forEach(t => { const g = t.genre || 'Unknown'; genres[g] = (genres[g] || 0) + 1; });
      const top = Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const colors = ['#8d67ab', '#e13300', '#1e3264', '#e8115b', '#148a08', '#b49bc8', '#dc148c', '#477d95'];
      body = `<div class="browse-title">Browse all</div><div class="genre-grid">${top.map(([g, n], i) =>
        `<div class="genre" style="background:${colors[i % colors.length]}" data-act="open-genre" data-id="${esc(g)}"><span>${esc(g)}</span>${icon('note')}</div>`).join('')}</div>
        <div class="trow" data-act="open-songs"><span style="display:flex;color:var(--sub)">${icon('note', 'width:30px;height:30px')}</span><div class="tmeta"><div class="ttitle">All songs</div><div class="tsub">${S.tracks.length} songs</div></div><span style="color:var(--sub);display:flex">${icon('chevR')}</span></div>
        <div class="trow" data-act="open-artists"><span style="display:flex;color:var(--sub)">${icon('person', 'width:30px;height:30px')}</span><div class="tmeta"><div class="ttitle">All artists</div><div class="tsub">${artists().length} artists</div></div><span style="color:var(--sub);display:flex">${icon('chevR')}</span></div>
        <div class="trow" data-act="open-albums"><span style="display:flex;color:var(--sub)">${icon('disc', 'width:30px;height:30px')}</span><div class="tmeta"><div class="ttitle">All albums</div><div class="tsub">${albums().length} albums</div></div><span style="color:var(--sub);display:flex">${icon('chevR')}</span></div>
        ${S.tracks.length ? '' : `<div class="empty"><h3>Search your music</h3><p>Import songs first, then find them here.</p><button class="bigbtn" data-act="import">Add music</button></div>`}`;
    } else {
      const plays = id => (S.playCounts && S.playCounts[id]) || 0;
      // v8.0: artists first, like Spotify. Derived artists (with songs) +
      // roster placeholders, ranked by match quality, follow state, plays.
      const seenA = new Set();
      const aList = [];
      artists().forEach(a => {
        const key = artistKey(a.name);
        seenA.add(key);
        aList.push({ name: a.name, key, followed: S.followedArtists.has(key),
          plays: a.tracks.reduce((sum, t) => sum + plays(t.id), 0), placeholder: false });
      });
      try {
        S.artists.forEach(ra => {
          const key = artistKey(ra.name);
          if (seenA.has(key)) return;
          seenA.add(key);
          aList.push({ name: ra.name, key, followed: S.followedArtists.has(key), plays: 0, placeholder: true });
        });
      } catch (e) {}
      const aHits = rankArtistHits(q, aList).slice(0, 8);
      // Songs underneath: title match outranks artist/album match, then plays.
      const sHits = rankSongHits(q, S.tracks.map(t => ({ t, plays: plays(t.id) }))).slice(0, 20);
      const als = albums().filter(a => (a.name + ' ' + a.artist).toLowerCase().includes(q)).slice(0, 8);
      const ps = S._pls.filter(p => p.name.toLowerCase().includes(q));
      const row = (name, sub, t, act) => `<div class="trow" ${act}>${artImg(t, 'art')}<div class="tmeta"><div class="ttitle">${esc(name)}</div><div class="tsub">${esc(sub)}</div></div></div>`;
      const artistRow = h => {
        const t = S.tracks.find(t => t.art && trackArtistKeys(t).includes(h.key));
        const art = t ? artImg(t, 'art') : `<div class="lib-thumb lib-ph round">${icon('person', 'width:26px;height:26px')}</div>`;
        return `<div class="trow" data-act="open-artist" data-id="${esc(h.name)}">${art}<div class="tmeta"><div class="ttitle">${esc(h.name)}</div><div class="tsub">Artist${h.placeholder && !h.followed ? ' \u2022 No songs yet' : ''}</div></div><button class="iconbtn" data-act="artist-follow" data-id="${esc(h.name)}" aria-label="${h.followed ? 'Unfollow' : 'Follow'}">${icon(h.followed ? 'check' : 'plus')}</button></div>`;
      };
      const top = pickTopResult(aHits, sHits);
      const topHtml = !top ? '' : `<div class="sectionhead"><h2>Top result</h2></div>` + (top.kind === 'artist'
        ? (() => {
            const t = S.tracks.find(t => t.art && trackArtistKeys(t).includes(top.a.key));
            const art = t ? artImg(t, 'top-art') : `<div class="top-art art-ph">${icon('person', 'width:44px;height:44px')}</div>`;
            return `<div class="top-result" data-act="open-artist" data-id="${esc(top.a.name)}">${art}<div class="tmeta"><div class="ttitle">${esc(top.a.name)}</div><div class="tsub">Artist</div></div><button class="bigbtn ${top.a.followed ? '' : 'pink'}" data-act="artist-follow" data-id="${esc(top.a.name)}">${top.a.followed ? 'Following' : 'Follow'}</button></div>`;
          })()
        : trackRow(top.s.t));
      body = `${topHtml}
      ${aHits.length ? `<div class="sectionhead"><h2>Artists</h2></div>${aHits.map(artistRow).join('')}` : ''}
      ${sHits.length ? `<div class="sectionhead"><h2>Songs</h2></div>${sHits.map(e => trackRow(e.t)).join('')}` : ''}
      ${als.length ? `<div class="sectionhead"><h2>Albums</h2></div>${als.map(a => row(a.name, 'Album \u2022 ' + a.artist, a.art, `data-act="open-album" data-id="${esc(a.key)}"`)).join('')}` : ''}
      ${ps.length ? `<div class="sectionhead"><h2>Playlists</h2></div>${ps.map(p => { const t = p.trackIds.map(id => S.byId.get(id)).find(x => x); return row(p.name, `Playlist \u2022 ${p.trackIds.length} songs`, t, `data-act="open-playlist" data-id="${p.id}"`); }).join('')}` : ''}
      ${(!aHits.length && !sHits.length && !als.length && !ps.length) ? `<div class="empty"><h3>No results for "${esc(S.query)}"</h3><p>Check the spelling, or try an artist or song title.</p></div>` : ''}`;
    }
    return `<div class="searchbox">${icon('search')}<input id="q" placeholder="What do you want to listen to?" value="${esc(S.query)}" autocomplete="off"></div>${body}`;
  }

  /* v7.0 library: Spotify-style. Header (avatar/title/search/+), filter
     chips, sort + grid toggle, pinned Liked Songs, then the library's
     playlists, followed artists, and albums. The SDB never appears here. */
  function libItems() {
    const items = [];
    const q = (S.libQ || '').trim().toLowerCase();
    const match = name => !q || String(name || '').toLowerCase().includes(q);
    const chip = S.libChip || 'all';
    const likedN = Player.state.liked.size;
    if (match('liked songs')) items.push({ kind: 'liked', id: 'liked', name: 'Liked Songs', sub: 'Playlist \u2022 ' + likedN + ' song' + (likedN === 1 ? '' : 's'), pinned: true, ts: Infinity, act: 'data-act="open-liked"' });
    if (chip === 'all' || chip === 'playlists') {
      for (const p of S._pls) {
        if (!match(p.name)) continue;
        const n = (p.trackIds || []).length;
        items.push({ kind: 'playlist', id: p.id, name: p.name, sub: 'Playlist \u2022 ' + n + ' song' + (n === 1 ? '' : 's'), ts: p.created || 0, act: 'data-act="open-playlist" data-id="' + p.id + '"', pl: p });
      }
    }
    if (chip === 'all' || chip === 'artists') {
      S.artists.forEach(a => {
        if (!a.followed || !match(a.name)) return;
        items.push({ kind: 'artist', id: a.name, name: a.name, sub: 'Artist', ts: a.followedAt || 0, act: 'data-act="open-artist" data-id="' + esc(a.name) + '"', artist: a });
      });
    }
    if (chip === 'all' || chip === 'albums') {
      for (const al of albums()) {
        const inLib = al.tracks.filter(t => libraryHas(t.id));
        if (!inLib.length || !match(al.name)) continue;
        items.push({ kind: 'album', id: al.key, name: al.name, sub: 'Album \u2022 ' + al.artist, ts: Math.max.apply(null, inLib.map(t => t.dateAdded || 0)), act: 'data-act="open-album" data-id="' + esc(al.key) + '"', albumTracks: inLib });
      }
    }
    const pinned = items.filter(i => i.pinned);
    const rest = items.filter(i => !i.pinned);
    if (S.libSort === 'az') rest.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    else rest.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return pinned.concat(rest);
  }
  function libThumb(it) {
    if (it.kind === 'liked') return '<div class="liked-heart-tile lib-liked">' + icon('heartF') + '</div>';
    let arts = [];
    if (it.kind === 'playlist' && it.pl) arts = it.pl.trackIds.map(id => S.byId.get(Number(id))).filter(t => t && t.art);
    else if (it.kind === 'album' && it.albumTracks) arts = it.albumTracks.filter(t => t.art);
    else if (it.kind === 'artist') { const t = S.tracks.find(t => t.art && trackArtistKeys(t).includes(artistKey(it.name))); if (t) arts = [t]; }
    const round = it.kind === 'artist' ? ' round' : '';
    if (arts.length >= 4) return '<div class="lib-mosaic' + round + '">' + arts.slice(0, 4).map(t => '<img src="' + artURL(t) + '" alt="" onerror="App.artErr(this)">').join('') + '</div>';
    if (arts.length) return '<img class="lib-thumb' + round + '" src="' + artURL(arts[0]) + '" alt="" onerror="App.artErr(this)">';
    return '<div class="lib-thumb lib-ph' + round + '">' + icon(it.kind === 'artist' ? 'person' : 'note', 'width:26px;height:26px') + '</div>';
  }
  function libRow(it) {
    const pin = it.pinned ? '<span class="lib-pin">' + icon('pin') + '</span>' : '';
    return '<div class="trow" ' + it.act + '>' + libThumb(it) + '<div class="tmeta"><div class="ttitle">' + esc(it.name) + '</div><div class="tsub">' + pin + esc(it.sub) + '</div></div></div>';
  }
  function libCard(it) {
    return '<div class="lib-card" ' + it.act + '>' + libThumb(it) + '<div class="tmeta"><div class="ttitle">' + esc(it.name) + '</div><div class="tsub">' + esc(it.sub) + '</div></div></div>';
  }
  function vLibrary() {
    S.viewCtx = null;
    const items = libItems();
    const chips = [['playlists', 'Playlists'], ['artists', 'Artists'], ['albums', 'Albums']];
    const body = !items.length
      ? '<div class="empty" style="padding:36px 24px"><h3>Your library is empty</h3><p>Save songs you love, or create your first playlist.</p><div style="display:flex;gap:10px;justify-content:center;margin-top:14px;flex-wrap:wrap"><button class="bigbtn pink" data-act="open-create-sheet">Create a playlist</button><button class="bigbtn" data-act="tab" data-tab="search">Search songs</button></div></div>'
      : (S.libGrid ? '<div class="lib-grid">' + items.map(libCard).join('') + '</div>' : items.map(libRow).join(''));
    return '<div class="lib-head"><div class="lib-avatar">' + icon('person', 'width:22px;height:22px') + '</div><h1 style="text-align:left">Your Library</h1>'
      + '<button class="iconbtn" data-act="lib-search" aria-label="Search library">' + icon('search') + '</button>'
      + '<button class="iconbtn" data-act="open-create-sheet" aria-label="Create">' + icon('plus') + '</button></div>'
      + (S.libSearching ? '<div class="lib-filter"><input id="lib-q" placeholder="Search your library" value="' + esc(S.libQ) + '" autocomplete="off" autocapitalize="off" spellcheck="false"></div>' : '')
      + '<div class="lib-chips">' + chips.map(c => '<button class="lib-chip' + (S.libChip === c[0] ? ' on' : '') + '" data-act="lib-chip" data-id="' + c[0] + '">' + c[1] + '</button>').join('') + '</div>'
      + '<div class="lib-sortrow"><button class="lib-sortbtn" data-act="lib-sort">' + icon('sortArrows') + '<span>' + (S.libSort === 'az' ? 'A to Z' : 'Recents') + '</span></button><span style="flex:1"></span>'
      + '<button class="iconbtn" data-act="lib-view" aria-label="Toggle view">' + icon(S.libGrid ? 'listV' : 'grid', 'width:22px;height:22px') + '</button></div>'
      + body;
  }
  /* Create sheet (v7.0): shared by the library + button and the Create tab. */
  function openCreateSheet() {
    openSheet('<div style="padding:10px 4px 24px"><h3 style="margin:4px 20px 12px;font-size:17px">Create</h3>'
      + '<div class="sheet-item" data-act="create-playlist"><img src="icons/create-tile.svg" style="width:46px;height:46px;border-radius:10px;flex:none" alt=""><span><b>Playlist</b><div class="sub">Create a new playlist</div></span></div></div>');
  }
  function openPlaylistNameSheet() {
    openSheet('<div style="padding:6px 20px 24px"><h3 style="margin:8px 0 14px;font-size:17px">Name your playlist</h3>'
      + '<input id="newpl-name" placeholder="My playlist" maxlength="60" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:100%;box-sizing:border-box;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 14px;color:var(--txt);font-size:16px" />'
      + '<button class="bigbtn pink" data-act="do-create-playlist" style="width:100%;margin-top:16px">Create</button></div>');
    setTimeout(() => { const i = document.getElementById('newpl-name'); if (i) i.focus(); }, 60);
  }

  function heroArt(t, round) {
    if (t && t.art) return `<img class="hero-art${round ? ' round' : ''}" src="${artURL(t)}" alt="" onerror="App.artErr(this)">`;
    return `<div class="hero-art${round ? ' round' : ''} art-ph" style="display:flex;align-items:center;justify-content:center">${icon('note', 'width:72px;height:72px')}</div>`;
  }
  function detailHead(backAct, artHTML, title, meta) {
    return `<div class="detail-hero"><button class="iconbtn back" data-act="${backAct}" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button>${artHTML}<h1>${esc(title)}</h1><div class="meta">${meta}</div></div>`;
  }
  function playRow(extra) {
    const extraHTML = typeof extra === 'string' ? extra : '';
    return `<div class="detail-actions"><div class="rowbtns"><button class="playfab" data-act="play-all" aria-label="Play">${icon('play')}</button></div>
    <div class="rowbtns"><button class="shufflebtn" data-act="shuffle-all">${icon('shuffle', 'width:22px;height:22px')} Shuffle</button>${extraHTML}</div></div>`;
  }

  function vPlaylist(id) {
    const p = S._pls.find(x => x.id === id);
    if (!p) return vLibrary();
    const ts = p.trackIds.map(x => S.byId.get(x)).filter(Boolean);
    const arts = ts.filter(t => t.art).slice(0, 4);
    const artHTML = arts.length >= 4
      ? `<div class="hero-art" style="display:grid;grid-template-columns:1fr 1fr;overflow:hidden">${arts.map(t => `<img src="${artURL(t)}" style="width:104px;height:104px;object-fit:cover" onerror="App.artErr(this)">`).join('')}</div>`
      : arts.length ? `<img class="hero-art" src="${artURL(arts[0])}" alt="" onerror="App.artErr(this)">` : `<div class="hero-art art-ph" style="display:flex;align-items:center;justify-content:center">${icon('note', 'width:72px;height:72px')}</div>`;
    S.viewCtx = { kicker: 'PLAYING FROM PLAYLIST', name: p.name, kind: 'playlist', id: p.id };
    return detailHead('go-back', artHTML, p.name, `Playlist • ${ts.length} song${ts.length === 1 ? '' : 's'}`)
      + playRow(p.trackIds)
      + (ts.length ? ts.map(t => trackRow(t)).join('') : `<div class="empty"><p>This playlist is empty.</p><button class="bigbtn" data-act="open-songs">Find songs</button></div>`)
      + `<div class="sectionhead"><h2></h2><button data-act="delete-playlist" data-id="${p.id}" style="color:#ff7b7b">DELETE PLAYLIST</button></div>`;
  }
  function vAlbum(key) {
    const a = albumByKey(key);
    if (!a) return vLibrary();
    S.viewCtx = { kicker: 'PLAYING FROM ALBUM', name: a.name, kind: 'album', id: a.key };
    return detailHead('go-back', heroArt(a.art), a.name, `${a.single ? 'Single' : 'Album'} • ${esc(a.artist)} • ${a.tracks.length} song${a.tracks.length === 1 ? '' : 's'}`)
      + playRow(`<button class="shufflebtn" data-act="fix-album" data-id="${esc(key)}">${icon('tag', 'width:18px;height:18px')} utag</button>`)
      + (S.fixing === key ? skelTrow().repeat(Math.max(a.tracks.length, 4)) : a.tracks.map(t => trackRow(t)).join(''));
  }
  function vArtist(name) {
    const a = artistViewModel(name);
    if (!a) return vLibrary();
    S.viewCtx = { kicker: 'PLAYING FROM ARTIST', name: a.name, kind: 'artist', id: a.name };
    const akey = artistKey(a.name);
    if (S.artistFor !== akey) { S.artistFor = akey; S.artistTab = 'music'; S.artistExpanded = false; S.artistReleasesExpanded = false; S.artistFilter = 'all'; }
    const stats = artistStats(a.name);
    const hero = artistHeroSrc(a);
    const top = artistTopTracks(a);
    const shownTop = (S.artistExpanded ? top.slice(0, 10) : top.slice(0, 5));
    const rels = artistReleases(a);
    const shownRels = S.artistReleasesExpanded ? rels : rels.slice(0, 4);
    const following = S.followedArtists.has(akey);
    const isCurrent = Player.current && Player.state.ctx && Player.state.ctx.kind === 'artist' && Player.state.ctx.id === a.name;
    const playIcon = isCurrent && Player.isPlaying ? 'pause' : 'play';
    const featPlaylists = (S._pls || []).filter(p => p.trackIds.some(tid => { const t = S.byId.get(tid); return t && trackArtistKeys(t).includes(akey); }));
    const fans = artists().filter(x => artistKey(x.name) !== akey).sort((x, y) => y.tracks.length - x.tracks.length).slice(0, 8);
    const statLine = stats ? fmtListeners(stats.listeners) : `${a.tracks.length} song${a.tracks.length === 1 ? '' : 's'}`;
    const music = `
      <div class="sectionhead ax-section"><h2>Popular</h2></div>
      ${shownTop.map((t, i) => artistTrackRow(t, i)).join('')}
      ${top.length > 5 ? `<button class="ax-more" data-act="artist-toggle-popular">${S.artistExpanded ? 'See less' : 'See more'} <span class="${S.artistExpanded ? 'up' : ''}">${icon('chevD')}</span></button>` : ''}
      <button class="ax-discog" data-act="open-artist-releases" data-id="${esc(a.name)}">See discography ${icon('chevR')}</button>
      ${rels.length ? `<div class="sectionhead ax-section"><h2>Popular Releases</h2></div>
      <div class="ax-expand ${S.artistReleasesExpanded ? 'open' : ''}">${shownRels.map(releaseRow).join('')}</div>
      ${rels.length > 4 ? `<button class="ax-more" data-act="artist-toggle-releases">${S.artistReleasesExpanded ? 'Show less' : 'Show all'} <span class="${S.artistReleasesExpanded ? 'up' : ''}">${icon('chevD')}</span></button>` : ''}` : ''}
      ${featPlaylists.length || top.length ? `<div class="sectionhead ax-section"><h2>Featuring ${esc(a.name)}</h2></div><div class="ax-cards">
        <div class="ax-this" data-act="artist-play" data-id="${esc(a.name)}">${artImg(top[0] || a.art, '')}<div><b>This Is ${esc(a.name)}</b><span>The essentials, all in one place.</span></div></div>
        ${featPlaylists.map(p => { const t = p.trackIds.map(tid => S.byId.get(tid)).find(Boolean); return `<div class="ax-card" data-act="open-playlist" data-id="${p.id}">${artImg(t, '')}<div class="t">${esc(p.name)}</div><div class="s">Playlist</div></div>`; }).join('')}
      </div>` : ''}
      ${fans.length ? `<div class="sectionhead ax-section"><h2>Fans also like</h2></div><div class="ax-cards artists">${fans.map(x => `<div class="ax-card" data-act="open-artist" data-id="${esc(x.name)}"><div class="ax-round">${artImg(x.art, '')}</div><div class="t">${esc(x.name)}</div><div class="s">Artist</div></div>`).join('')}</div>` : ''}
      <div class="sectionhead ax-section"><h2>About</h2></div>
      <div class="ax-about" ${hero ? `style="background-image:linear-gradient(180deg,rgba(0,0,0,.08),rgba(0,0,0,.88)),url('${esc(hero)}')"` : ''}>
        <div class="ax-about-name">${esc(a.name)}</div>
        ${stats ? `<div class="ax-about-stat">${fmtInt(stats.listeners)} monthly listeners</div><div class="ax-about-sub">#${fmtInt(stats.rank)} worldwide on Spotify</div>` : `<div class="ax-about-stat">${a.tracks.length} songs in your library</div>`}
        <div class="ax-about-sub">${a.tracks.length} song${a.tracks.length === 1 ? '' : 's'} • ${rels.length} release${rels.length === 1 ? '' : 's'} in Splotify</div>
        ${stats ? `<div class="ax-source">Stats from Kworb • fetched ${esc(stats.meta.fetched || '')}</div>` : ''}
      </div>`;
    const clips = `<div class="ax-empty">${icon('playRect', 'width:58px;height:58px')}<h3>No clips here yet</h3><p>Clips from ${esc(a.name)} will sit on this tab when video lives in your library.</p></div>`;
    return `<div class="ax-page">
      <header class="ax-topbar"><button class="ax-back" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><div class="ax-topname">${esc(a.name)}</div><span class="ax-topsp"></span></header>
      <section class="ax-hero">${hero ? `<img class="ax-hero-img" src="${esc(hero)}" alt="" onerror="App.artErr(this)">` : `<div class="ax-hero-img ax-hero-fallback">${icon('note', 'width:86px;height:86px')}</div>`}<div class="ax-hero-shade"></div>
        <div class="ax-hero-text"><h1>${esc(a.name)}</h1>${stats ? `<div class="ax-verified"><span>${icon('check')}</span>Verified artist</div>` : ''}</div>
      </section>
      <div class="ax-stat">${esc(statLine)}</div>
      <div class="ax-actions">
        <div class="ax-avatar">${artImg(a.art, '')}</div>
        <button class="ax-follow ${following ? 'on' : ''}" data-act="artist-follow" data-id="${esc(a.name)}">${following ? 'Following' : 'Follow'}</button>
        <button class="ax-menu" data-act="artist-menu" data-id="${esc(a.name)}" aria-label="Artist options">${icon('dots')}</button>
        <span class="ax-flex"></span>
        <button class="ax-shuffle ${Player.state.shuffle ? 'on' : ''}" data-act="artist-shuffle" data-id="${esc(a.name)}" aria-label="Shuffle">${icon('shuffle')}</button>
        <button class="ax-play" data-act="artist-play" data-id="${esc(a.name)}" aria-label="Play">${icon(playIcon)}</button>
      </div>
      <nav class="ax-tabs"><button class="${S.artistTab === 'music' ? 'on' : ''}" data-act="artist-tab" data-id="music">Music</button><button class="${S.artistTab === 'clips' ? 'on' : ''}" data-act="artist-tab" data-id="clips">Clips</button></nav>
      ${S.artistTab === 'clips' ? clips : music}
      <div class="ax-bottom"></div>
    </div>`;
  }
  function vArtistReleases(name) {
    const a = artistViewModel(name);
    if (!a) return vLibrary();
    S.viewCtx = { kicker: 'PLAYING FROM ARTIST', name: a.name, kind: 'artist', id: a.name };
    const rels = artistReleases(a);
    const groups = [['albums', 'Albums'], ['singles', 'Singles and EPs'], ['compilations', 'Compilations'], ['featured', 'Featured on']];
    const filters = [['all', 'All'], ...groups.filter(([g]) => rels.some(x => x.group === g))];
    if (!filters.some(([g]) => g === S.artistFilter)) S.artistFilter = 'all';
    const list = S.artistFilter === 'all' ? rels : rels.filter(x => x.group === S.artistFilter);
    const allTracks = [...a.tracks].sort((x, y) => String(x.album || '').localeCompare(String(y.album || '')) || (x.trackNo || 99) - (y.trackNo || 99) || x.title.localeCompare(y.title));
    const releaseBody = groups.map(([g, label]) => {
        const xs = rels.filter(x => x.group === g);
        return xs.length ? `<div class="sectionhead ax-section"><h2>${label}</h2></div>${xs.map(releaseRow).join('')}` : '';
      }).join('');
    const body = S.artistFilter === 'all'
      ? releaseBody + (allTracks.length ? `<div class="sectionhead ax-section"><h2>All songs</h2></div>${allTracks.map((t, i) => artistTrackRow(t, i)).join('')}` : '')
      : list.map(releaseRow).join('');
    return `<div class="ax-page releases">
      <header class="ax-relbar"><button class="ax-back solid" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><div><h1>Releases</h1><p>${esc(a.name)}</p></div><span></span></header>
      <div class="ax-chips">${filters.map(([g, label]) => `<button class="${S.artistFilter === g ? 'on' : ''}" data-act="artist-filter" data-id="${g}">${label}</button>`).join('')}</div>
      ${body || `<div class="empty"><h3>No releases found</h3><p>Releases for ${esc(a.name)} will appear here.</p></div>`}
      <div class="ax-bottom"></div>
    </div>`;
  }
  function vLiked() {
    const ids = [...Player.state.liked].map(Number).filter(id => S.byId.has(id)).reverse();
    S.viewCtx = { kicker: 'PLAYING FROM PLAYLIST', name: 'Liked Songs', kind: 'liked', id: 'liked' };
    return detailHead('go-back', `<div class="liked-heart-tile">${icon('heartF')}</div>`, 'Liked Songs', `${ids.length} song${ids.length === 1 ? '' : 's'}`)
      + (ids.length ? playRow(ids) + ids.map(id => trackRow(S.byId.get(id))).join('') : `<div class="empty">${icon('heart', 'width:64px;height:64px;color:var(--pink)')}<h3>Songs you like will live here</h3></div>`);
  }
  function vSongs() {
    const ts = [...S.tracks].sort((a, b) => a.title.localeCompare(b.title));
    S.viewCtx = { kicker: 'PLAYING FROM SONGS', name: 'Songs', kind: 'songs', id: 'songs' };
    // All songs browser: no play-all/shuffle-all — this is browsable, never a play context.
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Songs</h1><button class="iconbtn" data-act="import" aria-label="Add music">${icon('plus')}</button></div>`
      + (ts.length ? `<div class="sdb-note">Tap a song to play it, or save it to your library from \u22ef</div>` + ts.map(t => trackRow(t)).join('') : `<div class="empty"><h3>No songs yet</h3><button class="bigbtn pink" data-act="import">Add music</button></div>`);
  }
  function vPlaylists() {
    const likedN = Player.state.liked.size;
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Playlists</h1><button class="iconbtn" data-act="create-playlist" aria-label="New playlist">${icon('plus')}</button></div>
    <div class="trow" data-act="open-liked"><div class="liked-heart-tile" style="width:56px;height:56px">${icon('heartF', 'width:30px;height:30px')}</div><div class="tmeta"><div class="ttitle">Liked Songs</div><div class="tsub">Playlist • ${likedN} song${likedN === 1 ? '' : 's'}</div></div></div>
    ${S._pls.map(p => { const t = S.byId.get(p.trackIds[0]); return `<div class="trow" data-act="open-playlist" data-id="${p.id}">${artImg(t, 'art')}<div class="tmeta"><div class="ttitle">${esc(p.name)}</div><div class="tsub">Playlist • ${p.trackIds.length} songs</div></div></div>`; }).join('')}`;
  }
  function vAlbums() {
    const als = albums();
    const reg = als.filter(a => !a.single), sng = als.filter(a => a.single);
    const row = a => `<div class="trow" data-act="open-album" data-id="${esc(a.key)}">${artImg(a.art, 'art')}<div class="tmeta"><div class="ttitle">${esc(a.name)}</div><div class="tsub">${a.single ? 'Single' : 'Album'} • ${esc(a.artist)}</div></div></div>`;
    const body = reg.map(row).join('') + (sng.length ? `<div class="sectionhead"><h2>Singles</h2></div>` + sng.map(row).join('') : '');
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Albums</h1><span style="width:44px"></span></div>
    ${body || `<div class="empty"><p>No albums yet.</p></div>`}`;
  }
  function vArtists() {
    const as = artists();
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Artists</h1><span style="width:44px"></span></div>
    ${as.map(a => `<div class="trow" data-act="open-artist" data-id="${esc(a.name)}"><div class="art" style="border-radius:50%;overflow:hidden">${artImg(a.art, '')}</div><div class="tmeta"><div class="ttitle">${esc(a.name)}</div><div class="tsub">Artist</div></div></div>`).join('') || `<div class="empty"><p>No artists yet.</p></div>`}`;
  }
  /* ================= Made by Splotify =================
     Curated playlists, computed on render from local signals only:
     play counts, last-played, follows, genres, recency. Week/day-seeded
     so a mix is stable inside its refresh window. Cold start (no plays)
     = unbiased samplers across the collection; taste weighting grows
     as listening accumulates. */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function weekSeed() {
    const d = new Date(), onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    return d.getFullYear() * 100 + week;
  }
  function daySeed() { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
  function seededSample(rng, arr, n) {
    const a = arr.slice(), out = [];
    while (a.length && out.length < n) out.push(a.splice(Math.floor(rng() * a.length), 1)[0]);
    return out;
  }
  function tasteProfile() {
    const aW = {}, gW = {};
    let total = 0;
    for (const t of S.tracks) {
      const n = (S.playCounts && S.playCounts[t.id]) || 0;
      if (!n) continue;
      total += n;
      trackArtistKeys(t).forEach(k => { aW[k] = (aW[k] || 0) + n; });
      const g = String(t.genre || '').trim();
      if (g) gW[g] = (gW[g] || 0) + n;
    }
    const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(e => e[0]);
    return { topArtists: top(aW).slice(0, 12), topGenres: top(gW).slice(0, 8), totalPlays: total };
  }
  function mixSub(ts) {
    const c = {};
    ts.forEach(t => {
      const a = String(t.artist || '').split(',')[0].trim();
      if (a && !/^unknown/i.test(a)) c[a] = (c[a] || 0) + 1;
    });
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]).join(', ');
  }
  function dailyMixGenres() {
    const c = {};
    for (const t of S.tracks) {
      const g = String(t.genre || '').trim();
      if (!g || /^unknown$/i.test(g)) continue;
      c[g] = (c[g] || 0) + 1 + 3 * ((S.playCounts && S.playCounts[t.id]) || 0);
    }
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]);
  }
  function decadeGroups() {
    const groups = {};
    for (const t of S.tracks) {
      const y = parseInt(String(t.year || '').slice(0, 4), 10);
      if (!y || y < 1950 || y > 2100) continue;
      const d = Math.floor(y / 10) * 10;
      (groups[d] = groups[d] || []).push(t);
    }
    return Object.entries(groups)
      .filter(([, ts]) => ts.length >= 5)
      .sort((a, b) => b[0] - a[0])
      .map(([d, ts]) => [Number(d), ts]);
  }
  const MIX_BANNERS = ['#c9a7eb', '#a8e6b0', '#f5c518', '#f49ac1', '#9ecfff', '#ffb37e'];
  function curatedMixes() {
    if (!S.tracks.length) return [];
    const taste = tasteProfile();
    const mixes = [
      { id: 'discover-weekly', name: 'Discover Weekly', kind: 'discover', banner: MIX_BANNERS[0] },
      { id: 'release-radar', name: 'Release Radar', kind: 'radar', banner: MIX_BANNERS[1] },
    ];
    if (taste.totalPlays > 0) mixes.push({ id: 'on-repeat', name: 'On Repeat', kind: 'repeat', banner: MIX_BANNERS[3] });
    dailyMixGenres().forEach((g, i) => mixes.push({ id: 'dailymix-' + i, name: g + ' Mix', kind: 'dailymix', genre: g, banner: MIX_BANNERS[(i + 2) % MIX_BANNERS.length] }));
    decadeGroups().forEach(([dec], i) => mixes.push({ id: 'decade-' + dec, name: dec + 's Mix', kind: 'decade', decade: dec, banner: MIX_BANNERS[(i + 4) % MIX_BANNERS.length] }));
    return mixes;
  }
  function curatedTracks(mix) {
    const rng = mulberry32((mix.kind === 'dailymix' ? daySeed() : weekSeed()) + hashStr(mix.id));
    const taste = tasteProfile();
    const plays = id => (S.playCounts && S.playCounts[id]) || 0;
    switch (mix.kind) {
      case 'discover': {
        const unplayed = S.tracks.filter(t => !plays(t.id));
        const pool = unplayed.length ? unplayed : S.tracks;
        return pool.map(t => {
          let s = rng();
          if (trackArtistKeys(t).some(k => taste.topArtists.includes(k))) s += 2;
          const g = String(t.genre || '').trim();
          if (g && taste.topGenres.includes(g)) s += 1.5;
          return [s, t];
        }).sort((a, b) => b[0] - a[0]).slice(0, 30).map(e => e[1]);
      }
      case 'radar': {
        const tier = t => {
          const aks = trackArtistKeys(t);
          if (aks.some(k => S.followedArtists.has(k))) return 2;
          if (aks.some(k => taste.topArtists.includes(k))) return 1;
          return 0;
        };
        return [...S.tracks]
          .sort((a, b) => (tier(b) - tier(a)) || ((b.dateAdded || 0) - (a.dateAdded || 0)))
          .slice(0, 30);
      }
      case 'repeat': {
        return S.tracks.filter(t => plays(t.id) > 0)
          .sort((a, b) => (plays(b.id) - plays(a.id)) || ((S.lastPlayed[b.id] || 0) - (S.lastPlayed[a.id] || 0)))
          .slice(0, 30);
      }
      case 'dailymix': {
        const inG = S.tracks.filter(t => String(t.genre || '').trim() === mix.genre);
        const fam = inG.filter(t => plays(t.id) > 0).sort((a, b) => plays(b.id) - plays(a.id));
        const fresh = inG.filter(t => !(plays(t.id) > 0));
        const n = Math.min(30, inG.length);
        const nFam = Math.min(fam.length, Math.round(n * 0.7));
        const nFresh = Math.min(fresh.length, n - nFam);
        // No fresh tracks to round it out? Top up with more familiar ones.
        const topUp = Math.min(fam.length - nFam, n - nFam - nFresh);
        const pick = fam.slice(0, nFam + topUp).concat(seededSample(rng, fresh, nFresh));
        return seededSample(rng, pick, pick.length);
      }
      case 'decade': {
        const g = decadeGroups().find(([d]) => d === mix.decade);
        if (!g) return [];
        return seededSample(rng, g[1], Math.min(50, g[1].length));
      }
    }
    return [];
  }
  function mixTracksArts(mix, n) {
    const tracks = curatedTracks(mix);
    const urls = [];
    for (const t of tracks) {
      const u = artURL(t);
      if (u && !urls.includes(u)) urls.push(u);
      if (urls.length >= n) break;
    }
    return { tracks, urls };
  }
  function mixArtInner(mix, urls) {
    const inner = urls.length >= 4
      ? `<div class="mixmosaic">${urls.slice(0, 4).map(u => `<img src="${u}" alt="" loading="lazy" onerror="App.artErr(this)">`).join('')}</div>`
      : urls.length
        ? `<img class="mixsingle" src="${urls[0]}" alt="" loading="lazy" onerror="App.artErr(this)">`
        : `<div class="mixph">${icon('note', 'width:52px;height:52px')}</div>`;
    return `${inner}<div class="mixbanner" style="background:${mix.banner}">${esc(mix.name)}</div><div class="mixlogo"><img src="icons/icon-192.png" alt=""></div>`;
  }
  function mixCard(mix) {
    const { tracks, urls } = mixTracksArts(mix, 4);
    if (!tracks.length) return '';
    const sub = mixSub(tracks) || 'Made by Splotify';
    return `<div class="mixcard" data-act="open-curated" data-id="${mix.id}"><div class="mixart">${mixArtInner(mix, urls)}</div><div class="t">${esc(mix.name)}</div><div class="s">${esc(sub)}</div></div>`;
  }
  function madeBySplotify() {
    const mixes = curatedMixes();
    if (!mixes.length) return '';
    const cards = mixes.map(mixCard).filter(Boolean).join('');
    if (!cards) return '';
    return `<div class="sectionhead"><h2>Made by Splotify</h2></div><div class="rail">${cards}</div>`;
  }
  function vCurated(id) {
    const mix = curatedMixes().find(m => m.id === id);
    if (!mix) return vHome();
    const { tracks, urls } = mixTracksArts(mix, 4);
    const ids = tracks.map(t => t.id);
    S.viewCtx = { kicker: 'PLAYING FROM PLAYLIST', name: mix.name, kind: 'curated', id: mix.id };
    return detailHead('go-back', `<div class="mixart hero">${mixArtInner(mix, urls)}</div>`, mix.name, `Playlist \u2022 ${ids.length} song${ids.length === 1 ? '' : 's'} \u2022 Made by Splotify`)
      + (ids.length ? playRow(ids) + tracks.map(t => trackRow(t)).join('') : `<div class="empty"><h3>Nothing here yet</h3><p>Play some music and this mix will fill in.</p></div>`);
  }
  function vStub(title, ic, msg) {
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>${title}</h1><span style="width:44px"></span></div>
    <div class="empty">${icon(ic, 'width:64px;height:64px;color:var(--sub)')}<h3>${title}</h3><p>${msg}</p></div>`;
  }
  function vSettings() {
    const n = S.tracks.length;
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Settings</h1><span style="width:44px"></span></div>
    <div class="setgroup"><h2>Music</h2>
      <div class="setrow" data-act="import"><div>Add music to the SDB<div class="sub">Import audio files from the Files app</div></div><span style="color:var(--sub)">${icon('plus')}</span></div>
      <div class="setrow" data-act="import-zip"><div>Import ZIP<div class="sub">Pull the songs out of a zip file</div></div><span style="color:var(--sub)">${icon('download')}</span></div>
      <div class="setrow" data-act="export-hub"><div>Export music<div class="sub">Back up your songs to a link or Google Drive</div></div><span style="color:var(--sub)">${icon('download')}</span></div>
      <div class="setrow" data-act="open-spotify-import"><div>Import from Spotify<div class="sub" id="spimport-sub">Playlists, Liked Songs &amp; followed artists</div></div><span style="color:var(--sub)">${icon('download')}</span></div>
      <div class="setrow" data-act="open-plimport"><div>Download Spotify playlist<div class="sub" id="plimport-sub">Turn a playlist into SDB downloads</div></div><span style="color:var(--sub)">${icon('download')}</span></div>
      <div class="setrow" data-act="fix-all-tags"><div>utag fixer<div class="sub">Retag your library, watch it work, edit tags by hand</div></div><span style="color:var(--sub)">${icon('tag')}</span></div>
      <div class="setrow"><div>Songs in library<div class="sub" id="set-storage">Counting…</div></div><span style="color:var(--sub)">${n}</span></div>
    </div>
    <div class="setgroup"><h2>Playback</h2>
      <div class="setrow" data-act="clear-recent"><div>Clear recently played</div></div>
    </div>
    <div class="setgroup"><h2>Metadata</h2>
      <div class="setrow"><div>fanart.tv API key<div class="sub">Extra artwork source for the utag fixer — stored only on this iPhone, never uploaded</div></div></div>
      <div style="padding:0 16px 14px"><input id="fanart-key" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Paste key here" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:15px"></div>
      <div class="setrow"><div>AcoustID API key<div class="sub">Last-resort song ID for the utag fixer (identifies songs by sound when tags and filenames are both useless) — stored only on this iPhone, never uploaded</div></div></div>
      <div style="padding:0 16px 14px"><input id="acoustid-key" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Paste key here" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:15px"></div>
    </div>
    <div class="setgroup"><h2>App</h2>
      <div class="setrow" id="update-row" data-act="check-update"><div>App updates<div class="sub" id="update-sub">Checking for updates…</div></div><span class="updpill" id="update-pill">…</span></div>
    </div>
    <div class="setgroup"><h2>About</h2>
      <div class="setrow"><div>Splotify<div class="sub">Your files never leave this iPhone. Works offline.</div></div></div>
      <div class="setrow"><a href="privacy.html" style="color:inherit;text-decoration:none;width:100%">Privacy Policy</a></div>
      <div class="setrow"><a href="terms.html" style="color:inherit;text-decoration:none;width:100%">Terms of Use</a></div>
      <div class="setrow" data-act="wipe" style="color:#ff7b7b"><div>Delete all music &amp; data</div></div>
    </div>`;
  }
  /* ---- Library export: one streamed backup ZIP of every saved track ----
     Entries are stored (no compression), written one track at a time with a
     chunked CRC pass, so memory stays flat no matter how big the library is. */
  const CRC_TAB = (() => { const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c; } return t; })();
  function zipClean(s, fallback) {
    s = String(s || '').replace(/[\\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/\.+$/, '');
    return s || fallback;
  }
  function dosStamp(d, wantTime) {
    if (wantTime) return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  }
  let exporting = false, exportCancel = false, exportUserPaused = false;
  /* Build one ZIP blob from a list of tracks: stored entries, one track at a
     time, chunked CRC — memory stays flat no matter the part size. */
  async function buildZipBlob(list, ui) {
    const parts = []; const central = []; let offset = 0; const used = new Set();
    const enc = new TextEncoder();
    const push = u8 => { parts.push(u8); offset += u8.length; };
    let done = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i], f = t.file;
      if (exportCancel) throw new Error('cancelled');
      ui(i, list.length, done);
      /* chunked CRC pass: file bytes are never held in full */
      let crc = 0xFFFFFFFF;
      const CH = 1024 * 1024;
      for (let off = 0; off < f.size; off += CH) {
        const buf = new Uint8Array(await f.slice(off, Math.min(f.size, off + CH)).arrayBuffer());
        for (let j = 0; j < buf.length; j++) crc = CRC_TAB[(crc ^ buf[j]) & 0xFF] ^ (crc >>> 8);
        if (exportCancel) throw new Error('cancelled');
      }
      crc = (crc ^ 0xFFFFFFFF) >>> 0;
      const folder = (!t.album || t.album === 'Unknown Album') ? 'Singles' : zipClean(t.album, 'Singles');
      const base = zipClean(t.fileName || ((t.artist ? t.artist + ' - ' : '') + (t.title || 'track')), 'track');
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      let path = folder + '/' + base, k = 2;
      while (used.has(path)) path = folder + '/' + stem + ' (' + (k++) + ')' + ext;
      used.add(path);
      const nameBytes = enc.encode(path);
      const dt = t.dateAdded ? new Date(t.dateAdded) : new Date();
      const wTime = dosStamp(dt, true), wDate = dosStamp(dt, false);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true);
      lh.setUint16(10, wTime, true);
      lh.setUint16(12, wDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, f.size, true);
      lh.setUint32(22, f.size, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);
      const localOff = offset;
      push(new Uint8Array(lh.buffer)); push(nameBytes); parts.push(f); offset += f.size;
      central.push({ nameBytes, crc, size: f.size, off: localOff, wTime, wDate });
      done += f.size;
      ui(i + 1, list.length, done);
    }
    const cdStart = offset; let cdSize = 0;
    for (const c of central) {
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, c.wTime, true);
      ch.setUint16(14, c.wDate, true);
      ch.setUint32(16, c.crc, true);
      ch.setUint32(20, c.size, true);
      ch.setUint32(24, c.size, true);
      ch.setUint16(28, c.nameBytes.length, true);
      ch.setUint16(30, 0, true);
      ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true);
      ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true);
      ch.setUint32(42, c.off, true);
      push(new Uint8Array(ch.buffer)); push(c.nameBytes); cdSize += 46 + c.nameBytes.length;
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, cdStart, true);
    eocd.setUint16(20, 0, true);
    push(new Uint8Array(eocd.buffer));
    return new Blob(parts, { type: 'application/zip' });
  }
  /* Upload one backup part to filebin (plain HTTPS, no account, CORS-open).
     The bin holds every part; its link is good for 6 days. */
  function uploadPart(blob, bin, name, onProg) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://filebin.net/' + bin + '/' + encodeURIComponent(name));
      xhr.setRequestHeader('Content-Type', 'application/zip');
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProg(e.loaded / e.total); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('http ' + xhr.status));
      xhr.onerror = () => reject(new Error('network'));
      xhr.send(blob);
    });
  }
  /* Drive backup auto-resume: if the app was killed (not paused by the user)
     with an unfinished Drive backup, pick it up on its own — the closest an
     iPhone web app can get to "running in the background". */
  function driveBackupUnfinished() {
    try {
      const s = JSON.parse(localStorage.getItem('splotify-export-progress-drive') || 'null');
      if (!s || s.userPaused || !Array.isArray(s.done) || !s.done.length) return false;
      return s.done.filter(Boolean).length < s.done.length;
    } catch (e) { return false; }
  }
  function maybeAutoResumeDrive() {
    if (exporting) return;
    if (!S.tracks.some(t => t.file)) return;
    if (driveBackupUnfinished()) exportLibrary('drive', true);
  }
  async function exportLibrary(mode, auto) {
    if (exporting) return;
    const toDrive = mode === 'drive';
    /* Drive bridge: the phone uploads parts to a fixed staging bin; a worker
       on my server drains it into the user's Google Drive. Session-tagged part
       names keep concurrent backups from colliding in the shared bin. */
    const BRIDGE_BIN = 'splotify-bridge-01f7ca01ad84edb7438d7084';
    /* Session id, persisted with the progress: part filenames embed it, so a
       resumed backup must reuse the SAME session or the already-uploaded
       parts look missing and the run restarts at 0 (v5.8 bug). */
    let sess = Date.now().toString(36);
    if (exporting) return;
    const tracks = S.tracks.filter(t => t.file);
    if (!tracks.length) { toast('No songs to export yet'); return; }
    /* Claim the run up front: the resume confirm below blocks the main
       thread, and without an early claim a second trigger (auto-resume timer)
       could start a competing run. Released on early exits; finish() releases
       on completion. */
    exporting = true;
    tracks.sort((a, b) => String(a.album || '').localeCompare(String(b.album || '')) ||
      ((a.trackNo || 0) - (b.trackNo || 0)) || String(a.title).localeCompare(String(b.title)));
    /* Split into ~25 MB parts: small enough that a part actually finishes on
       a slow connection before the app gets closed, so progress checkpoints
       often and a killed run resumes close to where it stopped. */
    const PART = 25 * 1024 * 1024;
    const batches = []; let cur = [], curSize = 0;
    for (const t of tracks) {
      const s = t.file.size || 0;
      if (cur.length && curSize + s > PART) { batches.push(cur); cur = []; curSize = 0; }
      cur.push(t); curSize += s;
    }
    if (cur.length) batches.push(cur);
    /* Resume state: bin id + which parts made it up. The batch split is
       deterministic (sorted tracks, fixed part size), so a fingerprint of the
       library tells us whether saved progress still applies. */
    const fp = tracks.length + ':' + tracks.reduce((a, t) => a + (t.file.size || 0), 0) + ':' + batches.length;
    const SKEY = 'splotify-export-progress-' + (toDrive ? 'drive' : 'link');
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { /* ignore */ }
    let bin = null, done = null;
    if (saved && saved.fp === fp && saved.bin && Array.isArray(saved.done) && saved.done.length === batches.length) {
      const n = saved.done.filter(Boolean).length;
      if (n > 0 && n < batches.length) {
        if (auto || confirm('Resume backup? ' + n + ' of ' + batches.length + ' parts are already uploaded.')) {
          bin = saved.bin; done = saved.done.slice();
          if (saved.sess) sess = saved.sess;
        } else {
          // Cancelled: back out and keep the saved progress for next time —
          // never start fresh over it.
          exporting = false;
          return;
        }
      } else if (n === batches.length) {
        try { localStorage.removeItem(SKEY); } catch (e) { /* ignore */ }
      }
    }
    if (!bin) {
      bin = toDrive ? BRIDGE_BIN : 'splotify-' + sess;
      done = batches.map(() => false);
    }
    const save = () => { try { localStorage.setItem(SKEY, JSON.stringify({ fp, bin, done, sess, userPaused: exportUserPaused })); } catch (e) { /* ignore */ } };
    /* Session unification (drive): the bridge may hold parts from a richer
       interrupted session of this same backup (same part count) under a
       different session tag. Adopt the richest one and continue under its tag
       instead of re-uploading — the batch split is deterministic, so same
       part numbers mean same contents. The per-part HEAD check below
       re-validates every adopted part. */
    if (toDrive) {
      try {
        const r = await fetch('https://filebin.net/' + BRIDGE_BIN, { headers: { 'Accept': 'application/json' } });
        if (r.ok) {
          const d = await r.json();
          const bySess = {};
          for (const f of (d.files || [])) {
            const m = /^splotify-backup-([a-z0-9]+)-part(\d+)-of-(\d+)\.zip$/.exec(f.filename || '');
            if (m && +m[3] === batches.length) (bySess[m[1]] = bySess[m[1]] || []).push(+m[2]);
          }
          let best = null, bestParts = [];
          for (const s of Object.keys(bySess)) {
            if (bySess[s].length > bestParts.length) { best = s; bestParts = bySess[s]; }
          }
          if (best && bestParts.length > done.filter(Boolean).length) {
            sess = best;
            const ndone = batches.map(() => false);
            for (const p of bestParts) if (p >= 1 && p <= batches.length) ndone[p - 1] = true;
            done = ndone;
            dbUI.note = 'Picked up ' + bestParts.length + ' parts from the earlier run…';
          }
        }
      } catch (e) { /* bridge unreachable: fall through to per-part checks */ }
    }
    /* Verify the "done" parts are still on filebin (bins expire after 6 days);
       anything missing gets re-uploaded. */
    for (let b = 0; b < batches.length; b++) {
      if (!done[b]) continue;
      const name = toDrive ? 'splotify-backup-' + sess + '-part' + (b + 1) + '-of-' + batches.length + '.zip' : 'splotify-backup-part' + (b + 1) + '-of-' + batches.length + '.zip';
      try {
        const r = await fetch('https://filebin.net/' + bin + '/' + encodeURIComponent(name), { method: 'HEAD' });
        if (!r.ok) done[b] = false;
      } catch (e) { done[b] = false; }
    }
    save();
    exportCancel = false; exportUserPaused = false;
    const batchSizes = batches.map(ba => ba.reduce((a, t) => a + (t.file.size || 0), 0));
    const totalBytes = batchSizes.reduce((a, b) => a + b, 0);
    /* Live painter for the Drive Backup screen: updates the view's DOM in
       place so no full re-render ever interrupts the upload. */
    const dbPaint = (b, frac, upBytes, note) => {
      Object.assign(dbUI, { part: b + 1, frac, upBytes, note: note || '' });
      const pct = Math.min(100, Math.round(((b + frac) / batches.length) * 100));
      const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
      set('db-status', note || dbUI.note || ('Sending part ' + (b + 1) + ' of ' + batches.length + '…'));
      set('db-pct', pct + '%');
      set('db-part', (b + 1) + ' of ' + batches.length);
      set('db-sent', dbgb(upBytes) + ' of ' + dbgb(totalBytes));
      const f = document.getElementById('db-fill'); if (f) f.style.width = pct + '%';
    };
    /* Live painter for the Export-to-device screen: same shape as dbPaint,
       writing to the dev- element ids. */
    const devPaint = (b, frac, upBytes, note) => {
      Object.assign(devUI, { part: b + 1, frac, upBytes, note: note || '' });
      const pct = Math.min(100, Math.round(((b + frac) / batches.length) * 100));
      const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
      set('dev-status', note || devUI.note || ('Packing part ' + (b + 1) + ' of ' + batches.length + '…'));
      set('dev-pct', pct + '%');
      set('dev-part', (b + 1) + ' of ' + batches.length);
      set('dev-sent', devgb(upBytes) + ' of ' + devgb(totalBytes));
      const f = document.getElementById('dev-fill'); if (f) f.style.width = pct + '%';
    };
    if (toDrive) {
      Object.assign(dbUI, { phase: 'running', part: 0, parts: batches.length, frac: 0, upBytes: 0, totalBytes, t0: Date.now(), note: 'Preparing your songs…' });
      nav('driveBackup');
      clearInterval(dbTimer);
      dbTimer = setInterval(() => { const el = document.getElementById('db-time'); if (el) el.textContent = dbElapsed(); paintDbBgMode(); }, 1000);
    }
    /* Keep the screen awake while packing/uploading; iOS suspends background
       tabs, which is what kills the run. Re-acquire if the tab was hidden. */
    let wake = null;
    const grabWake = async () => { try { wake = await navigator.wakeLock.request('screen'); } catch (e) { /* unsupported */ } };
    const onVis = () => { if (document.visibilityState === 'visible' && exporting && !wake) grabWake(); };
    document.addEventListener('visibilitychange', onVis);
    grabWake();
    if (!toDrive) {
      Object.assign(devUI, { phase: 'running', part: 0, parts: batches.length, frac: 0, upBytes: 0, totalBytes, t0: Date.now(), note: 'Preparing your songs…', link: '' });
      nav('deviceExport');
      clearInterval(devTimer);
      devTimer = setInterval(() => { const el = document.getElementById('dev-time'); if (el) el.textContent = devElapsed(); }, 1000);
    }
    const finish = msg => {
      exporting = false;
      document.removeEventListener('visibilitychange', onVis);
      try { wake && wake.release(); } catch (e) { /* ignore */ } wake = null;
      clearInterval(dbTimer); dbTimer = null;
      clearInterval(devTimer); devTimer = null;
      const v = (S.stack[S.stack.length - 1] || {}).v;
      if (toDrive && v === 'driveBackup') render();
      if (!toDrive && v === 'deviceExport') render();
      if (msg) toast(msg);
    };
    try {
      for (let b = 0; b < batches.length; b++) {
        if (exportCancel) throw new Error('cancelled');
        if (done[b]) continue;
        const bytesBefore = batchSizes.slice(0, b).reduce((a, x) => a + x, 0);
        if (toDrive) dbPaint(b, 0, bytesBefore, 'Sending part ' + (b + 1) + ' of ' + batches.length + '…');
        else devPaint(b, 0, bytesBefore, 'Packing part ' + (b + 1) + ' of ' + batches.length + '…');
        const ui = (i, n, doneBytes) => {
          if (toDrive) { dbPaint(b, (n ? i / n : 1) * 0.5, bytesBefore + doneBytes); return; }
          devPaint(b, (n ? i / n : 1) * 0.5, bytesBefore + doneBytes);
        };
        const blob = await buildZipBlob(batches[b], ui);
        const name = toDrive ? 'splotify-backup-' + sess + '-part' + (b + 1) + '-of-' + batches.length + '.zip' : 'splotify-backup-part' + (b + 1) + '-of-' + batches.length + '.zip';
        await uploadPart(blob, bin, name, frac => {
          if (toDrive) { dbPaint(b, 0.5 + frac * 0.5, bytesBefore + batchSizes[b], 'Uploading part ' + (b + 1) + ' of ' + batches.length + ' — ' + Math.round(frac * 100) + '%'); return; }
          devPaint(b, 0.5 + frac * 0.5, bytesBefore + batchSizes[b], 'Uploading part ' + (b + 1) + ' of ' + batches.length + ' — ' + Math.round(frac * 100) + '%');
          if (exportCancel) throw new Error('cancelled');
        });
        if (exportCancel) throw new Error('cancelled');
        done[b] = true; save();
      }
    } catch (e) {
      save();
      const cancelled = e && e.message === 'cancelled';
      if (toDrive) Object.assign(dbUI, { phase: cancelled ? 'paused' : 'failed', note: cancelled ? '' : 'Upload failed — check Wi-Fi and try again.' });
      else Object.assign(devUI, { phase: cancelled ? 'paused' : 'failed', note: cancelled ? '' : 'Upload failed — check Wi-Fi and try again.' });
      finish(cancelled
        ? (toDrive ? 'Backup paused' : 'Export paused — your progress is saved')
        : 'Upload failed — reopen Export to resume when Wi-Fi is back');
      return;
    }
    try { localStorage.removeItem(SKEY); } catch (e) { /* ignore */ }
    if (toDrive) {
      Object.assign(dbUI, { phase: 'moving', part: batches.length, frac: 1, upBytes: totalBytes, note: '' });
      finish();
      return;
    }
    const url = 'https://filebin.net/' + bin;
    try { await navigator.clipboard.writeText(url); } catch (e) { /* fall through */ }
    Object.assign(devUI, { phase: 'done', part: batches.length, frac: 1, upBytes: totalBytes, link: url, note: '' });
    finish();
  }
  /* Drive Backup screen (v5.6): a dedicated view showing what the backup is
     doing — phase, part progress, GB moved, elapsed time — instead of the
     toast card. The export loop below paints it live via paintDB hooks. */
  const dbUI = { phase: 'idle', part: 0, parts: 0, frac: 0, upBytes: 0, totalBytes: 0, t0: 0, note: '' };
  let dbTimer = null;
  const dbgb = b => (b / 1073741824).toFixed(1) + ' GB';
  function dbElapsed() {
    if (!dbUI.t0) return '0:00';
    const s = Math.floor((Date.now() - dbUI.t0) / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  /* Background-mode line on the Drive Backup screen: iOS keeps uploads alive
     while music is playing, so a playing song means the backup survives
     leaving the app. */
  function paintDbBgMode() {
    const el = document.getElementById('db-bgmode');
    if (!el) return;
    const playing = (typeof Player !== 'undefined') && Player.isPlaying;
    el.innerHTML = playing
      ? '<span style="color:var(--pink)">&#9679;</span> Background-safe: music is playing — you can leave Splotify and the backup keeps going.'
      : 'Keep Splotify open — iOS pauses uploads in the background. Tip: play any song and you can leave the app.';
  }
  function vDriveBackup() {
    const u = dbUI;
    let savedParts = null;
    if (u.phase === 'idle') {
      try {
        const s = JSON.parse(localStorage.getItem('splotify-export-progress-drive') || 'null');
        if (s && Array.isArray(s.done)) {
          const n = s.done.filter(Boolean).length;
          if (n > 0 && n < s.done.length) savedParts = { n, of: s.done.length };
        }
      } catch (e) { /* ignore */ }
    }
    const pct = u.parts ? Math.min(100, Math.round(((u.part - 1 + u.frac) / u.parts) * 100)) : 0;
    let statusText, actionBtn;
    if (u.phase === 'running') {
      statusText = u.note || 'Sending…';
      actionBtn = '<button class="bigbtn" data-act="db-pause" style="margin-top:26px">Pause</button>';
    } else if (u.phase === 'paused') {
      statusText = 'Paused — your progress is saved.';
      actionBtn = '<button class="bigbtn pink" data-act="db-start" style="margin-top:26px">Resume backup</button>';
    } else if (u.phase === 'moving') {
      statusText = 'Everything is sent.';
      actionBtn = '<button class="bigbtn" data-act="db-done" style="margin-top:26px">Done</button>';
    } else if (u.phase === 'failed') {
      statusText = u.note || 'Something went wrong.';
      actionBtn = '<button class="bigbtn pink" data-act="db-start" style="margin-top:26px">Try again</button>';
    } else if (savedParts) {
      statusText = 'You have an unfinished backup.';
      actionBtn = '<button class="bigbtn pink" data-act="db-start" style="margin-top:26px">Resume backup — ' + savedParts.n + ' of ' + savedParts.of + ' parts sent</button>';
    } else {
      statusText = 'Send your whole library to Google Drive, organized by album.';
      actionBtn = '<button class="bigbtn pink" data-act="db-start" style="margin-top:26px">Start backup</button>';
    }
    const dot = st => '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:10px;background:' +
      (st === 'done' ? 'var(--pink)' : st === 'active' ? '#fff' : 'rgba(255,255,255,.25)') + '"></span>';
    const s1 = u.phase === 'moving' ? 'done' : (u.phase === 'idle' && !savedParts ? '' : 'active');
    const s2 = u.phase === 'moving' ? 'active' : '';
    const stepRow = (st, label, sub) =>
      '<div style="display:flex;align-items:flex-start;padding:10px 0">' + dot(st) +
      '<div><div style="font-weight:700;font-size:14px">' + label + '</div>' +
      '<div style="color:var(--sub);font-size:13px;margin-top:2px">' + sub + '</div></div></div>';
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Drive Backup</h1><span style="width:44px"></span></div>
    <div style="padding:4px 20px 48px">
      <div id="db-status" style="font-size:17px;font-weight:700;margin:10px 0 2px">${statusText}</div>
      <div id="db-note" style="color:var(--sub);font-size:13px;min-height:18px"></div>
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:14px">
        <span style="color:var(--sub);font-size:13px">Progress</span>
        <span id="db-pct" style="font-size:28px;font-weight:800">${pct}%</span>
      </div>
      <div style="height:8px;border-radius:4px;background:rgba(255,255,255,.12);margin:8px 0 4px;overflow:hidden">
        <div id="db-fill" style="height:100%;width:${pct}%;border-radius:4px;background:var(--pink);transition:width .3s"></div>
      </div>
      <div style="margin-top:18px">
        ${stepRow(s1, '1 · Sending from your phone', 'Songs upload in parts with resume.')}
        ${stepRow(s2, '2 · Moving to your Drive', u.phase === 'moving' ? 'Running on my side now — I\u2019ll message you when your songs are in Drive.' : 'Starts automatically when the upload finishes.')}
      </div>
      <div style="margin-top:14px;border-top:1px solid rgba(255,255,255,.1);padding-top:6px">
        <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:14px"><span style="color:var(--sub)">Part</span><span id="db-part" style="font-weight:700">${u.parts ? u.part + ' of ' + u.parts : '—'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:14px"><span style="color:var(--sub)">Sent</span><span id="db-sent" style="font-weight:700">${u.totalBytes ? dbgb(u.upBytes) + ' of ' + dbgb(u.totalBytes) : '—'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:14px"><span style="color:var(--sub)">Elapsed</span><span id="db-time" style="font-weight:700">${dbElapsed()}</span></div>
      </div>
      <div id="db-bgmode" style="color:var(--sub);font-size:13px;margin-top:14px"></div>
      <div style="text-align:center">${actionBtn}</div>
    </div>`;
  }
  /* Export-to-device screen (v5.8): the same full progress screen as Drive
     Backup, for the ZIP-parts-to-private-link export. */
  const devUI = { phase: 'idle', part: 0, parts: 0, frac: 0, upBytes: 0, totalBytes: 0, t0: 0, note: '', link: '' };
  let devTimer = null;
  const devgb = b => (b / 1073741824).toFixed(1) + ' GB';
  function devElapsed() {
    if (!devUI.t0) return '0:00';
    const s = Math.floor((Date.now() - devUI.t0) / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function vDeviceExport() {
    const u = devUI;
    let savedParts = null;
    if (u.phase === 'idle') {
      try {
        const s = JSON.parse(localStorage.getItem('splotify-export-progress-link') || 'null');
        if (s && Array.isArray(s.done)) {
          const n = s.done.filter(Boolean).length;
          if (n > 0 && n < s.done.length) savedParts = { n, of: s.done.length };
        }
      } catch (e) { /* ignore */ }
    }
    const pct = u.parts ? Math.min(100, Math.round(((u.part - 1 + u.frac) / u.parts) * 100)) : 0;
    let statusText, actionBtn, extra = '';
    if (u.phase === 'running') {
      statusText = u.note || 'Working…';
      actionBtn = '<button class="bigbtn" data-act="dev-pause" style="margin-top:26px">Pause</button>';
    } else if (u.phase === 'paused') {
      statusText = 'Paused — your progress is saved.';
      actionBtn = '<button class="bigbtn pink" data-act="dev-start" style="margin-top:26px">Resume export</button>';
    } else if (u.phase === 'done') {
      statusText = 'Your songs are packed and uploaded.';
      actionBtn = '<button class="bigbtn" data-act="dev-done" style="margin-top:26px">Done</button>';
      extra = '<div style="margin-top:20px"><div style="color:var(--sub);font-size:13px;margin-bottom:8px">Download link (works for 6 days) — copy it and send it to me:</div>' +
        '<div style="display:flex;gap:8px;align-items:center"><input id="dev-link" readonly value="' + esc(u.link) + '" ' +
        'style="flex:1;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;color:var(--txt);font-size:13px" />' +
        '<button class="bigbtn" data-act="dev-copy" style="margin:0;padding:12px 18px;flex-shrink:0">Copy</button></div></div>';
    } else if (u.phase === 'failed') {
      statusText = u.note || 'Something went wrong.';
      actionBtn = '<button class="bigbtn pink" data-act="dev-start" style="margin-top:26px">Try again</button>';
    } else if (savedParts) {
      statusText = 'You have an unfinished export.';
      actionBtn = '<button class="bigbtn pink" data-act="dev-start" style="margin-top:26px">Resume export — ' + savedParts.n + ' of ' + savedParts.of + ' parts uploaded</button>';
    } else {
      statusText = 'Pack your whole library into a private download link.';
      actionBtn = '<button class="bigbtn pink" data-act="dev-start" style="margin-top:26px">Start export</button>';
    }
    const dot = st => '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:10px;background:' +
      (st === 'done' ? 'var(--pink)' : st === 'active' ? '#fff' : 'rgba(255,255,255,.25)') + '"></span>';
    const s1 = u.phase === 'done' ? 'done' : (u.phase === 'idle' && !savedParts ? '' : 'active');
    const s2 = u.phase === 'done' ? 'active' : '';
    const stepRow = (st, label, sub) =>
      '<div style="display:flex;align-items:flex-start;padding:10px 0">' + dot(st) +
      '<div><div style="font-weight:700;font-size:14px">' + label + '</div>' +
      '<div style="color:var(--sub);font-size:13px;margin-top:2px">' + sub + '</div></div></div>';
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Export to device</h1><span style="width:44px"></span></div>
    <div style="padding:4px 20px 48px">
      <div id="dev-status" style="font-size:17px;font-weight:700;margin:10px 0 2px">${statusText}</div>
      <div id="dev-note" style="color:var(--sub);font-size:13px;min-height:18px"></div>
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:14px">
        <span style="color:var(--sub);font-size:13px">Progress</span>
        <span id="dev-pct" style="font-size:28px;font-weight:800">${pct}%</span>
      </div>
      <div style="height:8px;border-radius:4px;background:rgba(255,255,255,.12);margin:8px 0 4px;overflow:hidden">
        <div id="dev-fill" style="height:100%;width:${pct}%;border-radius:4px;background:var(--pink);transition:width .3s"></div>
      </div>
      <div style="margin-top:18px">
        ${stepRow(s1, '1 · Packing and uploading', 'Songs pack into parts and upload with resume.')}
        ${stepRow(s2, '2 · Your download link', u.phase === 'done' ? 'Copy it and send it to me.' : 'Appears here when the upload finishes.')}
      </div>
      <div style="margin-top:14px;border-top:1px solid rgba(255,255,255,.1);padding-top:6px">
        <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:14px"><span style="color:var(--sub)">Part</span><span id="dev-part" style="font-weight:700">${u.parts ? u.part + ' of ' + u.parts : '—'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:14px"><span style="color:var(--sub)">Sent</span><span id="dev-sent" style="font-weight:700">${u.totalBytes ? devgb(u.upBytes) + ' of ' + devgb(u.totalBytes) : '—'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:14px"><span style="color:var(--sub)">Elapsed</span><span id="dev-time" style="font-weight:700">${devElapsed()}</span></div>
      </div>
      ${extra}
      <div style="color:var(--sub);font-size:13px;margin-top:14px">Keep Splotify open — iOS pauses uploads in the background. Tip: play any song and you can leave the app.</div>
      <div style="text-align:center">${actionBtn}</div>
    </div>`;
  }
  /* Export hub (v5.8): one "Export music" entry opens this chooser with the
     two destinations — device link and Google Drive. */
  function vExportHub() {
    const card = (act, title, sub, ic) =>
      '<div class="setrow" data-act="' + act + '" style="padding:18px 16px"><div style="font-size:16px;font-weight:700">' + title +
      '<div class="sub" style="margin-top:4px">' + sub + '</div></div>' +
      '<span style="color:var(--sub)">' + icon(ic, 'width:26px;height:26px') + '</span></div>';
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Export music</h1><span style="width:44px"></span></div>
    <div style="padding:8px 16px 48px;display:flex;flex-direction:column;gap:12px">
      ${card('export-device', 'Export to device', 'Pack your songs into a private download link', 'download')}
      ${card('export-drive', 'Back up to Google Drive', 'Send your songs to Drive, organized by album', 'download')}
    </div>`;
  }
  /* Checks the live sw.js for a newer build. The update row only lights up
     when the server has something newer than the running code. */
  let checkingUpdate = false;
  async function checkForUpdate() {
    const row = document.getElementById('update-row');
    const sub = document.getElementById('update-sub');
    const pill = document.getElementById('update-pill');
    if (!row || !sub || !pill || checkingUpdate) return;
    const paint = (lit, subText, pillText, act) => {
      row.classList.toggle('litrow', lit);
      pill.classList.toggle('lit', lit);
      sub.textContent = subText;
      pill.textContent = pillText;
      row.dataset.act = act;
    };
    if (!('serviceWorker' in navigator)) {
      paint(false, 'App updates are not supported in this browser', APP_VERSION, 'check-update');
      return;
    }
    checkingUpdate = true;
    try {
      const r = await fetch('sw.js?cb=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const txt = await r.text();
      const m = txt.match(/splotify-(v\d+\.\d+)/);
      const latest = m ? m[1] : null;
      if (latest && latest !== APP_VERSION) {
        paint(true, 'Version ' + latest + ' is ready — tap to update', 'Update', 'apply-update');
      } else {
        paint(false, 'You are on the latest version (' + APP_VERSION + ')', APP_VERSION, 'check-update');
      }
    } catch (e) {
      paint(false, 'Could not check for updates — tap to retry', APP_VERSION, 'check-update');
    }
    checkingUpdate = false;
  }
  function vGenre(g) {
    const ts = S.tracks.filter(t => (t.genre || 'Unknown') === g);
    S.viewCtx = { kicker: 'PLAYING FROM SONGS', name: g, kind: 'genre', id: g };
    return detailHead('go-back', heroArt(ts.find(t => t.art)), g, `${ts.length} songs`) + playRow(ts.map(t => t.id)) + ts.map(t => trackRow(t)).join('');
  }

  /* Spotify transfer (v7.0): pull playlists, Liked Songs, and followed
     artists from Spotify, matched against the SDB. No audio ever moves. */
  function vSpotifyImport() {
    S.viewCtx = null;
    let savedId = '';
    try { savedId = localStorage.getItem('sp-clientid') || ''; } catch (e) {}
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Import from Spotify</h1><span style="width:44px"></span></div>
    <div style="padding:8px 16px 48px">
      <p class="sub" style="margin:0 0 16px">Bring your playlists, Liked Songs, and followed artists into Splotify. Songs are matched against your SDB \u2014 nothing downloads, and you can run this again anytime; anything already imported is skipped.</p>
      <div class="setgroup"><h2>Connect Spotify</h2>
        <p class="sub" style="margin:0 0 10px">One-tap import straight from your account. If Spotify blocks the app, use the data export below instead.</p>
        <input id="sp-clientid" placeholder="Spotify client ID" value="${esc(savedId)}" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:100%;box-sizing:border-box;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 14px;color:var(--txt);font-size:16px;margin-bottom:10px" />
        <p class="sub" style="margin:0 0 10px">In your Spotify dashboard, add this redirect URI:<br><b style="color:var(--txt)">${esc(SpImport.redirectUri())}</b></p>
        <button class="bigbtn pink" data-act="sp-oauth" style="width:100%">Connect Spotify</button>
      </div>
      <div class="setgroup"><h2>Data export</h2>
        <p class="sub" style="margin:0 0 10px">Upload the ZIP from Spotify's \u201cDownload your data\u201d (Privacy Settings). It's parsed on this iPhone \u2014 nothing uploads anywhere.</p>
        <button class="bigbtn" data-act="sp-pick-zip" style="width:100%">Choose export ZIP</button>
        <input type="file" id="sp-zip" accept=".zip,application/zip" style="display:none">
      </div>
      ${S.spBusy ? `<p class="sub">Working\u2026</p>` : ''}
    </div>`;
  }
  function vSpReview() {
    S.viewCtx = null;
    const items = S.spReview;
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Review matches</h1><span style="width:44px"></span></div>
    <div style="padding:8px 16px 48px">
      <p class="sub" style="margin:0 0 12px">These Spotify songs matched your SDB, but not confidently. Approve the right ones, skip the rest.</p>
      ${items.length ? `<button class="bigbtn pink" data-act="sp-review-approve-all" style="width:100%;margin-bottom:14px">Approve all ${items.length}</button>` : ''}
      ${items.length ? items.map((it, i) => {
        const t = it.sdb;
        const where = it.context.type === 'liked' ? 'Liked Songs' : ('Playlist: ' + it.context.name);
        return `<div class="sp-review-row">
          <div class="sp-review-sp"><div class="ttitle">${esc(it.sp.title)}</div><div class="tsub">${esc(it.sp.artist)} \u2022 ${esc(where)}</div></div>
          <div class="sp-review-arrow">\u2192</div>
          <div class="sp-review-sdb">${t ? `<div class="ttitle">${esc(t.title)}</div><div class="tsub">${esc(t.artist)}</div>` : `<div class="tsub">No match</div>`}</div>
          <div class="sp-review-btns"><button class="bigbtn pink" data-act="sp-review-approve" data-idx="${i}">Approve</button><button class="bigbtn" data-act="sp-review-skip" data-idx="${i}">Skip</button></div>
        </div>`;
      }).join('') : `<div class="empty"><h3>All reviewed</h3><p>Nothing left to check.</p><button class="bigbtn" data-act="sp-report">See the report</button></div>`}
    </div>`;
  }
  function vSpReport() {
    S.viewCtx = null;
    const s = S.spSummary || {};
    const missed = S.spMissed;
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Import report</h1><span style="width:44px"></span></div>
    <div style="padding:8px 16px 48px">
      <div class="setgroup"><h2>Imported</h2>
        <div class="setrow"><div>Playlists created<div class="sub">Matched songs added automatically</div></div><span>${s.playlistsCreated || 0}</span></div>
        <div class="setrow"><div>Liked Songs added</div><span>${s.likedAdded || 0}</span></div>
        <div class="setrow"><div>Artists followed</div><span>${s.artistsFollowed || 0}</span></div>
      </div>
      <div class="setgroup"><h2>Skipped (${missed.length})</h2>
        <p class="sub" style="margin:0 0 10px">These Spotify songs aren't in your SDB, so they were left out.</p>
        ${missed.slice(0, 100).map(it => `<div class="trow" style="min-height:48px"><div class="tmeta"><div class="ttitle" style="font-size:14px">${esc(it.sp.title)}</div><div class="tsub">${esc(it.sp.artist)}${it.context && it.context.name ? ' \u2022 ' + esc(it.context.name) : ''}</div></div></div>`).join('') || '<p class="sub">Nothing skipped.</p>'}
        ${missed.length > 100 ? `<p class="sub">\u2026and ${missed.length - 100} more.</p>` : ''}
      </div>
      <button class="bigbtn pink" data-act="tab" data-tab="library" style="width:100%">Open your library</button>
    </div>`;
  }
  /* Run matched Spotify data through the transfer engine. */
  async function runSpImportData(data) {
    S.spBusy = true; render();
    try {
      const summary = await SpImport.applyImport(data, S.tracks);
      S.spReview = summary.review; S.spMissed = summary.missed; S.spSummary = summary;
      S.spBusy = false;
      await refreshTracks(); render();
      toast(`Imported ${summary.playlistsCreated} playlists, ${summary.likedAdded} liked songs, ${summary.artistsFollowed} artists`);
      if (summary.review.length) nav('spReview');
      else nav('spReport');
    } catch (e) {
      S.spBusy = false; render();
      toast('Import failed: ' + (e && e.message ? e.message : e));
    }
  }
  async function runSpExport(file) {
    try {
      const data = await SpImport.parseExportZip(file);
      data.source = 'export';
      if (!data.playlists.length && !data.liked.length && !data.artists.length) {
        toast('No playlists, liked songs, or artists found' + (data.found.length ? ' (saw: ' + data.found.join('; ') + ')' : ''));
        return;
      }
      await runSpImportData(data);
    } catch (e) {
      toast('Could not read that ZIP: ' + (e && e.message ? e.message : e));
    }
  }
  /* v7.0 utag review: uncertain corrections, before/after, approve or skip. */
  function vTagReview() {
    S.viewCtx = null;
    // v7.8 review triage: highest confidence first.
    const items = [...(S.tagReview || [])].sort((a, b) => ((b.proposal || {}).confidence || 0) - ((a.proposal || {}).confidence || 0));
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Review corrections</h1><span style="width:44px"></span></div>
    <div style="padding:8px 16px 48px">
      <p class="sub" style="margin:0 0 12px">The audit wasn't sure about these. Approve the right ones, skip the rest.</p>
      ${items.length ? `<button class="bigbtn pink" data-act="tag-review-approve-all" style="width:100%;margin-bottom:14px">Approve all ${items.length}</button>` : ''}
      ${items.length ? items.map((it, i) => `
        <div class="sp-review-row">
          <div class="sp-review-sp"><div class="ttitle">${esc(it.title)}</div><div class="tsub">${esc(it.artist)}</div></div>
          <div class="sp-review-sdb" style="margin-top:8px">
            <div class="tsub" style="margin-bottom:4px">${esc(it.proposal.field)} \u2022 ${esc(it.proposal.source)} \u2022 ${Math.round(it.proposal.confidence * 100)}% confident</div>
            <div class="ttitle" style="font-size:14px"><s style="color:var(--sub)">${esc(it.proposal.from)}</s></div>
            <div class="ttitle" style="font-size:14px;color:var(--pink)">${esc(it.proposal.to)}</div>
          </div>
          <div class="sp-review-btns"><button class="bigbtn pink" data-act="tag-review-approve" data-idx="${i}">Approve</button><button class="bigbtn" data-act="tag-review-skip" data-idx="${i}">Skip</button></div>
          <div style="margin-top:8px"><button class="bigbtn" data-act="tag-edit" data-id="${it.trackId}" style="width:100%">Edit by hand instead</button></div>
        </div>`).join('') : `<div class="empty"><h3>All reviewed</h3><p>Nothing left to check.</p></div>`}
    </div>`;
  }
  function vPlImport() {
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Playlist import</h1><span style="width:44px"></span></div>
    <div id="plimport-body" style="padding:0 16px 32px"></div>`;
  }

  /* ================= router ================= */
  const VIEWS = {
    home: vHome, search: vSearch, library: vLibrary, settings: vSettings,
    playlist: id => vPlaylist(id), album: id => vAlbum(id), artist: id => vArtist(id), artistReleases: id => vArtistReleases(id),
    liked: vLiked, songs: vSongs, playlists: vPlaylists, albums: vAlbums, artists: vArtists,
    curated: id => vCurated(id), genre: id => vGenre(id),
    notifs: () => vStub('Notifications', 'bell', "You're all caught up."),
    history: () => vStub('Listening history', 'history', 'Your recent plays live in Your Library.'),
    stations: () => vStub('Stations', 'radio', 'Stations need streaming — your library is local-only.'),
    podcasts: () => vStub('Podcasts', 'radio', 'No podcasts here yet.'),
    videos: () => vStub('Videos', 'playRect', 'No videos here yet.'),
    plimport: () => vPlImport(),
    tagReview: () => vTagReview(),
    spotifyImport: () => vSpotifyImport(),
    spReview: () => vSpReview(),
    spReport: () => vSpReport(),
    driveBackup: () => vDriveBackup(),
    exportHub: () => vExportHub(),
    deviceExport: () => vDeviceExport(),
    tagFixer: () => vTagFixer(),
  };
  function render() {
    const cur = S.stack[S.stack.length - 1] || { v: 'home' };
    const st = view().scrollTop;
    const sameView = S._lastViewKey === cur.v + '|' + (cur.id || '');
    const qHadFocus = document.activeElement && document.activeElement.id === 'q';
    view().innerHTML = VIEWS[cur.v](cur.id);
    view().scrollTop = sameView ? st : 0;
    view().onscroll = null;
    if (cur.v === 'artist') bindArtistScroll();
    if (cur.v === 'driveBackup') paintDbBgMode();
    if (cur.v === 'tagFixer') {
      paintTagFixResults();
      // v8.4: skip buttons need the skip set; render immediately, then again
      // once it's loaded (bounded wait so a slow DB can't blank the list).
      buildFixList(); paintFixUI();
      Promise.race([ensureSkipIds(), new Promise(r => setTimeout(r, 4000))])
        .then(() => { buildFixList(); paintFixUI(); }).catch(() => {});
    }
    if (cur.v === 'settings') {
      // fanart.tv key lives only on this device (kv store) — never in the repo.
      try {
        DB.kvGet('fanartKey', '').then(v => {
          const i = document.getElementById('fanart-key');
          if (i && document.activeElement !== i) i.value = v || '';
        }).catch(() => {});
        const fi = document.getElementById('fanart-key');
        if (fi && !fi._fkeyBound) {
          fi._fkeyBound = true;
          fi.addEventListener('change', () => {
            DB.kvSet('fanartKey', fi.value.trim()).then(() => toast('fanart.tv key saved')).catch(() => {});
          });
        }
        // AcoustID key: same device-local pattern, never in the repo.
        DB.kvGet('acoustidKey', '').then(v => {
          const i = document.getElementById('acoustid-key');
          if (i && document.activeElement !== i) i.value = v || '';
        }).catch(() => {});
        const ai = document.getElementById('acoustid-key');
        if (ai && !ai._akeyBound) {
          ai._akeyBound = true;
          ai.addEventListener('change', () => {
            DB.kvSet('acoustidKey', ai.value.trim()).then(() => toast('AcoustID key saved')).catch(() => {});
          });
        }
      } catch (e) {}
    }
    S._lastViewKey = cur.v + '|' + (cur.id || '');
    document.querySelectorAll('.tab').forEach(b => {
      const on = b.dataset.tab === S.tab;
      b.classList.toggle('active', on);
      const nm = b.dataset.tab === 'home' ? (on ? 'home' : 'homeO') : b.dataset.tab === 'create' ? 'plus' : b.dataset.tab;
      b.querySelector('.tabicon').innerHTML = icon(nm, b.dataset.tab === 'search' ? 'width:27px;height:27px' : '');
    });
    const q = document.getElementById('q');
    if (q) {
      q.addEventListener('input', () => { S.query = q.value; const pos = q.selectionStart; render(); const nq = document.getElementById('q'); nq.focus(); nq.setSelectionRange(pos, pos); });
      if (qHadFocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }
    const lq = document.getElementById('lib-q');
    if (lq) {
      lq.addEventListener('input', () => { S.libQ = lq.value; const pos = lq.selectionStart; render(); const nlq = document.getElementById('lib-q'); if (nlq) { nlq.focus(); nlq.setSelectionRange(pos, pos); } });
    }
    const sz = document.getElementById('sp-zip');
    if (sz && !sz.dataset.bound) {
      sz.dataset.bound = '1';
      sz.addEventListener('change', () => { const f = sz.files && sz.files[0]; sz.value = ''; if (f) runSpExport(f); });
    }
    const tq = document.getElementById('tagfix-q');
    if (tq) tq.addEventListener('input', paintTagFixResults);
    const flq = document.getElementById('fixlist-q');
    if (flq) flq.addEventListener('input', applyFixFilter);
    updateStorageLine();
    updatePlImportLine();
    if ((S.stack[S.stack.length - 1] || {}).v === 'plimport') PlImport.paint();
  }
  async function updatePlImportLine() {
    const el = document.getElementById('plimport-sub');
    if (!el || typeof PlImport === 'undefined') return;
    try { el.textContent = await PlImport.settingsLine(); } catch (e) {}
  }
  async function updateStorageLine() {
    const el = document.getElementById('set-storage');
    if (!el) return;
    try { const e = await DB.usage(); el.textContent = e.usage ? (e.usage / 1048576).toFixed(0) + ' MB stored on this iPhone' : 'Stored on this iPhone'; } catch (e) {}
  }
  function nav(v, id) {
    if (['home', 'search', 'library'].includes(v)) { S.tab = v; S.stack = [{ v }]; }
    else S.stack.push({ v, id });
    render();
  }
  function back() { if (S.stack.length > 1) { S.stack.pop(); render(); } }

  /* ================= mini player + now playing ================= */
  function paintMini() {
    const mp = document.getElementById('miniplayer');
    const t = Player.current;
    if (!t) { mp.classList.add('hidden'); return; }
    mp.classList.remove('hidden');
    mp.style.background = cssTint(t);
    const mart = document.getElementById('mp-art');
    const mph = document.getElementById('mp-ph');
    const u = artURL(t);
    const tid = t.id;
    // Dead art must never show the broken-image glyph: shimmer skeleton
    // instead, with quiet retries in case it was a blip.
    mart.onerror = () => {
      try {
        mart.style.display = 'none';
        if (mph) mph.style.display = '';
        let tries = 0;
        const tick = () => {
          if (++tries > 3 || !mart.isConnected) return;
          const im = new Image();
          im.onload = () => {
            if (!mart.isConnected) return;
            const cur = Player.current;
            if (!cur || cur.id !== tid) return;
            if (mph) mph.style.display = 'none';
            mart.style.display = '';
            mart.src = u;
          };
          im.onerror = () => setTimeout(tick, 5000 * tries);
          im.src = u;
        };
        setTimeout(tick, 3000);
      } catch (e) {}
    };
    if (u) { mart.src = u; mart.style.display = ''; if (mph) mph.style.display = 'none'; }
    else { mart.removeAttribute('src'); mart.style.display = 'none'; if (mph) mph.style.display = 'none'; }
    document.getElementById('mp-title').textContent = t.title;
    document.getElementById('mp-artist').textContent = t.artist;
    document.getElementById('mp-play').innerHTML = icon(Player.isPlaying ? 'pause' : 'play');
    document.getElementById('mp-devices').innerHTML = icon('devices');
    tint(t);
  }
  function paintNowPlaying() {
    const t = Player.current;
    if (!t) return;
    const bg = document.getElementById('np-bg');
    const c = S.tintCache.get(t.id);
    bg.style.background = c ? `linear-gradient(180deg, rgb(${Math.min(255, c[0] + 60)},${Math.min(255, c[1] + 60)},${Math.min(255, c[2] + 60)}) 0%, #14181c 78%)` : '';
    const ctx = Player.state.ctx || {};
    document.getElementById('np-context-kicker').textContent = ctx.kicker || 'PLAYING FROM SONGS';
    // Album contexts resolve live: if the track's tags were fixed after play started,
    // the header follows the track's real album instead of a stale "Unknown Album".
    const ctxName = (ctx.kind === 'album' && t.album) ? t.album : (ctx.name || '');
    document.getElementById('np-context-name').textContent = ctxName;
    const art = document.getElementById('np-art');
    const ph = document.getElementById('np-ph');
    const u = artURL(t);
    const tid = t.id;
    // A dead cover must never show the broken-image glyph: shimmer skeleton
    // instead, with quiet retries in case it was a blip.
    art.onerror = () => {
      try {
        art.style.display = 'none';
        ph.style.display = '';
        ph.className = 'art-ph skel';
        ph.innerHTML = '';
        let tries = 0;
        const tick = () => {
          if (++tries > 3 || !ph.isConnected) return;
          const im = new Image();
          im.onload = () => {
            if (!ph.isConnected) return;
            const cur = Player.current;
            if (!cur || cur.id !== tid) return;
            ph.className = 'art-ph';
            ph.style.display = 'none';
            art.style.display = '';
            art.src = u;
          };
          im.onerror = () => setTimeout(tick, 5000 * tries);
          im.src = u;
        };
        setTimeout(tick, 3000);
      } catch (e) {}
    };
    if (u) { art.src = u; art.style.display = ''; ph.style.display = 'none'; ph.className = 'art-ph'; }
    else { art.removeAttribute('src'); art.style.display = 'none'; ph.style.display = ''; ph.className = 'art-ph'; if (!ph.innerHTML) ph.innerHTML = icon('note'); }
    document.getElementById('np-title').textContent = t.title;
    document.getElementById('np-artist').textContent = t.artist;
    const like = document.getElementById('np-like');
    const liked = Player.isLiked(t.id);
    like.innerHTML = icon(liked ? 'heartF' : 'heart');
    like.classList.toggle('liked', liked);
    const sh = document.getElementById('np-shuffle');
    sh.innerHTML = `<img src="icons/shuffle-pink.png" class="sprite${Player.state.shuffle ? '' : ' sprite-off'}" alt="Shuffle">`;
    sh.classList.toggle('on', Player.state.shuffle);
    const rp = document.getElementById('np-repeat');
    rp.innerHTML = `<img src="icons/${Player.state.repeat === 'one' ? 'repeat-one-pink' : 'repeat-all-pink'}.png" class="sprite${Player.state.repeat !== 'off' ? '' : ' sprite-off'}" alt="Repeat">`;
    rp.classList.toggle('on', Player.state.repeat !== 'off');
    const pp = document.getElementById('np-play');
    pp.innerHTML = icon(Player.isPlaying ? 'pause' : 'play');
    pp.classList.toggle('playing', Player.isPlaying);
    document.getElementById('np-close').innerHTML = icon('chevD');
    document.getElementById('np-menu').innerHTML = icon('dots');
    document.getElementById('np-prev').innerHTML = icon('prev');
    document.getElementById('np-next').innerHTML = icon('next');
    document.getElementById('np-devices').innerHTML = icon('devices');
    document.getElementById('np-queue').innerHTML = icon('queue');
    tint(t);
  }
  function openNP() { paintNowPlaying(); const np = document.getElementById('nowplaying'); np.classList.add('open'); np.setAttribute('aria-hidden', 'false'); }
  function closeNP() { const np = document.getElementById('nowplaying'); np.classList.remove('open'); np.setAttribute('aria-hidden', 'true'); }

  function fmt(s) { if (!s || !isFinite(s)) return '0:00'; s = Math.floor(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function paintTime(cur, dur) {
    document.getElementById('mp-fill').style.width = (dur ? (cur / dur * 100) : 0) + '%';
    const bar = document.getElementById('np-bar');
    if (!bar || !document.getElementById('nowplaying').classList.contains('open')) return;
    const pct = dur ? Math.min(100, cur / dur * 100) : 0;
    document.getElementById('np-fillbar').style.width = pct + '%';
    document.getElementById('np-knob').style.left = pct + '%';
    bar.setAttribute('aria-valuenow', Math.round(pct));
    document.getElementById('np-cur').textContent = fmt(cur);
    document.getElementById('np-dur').textContent = fmt(dur);
  }

  /* ================= sheets ================= */
  function trackSheet(id) {
    const t = S.byId.get(id); if (!t) return;
    const liked = Player.isLiked(id);
    const inLib = libraryHas(id);
    const noAlbum = !t.album || t.album === 'Unknown Album';
    openSheet(`<div class="sheet-title">${esc(t.title)}</div>
      <div class="sheet-item" data-act="sheet-like" data-id="${id}">${icon(liked ? 'heartF' : 'heart')}${liked ? 'Unlike' : 'Like'}</div>
      <div class="sheet-item" data-act="sheet-library-toggle" data-id="${id}">${icon(inLib ? 'check' : 'plus')}${inLib ? 'In your library' : 'Save to library'}</div>
      <div class="sheet-item" data-act="sheet-addto" data-id="${id}">${icon('plus')}Add to playlist</div>
      ${noAlbum ? '' : `<div class="sheet-item" data-act="sheet-album" data-id="${id}">${icon('disc')}Go to album</div>`}
      <div class="sheet-item" data-act="sheet-artist" data-id="${id}">${icon('person')}Go to artist</div>
      <div class="sheet-item" data-act="sheet-info" data-id="${id}">${icon('info')}Track info</div>
      <div class="sheet-item" data-act="sheet-fixtags" data-id="${id}">${icon('tag')}utag</div>
      <div class="sheet-item" data-act="sheet-download" data-id="${id}">${icon('download')}Download to this iPhone</div>
      <div class="sheet-item danger" data-act="sheet-delete" data-id="${id}">${icon('trash')}Delete permanently</div>`);
  }
  function artistSheet(name) {
    const a = artistByName(name); if (!a) return;
    const following = S.followedArtists.has(artistKey(a.name));
    openSheet(`<div class="sheet-title">${esc(a.name)}</div>
      <div class="sheet-item" data-act="artist-play" data-id="${esc(a.name)}">${icon('play')}Play</div>
      <div class="sheet-item" data-act="artist-shuffle" data-id="${esc(a.name)}">${icon('shuffle')}Shuffle</div>
      <div class="sheet-item" data-act="artist-follow" data-id="${esc(a.name)}">${icon(following ? 'check' : 'plus')}${following ? 'Following' : 'Follow'}</div>
      <div class="sheet-item" data-act="open-artist-releases" data-id="${esc(a.name)}">${icon('disc')}See discography</div>`);
  }
  function infoSheet(id) {
    const t = S.byId.get(id); if (!t) return;
    const kb = t.fileSize ? (t.fileSize / 1024).toFixed(0) + ' KB' : '—';
    const row = (k, v) => `<div class="info-row"><span>${k}</span><b>${esc(String(v || '—'))}</b></div>`;
    openSheet(`<div class="sheet-title">Track info</div>
      <div class="info-art">${artImg(t, 'art')}</div>
      ${row('Title', t.title)}${row('Artist', t.artist)}${row('Album', (!t.album || t.album === 'Unknown Album') ? '' : t.album)}
      ${row('Album artist', t.albumArtist)}${row('Genre', t.genre)}${row('Year', t.year)}
      ${row('Track', t.trackNo || '—')}${row('Duration', Importer.fmtDur(t.duration) || '—')}
      ${row('Artwork', t.art ? 'Embedded' : 'None found')}
      ${row('Tags from', t.tagsVia || (t.tagged ? 'File' : '—'))}
      ${row('Reader', t.diag || '—')}
      ${row('App version', APP_VERSION)}
      ${row('File', t.fileName)}${row('Size', kb)}
      <div class="info-note">Tags are read from the file when you import it. If something is missing here, it is not in the file's tags.</div>`);
  }
  function addToSheet(id) {
    openSheet(`<div class="sheet-title">Add to playlist</div>
      <div class="sheet-item" data-act="sheet-newpl" data-id="${id}">${icon('plus')}New playlist</div>
      ${S._pls.map(p => `<div class="sheet-item" data-act="sheet-addto-pl" data-id="${id}" data-pl="${p.id}">${icon('note')}${esc(p.name)}</div>`).join('')}`);
  }
  function queueSheet() {
    const cur = Player.current;
    const up = Player.queueList();
    const row = id => { const t = S.byId.get(id); if (!t) return ''; return `<div class="trow" data-act="queue-jump" data-id="${id}">${artImg(t, 'art')}<div class="tmeta"><div class="ttitle">${esc(t.title)}</div><div class="tsub">${esc(t.artist)}</div></div></div>`; };
    openSheet(`<div class="sheet-title">Queue</div>
      ${cur ? `<div class="sheet-item" style="color:var(--sub);font-size:13px">NOW PLAYING</div>` + row(cur.id) : ''}
      ${up.length ? `<div class="sheet-item" style="color:var(--sub);font-size:13px">NEXT UP</div>` + up.map(row).join('') : '<div class="empty"><p>Nothing queued.</p></div>'}`);
  }

  /* Download one library track to the device: iOS share sheet when the
     browser can share files (Save to Files, AirDrop, …), otherwise a plain
     download. The file never leaves the phone except where the user sends it. */
  async function downloadTrack(id) {
    const t = S.byId.get(id);
    if (!t || !t.file) { toast('Nothing to download for that track'); return; }
    const ext = (t.fileName && t.fileName.lastIndexOf('.') > 0)
      ? t.fileName.slice(t.fileName.lastIndexOf('.')) : '.mp3';
    const name = `${t.artist || 'Unknown'} - ${t.title || 'Unknown'}${ext}`
      .replace(/[\\/:*?"<>|]/g, '').slice(0, 120);
    try {
      const file = new File([t.file], name, { type: t.file.type || 'audio/mpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: t.title });
        return;
      }
    } catch (e) { /* share dismissed or unavailable: fall through to download */ }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(t.file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 20000);
  }

  /* utag fixer screen (v5.8): a dedicated view showing the auto fixer working
     live — per-song before/after, run stats — plus manual tag editing. */
  const fixUI = { running: false, album: '', albumIdx: 0, albumCount: 0, scanned: 0, matched: 0, fixed: 0, notFound: 0, log: [], via: { apple: 0, deezer: 0, musicbrainz: 0, spotify: 0, memory: 0 } };
  const TAG_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre'];
  const TAG_LABEL = { title: 'Title', artist: 'Artist', album: 'Album', albumArtist: 'Album artist', genre: 'Genre' };
  const snapTags = t => { const o = {}; TAG_FIELDS.forEach(f => o[f] = t[f] || ''); return o; };
  function diffTags(b, t) {
    const parts = [];
    TAG_FIELDS.forEach(f => {
      const bv = b[f] || '', av = t[f] || '';
      if (bv !== av) parts.push(TAG_LABEL[f] + ': ' + (bv || '—') + ' → ' + (av || '—'));
    });
    return parts.length ? parts.join('; ') : null;
  }
  function paintFixUI() {
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    // Idle screen restores the last run's numbers so the stats aren't blank.
    let d = fixUI, lastRun = false;
    if (!fixUI.running && !fixUI.albumCount) {
      try {
        const last = JSON.parse(localStorage.getItem('splotify-tagfix-last') || 'null');
        if (last && (last.scanned || last.fixed)) {
          d = { albumIdx: last.albums || 0, albumCount: last.albums || 0, scanned: last.scanned || 0, matched: last.matched || 0, fixed: last.fixed || 0, via: last.via || {} };
          lastRun = true;
        }
      } catch (e) { /* ignore */ }
    }
    set('fix-albums', d.albumCount ? d.albumIdx + ' of ' + d.albumCount : '—');
    set('fix-scanned', String(d.scanned));
    set('fix-matched', String(d.matched));
    set('fix-fixed', String(d.fixed));
    const vs = d.via || {};
    set('fix-sources', 'Apple Music: ' + (vs.apple || 0) + ' · Deezer: ' + (vs.deezer || 0) + ' · MusicBrainz: ' + (vs.musicbrainz || 0) + ' · Spotify: ' + (vs.spotify || 0) + ' · AcoustID: ' + (vs.acoustid || 0));
    try { Importer.memCount().then(n => set('fix-memory', n > 0 ? 'Remembers ' + n + ' fix' + (n === 1 ? '' : 'es') + ' — recognized songs skip the search next time' : '')); } catch (e) {}
    try {
      const skipped = (S.tracks || []).filter(t => !trackNeedsFix(t)).length;
      set('fix-skipped', skipped ? skipped + ' song' + (skipped === 1 ? '' : 's') + ' already have metadata — skipped' : '');
    } catch (e) {}
    set('fix-status', fixUI.running
      ? 'Fixing ' + fixUI.album + '…'
      : ((d.albumCount || lastRun) ? 'Last run: fixed ' + d.fixed + ' of ' + d.scanned + ' tracks' : 'Check every song\u2019s tags.'));
    const log = document.getElementById('fix-log');
    if (log) {
      log.innerHTML = fixUI.log.map(e =>
        '<div class="setrow" data-act="tag-edit" data-id="' + e.id + '"><div>' + esc(e.title) +
        '<div class="sub">' + esc(e.artist) + ' · ' + esc(e.changes) + '</div></div>' +
        '<span style="color:var(--sub)">' + icon('chevR', 'width:20px;height:20px') + '</span></div>'
      ).join('') || '<div style="color:var(--sub);font-size:13px">Nothing fixed yet — run the fixer and watch it work.</div>';
    }
    const btn = document.getElementById('fix-run-btn');
    if (btn) {
      btn.textContent = fixUI.running ? 'Fixing…' : 'Fix all songs';
      btn.disabled = fixUI.running;
      btn.classList.toggle('pink', !fixUI.running);
      btn.style.opacity = fixUI.running ? 0.5 : 1;
    }
    const rcta = document.getElementById('fix-review-cta');
    if (rcta) {
      const nq = (S.tagReview || []).length;
      rcta.innerHTML = (!fixUI.running && nq)
        ? '<button class="bigbtn pink" data-act="tag-review-open" style="width:100%;margin-bottom:8px">Review ' + nq + ' suggested correction' + (nq === 1 ? '' : 's') + '</button>' +
          '<button class="bigbtn" data-act="tag-review-approve-all" style="width:100%">Approve all ' + nq + ' without reviewing</button>'
        : '';
    }
  }
  function vTagFixer() {
    const stat = (id, label) =>
      '<div style="background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px">' +
      '<div id="' + id + '" style="font-size:24px;font-weight:800">—</div>' +
      '<div style="color:var(--sub);font-size:12px;margin-top:4px">' + label + '</div></div>';
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>utag fixer</h1><span style="width:44px"></span></div>
    <div style="padding:4px 20px 48px">
      <div style="color:var(--sub);font-size:12px;margin:2px 0 0">${APP_VERSION}</div>
      <div id="fix-status" style="font-size:15px;font-weight:700;margin:10px 0 2px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px">
        ${stat('fix-albums', 'Songs')}
        ${stat('fix-scanned', 'Scanned')}
        ${stat('fix-matched', 'Matched')}
        ${stat('fix-fixed', 'Fixed')}
      </div>
      <div id="fix-sources" style="color:var(--sub);font-size:13px;margin-top:10px"></div>
      <div id="fix-memory" style="color:var(--sub);font-size:13px;margin-top:4px"></div>
      <div style="text-align:center"><button id="fix-run-btn" class="bigbtn pink" data-act="fix-run" style="margin:20px 0 8px">Fix all songs</button>
      <p class="sub" style="margin:0 0 8px">Goes through songs with missing tags and checks them against the artist roster, Apple Music, Deezer, and MusicBrainz. Confident fixes apply on their own; the rest come to you for review. Songs with complete metadata are skipped — fix those by hand below. Songs nothing recognizes get identified by sound once you add an AcoustID key in Settings, Metadata.</p></div>
      <div id="fix-review-cta" style="margin:4px 0 8px"></div>
      <h2 style="font-size:16px;margin:22px 0 6px">Needs fixing</h2>
      <div id="fix-skipped" style="color:var(--sub);font-size:13px;margin:-2px 0 4px"></div>
      <input id="fixlist-q" placeholder="Filter songs…" autocomplete="off" autocapitalize="off" spellcheck="false"
        style="width:100%;box-sizing:border-box;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;color:var(--txt);font-size:15px;margin:4px 0 8px" />
      <div id="fix-all-songs"></div>
      <h2 style="font-size:16px;margin:26px 0 6px">Fixed in this run</h2>
      <div id="fix-log"></div>
      <h2 style="font-size:16px;margin:26px 0 6px">Edit by hand</h2>
      <input id="tagfix-q" placeholder="Search songs to edit…" autocomplete="off" autocapitalize="off" spellcheck="false"
        style="width:100%;box-sizing:border-box;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;color:var(--txt);font-size:15px;margin:4px 0 8px" />
      <div id="tagfix-results"></div>
    </div>`;
  }
  function paintTagFixResults() {
    const qEl = document.getElementById('tagfix-q');
    const box = document.getElementById('tagfix-results');
    if (!box) return;
    const needle = (qEl && qEl.value || '').trim().toLowerCase();
    if (needle.length < 2) { box.innerHTML = ''; return; }
    const hits = S.tracks.filter(t => ((t.title || '') + ' ' + (t.artist || '')).toLowerCase().includes(needle)).slice(0, 15);
    box.innerHTML = hits.map(t =>
      '<div class="setrow" data-act="tag-edit" data-id="' + t.id + '"><div>' + esc(t.title) +
      '<div class="sub">' + esc(t.artist) + '</div></div>' +
      '<span style="color:var(--sub)">' + icon('chevR', 'width:20px;height:20px') + '</span></div>'
    ).join('') || '<div style="color:var(--sub);font-size:13px">No matches.</div>';
  }
  /* Manual tag editor: a sheet with the song's fields, saved straight to
     the library. Opened from the fixer log or the manual search. */
  function openTagEditor(id) {
    id = Number(id);
    const t = S.byId.get(id);
    if (!t) { toast('Song not found'); return; }
    S._stagedArt = null; S._artRemoved = false;
    const inp = (fid, label, val, half) =>
      '<label style="display:block;margin:10px 0;' + (half ? 'flex:1;min-width:0' : '') + '">' +
      '<div style="color:var(--sub);font-size:12px;margin-bottom:6px">' + label + '</div>' +
      '<input id="tagedit-' + fid + '" value="' + esc(val || '') + '" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
      'style="width:100%;box-sizing:border-box;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;color:var(--txt);font-size:15px" /></label>';
    openSheet('<div style="padding:6px 4px 20px"><h3 style="margin:4px 0 2px;font-size:17px">' + esc(t.title) + '</h3>' +
      '<div style="color:var(--sub);font-size:13px;margin-bottom:6px">' + esc(t.artist) + ' — edit tags</div>' +
      '<div style="display:flex;gap:14px;align-items:center;margin:10px 0 4px">' +
      '<div id="tagedit-artprev" style="width:96px;height:96px;border-radius:12px;overflow:hidden;background:var(--card);flex:none;display:flex;align-items:center;justify-content:center"></div>' +
      '<div style="flex:1"><button class="bigbtn" data-act="tag-art-upload" style="width:100%">Upload artwork</button>' +
      '<button class="bigbtn" data-act="tag-art-remove" data-id="' + t.id + '" style="width:100%;margin-top:8px">Remove artwork</button>' +
      '<div class="sub" style="margin-top:6px">Hand-set artwork is never touched by the fixer.</div></div></div>' +
      '<input type="file" id="tagedit-artfile" accept="image/*" style="display:none" />' +
      inp('title', 'Title', t.title) + inp('artist', 'Artist', t.artist) +
      inp('album', 'Album', t.album) + inp('albumArtist', 'Album artist', t.albumArtist) +
      inp('genre', 'Genre', t.genre) +
      '<div style="display:flex;gap:10px">' + inp('year', 'Year', t.year, true) + inp('trackNo', 'Track #', t.trackNo, true) + '</div>' +
      '<button class="bigbtn pink" data-act="tag-save" data-id="' + t.id + '" style="width:100%;margin-top:14px">Save tags</button></div>');
    paintTagArtPreview(t);
    const fi = document.getElementById('tagedit-artfile');
    if (fi) fi.addEventListener('change', () => { const f = fi.files && fi.files[0]; fi.value = ''; if (f) stageArtwork(f, t); });
  }
  // Artwork preview inside the tag editor: staged upload, else current art,
  // else the placeholder.
  function paintTagArtPreview(t) {
    const box = document.getElementById('tagedit-artprev');
    if (!box) return;
    if (S._stagedArt) {
      box.innerHTML = '<img src="' + S._stagedArt.url + '" style="width:96px;height:96px;object-fit:cover;display:block" alt="" />';
    } else if (S._artRemoved) {
      box.innerHTML = '<span style="color:var(--sub)">' + icon('note') + '</span>';
    } else {
      const u = artURL(t);
      box.innerHTML = u
        ? '<img src="' + u + '" style="width:96px;height:96px;object-fit:cover;display:block" alt="" onerror="App.artErr(this)" />'
        : '<span style="color:var(--sub)">' + icon('note') + '</span>';
    }
  }
  // Stage an uploaded image as the track's artwork: downscaled to max
  // 1000px JPEG so the library stays lean, previewed instantly.
  async function stageArtwork(file, t) {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const max = 1000;
      const sc = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(1, Math.round((img.naturalWidth || max) * sc));
      const h = Math.max(1, Math.round((img.naturalHeight || max) * sc));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.85));
      if (!blob) { toast('Could not read that image'); return; }
      if (S._stagedArt) URL.revokeObjectURL(S._stagedArt.url);
      S._stagedArt = { blob, url: URL.createObjectURL(blob) };
      S._artRemoved = false;
      paintTagArtPreview(t);
    } catch (e) { toast('Could not read that image'); }
  }
  // Shared album-tag fixer: used by the album page button and the track •••
  // sheet. Quiet mode skips per-album toasts and view jumps. Returns the raw result.
  async function fixAlbumByKey(key, opts = {}) {
    const quiet = !!opts.quiet;
    const silent = !!opts.silent; // tag-fixer screen: no mid-run renders, it paints itself
    const a = albumByKey(key);
    if (!a || S.fixing) return null;
    const ids = a.tracks.map(t => t.id);
    const knownAlbums = albums()
      .filter(x => x.name && x.name !== 'Unknown Album' && x.key !== a.key)
      .map(x => ({ name: x.name, artist: x.artist }));
    const knownArtists = [...new Set(S.tracks.map(t => t.artist).filter(x => x && x !== 'Unknown Artist'))];
    // Strays: same-artist tracks filed under physical single releases.
    // Fixing the album pulls them home so the album comes out complete.
    // (Virtual singles are views onto the same tracks, not strays.)
    const strays = [];
    realAlbums()
      .filter(g => g.key !== a.key && g.name !== 'Unknown Album' && g.tracks.length <= 2 && g.artist === a.artist)
      .forEach(g => g.tracks.forEach(t => {
        if (!ids.includes(t.id) && (t.artist === a.artist || t.albumArtist === a.artist)) strays.push(t);
      }));
    if (!quiet) toast('Fixing album tags…');
    S.fixing = key; if (!silent) render();
    let res = null;
    try {
      res = await Importer.fixAlbum(a.tracks.concat(strays), knownAlbums, knownArtists);
    } catch (e) { console.warn('fix-album failed', e); }
    S.fixing = null;
    try {
      await refreshTracks(); if (!silent) { render(); paintMini(); }
      if (quiet) return res;
      if (res && res.fixed > 0) {
        const na = albums().find(x => !x.single && x.tracks.some(t => ids.includes(t.id)))
          || albums().find(x => x.tracks.some(t => ids.includes(t.id)));
        if (na) S.stack[S.stack.length - 1] = { v: 'album', id: na.key };
        render();
        toast(`Fixed ${res.fixed} of ${res.total} tracks`);
      } else if (res && res.notFound) toast('Couldn\u2019t find that album');
      else if (res && res.matched > 0) toast('Tags already look good');
      else if (res && res.found) toast('Couldn\u2019t find tags for these tracks');
      else if (res) toast('Tags already look good');
      else toast('Fix failed, try again');
    } catch (e) { console.warn('fix-album render failed', e); }
    return res;
  }
  // utag fixer: album-first pass, then a parallel per-song pool, with live
  // per-row painting. The album pass clusters named-album tracks and
  // resolves each cluster with one listing lookup; whatever it leaves over
  // (unknown albums, unmatched tracks) goes through the unified fixTrack
  // engine 5 at a time. Confident fixes apply on their own; the rest come
  // to you for review, highest confidence first.
  async function fixAllSongs() {
    if (S.fixing) return;
    // v8.1 stale-run guard: a previous run that died without resetting must
    // never wedge the button — restart it if nothing painted for 2 minutes.
    if (fixUI.running) {
      if (Date.now() - (fixUI.lastProgressAt || 0) < 120000) return;
      try { console.warn('fixAllSongs: resetting stale run'); } catch (e) {}
    }
    const list = [...S.tracks].filter(trackNeedsFix).sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    if (!list.length) { toast('All songs already have metadata'); return; }
    const roster = [...S.artists.values()];
    S.tagReview = S.tagReview || [];
    Object.assign(fixUI, { running: true, album: '', albumIdx: 0, albumCount: list.length, scanned: 0, matched: 0, fixed: 0, notFound: 0, log: [], lastProgressAt: Date.now(), via: { apple: 0, deezer: 0, musicbrainz: 0, spotify: 0, memory: 0, acoustid: 0 } });
    const markProgress = () => { fixUI.lastProgressAt = Date.now(); };
    buildFixList(list);
    paintFixUI();
    try {
    const queueReview = (queued) => {
      (queued || []).forEach(q => {
        if (!S.tagReview.some(x => x.trackId === q.trackId && x.proposal.field === q.proposal.field && x.proposal.to === q.proposal.to)) {
          S.tagReview.push(q);
        }
      });
    };
    const countVia = (t) => {
      const tv = t.tagsVia || '';
      if (tv.includes('memory')) fixUI.via.memory++;
      else if (tv.includes('AcoustID')) fixUI.via.acoustid++;
      else if (tv.includes('Deezer')) fixUI.via.deezer++;
      else if (tv.includes('Apple')) fixUI.via.apple++;
      else if (tv.includes('MusicBrainz')) fixUI.via.musicbrainz++;
      else if (tv.includes('Spotify')) fixUI.via.spotify++;
    };
    const logFixed = (t, note) => {
      fixUI.log.unshift({ id: t.id, title: t.title, artist: t.artist, changes: note });
      if (fixUI.log.length > 60) fixUI.log.pop();
      countVia(t);
    };
    const knownAlbums = albums()
      .filter(x => x.name && x.name !== 'Unknown Album')
      .map(x => ({ name: x.name, artist: x.artist }));
    const rosterNames = roster.map(r => r.name).filter(x => x && x !== 'Unknown Artist');
    // Phase 1 — album-first: named-album clusters resolve from one listing
    // lookup each; memory-known tracks skip the network entirely.
    // v8.1: the status names the live album so a slow run is diagnosable.
    fixUI.album = 'albums';
    paintFixUI();
    let leftover = list;
    try {
      const cr = await Importer.fixAlbumClusters(list, knownAlbums, rosterNames, (t, status, note) => {
        markProgress();
        if (status === 'scanning') {
          fixUI.album = (t.album && t.album !== 'Unknown Album' ? t.album : 'albums');
          paintFixRow(t.id, 'scanning'); paintFixUI(); return;
        }
        fixUI.scanned++; fixUI.albumIdx++;
        if (status === 'fixed') { fixUI.fixed++; fixUI.matched++; logFixed(t, note); }
        else if (status === 'ok') { fixUI.matched++; }
        paintFixRow(t.id, status, note);
        paintFixUI();
      });
      leftover = cr.leftover;
    } catch (e) { console.warn('album-first pass failed', e); }
    // Phase 2 — parallel fix pool for everything the album pass left over.
    // v8.1: inside the run try/finally so a throw can never leave the
    // button wedged on "Fixing…".
    // v8.4: skipHandle lets the Skip button interrupt a track mid-flight.
    const skipHandle = {};
    fixUI.skipNow = null;
    await Importer.fixTrackPool(leftover, roster, {
      concurrency: 5,
      skipHandle,
      isSkipped: (tid) => { const tr = S.byId.get(tid); return tr ? isTrackSkipped(tr) : false },
      onStart: (t) => {
        markProgress();
        if (!fixUI.skipNow && skipHandle.now) fixUI.skipNow = skipHandle.now;
        fixUI.album = t.title || 'Unknown Title';
        paintFixRow(t.id, 'scanning');
        paintFixUI();
      },
      // v7.9: the fixer only fingerprints tracks nothing else recognized.
      onFingerprint: (t) => { markProgress(); paintFixRow(t.id, 'fingerprinting'); },
      onDone: (t, res) => {
        markProgress();
        fixUI.scanned++; fixUI.albumIdx++;
        if (res) {
          if (res.fixed) { fixUI.fixed += res.fixed; fixUI.matched++; }
          queueReview(res.queued);
          paintFixRow(t.id, res.status, res.note);
          if (res.fixed && res.note) logFixed(t, res.note);
        } else {
          paintFixRow(t.id, 'nomatch');
        }
        paintFixUI();
      },
    });
    // v7.8 review triage: highest confidence first, in the queue and on screen.
    S.tagReview.sort((a, b) => ((b.proposal || {}).confidence || 0) - ((a.proposal || {}).confidence || 0));
    try {
      localStorage.setItem('splotify-tagfix-last', JSON.stringify({
        when: Date.now(), scanned: fixUI.scanned, matched: fixUI.matched,
        fixed: fixUI.fixed, notFound: fixUI.notFound, albums: fixUI.albumCount,
        via: fixUI.via,
      }));
    } catch (e) { /* ignore */ }
    try { await refreshTracks(); render(); paintMini(); } catch (e) {}
    buildFixList();
    paintFixUI();
    const nq = (S.tagReview || []).length;
    toast(fixUI.scanned
      ? `utag fixer: fixed ${fixUI.fixed} of ${fixUI.scanned} tracks` + (nq ? `, ${nq} to review` : '')
      : 'utag fixer: tags already look good');
    } finally {
      // v8.1: the run can never wedge the button on "Fixing…" again.
      fixUI.running = false; fixUI.album = ''; fixUI.skipNow = null;
      try { paintFixUI(); } catch (e) {}
    }
  }
  // All-songs list for the fixer menu: every song with artwork, filterable,
  // each row painted live as the fixer works through it.
  // v8.2: the auto fixer only queues songs with incomplete metadata —
  // complete tags are skipped (correct those by hand in "Edit by hand").
  function trackNeedsFix(t) {
    try { if (window.Importer && Importer.needsFix) return Importer.needsFix(t); } catch (e) {}
    return true;
  }
  // v8.4 manual skip: songs the user never wants the auto fixer to touch.
  // Persisted on the tagMemory record; S.skipIds mirrors it in memory.
  async function ensureSkipIds() {
    if (S.skipIds) return S.skipIds;
    S.skipIds = new Set();
    try {
      const all = (window.Importer && Importer.memAll) ? await Importer.memAll() : [];
      (all || []).forEach(r => { if (r && r.skip && r.key) S.skipIds.add(r.key); });
    } catch (e) {}
    return S.skipIds;
  }
  function trackSkipKey(t) {
    try { if (window.Importer && Importer.skipKeyFor) return Importer.skipKeyFor(t); } catch (e) {}
    return 'f:' + (t.fileName || '') + '::' + (t.fileSize || 0);
  }
  function isTrackSkipped(t) { return !!(S.skipIds && S.skipIds.has(trackSkipKey(t))); }
  function fixListTracks() {
    return [...S.tracks].filter(trackNeedsFix).sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
  }
  function buildFixList(prebuilt) {
    const box = document.getElementById('fix-all-songs');
    if (!box) return;
    const list = prebuilt || fixListTracks();
    box.innerHTML = list.map(t =>
      '<div class="fx-row" data-act="tag-edit" data-id="' + t.id + '">' +
      '<div class="fx-art">' + artImg(t) + '</div>' +
      '<div class="fx-meta"><div class="fx-title">' + esc(t.title || 'Unknown Title') + '</div>' +
      '<div class="fx-sub">' + esc(t.artist || 'Unknown Artist') + ' · ' + esc(t.album || 'Unknown Album') + '</div>' +
      '<div class="fx-note" id="fxn-' + t.id + '"></div></div>' +
      '<div class="fx-status" id="fxs-' + t.id + '"></div>' +
      '<button class="fx-skipbtn" data-act="fix-skip" data-id="' + t.id + '" style="flex:none;background:none;border:1px solid var(--line);border-radius:10px;color:var(--sub);font-size:12px;padding:6px 10px;margin-left:8px">' + (isTrackSkipped(t) ? 'Unskip' : 'Skip') + '</button></div>'
    ).join('');
    applyFixFilter();
  }
  const FX_STATUS = {
    scanning: ['<span class="fx-dot"></span>Fixing…', 'scanning'],
    fingerprinting: ['<span class="fx-dot"></span>Fingerprinting…', 'scanning'],
    fixed: ['✓ Fixed', 'fixed'],
    review: ['→ Review', 'review'],
    ok: ['✓ Checked', 'ok'],
    nomatch: ['No match', 'nomatch'],
    skipped: ['Skipped', 'skipped'],
  };
  function paintFixRow(id, status, note) {
    const el = document.getElementById('fxs-' + id);
    if (el) {
      const s = FX_STATUS[status] || FX_STATUS.nomatch;
      el.innerHTML = s[0];
      el.className = 'fx-status ' + s[1];
    }
    const n = document.getElementById('fxn-' + id);
    if (n) n.textContent = note || '';
  }
  function applyFixFilter() {
    const qEl = document.getElementById('fixlist-q');
    const box = document.getElementById('fix-all-songs');
    if (!box) return;
    const needle = (qEl && qEl.value || '').trim().toLowerCase();
    box.querySelectorAll('.fx-row').forEach(r => {
      const t = S.byId.get(Number(r.dataset.id));
      const hay = t ? ((t.title || '') + ' ' + (t.artist || '') + ' ' + (t.album || '')).toLowerCase() : '';
      r.style.display = (!needle || hay.includes(needle)) ? '' : 'none';
    });
  }

  /* ================= actions ================= */
  function ctxOf() { return S.viewCtx || { kicker: 'PLAYING FROM SONGS', name: '', kind: 'songs', id: 'songs' }; }
  async function handleAct(el) {
    const act = el.dataset.act, id = el.dataset.id;
    switch (act) {
      case 'tab': if (el.dataset.tab === 'create') { openCreateSheet(); break; } nav(el.dataset.tab); break;
      /* v7.0 library chrome */
      case 'lib-chip': S.libChip = (S.libChip === id ? 'all' : id); render(); break;
      case 'lib-sort': S.libSort = S.libSort === 'az' ? 'recent' : 'az'; render(); break;
      case 'lib-view': S.libGrid = !S.libGrid; render(); break;
      case 'lib-search':
        S.libSearching = !S.libSearching;
        if (!S.libSearching) S.libQ = '';
        render();
        if (S.libSearching) setTimeout(() => { const i = document.getElementById('lib-q'); if (i) i.focus(); }, 40);
        break;
      case 'open-create-sheet': openCreateSheet(); break;
      case 'create-playlist': openPlaylistNameSheet(); break;
      case 'do-create-playlist': {
        const inp = document.getElementById('newpl-name');
        const name = inp ? inp.value.trim().slice(0, 60) : '';
        if (!name) { toast('Give your playlist a name'); break; }
        const pl = { id: 'pl' + Date.now(), name, trackIds: [], created: Date.now() };
        try { await DB.putPlaylist(pl); } catch (e) { toast('Could not create playlist'); break; }
        S._pls.push(pl); closeSheet(); nav('playlist', pl.id);
        break;
      }
      case 'pill': S.pill = id; render(); break;
      case 'import': Importer.open(); break;
      case 'import-zip': Importer.openZip(); break;
      case 'export-hub': nav('exportHub'); break;
      case 'export-device': nav('deviceExport'); break;
      case 'export-drive': if (exporting) nav('driveBackup'); else exportLibrary('drive'); break;
      case 'dev-start': exportLibrary('link'); break;
      case 'dev-pause': exportUserPaused = true; exportCancel = true; { const el = document.getElementById('dev-note'); if (el) el.textContent = 'Finishing this part, then pausing…'; } break;
      case 'dev-done': nav('settings'); break;
      case 'dev-copy': { const u = devUI.link; if (u) { try { await navigator.clipboard.writeText(u); } catch (e) {} toast('Link copied'); } } break;
      case 'db-start': exportLibrary('drive'); break;
      case 'db-pause': exportUserPaused = true; exportCancel = true; { const el = document.getElementById('db-note'); if (el) el.textContent = 'Finishing this part, then pausing…'; } break;
      case 'db-done': nav('settings'); break;
      case 'open-plimport': nav('plimport'); break;
      /* v7.0 Spotify transfer */
      case 'open-spotify-import': nav('spotifyImport'); break;
      case 'sp-oauth': SpImport.oauthStart(); break;
      case 'sp-pick-zip': { const zi = document.getElementById('sp-zip'); if (zi) zi.click(); break; }
      case 'sp-review-approve': {
        const i = Number(el.dataset.idx);
        const it = S.spReview[i];
        if (it) { try { await SpImport.approveReviewItem(it); } catch (e) {} S.spReview.splice(i, 1); }
        await refreshTracks(); render();
        if (!S.spReview.length) nav('spReport');
        break;
      }
      case 'sp-review-skip': {
        S.spReview.splice(Number(el.dataset.idx), 1); render();
        if (!S.spReview.length) nav('spReport');
        break;
      }
      case 'sp-review-approve-all': {
        for (const it of S.spReview) { try { await SpImport.approveReviewItem(it); } catch (e) {} }
        S.spReview = [];
        await refreshTracks(); nav('spReport');
        break;
      }
      case 'plimport-start': PlImport.startFromUI(); break;
      case 'plimport-cancel': PlImport.cancel(); break;
      case 'plimport-resume': PlImport.resumeStopped(); break;
      case 'plimport-again': PlImport.reset(); break;
      case 'plimport-details': PlImport.toggleDetails(); break;
      case 'go-back': back(); break;
      case 'open-playlist': nav('playlist', id); break;
      case 'open-album': nav('album', id); break;
      case 'open-artist': nav('artist', id); break;
      case 'open-artist-releases': closeSheet(); nav('artistReleases', id); break;
      case 'artist-tab': S.artistTab = id; render(); break;
      case 'artist-toggle-popular': S.artistExpanded = !S.artistExpanded; render(); break;
      case 'artist-toggle-releases': S.artistReleasesExpanded = !S.artistReleasesExpanded; render(); break;
      case 'artist-filter': S.artistFilter = id; render(); break;
      case 'artist-menu': artistSheet(id); break;
      case 'artist-follow': {
        const a = artistViewModel(id); closeSheet();
        if (a) {
          const following = await setArtistFollowed(a.name, !S.followedArtists.has(artistKey(a.name)));
          toast((following ? 'Following ' : 'Unfollowed ') + a.name);
          render();
        }
        break;
      }
      case 'artist-play': case 'artist-shuffle': {
        const a = artistByName(id); closeSheet();
        if (!a) break;
        const ids = artistTopTracks(a).map(t => t.id);
        if (!ids.length) break;
        const isCurrent = Player.state.ctx && Player.state.ctx.kind === 'artist' && Player.state.ctx.id === a.name;
        if (act === 'artist-play' && isCurrent) { await Player.toggle(); paintMini(); paintNowPlaying(); render(); break; }
        if (act === 'artist-shuffle' && !Player.state.shuffle) await Player.toggleShuffle();
        S.viewCtx = { kicker: 'PLAYING FROM ARTIST', name: a.name, kind: 'artist', id: a.name };
        await Player.playContext(S.viewCtx, ids, ids[0]);
        paintMini(); render();
        break;
      }
      case 'open-liked': nav('liked'); break;
      case 'open-songs': nav('songs'); break;
      case 'open-playlists': nav('playlists'); break;
      case 'open-albums': nav('albums'); break;
      case 'open-artists': nav('artists'); break;
      case 'open-curated': nav('curated', id); break;
      case 'open-stations': nav('stations'); break;
      case 'open-podcasts': nav('podcasts'); break;
      case 'open-videos': nav('videos'); break;
      case 'open-notifs':
        S.notifSeen = true; await DB.kvSet('notifSeen', true); nav('notifs'); break;
      case 'open-history': nav('history'); break;
      case 'open-settings': nav('settings'); setTimeout(checkForUpdate, 40); break;
      case 'open-genre': nav('genre', id); break;
      case 'check-update': checkForUpdate(); break;
      case 'apply-update': {
        const sub = document.getElementById('update-sub');
        const pill = document.getElementById('update-pill');
        if (sub) sub.textContent = 'Updating…';
        if (pill) { pill.textContent = '…'; pill.classList.remove('lit'); }
        try {
          const r = await navigator.serviceWorker.getRegistration();
          if (r) await r.update();
          // The new worker skipWaits + claims, and the controllerchange
          // listener reloads the page. Fallback reload in case it stalls.
          setTimeout(() => window.location.reload(), 12000);
        } catch (e) {
          toast('Update failed, try again');
          checkForUpdate();
        }
        break;
      }
      case 'play-all': case 'shuffle-all': {
        const ids = [...el.closest('#view').querySelectorAll('.trow[data-id]')].map(r => Number(r.dataset.id));
        const ctx = ctxOf();
        if (act === 'shuffle-all' && !Player.state.shuffle) await Player.toggleShuffle();
        await Player.playContext(ctx, ids, ids[0]);
        break;
      }
      case 'fix-album': await fixAlbumByKey(id); break;
      case 'fix-all-tags': nav('tagFixer'); break;
      case 'fix-run': fixAllSongs(); break;
      case 'fix-skip': {
        const t = S.byId.get(Number(id));
        if (!t) break;
        await ensureSkipIds();
        const k = trackSkipKey(t);
        if (S.skipIds.has(k)) {
          S.skipIds.delete(k);
          try { await Importer.unskipTrack(t); } catch (e) {}
          toast('Will fix this song next run');
        } else {
          S.skipIds.add(k);
          try { await Importer.skipTrack(t); } catch (e) {}
          // Interrupt it mid-run if it's being processed right now.
          try { if (fixUI.skipNow) fixUI.skipNow(t.id); } catch (e) {}
          paintFixRow(t.id, 'skipped', 'skipped');
          toast('Skipped');
        }
        const btn = document.querySelector('[data-act="fix-skip"][data-id="' + id + '"]');
        if (btn) btn.textContent = S.skipIds.has(k) ? 'Unskip' : 'Skip';
        break;
      }
      case 'tag-review-open': nav('tagReview'); break;
      case 'tag-review-approve': {
        const i = Number(el.dataset.idx);
        const it = S.tagReview[i];
        if (it) {
          try {
            const t = S.byId.get(it.trackId);
            if (t) {
              const before = { ...t };
              const tr = { ...t, [it.proposal.field]: it.proposal.to };
              tr.tagsVia = (t.tagsVia ? t.tagsVia + '+' : '') + 'audit(' + it.proposal.source + ')';
              await DB.updateTrack(t.id, { [it.proposal.field]: it.proposal.to, tagsVia: tr.tagsVia, tagged: true });
              Object.assign(t, { [it.proposal.field]: it.proposal.to, tagsVia: tr.tagsVia, tagged: true });
              // v7.7 calibration: remember what was approved and how sure the
              // fixer was, so a later hand-edit can log a rejection signal.
              t.autoConf = { ...(t.autoConf || {}), [it.proposal.field]: it.proposal.confidence };
              t.autoSource = { ...(t.autoSource || {}), [it.proposal.field]: it.proposal.source };
              try { Importer.learnFix(before, t); } catch (e) {}
            }
          } catch (e) {}
          try { Importer.logCalib(it.proposal.source, it.proposal.confidence, true); } catch (e) {}
          S.tagReview.splice(i, 1);
        }
        render();
        break;
      }
      case 'tag-review-skip': {
        try {
          const it = S.tagReview[Number(el.dataset.idx)];
          if (it) Importer.logCalib(it.proposal.source, it.proposal.confidence, false);
        } catch (e) {}
        S.tagReview.splice(Number(el.dataset.idx), 1); render();
        break;
      }
      case 'tag-review-approve-all': {
        const befores = new Map();
        for (const it of S.tagReview) {
          try {
            const t = S.byId.get(it.trackId);
            if (t) {
              if (!befores.has(t.id)) befores.set(t.id, { ...t });
              const tagsVia = (t.tagsVia ? t.tagsVia + '+' : '') + 'audit(' + it.proposal.source + ')';
              await DB.updateTrack(t.id, { [it.proposal.field]: it.proposal.to, tagsVia, tagged: true });
              Object.assign(t, { [it.proposal.field]: it.proposal.to, tagsVia, tagged: true });
              t.autoConf = { ...(t.autoConf || {}), [it.proposal.field]: it.proposal.confidence };
              t.autoSource = { ...(t.autoSource || {}), [it.proposal.field]: it.proposal.source };
              try { Importer.logCalib(it.proposal.source, it.proposal.confidence, true); } catch (e) {}
            }
          } catch (e) {}
        }
        for (const [bid, before] of befores) {
          const t = S.byId.get(bid);
          if (t) { try { Importer.learnFix(before, t); } catch (e) {} }
        }
        S.tagReview = [];
        await refreshTracks(); render();
        toast('All corrections applied');
        break;
      }
      case 'tag-edit': openTagEditor(id); break;
      case 'tag-save': {
        const tid = Number(id);
        const val = fid => { const i = document.getElementById('tagedit-' + fid); return i ? i.value.trim() : ''; };
        const patch = { title: val('title'), artist: val('artist'), album: val('album'), albumArtist: val('albumArtist'), genre: val('genre') };
        const year = parseInt(val('year'), 10); if (year) patch.year = year;
        const trackNo = parseInt(val('trackNo'), 10); if (trackNo) patch.trackNo = trackNo;
        if (!patch.title) { toast('Title can\u2019t be empty'); break; }
        if (S._stagedArt) {
          patch.art = S._stagedArt.blob;
          patch.artManual = true;
          URL.revokeObjectURL(S._stagedArt.url);
          S._stagedArt = null;
        } else if (S._artRemoved) {
          patch.art = null;
          patch.artManual = true;
          S._artRemoved = false;
        }
        try {
          const t0 = S.byId.get(tid);
          const beforeTags = t0 ? { ...t0 } : null;
          await DB.updateTrack(tid, patch);
          const t = S.byId.get(tid); if (t) Object.assign(t, patch);
          if (beforeTags && t) { try { Importer.learnFix(beforeTags, t); } catch (e) {} }
          // v7.7 calibration: hand-editing a field the fixer auto-set is a
          // rejection signal at that confidence (best-effort, in-session).
          try {
            if (beforeTags && t && t.autoConf) {
              for (const f of ['title', 'artist', 'album', 'albumArtist', 'genre']) {
                if (t.autoConf[f] !== undefined && String(patch[f] ?? '') !== String(beforeTags[f] ?? '')) {
                  Importer.logCalib((t.autoSource || {})[f] || 'unknown', t.autoConf[f], false);
                }
              }
            }
          } catch (e) {}
          try { S.artURLs.delete(tid); } catch (e) {}
          closeSheet(); await refreshTracks(); render(); paintMini();
          paintFixUI();
          toast('Tags saved');
        } catch (e) { toast('Could not save tags'); }
        break;
      }
      case 'tag-art-upload': {
        const fi = document.getElementById('tagedit-artfile');
        if (fi) fi.click();
        break;
      }
      case 'tag-art-remove': {
        if (S._stagedArt) { URL.revokeObjectURL(S._stagedArt.url); S._stagedArt = null; }
        S._artRemoved = true;
        const t = S.byId.get(Number(id));
        paintTagArtPreview(t);
        break;
      }
      case 'sheet-fixtags': {
        const t = S.byId.get(Number(id));
        closeSheet();
        if (!t) break;
        const a = albums().find(x => x.tracks.some(y => y.id === t.id));
        if (!a) {
          // Loose song, not on an album: retag just this track.
          if (S.fixing) break;
          const knownAlbums = albums().filter(x => x.name && !x.single).map(x => ({ name: x.name, artist: x.artist }));
          const knownArtists = [...new Set(S.tracks.map(x => x.artist).filter(x => x && x !== 'Unknown Artist'))];
          toast('Fixing tags…');
          S.fixing = 'track-' + t.id; render();
          let res = null;
          try { res = await Importer.fixAlbum([t], knownAlbums, knownArtists); } catch (e) { console.warn('fix-track failed', e); }
          S.fixing = null;
          try {
            await refreshTracks(); render(); paintMini();
            if (res && res.fixed > 0) toast('Tags fixed');
            else if (res && res.notFound) toast('Couldn\u2019t find tags for this song');
            else if (res) toast('Tags already look good');
            else toast('Fix failed, try again');
          } catch (e) { console.warn('fix-track render failed', e); }
          break;
        }
        await fixAlbumByKey(a.key);
        break;
      }
      case 'play-track': {
        const ctx = ctxOf();
        // v7.0: the SDB is never a play context. Tapping a song while
        // browsing the SDB plays just that song; library contexts
        // (playlist/album/artist/liked) keep full-list queues.
        const sdbBrowse = ['songs', 'search', 'genre'].includes(ctx.kind);
        const ids = sdbBrowse ? [Number(id)] : [...el.closest('#view').querySelectorAll('.trow[data-id]')].map(r => Number(r.dataset.id));
        const sameCtx = Player.state.ctx && Player.state.ctx.kind === ctx.kind && String(Player.state.ctx.id) === String(ctx.id);
        if (sameCtx && Player.state.list.join() === ids.join()) await Player.playId(Number(id));
        else await Player.playContext(ctx, ids, Number(id));
        openNP();
        break;
      }
      case 'queue-jump': closeSheet(); await Player.jumpToQueueId(Number(id)); break;
      case 'track-menu': trackSheet(Number(id)); break;
      case 'sheet-like': await Player.toggleLike(Number(id)); closeSheet(); paintNowPlaying(); break;
      case 'sheet-download': closeSheet(); downloadTrack(Number(id)); break;
      case 'sheet-addto': addToSheet(Number(id)); break;
      case 'sheet-newpl': {
        const name = prompt('Name your playlist:');
        if (name && name.trim()) {
          const pl = { id: 'pl' + Date.now(), name: name.trim().slice(0, 60), trackIds: [Number(id)], created: Date.now() };
          await DB.putPlaylist(pl); S._pls.push(pl);
          toast(`Added to ${pl.name}`);
        }
        closeSheet(); break;
      }
      case 'sheet-addto-pl': {
        const pl = S._pls.find(x => x.id === el.dataset.pl);
        if (pl && !pl.trackIds.includes(Number(id))) { pl.trackIds.push(Number(id)); await DB.putPlaylist(pl); toast(`Added to ${pl.name}`); }
        closeSheet(); break;
      }
      case 'sheet-album': { const t = S.byId.get(Number(id)); closeSheet(); if (t) nav('album', albumKeyForTrack(t)); break; }
      case 'sheet-artist': { const t = S.byId.get(Number(id)); closeSheet(); if (t) { const ea = artists().find(x => x.tracks.includes(t)); if (ea) nav('artist', ea.name); } break; }
      case 'sheet-info': infoSheet(Number(id)); break;
      case 'sheet-library-toggle': {
        const tid = Number(id); closeSheet();
        if (libraryHas(tid)) { await libraryRemove(tid); toast('Removed from your library'); }
        else if (await libraryAdd(tid)) { toast('Saved to your library'); }
        render();
        break;
      }
      case 'sheet-delete': {
        const tid = Number(id); closeSheet();
        // v7.0: in a playlist, delete removes the song from the playlist.
        // Elsewhere it permanently deletes the song file from the SDB.
        const ctx = S.viewCtx;
        if (ctx && ctx.kind === 'playlist') {
          const pl = S._pls.find(x => x.id === ctx.id);
          if (pl && pl.trackIds.includes(tid)) {
            pl.trackIds = pl.trackIds.filter(x => x !== tid);
            await DB.putPlaylist(pl); render(); toast('Removed from playlist');
          }
          break;
        }
        if (confirm('Permanently delete this song file? This cannot be undone.')) {
          await DB.delTrack(tid);
          Player.forgetTrack(tid);
          await libraryRemove(tid);
          S._pls.forEach(p => { p.trackIds = p.trackIds.filter(x => x !== tid); DB.putPlaylist(p); });
          await refreshTracks(); paintMini(); render();
          toast('Song deleted');
        }
        break;
      }
      case 'delete-playlist': {
        if (confirm('Delete this playlist? (Songs stay in your library)')) {
          await DB.delPlaylist(id); S._pls = S._pls.filter(x => x.id !== id); nav('library');
        }
        break;
      }
      case 'toggle-edit-recent': S.editRecent = !S.editRecent; render(); break;
      case 'clear-recent': S.recent = []; await DB.kvSet('recent', []); render(); toast('Recently played cleared'); break;
      case 'wipe':
        if (confirm('Delete ALL music, playlists and likes from Splotify? This cannot be undone.')) {
          await DB.clearAll(); location.reload();
        }
        break;
    }
  }

  /* ================= boot ================= */
  /* v7.0 one-time migration: SDB/library split.
     - Every existing track becomes SDB-only (tracks stay untouched).
     - Library, liked songs, and playlists start EMPTY (clean state).
     - The artist roster table is seeded from the bundled placeholder list.
     - Legacy followedArtists (kv) move into the roster table, then the kv is dropped.
     Runs once; stamped in localStorage. Never breaks boot. */
  async function migrateV7() {
    try {
      if (localStorage.getItem('splotify-v7-migrated')) return;
      // 1. Seed the artist roster from the bundled placeholder list.
      let seed = [];
      try {
        const r = await fetch('js/placeholder-artists.json', { cache: 'no-store' });
        if (r.ok) seed = await r.json();
      } catch (e) {}
      const seen = new Set((await DB.allArtists().catch(() => [])).map(a => a.id));
      const batch = [];
      for (const name of (Array.isArray(seed) ? seed : [])) {
        const nm = String(name || '').trim();
        if (!nm) continue;
        const id = artistIdFor(nm);
        if (id === 'a_' || seen.has(id)) continue;
        seen.add(id);
        batch.push({ id, name: nm, isPlaceholder: true, followed: false, followedAt: 0, art: null, bio: null, stats: null });
      }
      // 2. Legacy follows (kv) become followed roster entries.
      let legacy = [];
      try { legacy = await DB.kvGet('followedArtists', []); } catch (e) {}
      for (const key of (Array.isArray(legacy) ? legacy : [])) {
        const id = artistIdFor(key);
        if (id === 'a_' || seen.has(id)) continue;
        seen.add(id);
        batch.push({ id, name: String(key), isPlaceholder: true, followed: true, followedAt: Date.now(), art: null, bio: null, stats: null });
      }
      if (batch.length) { try { await DB.putArtists(batch); } catch (e) {} }
      try { await DB.kvSet('followedArtists', []); } catch (e) {}
      // 3. Clean state: library, liked, playlists start empty.
      try {
        for (const p of await DB.allPlaylists()) { try { await DB.delPlaylist(p.id); } catch (e) {} }
      } catch (e) {}
      try { await DB.kvSet('liked', []); } catch (e) {}
      try { await DB.kvSet('library', []); } catch (e) {}
      try { localStorage.setItem('splotify-v7-migrated', '1'); } catch (e) {}
    } catch (e) { /* never break boot */ }
  }
  /* One-time library dedupe (v6.9): the retired Drive import could double-add
     songs already pulled from the ZIP. Exact match on file name + byte size
     (identical bytes from the same source files); keeps the earliest-added
     copy and remaps playlist/liked references onto it. */
  async function dedupeLibraryOnce() {
    try {
      if (localStorage.getItem('splotify-deduped-v1')) return;
      const tracks = await DB.allTracks();
      const groups = new Map();
      for (const t of tracks) {
        if (!t.fileName) continue;
        const k = t.fileName + '|' + (t.fileSize || 0);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(t);
      }
      const remap = new Map(), delIds = [];
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        g.sort((a, b) => ((a.dateAdded || 0) - (b.dateAdded || 0)) || (a.id < b.id ? -1 : 1));
        const keep = g[0].id;
        for (const d of g.slice(1)) { remap.set(d.id, keep); delIds.push(d.id); }
      }
      const mark = () => { try { localStorage.setItem('splotify-deduped-v1', '1'); } catch (e) {} };
      if (!delIds.length) { mark(); return; }
      const remapIds = (ids) => {
        const seen = new Set(); let changed = false;
        const next = [];
        for (const id of (ids || [])) {
          const nid = remap.get(id) || id;
          if (nid !== id) changed = true;
          if (seen.has(nid)) { changed = true; continue; }
          seen.add(nid); next.push(nid);
        }
        return { next, changed };
      };
      try {
        for (const p of await DB.allPlaylists()) {
          if (!Array.isArray(p.trackIds) || !p.trackIds.length) continue;
          const { next, changed } = remapIds(p.trackIds);
          if (changed) { p.trackIds = next; try { await DB.putPlaylist(p); } catch (e) {} }
        }
      } catch (e) {}
      try {
        const liked = await DB.kvGet('liked', []);
        if (Array.isArray(liked) && liked.length) {
          const { next, changed } = remapIds(liked);
          if (changed) await DB.kvSet('liked', next);
        }
      } catch (e) {}
      for (const id of delIds) { try { await DB.delTrack(id); } catch (e) {} }
      mark();
    } catch (e) { /* never break boot */ }
  }
  async function refreshTracks() {
    S.tracks = await DB.allTracks();
    S.byId = new Map(S.tracks.map(t => [t.id, t]));
    S._pls = await DB.allPlaylists();
    // v7.0: roster table + library membership ride along with the SDB cache.
    try { S.artists = new Map((await DB.allArtists()).map(a => [a.id, a])); } catch (e) { S.artists = new Map(); }
    try {
      const lib = await DB.kvGet('library', []);
      S.library = (Array.isArray(lib) ? lib : []).map(Number).filter(id => S.byId.has(id));
    } catch (e) { S.library = []; }
  }
  // v7.0: keep the in-memory playlist list in sync after external writes.
  function notePlaylist(pl) {
    const i = S._pls.findIndex(x => x.id === pl.id);
    if (i >= 0) S._pls[i] = pl; else S._pls.push(pl);
  }
  async function boot() {
    // Show skeleton content immediately: IndexedDB + the player take a moment,
    // and the view would otherwise sit blank on cold start.
    try { view().innerHTML = vSkeletonHome(); } catch (e) {}
    await DB.open();
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    await dedupeLibraryOnce();
    await migrateV7();
    await refreshTracks();
    try {
      // v7.0: follow state lives in the roster table; rebuild the in-memory set.
      S.followedArtists = new Set();
      S.artists.forEach(a => { if (a.followed) S.followedArtists.add(artistKey(a.name)); });
    } catch (e) {}
    await loadRecent();
    Importer.bind();
    // Warm the singles discography early so the first render orders the
    // Singles shelf newest-first; the post-heal pass below recomputes.
    Importer.recordSingles([...S.tracks]).then(async c => {
      if (c > 0) { await refreshTracks(); render(); paintMini(); }
    }).catch(() => {});
    // Quietly fix missing tags on tracks already in the library (no re-import needed),
    // then register single releases from the bundled discography.
    setTimeout(() => {
      Importer.healLibrary().then(async ({ fixed: n, changed }) => {
        const c = await Importer.recordSingles([...S.tracks]);
        if (changed > 0 || c > 0) {
          await refreshTracks(); render(); paintMini();
          if (n > 0) toast(`Fixed tags for ${n} song${n === 1 ? '' : 's'}`);
        }
      }).catch(() => {});
    }, 1500);
    await Player.init();

    Player.on('track', () => { paintMini(); paintNowPlaying(); render(); });
    Player.on('state', () => { paintMini(); paintNowPlaying(); paintDbBgMode(); });
    /* Unfinished Drive backup? Pick it back up on its own — unless the user
       deliberately paused it. Also re-check when the app comes back to the
       foreground, covering background kills without a full relaunch. */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { maybeAutoResumeDrive(); }
    });
    setTimeout(() => { maybeAutoResumeDrive(); }, 2500);
    // Player's track cache is a separate object from the library list; keep the
    // visible record in sync when playback learns a missing duration.
    Player.on('duration', ({ id, duration }) => {
      const t = S.byId.get(id);
      if (t && !t.duration) t.duration = duration;
    });
    Player.on('time', d => paintTime(d.cur, d.dur));

    document.addEventListener('click', e => {
      const scrim = e.target.closest('#sheet-scrim');
      if (scrim) { closeSheet(); return; }
      const el = e.target.closest('[data-act]');
      if (!el) return;
      // dots button inside a track row shouldn't also trigger play
      if (el.dataset.act === 'track-menu') { e.stopPropagation(); }
      handleAct(el);
    });
    // mini player
    document.getElementById('miniplayer').addEventListener('click', e => {
      if (e.target.closest('#mp-play')) { Player.toggle(); return; }
      if (e.target.closest('#mp-devices')) { toast('Playing on this iPhone'); return; }
      openNP();
    });
    // now playing controls
    document.getElementById('np-close').addEventListener('click', closeNP);
    document.getElementById('np-play').addEventListener('click', () => Player.toggle());
    document.getElementById('np-next').addEventListener('click', () => Player.next());
    document.getElementById('np-prev').addEventListener('click', () => Player.prev());
    document.getElementById('np-shuffle').addEventListener('click', () => Player.toggleShuffle());
    document.getElementById('np-repeat').addEventListener('click', () => Player.toggleRepeat());
    document.getElementById('np-like').addEventListener('click', () => { const t = Player.current; if (t) Player.toggleLike(t.id); });
    document.getElementById('np-devices').addEventListener('click', () => toast('Playing on this iPhone'));
    document.getElementById('np-queue').addEventListener('click', queueSheet);
    document.getElementById('np-menu').addEventListener('click', () => { const t = Player.current; if (t) trackSheet(t.id); });
    // seek bar drag
    const bar = document.getElementById('np-bar');
    let seeking = false;
    const setFromEvent = ev => {
      const r = document.getElementById('np-track').getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX);
      const p = Math.max(0, Math.min(1, (x - r.left) / r.width));
      const d = Player.audio.duration || (Player.current && Player.current.duration) || 0;
      document.getElementById('np-fillbar').style.width = (p * 100) + '%';
      document.getElementById('np-knob').style.left = (p * 100) + '%';
      document.getElementById('np-cur').textContent = fmt(p * d);
      return p * d;
    };
    bar.addEventListener('pointerdown', ev => { seeking = true; bar.setPointerCapture(ev.pointerId); setFromEvent(ev); });
    bar.addEventListener('pointermove', ev => { if (seeking) setFromEvent(ev); });
    bar.addEventListener('pointerup', ev => { if (seeking) { seeking = false; Player.seek(setFromEvent(ev)); } });
    // mute toggle: silences the song while it keeps playing (the keep-alive
    // trick). No volume slider: iOS ignores JS volume, and routing audio
    // through Web Audio for a slider would get the context suspended in the
    // background, killing playback.
    const paintMute = () => {
      const m = document.getElementById('np-mute');
      if (m) m.innerHTML = icon(Player.muted ? 'volMute' : 'vol', 'width:22px;height:22px');
    };
    document.getElementById('np-mute').addEventListener('click', () => Player.toggleMute());
    Player.on('volume', paintMute);
    paintMute();
    // Seamless swipe-down to minimize: the screen follows the finger, then
    // either finishes closing or springs back on release. The progress bar
    // keeps priority (seeking), horizontal swipes are ignored.
    (() => {
      const np = document.getElementById('nowplaying');
      let startY = 0, startX = 0, startT = 0, dragging = false, bailed = false;
      np.addEventListener('touchstart', e => {
        bailed = dragging = false;
        if (!np.classList.contains('open')) { bailed = true; return; }
        const t = e.touches[0];
        if (t.target.closest && t.target.closest('#np-bar')) { bailed = true; return; }
        startY = t.clientY; startX = t.clientX; startT = performance.now();
      }, { passive: true });
      np.addEventListener('touchmove', e => {
        if (bailed) return;
        const t = e.touches[0];
        const dy = t.clientY - startY, dx = t.clientX - startX;
        if (!dragging) {
          if (Math.abs(dx) > Math.abs(dy)) { bailed = true; return; }
          if (dy < 10) return;
          dragging = true;
          np.style.transition = 'none';
        }
        if (e.cancelable) e.preventDefault();
        np.style.transform = 'translateY(' + Math.max(0, dy) + 'px)';
      }, { passive: false });
      const endDrag = e => {
        if (bailed || !dragging) { bailed = dragging = false; return; }
        dragging = false;
        const t = e.changedTouches[0];
        const dy = t.clientY - startY;
        const dt = Math.max(1, performance.now() - startT);
        np.style.transition = '';
        np.style.transform = '';
        if (dy > 110 || dy / dt > 0.45) closeNP();
        bailed = false;
      };
      np.addEventListener('touchend', endDrag, { passive: true });
      np.addEventListener('touchcancel', endDrag, { passive: true });
    })();

    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); closeNP(); } });

    S.stack = [{ v: 'home' }];
    render();
    paintMini();
    // Resume any unfinished Spotify playlist import.
    try { if (typeof PlImport !== 'undefined') PlImport.resume(); } catch (e) {}
    // v7.0: complete the Spotify OAuth round-trip after redirect.
    try {
      const cb = await SpImport.handleCallback();
      if (cb === 'ok') {
        const data = SpImport.takeCallbackData();
        if (data) { toast('Spotify connected \u2014 matching your SDB\u2026'); await runSpImportData(data); }
      } else if (cb === 'blocked') {
        toast('Spotify blocked the app \u2014 use the data export instead');
        nav('spotifyImport');
      } else if (cb === 'error') {
        toast('Spotify connect failed \u2014 try the data export');
        nav('spotifyImport');
      }
    } catch (e) {}
    if ('serviceWorker' in navigator) {
      const updReg = () => navigator.serviceWorker.register('sw.js').then(r => { try { r.update(); } catch (e) {} }).catch(() => {});
      window.addEventListener('load', updReg);
      // Re-check for updates whenever the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { try { navigator.serviceWorker.getRegistration().then(r => r && r.update().catch(() => {})); } catch (e) {} }
      });
      // When a new version takes over, reload so the running code is never one version behind.
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return; reloaded = true;
        window.location.reload();
      });
    }
  }

  return {
    boot, nav, toast, logRecent, logPlay,
    artURL, artImg, artErr,
    searchTier, rankArtistHits, rankSongHits, pickTopResult, vSearch,
    libraryAdd, libraryRemove, libraryHas,
    upsertArtist, setArtistFollowed, notePlaylist,
    onLibraryChanged: async () => {
      await refreshTracks();
      if (await Importer.recordSingles([...S.tracks]) > 0) await refreshTracks();
      render(); paintMini();
    },
    state: S,
  };
})();

document.addEventListener('DOMContentLoaded', () => App.boot());
