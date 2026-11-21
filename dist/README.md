# Portal packages

Build these with `npm run build:portals` (it runs the static build first) and test them with `npm run test:portals`. The `docs/` folder (GitHub Pages) isn't changed: `js/portal.js` ships there too, but it does nothing unless `window.TRI_PORTAL` is set.

| package | file | notes |
|---|---|---|
| itch.io | `itch/triangulate-itch.zip` | `TRI_PORTAL='itch'`. No SDK. The share text leaves out the page URL. `index.html` is at the zip root, everything uses relative paths, 325 files, about 1.5 MB. |
| CrazyGames | `crazygames/triangulate-crazygames.zip` | `TRI_PORTAL='crazygames'`, which loads `https://sdk.crazygames.com/crazygames-sdk-v3.js`. Calls `SDK.init()`, then `loadingStart`/`loadingStop` (clue pack), `gameplayStart` (a round starts) and `gameplayStop` (game over, Home, before an ad), and `happytime` on a win. Plays one midgame ad only between matches, when "Play again" is pressed, with the UI blocked and audio muted while the ad plays. Respects `settings.muteAudio`. No external links and no fullscreen button. |

The cover art, screenshots, preview videos and store copy are in `assets/`. See `assets/store-copy.md`.
