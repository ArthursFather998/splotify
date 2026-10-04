/* Build the bundled web app for the Capacitor iOS shell.
 * Copies the site's static assets into www-ios (the native webDir).
 * Excludes the service worker: WKWebView has no SW support, and in the
 * native shell the app version is baked in at build time. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'www-ios');

const DIRS = ['css', 'js', 'icons', 'fonts'];
const FILES = ['index.html', 'manifest.json', 'privacy.html', 'terms.html'];

function rimraf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

rimraf(OUT);
fs.mkdirSync(OUT, { recursive: true });
for (const d of DIRS) {
  const s = path.join(ROOT, d);
  if (fs.existsSync(s)) copyDir(s, path.join(OUT, d));
}
for (const f of FILES) {
  const s = path.join(ROOT, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(OUT, f));
}
console.log('www-ios ready:', OUT);
