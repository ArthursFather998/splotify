// Player remote-playback smoke test (qa/player-remote-smoke.cjs).
// Runs player.js with stubbed browser/DB/app surfaces and exercises the
// streamed-track paths that killed v10.20/v10.21 in live verification:
//   1. a failed remote load must stop the previous track (no stale audio
//      playing under the failed shell) and must not resume it on toggle.
//   2. a successful remote load plays and caches.
//   3. next() skips a dead remote track and plays the next live one.
//   4. load race: a slow fetch that resolves after a newer tap must not
//      hijack the current track; a local tap during a remote fetch
//      clears the spinner.
//   5. playContext skips a dead first track; prev() skips dead tracks;
//      jumpToQueueId reverts on an early failure and keeps position on
//      a shell failure; saveNow never persists a failed shell.
// Run: node qa/player-remote-smoke.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' -- ' + (extra || '')));
  if (!cond) failures++;
}

// ---- stubs ----
class FakeAudio {
  constructor() { this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 0; this.src = ''; this._subs = {}; this.muted = false; this.volume = 1; }
  addEventListener(ev, fn) { (this._subs[ev] = this._subs[ev] || []).push(fn); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() {}
  load() {}
}
global.window = {};
global.navigator = {};
global.Audio = FakeAudio;
const localBlob = new Blob([Buffer.from('fake-local-audio')], { type: 'audio/mpeg' });
const remoteBlob = new Blob([Buffer.from('fake-remote-audio')], { type: 'audio/mpeg' });
const localTracks = {
  1: { id: 1, title: 'Local One', artist: 'Local Artist', album: 'Local Album', duration: 200, file: localBlob, art: null },
  2: { id: 2, title: 'Local Two', artist: 'Local Artist', album: 'Local Album', duration: 180, file: localBlob, art: null },
  3: { id: 3, title: 'Local Three', artist: 'Local Artist', album: 'Local Album', duration: 170, file: localBlob, art: null },
};
const missingIds = new Set();
let lastNow = null;
global.DB = {
  getTrack: async (id) => (missingIds.has(Number(id)) ? null : (localTracks[Number(id)] || null)),
  kvGet: async () => null,
  kvSet: async (k, v) => { if (k === 'now') lastNow = v; },
  updateTrack: async () => {},
};
global.App = {
  logPlay: () => {}, logHistory: () => {}, logRecent: () => {},
  showAuthGate: () => {}, artURL: (t) => (typeof t.art === 'string' ? t.art : ''),
  libraryAdd: async () => {},
};
global.UTAG = { getSession: () => ({ access_token: 'test' }), logHistory: () => {} };

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'player.js'), 'utf8');
eval(src + '\n;globalThis.Player = Player;');
eval(src + '\n;globalThis.__audio = null;'); // no-op, keeps eval scope warm

// Reach the fake audio element through playback state: Player.state.playing
// reflects out.paused, and the toggle path exercises out.play/pause.
function outPaused() { return !Player.state.playing; }

const remoteShell = (uuid) => ({
  id: 'cat:' + uuid, title: '505', artist: 'Arctic Monkeys',
  album: 'Favourite Worst Nightmare', year: 2007, trackNo: 1,
  art: null, duration: 0, file: null, _remote: true, utagTrackId: uuid,
});

