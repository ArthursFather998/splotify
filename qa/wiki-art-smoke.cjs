// Wikipedia cover lookup smoke test. Loads the real fixer engine and
// calls the lookup live. Run: node qa/wiki-art-smoke.cjs
const fs = require("fs");
const vm = require("vm");
const src = fs.readFileSync(__dirname + "/../js/fixer.js", "utf8");
globalThis.window = globalThis;
vm.runInThisContext(src);
const Fixer = globalThis.UtagFixer;
async function main() {
  const cases = [
    { t: { album: "Withered", artist: "d4vd" }, want: "Withered", mustHave: "upload.wikimedia.org" },
    { t: { album: "Petals to Thorns", artist: "d4vd" }, want: "Petals_to_Thorns", mustHave: "upload.wikimedia.org" },
    { t: { album: "Bad Vibes Forever", artist: "XXXTentacion" }, want: "Bad_vibes", mustHave: "upload.wikimedia.org" },
    { t: { album: "Always Love", artist: "d4vd" }, want: null, mustNot: "Max_always_lovecd" },
    { t: { album: "Withered", artist: "MAX" }, want: null },
    { t: { album: "Unknown Album", artist: "d4vd" }, want: null },
    { t: { album: "Celeste", artist: "d4vd" }, want: null },
  ];
  let fail = 0;
  for (const c of cases) {
    const r = await Fixer.wikiArt(c.t);
    console.log(JSON.stringify(c.t), "=>", r ? r.url + " [" + r.source + " w=" + r.w + "]" : null);
    if (c.want && (!r || !r.url.includes(c.mustHave) || !r.url.includes(c.want))) { console.log("  FAIL: expected a cover containing " + c.want); fail++; }
    if (c.want === null && r && c.mustNot && r.url.includes(c.mustNot)) { console.log("  FAIL: wrong-artist cover accepted"); fail++; }
    if (c.want === null && !c.mustNot && r) { console.log("  FAIL: expected null"); fail++; }
    if (r) {
      const res = await fetch(r.url);
      const buf = Buffer.from(await res.arrayBuffer());
      console.log("  image fetch:", res.status, buf.length, "bytes");
      if (!res.ok || buf.length <= 1000) { console.log("  FAIL: image blob too small or not ok"); fail++; }
    }
  }
  console.log(fail ? "FAILURES: " + fail : "ALL PASS");
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
