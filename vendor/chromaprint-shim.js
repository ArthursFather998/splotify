/* Splotify chromaprint shim (v7.9). Classic script — the app has no bundler.
   Lazy-loads the vendored Emscripten chromaprint build (js/vendor/chromaprint-glue.js
   + chromaprint.wasm, from @unimusic/chromaprint, MIT) via dynamic import, then
   exposes window.SplotifyFingerprint.compute(blob) -> Promise<{fingerprint, duration}>.
   The glue resolves its own .wasm relative to its file (import.meta.url), so this
   works from both deployment roots (/ and /splotify/). */
(function () {
  'use strict';
  var modulePromise = null;
  function loadModule() {
    if (!modulePromise) {
      var url = new URL('js/vendor/chromaprint-glue.js', document.baseURI).href;
      modulePromise = import(url).then(function (m) { return m.default(); });
    }
    return modulePromise;
  }
  async function decode(blob) {
    var ab = await blob.arrayBuffer();
    var copy = ab.slice(0); // decodeAudioData detaches its input
    var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (OC) {
      var oc = new OC(1, 1, 44100);
      return oc.decodeAudioData(copy);
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    var ac = new AC();
    try { return await ac.decodeAudioData(copy); }
    finally { try { ac.close(); } catch (e) {} }
  }
  async function compute(blob, opts) {
    opts = opts || {};
    var maxSec = opts.maxSeconds || 60;
    var mod = await loadModule();
    var audioBuf = await decode(blob);
    var sr = audioBuf.sampleRate;
    var n = Math.min(audioBuf.length, Math.max(1, Math.floor(maxSec * sr)));
    var ch = audioBuf.numberOfChannels || 1;
    var mono = new Float32Array(n);
    for (var c = 0; c < ch; c++) {
      var d = audioBuf.getChannelData(c);
      for (var i = 0; i < n; i++) mono[i] += d[i] / ch;
    }
    var pcm = new Int16Array(n);
    for (var j = 0; j < n; j++) {
      var s = mono[j] < -1 ? -1 : mono[j] > 1 ? 1 : mono[j];
      pcm[j] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    }
    // CHROMAPRINT_ALGORITHM_DEFAULT (fpcalc's default). The engine resamples
    // to its internal 11025 Hz from whatever the decoder produced.
    var ctx = mod._chromaprint_new(1);
    if (!ctx) throw new Error('chromaprint init failed');
    try {
      if (!mod._chromaprint_start(ctx, sr, 1)) throw new Error('chromaprint start failed');
      var ptr = mod._malloc(pcm.length * 2);
      try {
        mod.HEAP16.set(pcm, ptr >> 1);
        if (!mod._chromaprint_feed(ctx, ptr, pcm.length)) throw new Error('chromaprint feed failed');
        if (!mod._chromaprint_finish(ctx)) throw new Error('chromaprint finish failed');
        var fpPtr = mod._malloc(4);
        try {
          if (!mod._chromaprint_get_fingerprint(ctx, fpPtr)) throw new Error('chromaprint fingerprint failed');
          var cstr = mod.HEAP32[fpPtr >> 2];
          var fp = mod.UTF8ToString(cstr);
          mod._free(cstr);
          return { fingerprint: fp, duration: audioBuf.duration };
        } finally { mod._free(fpPtr); }
      } finally { mod._free(ptr); }
    } finally { mod._chromaprint_free(ctx); }
  }
  window.SplotifyFingerprint = { compute: compute };
})();
