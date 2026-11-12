/* Splotify haptics bridge (v10.23).
 * Bundled with esbuild into js/vendor/haptics-bridge.js (committed).
 * Rebuild: npm run build:haptics
 * In the Capacitor iOS shell this drives the native Taptic Engine via
 * @capacitor/haptics. On the plain web it falls back to the plugin's web
 * implementation (navigator.vibrate, Android only; silent no-op on iOS
 * Safari). Never throws: a missing bridge just means no haptics. */
import { Haptics, ImpactStyle } from '@capacitor/haptics';

function safe(p) {
  try {
    const r = p && p.catch ? p.catch(function () {}) : p;
    if (r && r.catch) r.catch(function () {});
  } catch (e) {}
}

window.SplotifyHaptics = {
  light: function () { safe(Haptics.impact({ style: ImpactStyle.Light })); },
  medium: function () { safe(Haptics.impact({ style: ImpactStyle.Medium })); },
  selection: function () { safe(Haptics.selectionChanged()); },
};
