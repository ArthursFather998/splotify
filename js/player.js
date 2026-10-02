/* Splotify player engine — local <audio>, queue, shuffle/repeat, MediaSession. */
const Player = (() => {
  const audio = new Audio();
  audio.preload = 'auto';
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
    if (S.track && S.track._url) URL.revokeObjectURL(S.track._url);
    S.track = t;
    t._url = URL.createObjectURL(t.file);
    audio.src = t._url;
    setMediaSession(t);
    emit('track', t);
    if (autoplay) { try { await audio.play(); } catch (e) { /* iOS needs gesture; UI reflects */ } }
    syncPlayState();
    saveNow();
    return true;
  }
  function setMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    try {
      const art = [];
      if (t.art) { const u = App.artURL(t); ['96x96', '128x128', '192x192', '512x512'].forEach(s => art.push({ src: u, sizes: s, type: t.art.type || 'image/jpeg' })); }
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: art });
    } catch (e) { /* noop */ }
  }
  function syncPlayState() {
    S.playing = !audio.paused && !audio.ended;
    emit('state', { playing: S.playing, track: S.track });
  }

  audio.addEventListener('play', syncPlayState);
  audio.addEventListener('pause', syncPlayState);
  audio.addEventListener('ended', () => {
    if (S.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
    api.next(true);
  });
  audio.addEventListener('timeupdate', () => {
    emit('time', { cur: audio.currentTime, dur: audio.duration || S.track?.duration || 0 });
  });
  audio.addEventListener('loadedmetadata', () => {
    if (S.track && !S.track.duration && audio.duration) {
      // The player often learns the duration before the record has one
      // (e.g. imported while the tag reader was unavailable). Persist it so
      // Track Info and the singles duration veto see it after reload.
      S.track.duration = audio.duration;
      DB.updateTrack(S.track.id, { duration: audio.duration }).catch(() => {});
      emit('duration', { id: S.track.id, duration: audio.duration });
    }
    emit('time', { cur: audio.currentTime, dur: audio.duration || 0 });
  });
  let saveT = 0;
  audio.addEventListener('timeupdate', () => {
    const n = Date.now();
    if (n - saveT > 8000) { saveT = n; saveNow(); }
  });
  function saveNow() {
    if (!S.track) return;
    const rawPos = S.order ? S.order[S.pos] : S.pos;
    DB.kvSet('now', { trackId: S.track.id, rawPos, shuffle: S.shuffle, repeat: S.repeat, ctx: S.ctx, list: S.list.slice(0, 500), at: audio.currentTime }).catch(() => {});
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => api.toggle());
      navigator.mediaSession.setActionHandler('pause', () => api.toggle());
      navigator.mediaSession.setActionHandler('previoustrack', () => api.prev());
      navigator.mediaSession.setActionHandler('nexttrack', () => api.next());
      navigator.mediaSession.setActionHandler('seekto', d => { if (d.seekTime != null) api.seek(d.seekTime); });
      /* iOS shows its own 10s skip buttons over previous/next unless they're
         explicitly disabled — null removes them, leaving prev/play/next. */
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
    } catch (e) { /* noop */ }
  }

  const api = {
    on(ev, fn) { listeners[ev].push(fn); },
    get state() { return S; },
    get audio() { return audio; },
    get current() { return S.track; },
    get isPlaying() { return S.playing; },

    async init() {
      const liked = await DB.kvGet('liked', []);
      S.liked = new Set(liked);
      const sh = await DB.kvGet('pshuffle', false); S.shuffle = !!sh;
      const rp = await DB.kvGet('prepeat', 'off'); S.repeat = rp;
      S.volume = Math.max(0, Math.min(1, (await DB.kvGet('pvolume', 1)) ?? 1));
      S.muted = !!(await DB.kvGet('pmuted', false));
      S.preMute = S.volume > 0 ? S.volume : 0.8;
      /* Mute goes through the element: iOS honors audio.muted (it ignores
         audio.volume). No Web Audio routing — iOS suspends AudioContext in
         the background, which would kill the keep-alive playback. */
      audio.muted = S.muted;
      try { audio.volume = S.volume; } catch (e) {}
      if (navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (e) {} }
      const now = await DB.kvGet('now', null);
      if (now && now.trackId) {
        S.ctx = now.ctx; S.list = now.list || [];
        const raw = (now.rawPos != null ? now.rawPos : now.pos) || 0;
        S.pos = Math.min(raw, Math.max(0, S.list.length - 1));
        if (S.shuffle && S.list.length > 1) { S.order = shuffledOrder(S.list.length, S.pos); S.pos = 0; }
        await load(now.trackId, false);
        if (now.at > 5) { try { audio.currentTime = now.at; } catch (e) {} }
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
    toggle() { if (!S.track) return; if (audio.paused) audio.play().catch(() => {}); else audio.pause(); },
    play() { if (S.track) audio.play().catch(() => {}); },
    pause() { audio.pause(); },
    async next(auto) {
      if (!S.list.length) return;
      if (S.pos < (S.order ? S.order.length : S.list.length) - 1) { S.pos++; await load(curId(), true); }
      else if (S.repeat === 'all') {
        if (S.shuffle) S.order = shuffledOrder(S.list.length);
        S.pos = 0; await load(curId(), true);
      } else { audio.pause(); try { audio.currentTime = 0; } catch (e) {} syncPlayState(); }
      emit('queue', null);
    },
    async prev() {
      if (!S.list.length) return;
      if (audio.currentTime > 3) { audio.currentTime = 0; return; }
      if (S.pos > 0) { S.pos--; await load(curId(), true); }
      else { audio.currentTime = 0; }
      emit('queue', null);
    },
    seek(sec) {
      if (!S.track) return;
      const d = audio.duration || S.track.duration || 0;
      audio.currentTime = Math.max(0, Math.min(d, sec));
    },
    get volume() { return S.volume == null ? 1 : S.volume; },
    get muted() { return !!S.muted; },
    setVolume(v) {
      S.volume = Math.max(0, Math.min(1, v));
      if (S.volume > 0) { S.muted = false; S.preMute = S.volume; audio.muted = false; }
      try { audio.volume = S.volume; } catch (e) {}
      DB.kvSet('pvolume', S.volume).catch(() => {});
      DB.kvSet('pmuted', S.muted).catch(() => {});
      emit('volume', { volume: S.volume, muted: S.muted });
    },
    toggleMute() {
      S.muted = !S.muted;
      audio.muted = S.muted;
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
      if (S.liked.has(id)) S.liked.delete(id); else S.liked.add(id);
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
        if (S.track && S.track.id === id) { S.track = null; audio.removeAttribute('src'); audio.load(); syncPlayState(); }
        emit('queue', null); saveNow();
      }
    }
  };
  return api;
})();
