/* Splotify native shell bridge (Capacitor iOS). Inert on the web.
 * When running inside the native app, exposes window.SplotifyNativeOut(),
 * an audio-output object with the same surface player.js expects from its
 * output: setTrack/play/pause/stop/currentTime/duration/muted/volume and
 * play/pause/ended/timeupdate/loadedmetadata events, plus remote-prev /
 * remote-next for lock-screen commands. Audio bytes are cached to the app's
 * Documents folder (per-track, stat-checked) and played by the native
 * SplotifyAudio plugin (AVPlayer + real prev/play/next remote commands). */
(function () {
  var Cap = window.Capacitor;
  var NATIVE = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  if (!NATIVE) return;
  var Plugins = Cap.Plugins || {};
  var SA = Plugins.SplotifyAudio;
  var FS = Plugins.Filesystem;
  if (!SA || !FS) return;

  var DOCS = 'DOCUMENTS';
  var listeners = {};
  function emit(type, data) {
    (listeners[type] || []).forEach(function (fn) { try { fn(data); } catch (e) {} });
  }
  function on(type, fn) {
    (listeners[type] = listeners[type] || []).push(fn);
  }

  var state = { pos: 0, dur: 0, paused: true, ended: false, muted: false, volume: 1 };

  function blobToBase64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result).split(',')[1]); };
      fr.onerror = function () { rej(new Error('blob read failed')); };
      fr.readAsDataURL(blob);
    });
  }
  function safeId(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, '_'); }
  function extOf(t) {
    var fn = t.fileName || '';
    var i = fn.lastIndexOf('.');
    return i > 0 ? fn.slice(i).toLowerCase() : '.mp3';
  }
  async function ensureFile(relPath, blob) {
    try { await FS.stat({ path: relPath, directory: DOCS }); return; }
    catch (e) { /* not cached yet */ }
    var b64 = await blobToBase64(blob);
    await FS.writeFile({ path: relPath, data: b64, directory: DOCS, recursive: true });
  }
  async function cacheArtwork(t) {
    try {
      var u = null;
      try { u = window.App && App.artURL(t); } catch (e) {}
      if (!u) return null;
      var rel = 'splotify-art/' + safeId(t.id) + '.jpg';
      try { await FS.stat({ path: rel, directory: DOCS }); return rel; } catch (e) {}
      var r = await fetch(u);
      if (!r.ok) return null;
      await ensureFile(rel, await r.blob());
      return rel;
    } catch (e) { return null; }
  }

  // Native -> JS events.
  SA.addListener('position', function (e) {
    state.pos = e && e.pos ? e.pos : 0;
    if (e && e.dur) state.dur = e.dur;
    emit('timeupdate');
  });
  SA.addListener('remotePlay', function () { state.paused = false; state.ended = false; emit('play'); });
  SA.addListener('remotePause', function () { state.paused = true; emit('pause'); });
  SA.addListener('remotePrev', function () { emit('remote-prev'); });
  SA.addListener('remoteNext', function () { emit('remote-next'); });
  SA.addListener('trackEnded', function () { state.ended = true; state.paused = true; emit('ended'); });
  SA.addListener('interrupted', function () { state.paused = true; emit('pause'); });

  var NativeOut = {
    isNative: true,
    on: on,
    get paused() { return state.paused; },
    get ended() { return state.ended; },
    get currentTime() { return state.pos; },
    set currentTime(v) {
      v = Math.max(0, state.dur ? Math.min(state.dur, v) : v);
      state.pos = v;
      try { SA.seekTo({ pos: v }); } catch (e) {}
    },
    get duration() { return state.dur; },
    get muted() { return state.muted; },
    set muted(m) {
      state.muted = !!m;
      try { SA.setMuted({ muted: !!m, volume: state.volume }); } catch (e) {}
    },
    get volume() { return state.volume; },
    set volume(v) {
      state.volume = Math.max(0, Math.min(1, v));
      try { SA.setMuted({ muted: state.muted, volume: state.volume }); } catch (e) {}
    },
    async setTrack(t) {
      state.ended = false; state.paused = true; state.pos = 0;
      state.dur = t.duration || 0;
      var rel = 'splotify-audio/' + safeId(t.id) + extOf(t);
      await ensureFile(rel, t.file);
      var artRel = await cacheArtwork(t);
      var res = await SA.setTrack({
        path: rel,
        title: t.title || 'Unknown',
        artist: t.artist || 'Unknown',
        album: t.album || '',
        duration: t.duration || 0,
        artworkPath: artRel || ''
      });
      if (res && res.duration) {
        state.dur = res.duration;
        try {
          if (t && !t.duration) {
            t.duration = res.duration;
            if (window.DB && DB.updateTrack) DB.updateTrack(t.id, { duration: res.duration }).catch(function () {});
          }
        } catch (e) {}
      }
      emit('loadedmetadata');
      return true;
    },
    async play() {
      await SA.play();
      state.paused = false; state.ended = false;
      emit('play');
    },
    async pause() {
      await SA.pause();
      state.paused = true;
      emit('pause');
    },
    async stop() {
      try { await SA.stop(); } catch (e) {}
      state.paused = true; state.ended = false; state.pos = 0;
      emit('pause');
    }
  };

  window.SplotifyNativeOut = function () { return NativeOut; };
  window.SplotifyNative = true;
})();
