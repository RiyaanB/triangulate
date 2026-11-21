// Portal hooks (CrazyGames SDK v3). Inert unless the page sets window.TRI_PORTAL = 'crazygames'
// (only the dist/crazygames build does). GitHub Pages / itch / server builds: every call is a no-op.
const KIND = window.TRI_PORTAL || '';
let sdk = null, playing = false, adBusy = false;
const listeners = new Set();
const ev = (window.__portalEvents = []);
const log = (e) => { ev.push(e); };
const safe = (fn) => { try { return fn(); } catch (e) { console.warn('[portal]', e?.message || e); } };

export const portal = {
  kind: KIND,
  /** muted by the portal (SDK muteAudio setting or a running ad) */
  forcedMute: false,
  get active() { return !!sdk; },
  async init() {
    if (KIND !== 'crazygames' || !window.CrazyGames?.SDK) return;
    try {
      await window.CrazyGames.SDK.init();
      if (window.CrazyGames.SDK.environment === 'disabled') return;
      sdk = window.CrazyGames.SDK; log('init:' + sdk.environment);
      const apply = (s) => { this.settingsMute = !!s?.muteAudio; this._emit(); };
      apply(sdk.game.settings);
      sdk.game.addSettingsChangeListener(apply);
    } catch (e) { console.warn('[portal] SDK init failed', e?.message || e); sdk = null; }
  },
  settingsMute: false,
  adMute: false,
  onMuteChange(fn) { listeners.add(fn); },
  _emit() { this.forcedMute = this.settingsMute || this.adMute; listeners.forEach((f) => safe(() => f(this.forcedMute))); },
  loadingStart() { if (sdk) log('loadingStart'), safe(() => sdk.game.loadingStart()); },
  loadingStop() { if (sdk) log('loadingStop'), safe(() => sdk.game.loadingStop()); },
  gameplayStart() { if (sdk && !playing && !adBusy) { playing = true; log('gameplayStart'); safe(() => sdk.game.gameplayStart()); } },
  gameplayStop() { if (sdk && playing) { playing = false; log('gameplayStop'); safe(() => sdk.game.gameplayStop()); } },
  happytime() { if (sdk) log('happytime'), safe(() => sdk.game.happytime()); },
  /** Midgame ad at a natural break (between matches only). Resolves when the game may continue. */
  midgame(blockUi) {
    if (!sdk || adBusy) return Promise.resolve();
    this.gameplayStop();
    adBusy = true; blockUi?.(true);
    return new Promise((resolve) => {
      let done = false;
      const end = (how) => { if (done) return; done = true; log('ad:' + (how?.code || how || 'end')); adBusy = false; this.adMute = false; this._emit(); blockUi?.(false); resolve(); };
      safe(() => sdk.ad.requestAd('midgame', {
        adStarted: () => { log('adStarted'); this.adMute = true; this._emit(); },
        adFinished: () => end('finished'),
        adError: end,
      }));
      setTimeout(() => end('timeout'), 90000); // never leave the player stuck if the SDK goes silent
    });
  },
};