(async () => {
  const ctx = { kicker: 'TEST', name: 'test', kind: 'single', id: 'test' };

  // Resolver whose bytes always fail (the Mega API is unreachable case).
  Player.setRemoteResolver(async (ref) => ({
    shell: remoteShell(String(ref).slice(4)),
    loadBytes: async () => { throw new Error('network down'); },
  }));

  // 1. Play a local track, then tap a remote track that fails to load.
  await Player.playContext(ctx, [1], 1);
  check('local track plays', Player.state.playing === true && Player.current && Player.current.id === 1);
  let heardError = false;
  Player.on('track-error', () => { heardError = true; });
  await Player.playId('cat:uuid-1');
  check('failed remote load emits track-error', heardError === true);
  check('failed remote load shows the shell', Player.current && Player.current.id === 'cat:uuid-1');
  check('loading flag clears after failure', Player.state.loading === false);
  check('BUG1: previous track stops when remote load fails (no stale audio)', outPaused() === true,
    'old track kept playing under the failed shell');
  // Toggle after failure must NOT resume the old track's audio.
  await Player.toggle();
  check('BUG1b: play button after failure does not resume stale audio', outPaused() === true,
    'toggle resumed the previous track under the failed shell');

  // 2. Successful remote load plays.
  Player.setRemoteResolver(async (ref) => ({
    shell: remoteShell(String(ref).slice(4)),
    loadBytes: async () => remoteBlob,
  }));
  await Player.playId('cat:uuid-1');
  check('successful remote load plays', Player.state.playing === true && Player.current && Player.current.id === 'cat:uuid-1' && !!Player.current.file);
  check('loading flag clears after success', Player.state.loading === false);

  // 3. next() skips a dead remote track.
  Player.setRemoteResolver(async (ref) => ({
    shell: remoteShell(String(ref).slice(4)),
    loadBytes: async () => { throw new Error('network down'); },
  }));
  await Player.playContext(ctx, [1, 'cat:uuid-1', 2], 1);
  check('queue starts on local 1', Player.current && Player.current.id === 1);
  await Player.next(false);
  check('next() skips dead remote and plays local 2', Player.current && Player.current.id === 2 && Player.state.playing === true,
    'current=' + (Player.current && Player.current.id));

  // 4. Load race: slow remote fetch vs a newer local tap.
  let resolveSlow;
  const slowGate = new Promise((r) => { resolveSlow = r; });
  Player.setRemoteResolver(async (ref) => {
    if (String(ref) === 'cat:slow') return { shell: remoteShell('slow'), loadBytes: async () => { await slowGate; return remoteBlob; } };
    return { shell: remoteShell(String(ref).slice(4)), loadBytes: async () => remoteBlob };
  });
  const slowP = Player.playId('cat:slow');
  await new Promise((r) => setTimeout(r, 10));
  check('slow remote shows shell + spinner', Player.current && Player.current.id === 'cat:slow' && Player.state.loading === true);
  await Player.playId(1);
  check('local tap during remote fetch plays + clears spinner', Player.current && Player.current.id === 1 && Player.state.playing === true && Player.state.loading === false);
  resolveSlow();
  await slowP;
  check('stale slow fetch does not hijack the local track', Player.current && Player.current.id === 1 && Player.state.playing === true,
    'current=' + (Player.current && Player.current.id));

  // 5. playContext skips a dead first track.
  Player.setRemoteResolver(async (ref) => ({
    shell: remoteShell(String(ref).slice(4)),
    loadBytes: async () => { throw new Error('network down'); },
  }));
  await Player.playContext(ctx, ['cat:dead-first', 1], 'cat:dead-first');
  check('playContext skips dead first track', Player.current && Player.current.id === 1 && Player.state.playing === true,
    'current=' + (Player.current && Player.current.id));

  // 6. prev() skips a missing local track.
  missingIds.add(2);
  await Player.playContext(ctx, [1, 2, 3], 3);
  check('queue starts on local 3', Player.current && Player.current.id === 3);
  await Player.prev();
  check('prev() skips missing local track', Player.current && Player.current.id === 1 && Player.state.playing === true,
    'current=' + (Player.current && Player.current.id));
  missingIds.delete(2);

  // 7. jumpToQueueId: early failure reverts position; shell failure keeps it.
  Player.setRemoteResolver(async () => null);
  await Player.playContext(ctx, [1, 'cat:gone', 2], 1);
  await Player.jumpToQueueId('cat:gone');
  check('jump to unresolvable track reverts position', Player.state.pos === 0 && Player.current && Player.current.id === 1,
    'pos=' + Player.state.pos + ' current=' + (Player.current && Player.current.id));
  Player.setRemoteResolver(async (ref) => ({
    shell: remoteShell(String(ref).slice(4)),
    loadBytes: async () => { throw new Error('network down'); },
  }));
  await Player.jumpToQueueId('cat:gone');
  check('jump to failing shell keeps position on the failed track', Player.state.pos === 1 && Player.current && Player.current.id === 'cat:gone',
    'pos=' + Player.state.pos + ' current=' + (Player.current && Player.current.id));
  // saveNow must never persist the failed shell as the resume record.
  await Player.toggleShuffle();
  check('saveNow never persists a failed shell', lastNow && lastNow.trackId === 1, 'now=' + JSON.stringify(lastNow));

  console.log(failures ? `REMOTE SMOKE FAILED (${failures})` : 'REMOTE SMOKE PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('REMOTE SMOKE ERROR', e); process.exit(1); });
