/* Splotify player engine — queue, shuffle/repeat, audio output, MediaSession.
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
  const listeners = { state: [], track: [], time: [], queue: [], duration: [], volume: [] };
  const emit = (ev, d) => listeners[ev].forEach(f => { try { f(d); } catch (e) { console.error(e); } });

  const S = {
    ctx: null,          // {kicker, name, kind, id}
    list: [],           // track ids in context order
    order: null,        // shuffled index order or null
    pos: 0,             // position within (order || list)
    shuffle: false,
    repeat: 'off',      // off | all | one
    track: null,        // current track object
    playing: false,
    liked: new Set(),
    trackCache: new Map(),
  };
  const curId = () => (S.order ? S.list[S.order[S.pos]] : S.list[S.pos]);
  let lastCountedId = null; // play-count dedupe: one count per track start

  async function ensureTrack(id) {
    if (S.trackCache.has(id)) return S.trackCache.get(id);
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
    const t = await ensureTrack(id);
    if (!t) return false;
    S.track = t;
    await out.setTrack(t);
    setMediaSession(t);
    emit('track', t);
    if (autoplay && t.id !== lastCountedId) { lastCountedId = t.id; try { App.logPlay(t.id); } catch (e) {} }
    if (autoplay) { try { await out.play(); } catch (e) { /* iOS needs gesture; UI reflects */ } }
    syncPlayState();
    saveNow();
    return true;
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
      S.track.duration = out.duration;
      DB.updateTrack(S.track.id, { duration: out.duration }).catch(() => {});
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
    const rawPos = S.order ? S.order[S.pos] : S.pos;
    DB.kvSet('now', { trackId: S.track.id, rawPos, shuffle: S.shuffle, repeat: S.repeat, ctx: S.ctx, list: S.list.slice(0, 500), at: out.currentTime }).catch(() => {});
  }

  /* MediaSession: every action gets its own guarded registration — one rejected
     action must never silently block the rest (e.g. previous/next track).
     v8.9: no 'seekto' registration — it is the only seek-flavored action we set
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
    on(ev, fn) { listeners[ev].push(fn); },
    get state() { return S; },
    get audio() { return out; },
    get current() { return S.track; },
    get isPlaying() { return S.playing; },
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
         ignores audio.volume). No Web Audio routing — iOS suspends
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
      if (!trackIds.length) return;
      S.ctx = ctx; S.list = trackIds.slice(); S.order = null;
      let idx = startId != null ? trackIds.indexOf(startId) : 0;
      if (idx < 0) idx = 0;
      if (S.shuffle) { S.order = shuffledOrder(trackIds.length, idx); S.pos = 0; }
      else S.pos = idx;
      S.trackCache.clear();
      await load(curId(), true);
      App.logRecent(ctx);
      emit('queue', null);
    },
    async playId(id) {
      const i = S.list.indexOf(id);
      if (i >= 0) {
        S.pos = S.order ? S.order.indexOf(i) : i;
        await load(id, true);
      } else {
        // play standalone (e.g. from search): context = single track
        await api.playContext({ kicker: 'PLAYING FROM SONGS', name: '', kind: 'single', id: 'single' }, [id], id);
      }
    },
    toggle() { if (!S.track) return; if (out.paused) out.play().catch(() => {}); else out.pause(); },
    play() { if (S.track) out.play().catch(() => {}); },
    pause() { out.pause(); },
    async next(auto) {
      if (!S.list.length) return;
      if (S.pos < (S.order ? S.order.length : S.list.length) - 1) { S.pos++; await load(curId(), true); }
      else if (S.repeat === 'all') {
        if (S.shuffle) S.order = shuffledOrder(S.list.length);
        S.pos = 0; await load(curId(), true);
      } else { out.pause(); out.currentTime = 0; syncPlayState(); }
      emit('queue', null);
    },
    async prev() {
      if (!S.list.length) return;
      if (out.currentTime > 3) { out.currentTime = 0; return; }
      if (S.pos > 0) { S.pos--; await load(curId(), true); }
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
        const p = (S.pos + k) % (S.order ? n : n);
        if (!S.order && S.pos + k >= n) break;
        const idx = S.order ? S.order[(S.pos + k) % n] : S.pos + k;
        out.push(S.list[idx]);
        if (out.length >= 100) break;
      }
      return out;
    },
    async jumpToQueueId(id) {
      const raw = S.list.indexOf(id); if (raw < 0) return;
      S.pos = S.order ? S.order.indexOf(raw) : raw;
      await load(id, true); emit('queue', null);
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
