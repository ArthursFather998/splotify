/* Splotify Spotify transfer (v7.0) — bring playlists, Liked Songs, and
   followed artists from Spotify into Splotify, matched against the SDB.
   Two routes in: OAuth (PKCE) against the Spotify Web API, or a Spotify
   data-export ZIP parsed locally. No audio ever moves — pure metadata. */
const SpImport = (() => {
  /* ---------- normalization & matching ---------- */
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/\s*\([^)]*\)/g, '')          // (parentheticals)
      .replace(/\s*\[[^\]]*\]/g, '')          // [bracketed]
      .replace(/\b(feat|ft|featuring|with)\b\.?.*$/i, '') // feat. suffixes
      .replace(/[^a-z0-9]/g, '');
  }
  function artistBits(s) {
    return String(s || '').toLowerCase()
      .split(/\s*(?:,|&|\+|\bfeat\.?(?!\w)|\bfeaturing\b|\bft\.?(?!\w)|\bwith\b)\s*|\s+x\s+/i)
      .map(x => x.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  }
  function lev(a, b) {
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (!la) return lb; if (!lb) return la;
    let prev = new Array(lb + 1), cur = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= lb; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
      const t = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }
  function sim(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    return 1 - lev(a, b) / Math.max(a.length, b.length);
  }
  // Score one Spotify track against one SDB track. 0..1.
  function scoreTrack(sp, t) {
    const st = norm(sp.title), tt = norm(t.title);
    const titleSim = sim(st, tt);
    const spBits = artistBits(sp.artist), tBits = artistBits(t.artist);
    const artistHit = spBits.some(b => tBits.includes(b));
    if (!spBits.length || !tBits.length) return titleSim * 0.7;
    if (st === tt && artistHit) return 1;
    if (artistHit) return 0.55 + titleSim * 0.45;
    return titleSim * 0.6;
  }
  // Match every Spotify track against the SDB. Returns {auto, review, missed}.
  // auto: confident (applied immediately). review: fuzzy (user approves).
  // missed: nothing close (report).
  function matchAll(spTracks, sdbTracks) {
    const auto = [], review = [], missed = [];
    for (const sp of spTracks) {
      let best = null, bestScore = 0;
      for (const t of sdbTracks) {
        const s = scoreTrack(sp, t);
        if (s > bestScore) { bestScore = s; best = t; }
      }
      const item = { sp, sdb: best, score: bestScore };
      if (bestScore >= 0.92) auto.push(item);
      else if (bestScore >= 0.6) review.push(item);
      else missed.push(item);
    }
    return { auto, review, missed };
  }

  /* ---------- data-export ZIP parsing ---------- */
  // Spotify's "Download your data" ZIP. Known files: PlaylistN.json,
  // YourLibrary.json (tracks/albums/artists), Follow.json (followed artists).
  // Defensive: tries documented shapes, reports what it found.
  async function parseExportZip(file) {
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files);
    const find = re => names.find(n => re.test(n));
    const readJson = async n => {
      if (!n) return null;
      try { return JSON.parse(await zip.files[n].async('string')); } catch (e) { return null; }
    };
    const out = { playlists: [], liked: [], artists: [], found: [] };

    // Playlists: Playlist1.json, Playlist2.json, ...
    const plFiles = names.filter(n => /(^|\/)Playlist\d*\.json$/i.test(n));
    for (const pf of plFiles) {
      const j = await readJson(pf);
      if (!j) continue;
      const pls = j.playlists || j || [];
      for (const p of (Array.isArray(pls) ? pls : [])) {
        const items = p.items || [];
        out.playlists.push({
          name: p.name || 'Untitled',
          spotifyId: p.id || null,
          tracks: items.map(it => {
            const tr = it.track || it;
            return {
              title: tr.trackName || tr.name || '',
              artist: tr.artistName || tr.artist || '',
              album: tr.albumName || tr.album || '',
              uri: tr.trackUri || tr.uri || null,
            };
          }).filter(t => t.title),
        });
      }
      out.found.push(pf.split('/').pop() + ': ' + out.playlists.length + ' playlists');
    }

    // Liked songs: YourLibrary.json -> tracks[]
    const libFile = find(/(^|\/)YourLibrary\.json$/i);
    const lib = await readJson(libFile);
    if (lib) {
      const tracks = lib.tracks || [];
      out.liked = tracks.map(t => ({
        title: t.track || t.trackName || t.name || '',
        artist: t.artist || t.artistName || '',
        album: t.album || t.albumName || '',
        uri: t.uri || t.trackUri || null,
      })).filter(t => t.title);
      // Saved albums (for the Albums chip seed — artist merge happens via artists)
      out.savedAlbums = (lib.albums || []).map(a => ({ artist: a.artist || '', album: a.album || a.albumName || '' })).filter(a => a.album);
      out.found.push('YourLibrary.json: ' + out.liked.length + ' liked songs');
      // Followed artists sometimes live here
      const libArtists = lib.artists || [];
      for (const a of libArtists) {
        const name = a.name || a.artist;
        if (name) out.artists.push({ name, uri: a.uri || null });
      }
    }

    // Followed artists: Follow.json
    const folFile = find(/(^|\/)Follow\.json$/i);
    const fol = await readJson(folFile);
    if (fol) {
      const list = Array.isArray(fol) ? fol : (fol.artists || fol.following || []);
      for (const a of list) {
        const name = a.name || a.artist;
        if (name) out.artists.push({ name, uri: a.uri || null });
      }
      out.found.push('Follow.json: followed artists');
    }
    // Dedupe artists by normalized name
    const seen = new Set();
    out.artists = out.artists.filter(a => {
      const k = norm(a.name);
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    });
    return out;
  }

  /* ---------- OAuth (PKCE) ---------- */
  // Static-page friendly: no secret, redirect back to this page.
  // The redirect URI must be registered in the Spotify dev dashboard.
  function redirectUri() { return location.origin + location.pathname; }
  function b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function oauthStart() {
    const inp = document.getElementById('sp-clientid');
    const clientId = (inp ? inp.value : '').trim();
    if (!clientId) { App.toast('Paste your Spotify client ID first'); return; }
    try { localStorage.setItem('sp-clientid', clientId); } catch (e) {}
    const verifierBytes = new Uint8Array(64);
    crypto.getRandomValues(verifierBytes);
    const verifier = b64url(verifierBytes.buffer);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    try {
      sessionStorage.setItem('sp-verifier', verifier);
      sessionStorage.setItem('sp-clientid', clientId);
    } catch (e) {}
    const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirectUri(),
      code_challenge_method: 'S256', code_challenge: challenge,
      scope: 'playlist-read-private playlist-read-collaborative user-library-read user-follow-read',
    });
    location.href = url;
  }
  async function apiGet(token, path) {
    let url = 'https://api.spotify.com/v1' + path;
    const items = [];
    while (url) {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (r.status === 403) { const e = new Error('Spotify blocked this app (403)'); e.spBlocked = true; throw e; }
      if (!r.ok) throw new Error('Spotify API error ' + r.status);
      const j = await r.json();
      if (Array.isArray(j.items)) items.push(...j.items);
      else if (j.artists && Array.isArray(j.artists.items)) items.push(...j.artists.items);
      else return j;
      url = j.next;
    }
    return items;
  }
  async function oauthFetchAll(token) {
    const out = { playlists: [], liked: [], artists: [] };
    const pls = await apiGet(token, '/me/playlists?limit=50');
    for (const p of pls) {
      const tracks = await apiGet(token, `/playlists/${p.id}/tracks?limit=100&fields=next,items(track(name,artists(name),album(name),uri))`);
      out.playlists.push({
        name: p.name || 'Untitled', spotifyId: p.id,
        tracks: tracks.map(it => {
          const t = it.track || {};
          return {
            title: t.name || '',
            artist: (t.artists || []).map(a => a.name).join(', '),
            album: (t.album || {}).name || '',
            uri: t.uri || null,
          };
        }).filter(t => t.title),
      });
    }
    const liked = await apiGet(token, '/me/tracks?limit=50');
    out.liked = liked.map(it => {
      const t = it.track || {};
      return { title: t.name || '', artist: (t.artists || []).map(a => a.name).join(', '), album: (t.album || {}).name || '', uri: t.uri || null };
    }).filter(t => t.title);
    const following = await apiGet(token, '/me/following?type=artist&limit=50');
    out.artists = following.map(a => ({ name: a.name, uri: a.uri || null })).filter(a => a.name);
    return out;
  }
  // Called from App.boot: completes the OAuth round-trip after redirect.
  // Returns 'ok' | 'blocked' | 'error' | null (no callback pending).
  async function handleCallback() {
    let params;
    try { params = new URLSearchParams(location.search); } catch (e) { return null; }
    const code = params.get('code'), err = params.get('error');
    if (!code && !err) return null;
    try { history.replaceState({}, '', location.pathname); } catch (e) {}
    if (err) return 'error';
    let verifier, clientId;
    try { verifier = sessionStorage.getItem('sp-verifier'); clientId = sessionStorage.getItem('sp-clientid'); } catch (e) {}
    if (!verifier || !clientId) return 'error';
    try {
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier }),
      });
      if (r.status === 403) return 'blocked';
      if (!r.ok) return 'error';
      const tok = await r.json();
      if (!tok.access_token) return 'error';
      const data = await oauthFetchAll(tok.access_token);
      data.source = 'oauth';
      try { sessionStorage.setItem('sp-import-data', JSON.stringify(data)); } catch (e) {}
      return 'ok';
    } catch (e) {
      return e.spBlocked ? 'blocked' : 'error';
    }
  }
  function takeCallbackData() {
    try {
      const raw = sessionStorage.getItem('sp-import-data');
      sessionStorage.removeItem('sp-import-data');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /* ---------- apply ---------- */
  // Match Spotify data against the SDB and write the confident hits into
  // the library. Fuzzy hits go to the review queue (returned); misses to
  // the skipped report (returned). Re-runnable: kv 'spotifySync' dedupes.
  async function applyImport(data, sdbTracks) {
    const summary = { playlistsCreated: 0, likedAdded: 0, artistsFollowed: 0, review: [], missed: [] };
    let sync = { playlists: {}, liked: [], artists: [] };
    try { sync = Object.assign(sync, await DB.kvGet('spotifySync', {})); } catch (e) {}
    const likedKeys = new Set(sync.liked || []);
    const artistKeys = new Set(sync.artists || []);
    const likeKey = t => t.uri || ('n:' + norm(t.title) + '|' + norm(t.artist));

    // Liked Songs -> Splotify Liked Songs (+ library)
    const freshLiked = (data.liked || []).filter(t => !likedKeys.has(likeKey(t)));
    if (freshLiked.length) {
      const m = matchAll(freshLiked, sdbTracks);
      for (const it of m.auto) {
        Player.state.liked.add(it.sdb.id);
        try { await App.libraryAdd(it.sdb.id); } catch (e) {}
        likedKeys.add(likeKey(it.sp));
        summary.likedAdded++;
      }
      for (const it of m.review) summary.review.push(Object.assign(it, { context: { type: 'liked' } }));
      for (const it of m.missed) summary.missed.push(Object.assign(it, { context: { type: 'liked' } }));
      try { await DB.kvSet('liked', [...Player.state.liked]); } catch (e) {}
    }

    // Playlists -> Splotify playlists (artists auto-saved via track artists)
    for (const pl of (data.playlists || [])) {
      const plKey = pl.spotifyId || ('n:' + norm(pl.name));
      if (sync.playlists[plKey]) continue;
      const m = matchAll(pl.tracks || [], sdbTracks);
      const trackIds = m.auto.map(it => it.sdb.id);
      const newPl = {
        id: 'pl_sp_' + Date.now() + '_' + Math.floor(Math.random() * 1e6),
        name: String(pl.name || 'Untitled').slice(0, 60),
        trackIds, created: Date.now(), spotifyId: pl.spotifyId || null,
      };
      try { await DB.putPlaylist(newPl); } catch (e) {}
      try { await App.notePlaylist(newPl); } catch (e) {}
      sync.playlists[plKey] = newPl.id;
      summary.playlistsCreated++;
      // Playlist artists get saved to the library.
      const artistNames = new Set();
      m.auto.forEach(it => { (it.sdb.artist || '').split(/,|&/).forEach(a => { const n = a.trim(); if (n) artistNames.add(n); }); });
      for (const n of artistNames) {
        try {
          if (await App.setArtistFollowed(n, true)) summary.artistsFollowed++;
        } catch (e) {}
        try { await App.upsertArtist(n, { isPlaceholder: false }); } catch (e) {}
      }
      for (const it of m.auto) { try { await App.libraryAdd(it.sdb.id); } catch (e) {} }
      for (const it of m.review) summary.review.push(Object.assign(it, { context: { type: 'playlist', name: newPl.name, id: newPl.id } }));
      for (const it of m.missed) summary.missed.push(Object.assign(it, { context: { type: 'playlist', name: newPl.name } }));
    }

    // Followed artists -> roster (placeholders until SDB music lands)
    for (const a of (data.artists || [])) {
      const k = norm(a.name);
      if (!k || artistKeys.has(k)) continue;
      try {
        await App.upsertArtist(a.name, {});
        await App.setArtistFollowed(a.name, true);
        artistKeys.add(k);
        summary.artistsFollowed++;
      } catch (e) {}
    }

    sync.liked = [...likedKeys]; sync.artists = [...artistKeys];
    try { await DB.kvSet('spotifySync', sync); } catch (e) {}
    return summary;
  }
  // Approve one review item (from the review screen).
  async function approveReviewItem(it) {
    if (it.context.type === 'liked') {
      Player.state.liked.add(it.sdb.id);
      try { await DB.kvSet('liked', [...Player.state.liked]); } catch (e) {}
    } else if (it.context.type === 'playlist' && it.context.id) {
      const pl = await DB.getPlaylist(it.context.id).catch(() => null);
      if (pl && !pl.trackIds.includes(it.sdb.id)) {
        pl.trackIds.push(it.sdb.id);
        try { await DB.putPlaylist(pl); } catch (e) {}
        try { await App.notePlaylist(pl); } catch (e) {}
      }
    }
    try { await App.libraryAdd(it.sdb.id); } catch (e) {}
  }
  return { norm, matchAll, parseExportZip, oauthStart, handleCallback, takeCallbackData, redirectUri, applyImport, approveReviewItem };
})();
