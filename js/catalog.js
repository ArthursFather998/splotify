(function () {
  const { state } = window.Splotify || {};
  const { normTitle, normBase } = (window.Splotify && window.Splotify.utils) || {};

  function realAlbums() {
    const S = window.S || state;
    if (!S || !Array.isArray(S.tracks)) return [];
    return S.tracks
      .filter(t => t && t.album && !String(t.album || '').match(/^\s*single\s*$/i))
      .reduce((out, t) => {
        const key = `${(t.albumArtist || t.artist || '')}|||::|||${t.album}`;
        const existing = out.find(a => a.key === key);
        if (existing) {
          existing.tracks.push(t);
          return out;
        }
        out.push({
          key,
          name: t.album,
          artist: t.albumArtist || t.artist || '',
          art: t.art,
          tracks: [t],
          single: false,
          year: t.year || ''
        });
        return out;
      }, []);
  }

  function singleAlbums() {
    const S = window.S || state;
    if (!S || !Array.isArray(S.tracks)) return [];
    return S.tracks
      .filter(t => t && t.album && String(t.album || '').trim().toLowerCase() === 'single')
      .reduce((out, t) => {
        const key = `${(t.albumArtist || t.artist || '')}|||::|||${t.album}`;
        const existing = out.find(a => a.key === key);
        if (existing) {
          existing.tracks.push(t);
          return out;
        }
        out.push({
          key,
          name: t.album,
          artist: t.albumArtist || t.artist || '',
          art: t.art,
          tracks: [t],
          single: true,
          year: t.year || ''
        });
        return out;
      }, []);
  }

  function albums() {
    return realAlbums().concat(singleAlbums());
  }

  function splitArtists(s) {
    const raw = String(s || '');
    if (!raw) return [];
    return raw
      .split(/\s*(?:,|&|feat\.|ft\.| featuring )\s*/i)
      .map(v => v.trim())
      .filter(Boolean)
      .map(v => v.replace(/\s*\([^)]*\)/g, ''))
      .filter(Boolean)
      .slice(0, 8);
  }

  function artistKey(s) {
    const raw = String(s || '');
    return raw.toLowerCase().replace(/\s+&\s+/g, ',').replace(/\s*\([^)]*\)/g, '').trim();
  }

  function artistDisp(s) {
    const raw = String(s || '');
    const clean = raw
      .replace(/^\d+\.\s*/, '')
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/^@/, '')
      .trim();
    return clean || raw;
  }

  function artistStats(name) {
    const S = window.S || state;
    const list = S.tracks.filter(t => splitArtists(t.artist).some(a => artistKey(a) === artistKey(name)));
    const total = list.length;
    const albums = [...new Set(list.map(t => t.album).filter(Boolean))].length;
    return { total, albums };
  }

  function releaseYear(x) {
    const ys = (x && x.tracks ? x.tracks : []).map(t => parseInt(t.year, 10)).filter(Boolean);
    return ys.length ? Math.max(...ys) : 0;
  }

  function artists() {
    const S = window.S || state;
    if (!S || !Array.isArray(S.tracks)) return [];
    const map = new Map();
    for (const track of S.tracks) {
      for (const artistName of splitArtists(track.artist)) {
        const key = artistKey(artistName);
        const disp = artistDisp(artistName);
        const existing = map.get(key) || { key, name: disp, tracks: [] };
        existing.tracks.push(track);
        map.set(key, existing);
      }
    }
    return [...map.values()].map(a => ({ ...a, name: a.name || a.key }));
  }

  const api = window.Splotify || (window.Splotify = {});
  api.catalog = {
    realAlbums,
    singleAlbums,
    albums,
    splitArtists,
    artistKey,
    artistDisp,
    artistStats,
    releaseYear,
    artists
  };

  window.realAlbums = realAlbums;
  window.singleAlbums = singleAlbums;
  window.albums = albums;
  window.splitArtists = splitArtists;
  window.artistKey = artistKey;
  window.artistDisp = artistDisp;
  window.artistStats = artistStats;
  window.releaseYear = releaseYear;
  window.artists = artists;
})();
