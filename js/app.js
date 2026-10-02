/* Splotify app — views, router, artwork, sheets. */
const App = (() => {
  const APP_VERSION = 'v6.3';
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
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    // No art at all: unreleased d4vd tracks (or untagged files) fall back to
    // the deluxe cover instead of a blank. Anything with a real artist tag
    // that isn't d4vd is left alone.
    const ta = normTitle(t.artist);
    if (!ta || ta === 'unknownartist' || ta.indexOf('d4vd') !== -1) return 'js/custom-art/marcescence.jpg';
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
  }
  function logRecent(ctx) {
    if (!ctx || ctx.kind === 'single' || ctx.kind === 'search') return;
    S.recent = S.recent.filter(r => !(r.kind === ctx.kind && r.id === ctx.id));
    S.recent.unshift({ kind: ctx.kind, id: ctx.id, ts: Date.now() });
    S.recent = S.recent.slice(0, 20);
    DB.kvSet('recent', S.recent).catch(() => {});
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
    const cards = recentCards();
    const grid = cards.length ? cards : albums().slice(0, 8).map(a => ({ name: a.name, t: a.art, act: `data-act="open-album" data-id="${esc(a.key)}"` }));
    // more-like: top artist by play count → fallback most tracks
    const counts = {};
    S.tracks.forEach(t => { trackArtistKeys(t).forEach(k => { counts[k] = (counts[k] || 0) + 1; }); });
    const topKey = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const ta = topKey ? artists().find(a => artistKey(a.name) === topKey) : null;
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
        ${S.tracks.length ? '' : `<div class="empty"><h3>Search your music</h3><p>Import songs first, then find them here.</p><button class="bigbtn" data-act="import">Add music</button></div>`}`;
    } else {
      const ts = S.tracks.filter(t => (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q)).slice(0, 20);
      const as = artists().filter(a => a.name.toLowerCase().includes(q)).slice(0, 8);
      const als = albums().filter(a => (a.name + ' ' + a.artist).toLowerCase().includes(q)).slice(0, 8);
      const ps = S._pls.filter(p => p.name.toLowerCase().includes(q));
      const row = (name, sub, t, act) => `<div class="trow" ${act}>${artImg(t, 'art')}<div class="tmeta"><div class="ttitle">${esc(name)}</div><div class="tsub">${esc(sub)}</div></div></div>`;
      body = `${ts.length ? `<div class="sectionhead"><h2>Songs</h2></div>${ts.map(t => trackRow(t)).join('')}` : ''}
      ${as.length ? `<div class="sectionhead"><h2>Artists</h2></div>${as.map(a => row(a.name, 'Artist', a.art, `data-act="open-artist" data-id="${esc(a.name)}"`)).join('')}` : ''}
      ${als.length ? `<div class="sectionhead"><h2>Albums</h2></div>${als.map(a => row(a.name, 'Album • ' + a.artist, a.art, `data-act="open-album" data-id="${esc(a.key)}"`)).join('')}` : ''}
      ${ps.length ? `<div class="sectionhead"><h2>Playlists</h2></div>${ps.map(p => { const t = p.trackIds.map(id => S.byId.get(id)).find(x => x); return row(p.name, `Playlist • ${p.trackIds.length} songs`, t, `data-act="open-playlist" data-id="${p.id}"`); }).join('')}` : ''}
      ${(!ts.length && !as.length && !als.length && !ps.length) ? `<div class="empty"><h3>No results for "${esc(S.query)}"</h3><p>Check the spelling, or try an artist or song title.</p></div>` : ''}`;
    }
    return `<div class="searchbox">${icon('search')}<input id="q" placeholder="What do you want to listen to?" value="${esc(S.query)}" autocomplete="off"></div>${body}`;
  }

  function vLibrary() {
    S.viewCtx = null;
    const n = S.tracks.length;
    const rows = [
      ['sun', 'Made For You', 'open-madeforyou'],
      ['note', 'Playlists', 'open-playlists'],
      ['radio', 'Stations', 'open-stations'],
      ['note', 'Songs', 'open-songs'],
      ['disc', 'Albums', 'open-albums'],
      ['person', 'Artists', 'open-artists'],
      ['radio', 'Podcasts', 'open-podcasts'],
      ['playRect', 'Videos', 'open-videos'],
    ];
    const rec = S.recent.slice(0, 6).map(r => {
      let name = '', sub = '', t = null, act = '';
      if (r.kind === 'playlist') { const p = S._pls.find(x => x.id === r.id); if (!p) return ''; name = p.name; sub = 'Playlist'; t = S.byId.get(p.trackIds[0]); act = `data-act="open-playlist" data-id="${p.id}"`; }
      else if (r.kind === 'album') { const a = albumByKey(r.id); if (!a) return ''; name = a.name; sub = 'Album • by ' + a.artist; t = a.art; act = `data-act="open-album" data-id="${esc(r.id)}"`; }
      else if (r.kind === 'artist') { const a = artistByName(r.id); if (!a) return ''; name = a.name; sub = 'Artist'; t = a.art; act = `data-act="open-artist" data-id="${esc(r.id)}"`; }
      else if (r.kind === 'liked') { name = 'Liked Songs'; sub = 'Playlist • ' + Player.state.liked.size + ' songs'; t = { id: 'liked', art: null }; act = `data-act="open-liked"`; }
      else if (r.kind === 'songs') { name = 'Songs'; sub = n + ' songs'; t = S.tracks.find(x => x.art) || S.tracks[0]; act = `data-act="open-songs"`; }
      else return '';
      const art = (r.kind === 'liked') ? `<div class="liked-heart-tile" style="width:62px;height:62px">${icon('heartF')}</div>` : artImg(t, '');
      return `<div class="trow" ${act}>${art}<div class="tmeta"><div class="ttitle" style="font-size:16px">${esc(name)}</div><div class="tsub">${esc(sub)}</div></div><span style="color:var(--sub);display:flex">${icon('chevR')}</span></div>`;
    }).join('');
    return `
    <div class="lib-head"><div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--pink),var(--pink-deep));display:flex;align-items:center;justify-content:center;color:#111">${icon('note', 'width:22px;height:22px')}</div><h1>Your Library</h1>
    <button class="iconbtn" data-act="import" aria-label="Add music">${icon('plus')}</button>
    <button class="iconbtn" data-act="open-settings" aria-label="Settings">${icon('gear')}</button></div>
    ${rows.map(([ic, lbl, act]) => `<div class="librow" data-act="${act}">${icon(ic)}<span class="lbl">${lbl}</span><span class="chev">${icon('chevR')}</span></div>`).join('')}
    <div class="lib-recent">
      <div class="sectionhead"><h2>Recently Played</h2><button data-act="toggle-edit-recent">${S.editRecent ? 'DONE' : 'EDIT'}</button></div>
      ${rec || `<div class="empty" style="padding:24px"><p>Plays you make will show up here.</p></div>`}
    </div>`;
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
    const a = artistByName(name);
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
    const statLine = stats ? fmtListeners(stats.listeners) : `${a.tracks.length} song${a.tracks.length === 1 ? '' : 's'} in your library`;
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
    const a = artistByName(name);
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
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Songs</h1><button class="iconbtn" data-act="import" aria-label="Add music">${icon('plus')}</button></div>`
      + (ts.length ? playRow(ts.map(t => t.id)) + ts.map(t => trackRow(t)).join('') : `<div class="empty"><h3>No songs yet</h3><button class="bigbtn pink" data-act="import">Add music</button></div>`);
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
  function vMadeForYou() {
    // "On Repeat"-style: 25 most-played = most recently added fallback
    const plays = DB ? null : null;
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Made For You</h1><span style="width:44px"></span></div>
    <div class="empty">${icon('sun', 'width:64px;height:64px;color:var(--pink)')}<h3>On Repeat</h3><p>Your most-played songs will gather here.</p></div>`;
  }
  function vStub(title, ic, msg) {
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>${title}</h1><span style="width:44px"></span></div>
    <div class="empty">${icon(ic, 'width:64px;height:64px;color:var(--sub)')}<h3>${title}</h3><p>${msg}</p></div>`;
  }
  function vSettings() {
    const n = S.tracks.length;
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Settings</h1><span style="width:44px"></span></div>
    <div class="setgroup"><h2>Music</h2>
      <div class="setrow" data-act="import"><div>Add music to library<div class="sub">Import audio files from the Files app</div></div><span style="color:var(--sub)">${icon('plus')}</span></div>
      <div class="setrow" data-act="import-zip"><div>Import ZIP<div class="sub">Pull the songs out of a zip file</div></div><span style="color:var(--sub)">${icon('download')}</span></div>
      <div class="setrow" data-act="export-hub"><div>Export music<div class="sub">Back up your songs to a link or Google Drive</div></div><span style="color:var(--sub)">${icon('download')}</span></div>
      <div class="setrow" data-act="open-plimport"><div>Import Spotify playlist<div class="sub" id="plimport-sub">Turn a playlist into library downloads</div></div><span style="color:var(--sub)">${icon('download')}</span></div>
      <div class="setrow" data-act="fix-all-tags"><div>utag fixer<div class="sub">Retag your library, watch it work, edit tags by hand</div></div><span style="color:var(--sub)">${icon('tag')}</span></div>
      <div class="setrow"><div>Songs in library<div class="sub" id="set-storage">Counting…</div></div><span style="color:var(--sub)">${n}</span></div>
    </div>
    <div class="setgroup"><h2>Playback</h2>
      <div class="setrow" data-act="clear-recent"><div>Clear recently played</div></div>
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
      if (n > 0 && n < batches.length &&
          (auto || confirm('Resume backup? ' + n + ' of ' + batches.length + ' parts are already uploaded.'))) {
        bin = saved.bin; done = saved.done.slice();
        if (saved.sess) sess = saved.sess;
      } else if (n === batches.length) {
        try { localStorage.removeItem(SKEY); } catch (e) { /* ignore */ }
      }
    }
    if (!bin) {
      bin = toDrive ? BRIDGE_BIN : 'splotify-' + sess;
      done = batches.map(() => false);
    }
    const save = () => { try { localStorage.setItem(SKEY, JSON.stringify({ fp, bin, done, sess, userPaused: exportUserPaused })); } catch (e) { /* ignore */ } };
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
    exporting = true; exportCancel = false; exportUserPaused = false;
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

  /* Spotify playlist import: paste a link, songs land in the library one by
     one as the converter finishes them. The live job UI is painted by
     PlImport (js/plimport.js) into #plimport-body. */
  function vPlImport() {
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>Playlist import</h1><span style="width:44px"></span></div>
    <div id="plimport-body" style="padding:0 16px 32px"></div>`;
  }

  /* ================= router ================= */
  const VIEWS = {
    home: vHome, search: vSearch, library: vLibrary, settings: vSettings,
    playlist: id => vPlaylist(id), album: id => vAlbum(id), artist: id => vArtist(id), artistReleases: id => vArtistReleases(id),
    liked: vLiked, songs: vSongs, playlists: vPlaylists, albums: vAlbums, artists: vArtists,
    madeforyou: vMadeForYou, genre: id => vGenre(id),
    notifs: () => vStub('Notifications', 'bell', "You're all caught up."),
    history: () => vStub('Listening history', 'history', 'Your recent plays live in Your Library.'),
    stations: () => vStub('Stations', 'radio', 'Stations need streaming — your library is local-only.'),
    podcasts: () => vStub('Podcasts', 'radio', 'No podcasts here yet.'),
    videos: () => vStub('Videos', 'playRect', 'No videos here yet.'),
    plimport: () => vPlImport(),
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
    if (cur.v === 'tagFixer') { paintFixUI(); paintTagFixResults(); }
    S._lastViewKey = cur.v + '|' + (cur.id || '');
    document.querySelectorAll('.tab').forEach(b => {
      const on = b.dataset.tab === S.tab;
      b.classList.toggle('active', on);
      b.querySelector('.tabicon').innerHTML = icon(b.dataset.tab === 'home' ? (on ? 'home' : 'homeO') : b.dataset.tab, b.dataset.tab === 'search' ? 'width:27px;height:27px' : '');
    });
    const q = document.getElementById('q');
    if (q) {
      q.addEventListener('input', () => { S.query = q.value; const pos = q.selectionStart; render(); const nq = document.getElementById('q'); nq.focus(); nq.setSelectionRange(pos, pos); });
      if (qHadFocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }
    const tq = document.getElementById('tagfix-q');
    if (tq) tq.addEventListener('input', paintTagFixResults);
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
    sh.innerHTML = icon('shuffle'); sh.classList.toggle('on', Player.state.shuffle);
    const rp = document.getElementById('np-repeat');
    rp.innerHTML = icon(Player.state.repeat === 'one' ? 'repeat1' : 'repeat');
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
    const noAlbum = !t.album || t.album === 'Unknown Album';
    openSheet(`<div class="sheet-title">${esc(t.title)}</div>
      <div class="sheet-item" data-act="sheet-like" data-id="${id}">${icon(liked ? 'heartF' : 'heart')}${liked ? 'Unlike' : 'Like'}</div>
      <div class="sheet-item" data-act="sheet-addto" data-id="${id}">${icon('plus')}Add to playlist</div>
      ${noAlbum ? '' : `<div class="sheet-item" data-act="sheet-album" data-id="${id}">${icon('disc')}Go to album</div>`}
      <div class="sheet-item" data-act="sheet-artist" data-id="${id}">${icon('person')}Go to artist</div>
      <div class="sheet-item" data-act="sheet-info" data-id="${id}">${icon('info')}Track info</div>
      <div class="sheet-item" data-act="sheet-fixtags" data-id="${id}">${icon('tag')}utag</div>
      <div class="sheet-item" data-act="sheet-download" data-id="${id}">${icon('download')}Download to this iPhone</div>
      <div class="sheet-item danger" data-act="sheet-delete" data-id="${id}">${icon('trash')}Delete from library</div>`);
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
  const fixUI = { running: false, album: '', albumIdx: 0, albumCount: 0, scanned: 0, matched: 0, fixed: 0, notFound: 0, log: [], via: { apple: 0, musicbrainz: 0, spotify: 0 } };
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
    set('fix-sources', 'Apple Music: ' + (vs.apple || 0) + ' · MusicBrainz: ' + (vs.musicbrainz || 0) + ' · Spotify: ' + (vs.spotify || 0));
    set('fix-status', fixUI.running
      ? 'Fixing ' + fixUI.album + '…'
      : ((d.albumCount || lastRun) ? 'Last run: fixed ' + d.fixed + ' of ' + d.scanned + ' tracks' : 'Retag every album in your library.'));
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
      btn.textContent = fixUI.running ? 'Fixing…' : 'Fix all albums';
      btn.disabled = fixUI.running;
      btn.classList.toggle('pink', !fixUI.running);
      btn.style.opacity = fixUI.running ? 0.5 : 1;
    }
  }
  function vTagFixer() {
    const stat = (id, label) =>
      '<div style="background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px">' +
      '<div id="' + id + '" style="font-size:24px;font-weight:800">—</div>' +
      '<div style="color:var(--sub);font-size:12px;margin-top:4px">' + label + '</div></div>';
    return `<div class="pagehead"><button class="iconbtn" data-act="go-back" aria-label="Back">${icon('chevD', 'transform:rotate(90deg)')}</button><h1>utag fixer</h1><span style="width:44px"></span></div>
    <div style="padding:4px 20px 48px">
      <div id="fix-status" style="font-size:15px;font-weight:700;margin:10px 0 2px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px">
        ${stat('fix-albums', 'Albums')}
        ${stat('fix-scanned', 'Tracks scanned')}
        ${stat('fix-matched', 'Matched')}
        ${stat('fix-fixed', 'Fixed')}
      </div>
      <div id="fix-sources" style="color:var(--sub);font-size:13px;margin-top:10px"></div>
      <div style="text-align:center"><button id="fix-run-btn" class="bigbtn pink" data-act="fix-run" style="margin:20px 0 8px">Fix all albums</button></div>
      <h2 style="font-size:16px;margin:22px 0 6px">Fixed in this run</h2>
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
    const t = S.byId.get(id) || S.tracks.find(x => x.id === id);
    if (!t) { toast('Song not found'); return; }
    const inp = (fid, label, val, half) =>
      '<label style="display:block;margin:10px 0;' + (half ? 'flex:1;min-width:0' : '') + '">' +
      '<div style="color:var(--sub);font-size:12px;margin-bottom:6px">' + label + '</div>' +
      '<input id="tagedit-' + fid + '" value="' + esc(val || '') + '" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
      'style="width:100%;box-sizing:border-box;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;color:var(--txt);font-size:15px" /></label>';
    openSheet('<div style="padding:6px 4px 20px"><h3 style="margin:4px 0 2px;font-size:17px">' + esc(t.title) + '</h3>' +
      '<div style="color:var(--sub);font-size:13px;margin-bottom:6px">' + esc(t.artist) + ' — edit tags</div>' +
      inp('title', 'Title', t.title) + inp('artist', 'Artist', t.artist) +
      inp('album', 'Album', t.album) + inp('albumArtist', 'Album artist', t.albumArtist) +
      inp('genre', 'Genre', t.genre) +
      '<div style="display:flex;gap:10px">' + inp('year', 'Year', t.year, true) + inp('trackNo', 'Track #', t.trackNo, true) + '</div>' +
      '<button class="bigbtn pink" data-act="tag-save" data-id="' + t.id + '" style="width:100%;margin-top:14px">Save tags</button></div>');
  }
  // Shared album-tag fixer: used by the album page button, the track ••• sheet,
  // and the Settings "utag fixer" (fix-all). Quiet mode skips per-album
  // toasts and view jumps so fixAllTags can aggregate; returns the raw result.
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
  // utag fixer (fix-all): retag every album in the library, one by one.
  // Paints the tag-fixer screen live: current album, per-song before/after,
  // and running stats.
  async function fixAllTags() {
    if (S.fixing || fixUI.running) return;
    const list = albums().filter(a => a.tracks && a.tracks.length);
    if (!list.length) { toast('No albums to fix'); return; }
    Object.assign(fixUI, { running: true, album: '', albumIdx: 0, albumCount: list.length, scanned: 0, matched: 0, fixed: 0, notFound: 0, log: [], via: { apple: 0, musicbrainz: 0, spotify: 0 } });
    paintFixUI();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      fixUI.album = a.name || 'Unknown Album'; fixUI.albumIdx = i + 1;
      const tracks = a.tracks || [];
      const before = new Map(tracks.map(t => [t.id, snapTags(t)]));
      let res = null;
      try {
        res = await fixAlbumByKey(a.key, { quiet: true, silent: true });
      } catch (e) { console.warn('utag fixer failed on', a.key, e); }
      if (res) {
        fixUI.scanned += res.total || 0;
        fixUI.matched += res.matched || 0;
        fixUI.fixed += res.fixed || 0;
        const rv = res.via || {};
        fixUI.via.apple += rv.apple || 0;
        fixUI.via.musicbrainz += rv.musicbrainz || 0;
        fixUI.via.spotify += rv.spotify || 0;
        if (!res.found) fixUI.notFound++;
        for (const t of tracks) {
          const b = before.get(t.id); if (!b) continue;
          const changes = diffTags(b, t);
          if (changes) {
            fixUI.log.unshift({ id: t.id, title: t.title, artist: t.artist, changes });
            if (fixUI.log.length > 60) fixUI.log.pop();
          }
        }
      }
      paintFixUI();
    }
    fixUI.running = false; fixUI.album = '';
    try {
      localStorage.setItem('splotify-tagfix-last', JSON.stringify({
        when: Date.now(), scanned: fixUI.scanned, matched: fixUI.matched,
        fixed: fixUI.fixed, notFound: fixUI.notFound, albums: fixUI.albumCount,
        via: fixUI.via,
      }));
    } catch (e) { /* ignore */ }
    try { await refreshTracks(); render(); paintMini(); } catch (e) {}
    paintFixUI();
    toast(fixUI.scanned ? `utag fixer: fixed ${fixUI.fixed} of ${fixUI.scanned} tracks` : 'utag fixer: tags already look good');
  }

  /* ================= actions ================= */
  function ctxOf() { return S.viewCtx || { kicker: 'PLAYING FROM SONGS', name: '', kind: 'songs', id: 'songs' }; }
  async function handleAct(el) {
    const act = el.dataset.act, id = el.dataset.id;
    switch (act) {
      case 'tab': nav(el.dataset.tab); break;
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
        const a = artistByName(id); closeSheet();
        if (a) {
          const k = artistKey(a.name);
          if (S.followedArtists.has(k)) { S.followedArtists.delete(k); toast(`Unfollowed ${a.name}`); }
          else { S.followedArtists.add(k); toast(`Following ${a.name}`); }
          await DB.kvSet('followedArtists', [...S.followedArtists]);
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
      case 'open-madeforyou': nav('madeforyou'); break;
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
      case 'fix-run': fixAllTags(); break;
      case 'tag-edit': openTagEditor(id); break;
      case 'tag-save': {
        const val = fid => { const i = document.getElementById('tagedit-' + fid); return i ? i.value.trim() : ''; };
        const patch = { title: val('title'), artist: val('artist'), album: val('album'), albumArtist: val('albumArtist'), genre: val('genre') };
        const year = parseInt(val('year'), 10); if (year) patch.year = year;
        const trackNo = parseInt(val('trackNo'), 10); if (trackNo) patch.trackNo = trackNo;
        if (!patch.title) { toast('Title can\u2019t be empty'); break; }
        try {
          await DB.updateTrack(id, patch);
          const t = S.byId.get(id); if (t) Object.assign(t, patch);
          closeSheet(); await refreshTracks(); render(); paintMini();
          paintFixUI();
          toast('Tags saved');
        } catch (e) { toast('Could not save tags'); }
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
        const ids = [...el.closest('#view').querySelectorAll('.trow[data-id]')].map(r => Number(r.dataset.id));
        const ctx = ctxOf();
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
      case 'sheet-delete': {
        const tid = Number(id); closeSheet();
        if (confirm('Delete this song from your library?')) {
          await DB.delTrack(tid);
          Player.forgetTrack(tid);
          S._pls.forEach(p => { p.trackIds = p.trackIds.filter(x => x !== tid); DB.putPlaylist(p); });
          await refreshTracks(); paintMini(); render();
          toast('Song deleted');
        }
        break;
      }
      case 'create-playlist': {
        const name = prompt('Name your playlist:');
        if (name && name.trim()) {
          const pl = { id: 'pl' + Date.now(), name: name.trim().slice(0, 60), trackIds: [], created: Date.now() };
          await DB.putPlaylist(pl); S._pls.push(pl); render();
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
  async function refreshTracks() {
    S.tracks = await DB.allTracks();
    S.byId = new Map(S.tracks.map(t => [t.id, t]));
    S._pls = await DB.allPlaylists();
  }
  async function boot() {
    // Show skeleton content immediately: IndexedDB + the player take a moment,
    // and the view would otherwise sit blank on cold start.
    try { view().innerHTML = vSkeletonHome(); } catch (e) {}
    await DB.open();
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    await refreshTracks();
    try { S.followedArtists = new Set(await DB.kvGet('followedArtists', [])); } catch (e) {}
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
      if (document.visibilityState === 'visible') maybeAutoResumeDrive();
    });
    setTimeout(maybeAutoResumeDrive, 2500);
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
    boot, nav, toast, logRecent,
    artURL, artImg, artErr,
    onLibraryChanged: async () => {
      await refreshTracks();
      if (await Importer.recordSingles([...S.tracks]) > 0) await refreshTracks();
      render(); paintMini();
    },
    state: S,
  };
})();

document.addEventListener('DOMContentLoaded', () => App.boot());
