/* Splotify local database — IndexedDB. The SDB (tracks) + library live on-device only. */
const DB = (() => {
  const NAME = 'splotify', VER = 4;
  let db = null;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('tracks')) {
          const s = d.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
          s.createIndex('title', 'title', { unique: false });
          s.createIndex('artist', 'artist', { unique: false });
          s.createIndex('album', 'album', { unique: false });
          s.createIndex('added', 'dateAdded', { unique: false });
        }
        if (!d.objectStoreNames.contains('playlists')) d.createObjectStore('playlists', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
        // v7.0: artist roster table (placeholder artists + follow state).
        // The SDB is the tracks store; the library is a membership list in kv.
        if (!d.objectStoreNames.contains('artists')) d.createObjectStore('artists', { keyPath: 'id' });
        // v7.6: tag memory — corrections the fixer got right (auto-applied,
        // review-approved, hand-edited), keyed for instant recall next run.
        if (!d.objectStoreNames.contains('tagMemory')) d.createObjectStore('tagMemory', { keyPath: 'key' });
        // v9.0: UTAG cache (verified records fetched from the UTAG database)
        // + submission outbox (unknowns/corrections waiting to drain).
        if (!d.objectStoreNames.contains('utagCache')) d.createObjectStore('utagCache', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('utagOutbox')) d.createObjectStore('utagOutbox', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }
  function tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      // v8.3: an aborted transaction fires neither oncomplete nor onerror —
      // without this the promise never settles and the caller hangs forever.
      t.onabort = () => reject(t.error || new Error('IDB transaction aborted: ' + store));
    });
  }
  const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  return {
    open,
    addTracks(list) {
      return new Promise((resolve, reject) => {
        const t = db.transaction('tracks', 'readwrite');
        const s = t.objectStore('tracks');
        const ids = [];
        list.forEach(tr => { const r = s.add(tr); r.onsuccess = () => ids.push(r.result); });
        t.oncomplete = () => resolve(ids);
        t.onerror = () => reject(t.error);
      });
    },
    allTracks() { return tx('tracks', 'readonly', s => req2p(s.getAll())); },
    getTrack(id) { return tx('tracks', 'readonly', s => req2p(s.get(id))); },
    updateTrack(id, patch) {
      return tx('tracks', 'readwrite', s =>
        req2p(s.get(id)).then(cur => { if (!cur) return; Object.assign(cur, patch); return req2p(s.put(cur)); }));
    },
    delTrack(id) { return tx('tracks', 'readwrite', s => { s.delete(id); }); },
    countTracks() { return tx('tracks', 'readonly', s => req2p(s.count())); },

    allPlaylists() { return tx('playlists', 'readonly', s => req2p(s.getAll())); },
    getPlaylist(id) { return tx('playlists', 'readonly', s => req2p(s.get(id))); },
    putPlaylist(pl) { return tx('playlists', 'readwrite', s => { s.put(pl); }); },
    delPlaylist(id) { return tx('playlists', 'readwrite', s => { s.delete(id); }); },

    allArtists() { return tx('artists', 'readonly', s => req2p(s.getAll())); },
    getArtist(id) { return tx('artists', 'readonly', s => req2p(s.get(id))); },
    putArtist(a) { return tx('artists', 'readwrite', s => { s.put(a); }); },
    putArtists(list) {
      return new Promise((resolve, reject) => {
        const t = db.transaction('artists', 'readwrite');
        const s = t.objectStore('artists');
        (list || []).forEach(a => { try { s.put(a); } catch (e) {} });
        t.oncomplete = resolve; t.onerror = () => reject(t.error);
      });
    },

    kvGet(k, def) {
      return tx('kv', 'readonly', s => req2p(s.get(k))).then(r => (r ? r.v : def));
    },
    kvSet(k, v) { return tx('kv', 'readwrite', s => { s.put({ k, v }); }); },

    memGet(key) { return tx('tagMemory', 'readonly', s => req2p(s.get(key))); },
    memPut(rec) { return tx('tagMemory', 'readwrite', s => { s.put(rec); }); },
    memCount() { return tx('tagMemory', 'readonly', s => req2p(s.count())); },
    memAll() { return tx('tagMemory', 'readonly', s => req2p(s.getAll())); },

    utagGet(key) { return tx('utagCache', 'readonly', s => req2p(s.get(key))); },
    utagPut(rec) { return tx('utagCache', 'readwrite', s => { s.put(rec); }); },
    utagCount() { return tx('utagCache', 'readonly', s => req2p(s.count())); },
    outAdd(rec) { return tx('utagOutbox', 'readwrite', s => { s.add(rec); }); },
    outAll() { return tx('utagOutbox', 'readonly', s => req2p(s.getAll())); },
    outDel(id) { return tx('utagOutbox', 'readwrite', s => { s.delete(id); }); },
    outCount() { return tx('utagOutbox', 'readonly', s => req2p(s.count())); },

    usage() {
      if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate();
      return Promise.resolve({});
    },
    clearAll() {
      return new Promise((resolve, reject) => {
        const t = db.transaction(['tracks', 'playlists', 'kv', 'artists'], 'readwrite');
        t.objectStore('tracks').clear();
        t.objectStore('playlists').clear();
        t.objectStore('kv').clear();
        if (t.objectStoreNames.contains('artists')) t.objectStore('artists').clear();
        t.oncomplete = resolve; t.onerror = () => reject(t.error);
      });
    }
  };
})();
