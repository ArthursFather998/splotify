(function () {
  const state = {
    tracks: [],
    byId: new Map(),
    library: [],
    playCounts: {},
    followedArtists: new Set(),
    skipIds: new Set(),
    stack: [{ v: 'home' }],
    tab: 'home',
    viewCtx: null,
    libQ: '',
    q: '',
    artistName: '',
    playlistId: null,
    albumKey: null,
    recent: [],
    _pls: [],
    _lastView: null,
    fixUI: {},
    devUI: {},
    dbUI: {},
    spReview: [],
    spReport: [],
    tagReview: [],
    tags: {},
    ui: {
      tab: 'home',
      stack: [{ v: 'home' }],
      search: '',
      library: { q: '', pinned: [] },
      fix: { filter: 'all' }
    }
  };

  const api = window.Splotify || (window.Splotify = {});
  api.state = state;
  api.getState = () => state;
  api.setState = patch => Object.assign(state, patch);

  Object.defineProperty(window, 'S', {
    configurable: true,
    get() { return state; }
  });
})();
