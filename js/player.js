/* Splotify player engine - queue, shuffle/repeat, audio output, MediaSession.
 * Audio output is a seam: on the web it's the <audio> element; inside the
 * native iOS shell it's window.SplotifyNativeOut() (js/native-audio.js),
 * which drives the native AVPlayer plugin with real lock-screen controls. */
const Player = (() => {
  const NATIVE_MODE = (typeof window.SplotifyNativeOut === 'function');
  function makeWebOut() {
    const audio = new Audio();
    audio.preload = 'auto';
    const subs = {};
    const on = (t, f) => { (subs[t] = subs[t] || []).push(f); };
    ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata'].forEach(ev =>
      audio.addEventListener(ev, () => (subs[ev] || []).forEach(f => { try { f(); } catch (e) {} })));
    let lastUrl = null;
    return {
      isNative: false,
      on,
      get paused() { return audio.paused; },
      get ended() { return audio.ended; },
      get currentTime() { return audio.currentTime; },
      set currentTime(v) { try { audio.currentTime = v; } catch (e) {} },
      get duration() { return audio.duration || 0; },
      get muted() { return audio.muted; },
      set muted(m) { audio.muted = !!m; },
      get volume() { return audio.volume; },
      set volume(v) { try { audio.volume = v; } catch (e) {} },
      async setTrack(t) {
        if (lastUrl) { try { URL.revokeObjectURL(lastUrl); } catch (e) {} lastUrl = null; }
        lastUrl = URL.createObjectURL(t.file);
        t._url = lastUrl;
        audio.src = lastUrl;
      },
      async clear() {
        if (lastUrl) { try { URL.revokeObjectURL(lastUrl); } catch (e) {} lastUrl = null; }
        try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
      },
      play() { return audio.play(); },
      pause() { audio.pause(); }
    };
  }
  const out = NATIVE_MODE ? window.SplotifyNativeOut() : makeWebOut();
  const listeners = { state: [], track: [], time: [], queue: [], duration: [], volume: [], 'track-error': [] };
  // on/emit stay safe for event names with no listeners yet: a missing
  // array must never throw, or boot dies before the sign-in screen.
  const emit = (ev, d) => (listeners[ev] || []).forEach(f => { try { f(d); } catch (e) { console.error(e); } });

  const S = {
    ctx: null,          // {kicker, name, kind, id}
    list: [],           // track ids in context order (numbers for local
                        // tracks, 'cat:<catalog-uuid>' for streamed ones)
    order: null,        // shuffled index order or null
    pos: 0,             // position within (order || list)
    shuffle: false,
    repeat: 'off',      // off | all | one
    track: null,        // current track object
    playing: false,
    loading: false,     // true while a streamed track's audio is fetching
    liked: new Set(),
    trackCache: new Map(),
  };
  const curId = () => (S.order ? S.list[S.order[S.pos]] : S.list[S.pos]);
  let lastCountedId = null; // play-count dedupe: one count per track start

  /* Streamed tracks: a queue id of the form 'cat:<catalog-uuid>'
     is not in the local database. The app registers a resolver that
     turns the ref into a metadata shell plus a byte loader; the player
     shows the shell at once and starts playback when the bytes land.
     The resolver lives in app.js because only it knows the catalog
     pools and the audio map. */
  function isRemoteId(id) { return typeof id === 'string' && id.indexOf('cat:') === 0; }
  let remoteResolver = null;
  function setRemoteResolver(fn) { remoteResolver = typeof fn === 'function' ? fn : null; }

  async function ensureTrack(id) {
    if (S.trackCache.has(id)) return S.trackCache.get(id);
    if (isRemoteId(id)) return null; // streamed: resolved by loadRemote
    const t = await DB.getTrack(id);
    if (t) S.trackCache.set(id, t);
    return t;
  }
  function shuffledOrder(n, keepFirst) {
    const a = [...Array(n).keys()];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
    if (keepFirst !== undefined) {
      const k = a.indexOf(keepFirst);
      if (k > 0) { a.splice(k, 1); a.unshift(keepFirst); }
    }
    return a;
  }

  async function load(id, autoplay) {
    const gen = ++loadGen;
    if (isRemoteId(id)) return loadRemote(id, autoplay, gen);
    // A local track starting while a remote fetch is in flight owns the
    // player now: clear the spinner the remote load set, or it sticks
    // on the play button until that fetch settles.
    S.loading = false;
    const t = await ensureTrack(id);
    if (!t) return false;
    if (gen !== loadGen) return false;
    S.track = t;
    await out.setTrack(t);
    if (gen !== loadGen) return false;
    setMediaSession(t);
    emit('track', t);
    if (autoplay && t.id !== lastCountedId) { lastCountedId = t.id; try { App.logPlay(t.id); } catch (e) {} }
    if (autoplay) { try { await out.play(); } catch (e) { /* iOS needs gesture; UI reflects */ } }
    syncPlayState();
    saveNow();
    return true;
  }
  /* Streamed track: show the shell (title, artist, art) at once so the
     player never sits blank, fetch the audio, then play. A fetch that
     already happened this session is reused from the cache. Returns
     false when the song cannot be fetched; callers decide whether to
     tell the user (explicit tap) or just move on (queue advance). */
  let loadGen = 0; // every load() call stamps a generation; a load whose
  // generation is stale by the time an await resolves does nothing, so a
  // slow fetch can never hijack a newer track the user already started.
  async function loadRemote(id, autoplay, gen) {
    const cached = S.trackCache.get(id);
    if (cached && cached.file) {
      S.track = cached;
      S.loading = false;
      await out.setTrack(cached);
      if (gen !== loadGen) return false;
      setMediaSession(cached);
      emit('track', cached);
      if (autoplay) {
        if (cached.utagTrackId && cached.utagTrackId !== lastCountedId && typeof UTAG !== 'undefined' && UTAG.logHistory) { lastCountedId = cached.utagTrackId; try { UTAG.logHistory(cached.utagTrackId); } catch (e) {} }
        try { await out.play(); } catch (e) {}
      }
      syncPlayState();
      saveNow();
      return true;
    }
    if (!remoteResolver) return false;
    let resolved = null;
    try { resolved = await remoteResolver(id); } catch (e) { resolved = null; }
    if (gen !== loadGen) return false;
    if (!resolved || !resolved.shell || typeof resolved.loadBytes !== 'function') return false;
    const shell = resolved.shell;
    S.track = shell;
    S.loading = true;
    // The old track stops the moment the new one is tapped: without this
    // it keeps playing under the shell while the fetch runs, and on a
    // failed fetch it would keep playing under a song that never loads.
    try { out.pause(); } catch (e) {}
    setMediaSession(shell);
    emit('track', shell);
    syncPlayState();
    try {
      const blob = await resolved.loadBytes();
      if (gen !== loadGen) return false;
      if (!blob) throw new Error('empty audio');
      const full = Object.assign({}, shell, { file: blob });
      S.trackCache.set(id, full);
      S.track = full;
      S.loading = false;
      await out.setTrack(full);
      if (gen !== loadGen) return false;
      emit('track', full);
      if (autoplay) {
        if (full.utagTrackId && full.utagTrackId !== lastCountedId && typeof UTAG !== 'undefined' && UTAG.logHistory) { lastCountedId = full.utagTrackId; try { UTAG.logHistory(full.utagTrackId); } catch (e) {} }
        try { await out.play(); } catch (e) {}
      }
      syncPlayState();
      saveNow();
      return true;
    } catch (e) {
      // Only the current load owns the spinner: a stale load's failure
      // must not clear the newer load's loading state.
      if (gen === loadGen) { S.loading = false; syncPlayState(); }
      return false;
    }
  }
  function setMediaSession(t) {
    if (NATIVE_MODE) return; // native remote commands own the lock screen
    if (!('mediaSession' in navigator)) return;
    try {
      const art = [];
      if (t.art) { const u = App.artURL(t); ['96x96', '128x128', '192x192', '512x512'].forEach(s => art.push({ src: u, sizes: s, type: t.art.type || 'image/jpeg' })); }
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: art });
    } catch (e) { /* noop */ }
  }
  function syncPlayState() {
    S.playing = !out.paused && !out.ended;
    emit('state', { playing: S.playing, track: S.track });
  }

  out.on('play', syncPlayState);
  out.on('pause', syncPlayState);
  out.on('ended', () => {
    if (S.repeat === 'one') { out.currentTime = 0; out.play(); return; }
    api.next(true);
  });
  out.on('timeupdate', () => {
    emit('time', { cur: out.currentTime, dur: out.duration || S.track?.duration || 0 });
  });
  out.on('loadedmetadata', () => {
    if (S.track && !S.track.duration && out.duration) {
      // The player often learns the duration before the record has one
      // (e.g. imported while the tag reader was unavailable). Persist it so
      // Track Info and the singles duration veto see it after reload.
      // Streamed tracks have no local record: keep it in memory only.
      S.track.duration = out.duration;
      if (!S.track._remote) DB.updateTrack(S.track.id, { duration: out.duration }).catch(() => {});
      emit('duration', { id: S.track.id, duration: out.duration });
    }
    emit('time', { cur: out.currentTime, dur: out.duration || 0 });
  });
  let saveT = 0;
  out.on('timeupdate', () => {
    const n = Date.now();
    if (n - saveT > 8000) { saveT = n; saveNow(); }
  });
  function saveNow() {
    if (!S.track) return;
    // Never persist a streamed shell that never loaded as the resume
    // record, or a reload would try to resume a song with no audio.
    if (S.track._remote && !S.track.file) return;
    const rawPos = S.order ? S.order[S.pos] : S.pos;
    const rec = { trackId: S.track.id, rawPos, shuffle: S.shuffle, repeat: S.repeat, ctx: S.ctx, list: S.list.slice(0, 500), at: out.currentTime };
    // A streamed track resumes after reload from its shell metadata:
    // the catalog pools are empty at boot, so the shell rides along
    // in the resume record (audio bytes are never stored here).
    if (S.track._remote) {
      const { title, artist, album, year, trackNo, art, utagTrackId } = S.track;
      // The shell is stored song-shaped (bare catalog id), so the
      // resolver and the session cache can use it like any pool song.
      rec.shell = { id: utagTrackId, title, artist, album, year, trackNo, art, utagTrackId };
    }
    DB.kvSet('now', rec).catch(() => {});
  }

  /* MediaSession: every action gets its own guarded registration - one rejected
     action must never silently block the rest (e.g. previous/next track).
     no 'seekto' registration - it is the only seek-flavored action we set
     and iOS keys the +/-10s lock-screen buttons off it, displacing prev/next.
     (In-app seek bar is unaffected; it calls api.seek() directly.) */
  const msFailed = [];
  if (!NATIVE_MODE && 'mediaSession' in navigator) {
    const setH = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); }
      catch (e) { msFailed.push(action); }
    };
    setH('seekbackward', null);
    setH('seekforward', null);
    setH('play', () => api.toggle());
    setH('pause', () => api.toggle());
    setH('previoustrack', () => api.prev());
    setH('nexttrack', () => api.next());
  }

  const api = {
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    get state() { return S; },
    get audio() { return out; },
    get current() { return S.track; },
    get isPlaying() { return S.playing; },
    get loading() { return !!S.loading; },
    setRemoteResolver,
    get msFailed() { return msFailed.slice(); },

    async init() {
      const liked = await DB.kvGet('liked', []);
      S.liked = new Set(liked);
      const sh = await DB.kvGet('pshuffle', false); S.shuffle = !!sh;
      const rp = await DB.kvGet('prepeat', 'off'); S.repeat = rp;
      S.volume = Math.max(0, Math.min(1, (await DB.kvGet('pvolume', 1)) ?? 1));
      S.muted = !!(await DB.kvGet('pmuted', false));
      S.preMute = S.volume > 0 ? S.volume : 0.8;
      /* Mute goes through the output: on the web iOS honors audio.muted (it
         ignores audio.volume). No Web Audio routing - iOS suspends
         AudioContext in the background, which would kill keep-alive
         playback. In the native shell mute maps to the AVPlayer volume. */
      out.muted = S.muted;
      out.volume = S.volume;
      if (navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (e) {} }
      const now = await DB.kvGet('now', null);
      if (now && now.trackId) {
        S.ctx = now.ctx; S.list = now.list || [];
        const raw = (now.rawPos != null ? now.rawPos : now.pos) || 0;
        S.pos = Math.min(raw, Math.max(0, S.list.length - 1));
        if (S.shuffle && S.list.length > 1) { S.order = shuffledOrder(S.list.length, S.pos); S.pos = 0; }
        await load(now.trackId, false);
        if (now.at > 5) { out.currentTime = now.at; }
      }
      emit('queue', null);
    },
    async playContext(ctx, trackIds, startId) {
      // Login gate, single check at the play entry point: no session, no
      // audio - show the auth view instead of starting playback.
      if (typeof UTAG !== 'undefined' && UTAG.getSession && !UTAG.getSession()) {
        try { App.showAuthGate(); } catch (e) {}
        return;
      }
      if (!trackIds.length) return;
      S.ctx = ctx; S.list = trackIds.slice(); S.order = null;
      let idx = startId != null ? trackIds.indexOf(startId) : 0;
      if (idx < 0) idx = 0;
      if (S.shuffle) { S.order = shuffledOrder(trackIds.length, idx); S.pos = 0; }
      else S.pos = idx;
      S.trackCache.clear();
      let ok = await load(curId(), true);
      // A dead first track must not stop play-all: keep advancing until
      // one plays, the same way next() skips dead tracks.
      while (!ok && S.pos < (S.order ? S.order.length : S.list.length) - 1) {
        S.pos++;
        ok = await load(curId(), true);
      }
      if (!ok) emit('track-error', { id: curId() });
      App.logRecent(ctx);
      emit('queue', null);
    },
    async playId(id) {
      const i = S.list.indexOf(id);
      if (i >= 0) {
        S.pos = S.order ? S.order.indexOf(i) : i;
        const ok = await load(id, true);
        if (!ok) emit('track-error', { id });
      } else {
        // play standalone (e.g. from search): context = single track
        await api.playContext({ kicker: 'PLAYING FROM SONGS', name: '', kind: 'single', id: 'single' }, [id], id);
      }
    },
    async toggle() {
      if (!S.track) return;
      // Login gate: lock-screen / MediaSession resume must not restart
      // audio after sign-out. Pause anything playing, then show auth.
      if (typeof UTAG !== 'undefined' && UTAG.getSession && !UTAG.getSession()) {
        try { if (!out.paused) out.pause(); } catch (e) {}
        try { App.showAuthGate(); } catch (e) {}
        return;
      }
      // While a streamed track is still fetching, the button waits: the
      // fetch decides what plays. A streamed track that never loaded is
      // a shell with no audio - the button retries the load instead of
      // resuming whatever played before, which would sound like the
      // wrong song under this title.
      if (S.loading) return;
      if (S.track._remote && !S.track.file) {
        const ok = await load(S.track.id, true);
        if (!ok) emit('track-error', { id: S.track.id });
        return;
      }
      if (out.paused) out.play().catch(() => {}); else out.pause();
    },
    play() { if (S.track) out.play().catch(() => {}); },
    pause() { out.pause(); },
    async next(auto) {
      if (!S.list.length) return;
      // A track that cannot load (stream gone, local file missing) must
      // never stall the queue: keep advancing until one plays, or the
      // queue runs out. One quiet failure notice if nothing plays.
      let played = false;
      let guard = 0;
      for (;;) {
        if (S.pos < (S.order ? S.order.length : S.list.length) - 1) { S.pos++; }
        else if (S.repeat === 'all') {
          if (S.shuffle) S.order = shuffledOrder(S.list.length);
          S.pos = 0;
        } else { break; }
        if (await load(curId(), true)) { played = true; break; }
        if (++guard >= S.list.length) break;
      }
      if (!played) {
        if (S.repeat !== 'all') { out.pause(); out.currentTime = 0; syncPlayState(); }
        else emit('track-error', { id: curId() });
      }
      emit('queue', null);
    },
    async prev() {
      if (!S.list.length) return;
      if (out.currentTime > 3) { out.currentTime = 0; return; }
      if (S.pos > 0) {
        S.pos--;
        let ok = await load(curId(), true);
        while (!ok && S.pos > 0) { S.pos--; ok = await load(curId(), true); }
        if (!ok) { out.pause(); out.currentTime = 0; syncPlayState(); }
      }
      else { out.currentTime = 0; }
      emit('queue', null);
    },
    seek(sec) {
      if (!S.track) return;
      const d = out.duration || S.track.duration || 0;
      out.currentTime = Math.max(0, Math.min(d, sec));
    },
    get volume() { return S.volume == null ? 1 : S.volume; },
    get muted() { return !!S.muted; },
    setVolume(v) {
      S.volume = Math.max(0, Math.min(1, v));
      if (S.volume > 0) { S.muted = false; S.preMute = S.volume; out.muted = false; }
      out.volume = S.volume;
      DB.kvSet('pvolume', S.volume).catch(() => {});
      DB.kvSet('pmuted', S.muted).catch(() => {});
      emit('volume', { volume: S.volume, muted: S.muted });
    },
    toggleMute() {
      S.muted = !S.muted;
      out.muted = S.muted;
      DB.kvSet('pmuted', S.muted).catch(() => {});
      emit('volume', { volume: S.volume, muted: S.muted });
    },
    async toggleShuffle() {
      S.shuffle = !S.shuffle;
      const cid = curId();
      if (S.shuffle && S.list.length > 1) {
        const rawIdx = S.list.indexOf(cid);
        S.order = shuffledOrder(S.list.length, rawIdx);
        S.pos = 0;
      } else { S.pos = S.list.indexOf(cid); S.order = null; }
      DB.kvSet('pshuffle', S.shuffle).catch(() => {});
      emit('state', { playing: S.playing, track: S.track });
      emit('queue', null); saveNow();
    },
    toggleRepeat() {
      S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
      DB.kvSet('prepeat', S.repeat).catch(() => {});
      emit('state', { playing: S.playing, track: S.track }); saveNow();
    },
    isLiked(id) { return S.liked.has(id); },
    async toggleLike(id) {
      if (isRemoteId(id)) {
        // Liking saves the song to the library, and the library holds
        // songs on the phone: download it first, then like the local copy.
        if (typeof App !== 'undefined' && App.likeRemoteTrack) { await App.likeRemoteTrack(id); return; }
        return;
      }
      id = Number(id);
      if (S.liked.has(id)) S.liked.delete(id);
      else { S.liked.add(id); try { await App.libraryAdd(id); } catch (e) {} }
      await DB.kvSet('liked', [...S.liked]);
      emit('state', { playing: S.playing, track: S.track });
    },
    queueList() {
      // upcoming tracks after current
      const out = [];
      const n = S.list.length;
      for (let k = 1; k < n; k++) {
        if (!S.order && S.pos + k >= n) break;
        const idx = S.order ? S.order[(S.pos + k) % n] : S.pos + k;
        out.push(S.list[idx]);
        if (out.length >= 100) break;
      }
      return out;
    },
    async jumpToQueueId(id) {
      const raw = S.list.indexOf(id); if (raw < 0) return;
      const prevPos = S.pos;
      S.pos = S.order ? S.order.indexOf(raw) : raw;
      const ok = await load(id, true);
      // A failed jump leaves the queue where it was, but only when the
      // position still points at the failed track and the current track
      // is not it (an early failure before any shell). A shell failure
      // already agrees with the position, and a superseding load must
      // never be rewound.
      if (!ok && curId() === id && (!S.track || S.track.id !== id)) S.pos = prevPos;
      emit('queue', null);
    },
    forgetTrack(id) {
      S.trackCache.delete(id);
      const i = S.list.indexOf(id);
      if (i >= 0) {
        S.list.splice(i, 1);
        if (S.order) { S.order = S.order.map(x => x > i ? x - 1 : x).filter(x => x !== i); if (S.pos >= S.order.length) S.pos = Math.max(0, S.order.length - 1); }
        else if (S.pos > i) S.pos--;
        if (S.track && S.track.id === id) { S.track = null; try { out.clear(); } catch (e) {} syncPlayState(); }
        emit('queue', null); saveNow();
      }
    }
  };
  if (NATIVE_MODE) {
    // Lock-screen / Control Center commands from the native plugin.
    out.on('remote-prev', () => api.prev());
    out.on('remote-next', () => api.next());
  }
  return api;
})();
