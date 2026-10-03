(function () {
  const normTitle = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normBase = s => normTitle(String(s || '').replace(/\s*[\(\[].*?[\)\]]/g, ''));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = s => {
    if (!s || !isFinite(s)) return '0:00';
    s = Math.floor(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  const hashStr = s => {
    let h = 0;
    s = String(s);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  };
  const daySeed = () => {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  };

  const api = window.Splotify || (window.Splotify = {});
  api.utils = { esc, fmt, normTitle, normBase, hashStr, daySeed };

  window.esc = esc;
  window.normTitle = normTitle;
  window.normBase = normBase;
  window.fmt = fmt;
  window.hashStr = hashStr;
  window.daySeed = daySeed;
})();
