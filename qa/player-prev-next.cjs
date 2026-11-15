// Verify the prev/next dead-track fix: the player must never park on a
// song with no audio; it comes back to the track that was playing.
const fs = require('fs');
global.window = {};
global.navigator = {};
global.URL.createObjectURL = global.URL.createObjectURL || (() => 'blob:fake');
class FakeAudio {
  constructor() { this._subs = {}; this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 0; this.src = ''; }
  addEventListener(ev, fn) { (this._subs[ev] = this._subs[ev] || []).push(fn); }
  _fire(ev) { (this._subs[ev] || []).forEach((f) => { try { f(); } catch (e) {} }); }
  play() { this.paused = false; this._fire('play'); return Promise.resolve(); }
  pause() { this.paused = true; this._fire('pause'); }
  load() {}
  removeAttribute() {}
}
global.Audio = FakeAudio;
const localTracks = {
  1: { id: 1, title: 'Local One', artist: 'Me', album: 'A', file: new Blob(['aaa'], { type: 'audio/mpeg' }), duration: 180 },
  2: { id: 2, title: 'Local Two', artist: 'Me', album: 'A', file: new Blob(['bbb'], { type: 'audio/mpeg' }), duration: 200 },
};
global.DB = {
  kvGet: async () => null, kvSet: async () => {},
  getTrack: async (id) => localTracks[id] || null,
  updateTrack: async () => {},
};
global.App = { logPlay: () => {}, showAuthGate: () => {}, logRecent: () => {}, artURL: () => '' };
global.UTAG = { getSession: () => ({ user: { id: 'x' } }) };
const src = fs.readFileSync('js/player.js', 'utf8');
eval(src + '\n;globalThis.Player = Player;');
let fail = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) fail++;
}
async function main() {
  // cat:B and cat:D have no audio (bytes fail); cat:A, cat:C play.
  Player.setRemoteResolver(async (ref) => {
    const uuid = ref.slice(4);
    const shell = { id: ref, title: 'Song ' + uuid, artist: 'Cat', album: '', year: '', trackNo: 0, art: null, duration: 0, file: null, _remote: true, utagTrackId: uuid };
    if (uuid === 'B' || uuid === 'D') return { shell, loadBytes: async () => null };
    return { shell, loadBytes: async () => new Blob(['audio-' + uuid], { type: 'audio/mpeg' }) };
  });

  // 1. prev skips a dead track and plays the one before it.
  await Player.playContext({ kicker: 'T', name: '', kind: 'album', id: 'a' }, ['cat:A', 'cat:B', 'cat:C'], 'cat:C');
  await Player.prev();
  check('prev skips dead B, plays A', Player.current.title === 'Song A' && Player.isPlaying && Player.state.pos === 0);

  // 2. prev with NO playable earlier track restarts the current song.
  await Player.playContext({ kicker: 'T', name: '', kind: 'album', id: 'a' }, ['cat:B', 'cat:C'], 'cat:C');
  await Player.prev();
  check('dead-end prev restarts C playing', Player.current.title === 'Song C' && Player.isPlaying && Player.state.pos === 1,
    'got ' + Player.current.title + ' playing=' + Player.isPlaying + ' pos=' + Player.state.pos);
  check('play button works after dead-end prev (toggle pauses a playing track)', (() => { Player.toggle(); return !Player.isPlaying; })());
  await Player.toggle(); // resume for the next check

  // 3. next into an all-dead tail stops on the track that was playing.
  await Player.playContext({ kicker: 'T', name: '', kind: 'album', id: 'a' }, ['cat:C', 'cat:B', 'cat:D'], 'cat:C');
  await Player.next();
  check('dead-tail next stops on C', Player.current.title === 'Song C' && !Player.isPlaying && Player.state.pos === 0,
    'got ' + Player.current.title + ' playing=' + Player.isPlaying + ' pos=' + Player.state.pos);
  await Player.toggle();
  check('play button revives C after dead-tail next', Player.isPlaying);

  // 4. prev past 3s restarts the current song; prev at pos 0 restarts.
  await Player.playContext({ kicker: 'T', name: '', kind: 'album', id: 'a' }, [1, 2], 2);
  Player.audio.currentTime = 10;
  await Player.prev();
  check('prev past 3s restarts current track', Player.current.title === 'Local Two' && Player.isPlaying);
  Player.audio.currentTime = 0;
  await Player.playContext({ kicker: 'T', name: '', kind: 'album', id: 'a' }, [1, 2], 1);
  await Player.prev();
  check('prev at pos 0 restarts first track', Player.current.title === 'Local One' && Player.isPlaying);

  // 5. local prev still moves back.
  await Player.playContext({ kicker: 'T', name: '', kind: 'album', id: 'a' }, [1, 2], 2);
  await Player.prev();
  check('local prev plays Local One', Player.current.title === 'Local One' && Player.isPlaying);

  console.log(fail ? 'REPRO FAILED' : 'REPRO PASSED');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
