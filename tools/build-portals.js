// Builds portal packages from the static build (docs/), leaving docs/ (GitHub Pages) untouched:
//   dist/itch/triangulate-itch.zip                 TRI_PORTAL='itch'        (no SDK, no external URLs)
//   dist/crazygames/triangulate-crazygames.zip     TRI_PORTAL='crazygames'  (CrazyGames HTML5 SDK v3)
// Run: npm run build:portals   (runs build:static first if docs/ is missing)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DOCS = path.join(ROOT, 'docs');
if (!fs.existsSync(path.join(DOCS, 'index.html'))) execFileSync('node', [path.join(ROOT, 'tools/build-static.js')], { stdio: 'inherit' });
const PORTALS = {
  itch: { head: `<script>window.TRI_PORTAL = 'itch';</script>` },
  crazygames: { head: `<script>window.TRI_PORTAL = 'crazygames';</script>\n  <script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>` },
};
const CSS = `<style>body{-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;-webkit-touch-callout:none}input,textarea{-webkit-user-select:text;user-select:text}</style>`;
for (const [name, cfg] of Object.entries(PORTALS)) {
  const out = path.join(ROOT, 'dist', name);
  const game = path.join(out, 'game');
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(DOCS, game, { recursive: true, filter: (src) => !/\.nojekyll$/.test(src) });
  const idx = path.join(game, 'index.html');
  let html = fs.readFileSync(idx, 'utf8');
  if (!html.includes('window.TRI_STATIC = true')) throw new Error('docs/index.html is not a static build');
  html = html.replace(/\s*<script data-goatcounter[^>]*><\/script>/, ''); // portals: no analytics
  html = html.replace('<script>window.TRI_STATIC = true;</script>', `<script>window.TRI_STATIC = true;</script>\n  ${cfg.head}\n  ${CSS}`);
  fs.writeFileSync(idx, html);
  const zip = path.join(out, `triangulate-${name}.zip`);
  // python3 zipfile (deflate), entries relative so index.html sits at the zip root
  execFileSync('python3', ['-c', 'import os,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED,compresslevel=9)\nfor r,d,f in os.walk("."):\n d.sort()\n for n in sorted(f): z.write(os.path.join(r,n),os.path.relpath(os.path.join(r,n),"."))\nz.close()', zip], { cwd: game });
  const files = execFileSync('find', [game, '-type', 'f']).toString().trim().split('\n').length;
  console.log(`${name}: ${path.relative(ROOT, zip)} ${(fs.statSync(zip).size / 1048576).toFixed(2)} MB, ${files} files`);
}
