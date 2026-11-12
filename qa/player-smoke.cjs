// Focused smoke test: Player.on must accept any event name (this is what
// killed boot once: 'track-error' had no listeners array).
const fs = require('fs');
global.window = {};
global.navigator = {};
global.Audio = class {
  constructor() { this._subs = {}; }
  addEventListener(ev, fn) { (this._subs[ev] = this._subs[ev] || []).push(fn); }
  play() { return Promise.resolve(); }
  pause() {}
};
global.DB = { kvGet: async () => null, kvSet: async () => {}, getTrack: async () => null, updateTrack: async () => {} };
global.App = { logPlay: () => {}, showAuthGate: () => {}, logRecent: () => {} };
global.UTAG = { getSession: () => null };
const src = fs.readFileSync('js/player.js', 'utf8');
eval(src + '\n;globalThis.Player = Player;');
let fail = 0;
for (const ev of ['track', 'state', 'track-error', 'brand-new-event', 'time', 'queue']) {
  try { Player.on(ev, () => {}); console.log('on(' + ev + ') OK'); }
  catch (e) { fail++; console.log('on(' + ev + ') THREW: ' + e.message); }
}
// setRemoteResolver + loading getter exist
console.log('setRemoteResolver:', typeof Player.setRemoteResolver);
console.log('loading getter:', Player.loading === false ? 'OK (false)' : 'BAD');
console.log(fail ? 'SMOKE FAILED' : 'SMOKE PASSED');
process.exit(fail ? 1 : 0);
