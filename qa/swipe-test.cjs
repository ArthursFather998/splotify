// Extract the EXACT swipe-back IIFE shipped in js/app.js and drive it with
// synthetic touch sequences through a minimal DOM shim. Proves the logic
// as-shipped, independent of any browser's gesture recognizer.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'js', 'app.js'), 'utf8');
const start = src.indexOf('    // Site-wide swipe-right to go back.');
const end = src.indexOf('    // Drag across the tab bar', start);
if (start < 0 || end < 0) { console.log('IIFE NOT FOUND'); process.exit(1); }
const iife = src.slice(start, end);

// --- minimal DOM shim ---
class El {
  constructor(tag, cls, parent) {
    this.tagName = tag; this.className = cls || '';
    this.parentElement = parent || null;
    this.children = []; this.listeners = {};
    this.style = {}; this.scrollWidth = 300; this.clientWidth = 300;
    if (parent) parent.children.push(this);
  }
  addEventListener(type, fn, opts) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, ev) { (this.listeners[type] || []).forEach(fn => fn(ev)); }
  closest(sel) {
    let n = this;
    const sels = sel.split(',').map(s => s.trim());
    while (n) {
      for (const s of sels) {
        if (s.startsWith('.') && n.className.split(' ').includes(s.slice(1))) return n;
        if (s.toLowerCase() === n.tagName.toLowerCase()) return n;
      }
      n = n.parentElement;
    }
    return null;
  }
}
const viewEl = new El('div', '', null);
viewEl.scrollWidth = 390; viewEl.clientWidth = 390;
const row = new El('div', 'trow', viewEl);
const rowTitle = new El('div', 'ttitle', row);
const rail = new El('div', 'rail', viewEl);
rail.scrollWidth = 900; rail.clientWidth = 390;
const railCard = new El('div', 'railcard', rail);

let backCalls = 0, tapCalls = 0;
const S = { stack: [{ v: 'library' }, { v: 'liked' }] };
const view = () => viewEl;
const tap = () => { tapCalls++; };
const back = () => { backCalls++; S.stack.pop(); };
const getComputedStyle = el => ({ overflowX: el === rail ? 'auto' : 'visible' });

// run the shipped IIFE with the stubs in scope
new Function('view', 'S', 'getComputedStyle', 'tap', 'back', iife)(view, S, getComputedStyle, tap, back);

function touch(type, target, x, y) {
  const t = { clientX: x, clientY: y, target };
  const ev = { touches: [t], changedTouches: [t], cancelable: true, preventDefault() {} };
  viewEl.dispatch(type, ev);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function swipe(target, points) {
  touch('touchstart', target, points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) touch('touchmove', target, points[i][0], points[i][1]);
  const last = points[points.length - 1];
  touch('touchend', target, last[0], last[1]);
  await sleep(320);
}
function reset() { backCalls = 0; tapCalls = 0; viewEl.style = {}; S.stack = [{ v: 'library' }, { v: 'liked' }]; }

let pass = 0, fail = 0;
(async () => {
function check(name, cond) { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } }

// 1. clean left swipe on a track row -> back()
reset();
await swipe(rowTitle, [[150, 400], [190, 401], [250, 402], [300, 403]]);
check('right swipe on row calls back()', backCalls === 1);
check('right swipe sets fly-off transform', viewEl.style.transform === 'translateX(100%)');

// 2. short swipe -> springs back, no back()
reset();
await swipe(rowTitle, [[150, 400], [160, 400], [175, 400]]);
check('short swipe does NOT call back()', backCalls === 0);
check('short swipe clears transform', viewEl.style.transform === '');

// 3. vertical scroll -> nothing
reset();
await swipe(rowTitle, [[300, 400], [301, 450], [302, 520]]);
check('vertical scroll does NOT call back()', backCalls === 0);
check('vertical scroll sets no transform', !viewEl.style.transform);

// 4. swipe starting on a rail -> nothing (rail scrolls)
reset();
await swipe(railCard, [[150, 400], [200, 400], [250, 400]]);
check('swipe on rail does NOT call back()', backCalls === 0);

// 5. swipe right -> nothing
reset();
await swipe(rowTitle, [[300, 400], [250, 400], [190, 400]]);
check('swipe left does NOT call back()', backCalls === 0);

// 6. root view (stack length 1) -> nothing
reset();
S.stack = [{ v: 'home' }];
await swipe(rowTitle, [[150, 400], [200, 400], [250, 400]]);
check('root view swipe does NOT call back()', backCalls === 0);

// 7. fast flick past 40px -> back()
reset();
await swipe(rowTitle, [[150, 400], [195, 400]]);
check('fast flick calls back()', backCalls === 1);


// 8. zero-move flick: touchstart then touchend directly, no touchmove -> back()
reset();
touch('touchstart', rowTitle, 150, 400);
touch('touchend', rowTitle, 230, 400);
await sleep(320);
check('zero-move flick calls back()', backCalls === 1);

// 9. browser cancels mid-swipe after claim -> still completes
reset();
touch('touchstart', rowTitle, 150, 400);
touch('touchmove', rowTitle, 190, 401);
touch('touchmove', rowTitle, 220, 401);
touch('touchcancel', rowTitle, 220, 401);
await sleep(320);
check('touchcancel after claim calls back()', backCalls === 1);

// 10. flick on a rail must NOT go back (bailed guard on the fallback)
reset();
touch('touchstart', railCard, 150, 400);
touch('touchend', railCard, 230, 400);
await sleep(320);
check('rail flick does NOT call back()', backCalls === 0);

// 11. diagonal scroll ending left-down must NOT go back
reset();
touch('touchstart', rowTitle, 150, 400);
touch('touchmove', rowTitle, 170, 450);
touch('touchmove', rowTitle, 220, 520);
touch('touchend', rowTitle, 220, 520);
await sleep(320);
check('diagonal scroll does NOT call back()', backCalls === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
