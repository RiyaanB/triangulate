// Builds a SINGLE-FILE CrazyGames package: one self-contained index.html (CSS, JS bundles, d3, map/clue data, favicon inlined).
// Only external reference: the CrazyGames SDK v3 <script> on its CDN. TRI_PORTAL='crazygames' behaviour is preserved.
// Usage: node tools/build-crazygames-single.mjs [srcDir=dist/crazygames/game] [outDir=dist/crazygames-single]
// (run `npm run build:portals` first to produce srcDir). fetch('data/...') is answered from an inlined table by a tiny fetch shim.
// outDir ends up containing exactly one file, index.html. For safety the script never deletes anything: it refuses to
// run if outDir already holds anything other than index.html.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.argv[2] || path.join(ROOT, 'dist/crazygames/game'));
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'dist/crazygames-single'));
const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
const die = (msg) => { console.error('build-crazygames-single: ' + msg); process.exit(1); };
if (!fs.existsSync(path.join(SRC, 'index.html'))) die(`no index.html in ${SRC} (run npm run build:portals first?)`);
if (OUT === SRC || SRC.startsWith(OUT + path.sep)) die('outDir must not be (a parent of) srcDir');

const rd = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
// Escape every non-ASCII char as \uXXXX: inlined code/data then decodes identically whatever charset the page is served with.
const asciiJs = (s) => s.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
// Inside <script> only "</script" (ends the element) and "<!--" (enters the escaped/double-escaped states) are special.
// Both can only occur inside string/regex/template literals or comments in real code; "<\/" and "<\!" are identity
// escapes there (the inlined result is re-parsed below to prove it is still valid JS).
const scriptSafe = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const styleSafe = (s) => { if (/<\/style/i.test(s)) die('stylesheet contains "</style"'); return s; };

/** literal (non-regex) replacement that must hit exactly once */
let html = rd('index.html');
const swap = (needle, make) => {
  const n = html.split(needle).length - 1;
  if (n !== 1) die(`expected exactly one ${JSON.stringify(needle)} in ${SRC}/index.html, found ${n}`);
  html = html.replace(needle, () => make(needle));
};

// ---- data table (all of data/**, JSON only; minified + validated)
const data = {};
const walk = (d) => {
  for (const f of fs.readdirSync(path.join(SRC, d)).sort()) {
    const rel = d + '/' + f;
    if (fs.statSync(path.join(SRC, rel)).isDirectory()) { walk(rel); continue; }
    if (!f.endsWith('.json')) die(`unexpected non-JSON data file ${rel}`);
    try { data[rel] = JSON.stringify(JSON.parse(rd(rel))); } catch (e) { die(`${rel}: ${e.message}`); }
  }
};
walk('data');
// JSON.stringify output is a valid JS expression; escape "<" (so no "</script" / "<!--") and all non-ASCII (incl. U+2028/9).
const table = asciiJs(JSON.stringify(data).replace(/</g, '\\u003c'));
const shim = `(function(){
var D=${table},F=window.fetch,H=Object.prototype.hasOwnProperty;
function key(u){
  var s=typeof u==='string'?u:(u&&typeof u.url==='string'?u.url:String(u)),k=s.split(/[?#]/)[0].replace(/^\\.?\\//,'');
  if(H.call(D,k))return k;
  try{var b=location.href.split(/[?#]/)[0].replace(/[^\\/]*$/,''),a=new URL(s,b).href.split(/[?#]/)[0];if(a.indexOf(b)===0&&H.call(D,a.slice(b.length)))return a.slice(b.length)}catch(e){}
  return null;
}
window.fetch=function(u){var k=key(u);
  if(k!==null)return Promise.resolve(new Response(D[k],{status:200,headers:{'Content-Type':'application/json; charset=utf-8'}}));
  return F.apply(this,arguments)};
})();`;

// ---- JS: each module entry bundled separately (app.js and fx/ambient.js share no imports; asserted below).
// Inline <script type="module"> keeps the original semantics: deferred, executed in document order after parsing.
const entries = {};
const bundle = async (entry) => {
  const r = await build({ entryPoints: [path.join(SRC, entry)], bundle: true, format: 'esm', minify: true, write: false, metafile: true,
    target: 'es2020', charset: 'ascii', legalComments: 'none', logLevel: 'warning' });
  entries[entry] = Object.keys(r.metafile.inputs);
  return r.outputFiles[0].text;
};
const app = await bundle('js/app.js'), amb = await bundle('js/fx/ambient.js');
const shared = entries['js/app.js'].filter((f) => entries['js/fx/ambient.js'].includes(f));
if (shared.length) die(`app.js and fx/ambient.js share modules (would be duplicated): ${shared.join(', ')}`);
// d3 was a deferred classic script (runs after parsing, before the module scripts). An inline classic script runs
// immediately instead; it only defines window.d3 and touches no DOM, and it still runs before the modules use it.
const d3 = asciiJs(rd('vendor/d3.min.js'));

// ---- assemble
// <meta charset> must be in the first 1024 bytes; the inlined shim would push it to byte ~4M, so hoist it to the top.
swap('<meta charset="utf-8">', () => '');
html = html.replace(/<head>\s*/, (m) => `<head>\n  <meta charset="utf-8">\n  `);
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, h) => `<style>${styleSafe(rd(h))}</style>`);
swap('href="favicon.svg"', () => `href="data:image/svg+xml,${encodeURIComponent(rd('favicon.svg'))}"`);
swap('<script src="vendor/d3.min.js" defer></script>', () => `<script>${scriptSafe(d3)}</script>`);
swap('<script type="module" src="js/app.js"></script>', () => `<script type="module">${scriptSafe(app)}</script>`);
swap('<script type="module" src="js/fx/ambient.js"></script>', () => `<script type="module">${scriptSafe(amb)}</script>`);
// shim must run before anything can fetch: right after the TRI_PORTAL flag (before the SDK, d3 and the app)
swap("<script>window.TRI_PORTAL = 'crazygames';</script>", (m) => `${m}\n  <script>${shim}</script>`);

// ---- verify
if (html.indexOf('<meta charset="utf-8">') > 200) die('meta charset not near the top');
if (!html.includes(`<script src="${SDK_URL}"></script>`)) die('CrazyGames SDK tag missing');
if (!/window\.TRI_PORTAL = 'crazygames'/.test(html)) die('TRI_PORTAL flag missing');
// outside the inline <script>/<style> bodies, every src/href/url() must be the SDK, data:, or a fragment
const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>').replace(/<style>[\s\S]*?<\/style>/gi, '<style></style>');
const refs = [...markup.matchAll(/\b(?:src|href|srcset|poster|data)\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]);
const bad = refs.filter((r) => !(r === SDK_URL || r.startsWith('data:') || r.startsWith('#')));
if (bad.length) die('unresolved references in markup: ' + bad.join(', '));
const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n') + markup;
const cssUrls = [...styles.matchAll(/url\(\s*["']?([^"')]+)/gi)].map((m) => m[1]).filter((u) => !u.startsWith('data:') && !u.startsWith('#'));
if (cssUrls.length) die('unresolved url() references: ' + cssUrls.join(', '));
// every fetch('...') literal in the bundles must be served by the shim
for (const [name, code] of [['app', app], ['ambient', amb]]) {
  if (/\bimport\s*\(|new\s+Worker\b|importScripts|import\.meta/.test(code)) die(`${name}: dynamic import / worker / import.meta not supported in single-file build`);
  for (const m of code.matchAll(/fetch\(\s*(["'`])([^"'`$]*)\1/g)) if (!Object.hasOwn(data, m[2])) die(`${name}: fetch(${m[2]}) is not inlined`);
  for (const m of code.matchAll(/fetch\(\s*`([^`]*)\$\{/g)) if (!Object.keys(data).some((k) => k.startsWith(m[1]))) die(`${name}: fetch(\`${m[1]}...\`) is not inlined`);
}
// inlined scripts must still parse after escaping
const inline = [...html.matchAll(/<script(\b[^>]*)>([\s\S]*?)<\/script>/gi)];
if (inline.length !== 8) die(`expected 8 <script> elements, found ${inline.length}`);
for (const [, attrs, body] of inline) {
  if (/type="module"/.test(attrs)) await transform(body, { format: 'esm', loader: 'js' }).catch((e) => die('inline module no longer parses: ' + e.message));
  else if (body.trim()) { try { new vm.Script(body); } catch (e) { die('inline script no longer parses: ' + e.message); } }
}
// mirrors the HTML tokenizer: no premature </script> anywhere in a body, no "<!--" that could start an escaped state
for (const [, , body] of inline) if (/<\/script|<!--/i.test(body)) die('script body contains </script or <!--');

// ---- write (never deletes: refuses a non-empty outDir that holds anything besides index.html)
fs.mkdirSync(OUT, { recursive: true });
const extra = fs.readdirSync(OUT).filter((f) => f !== 'index.html');
if (extra.length) die(`${OUT} contains other files (${extra.join(', ')}); empty it first — the output dir must hold only index.html`);
fs.writeFileSync(path.join(OUT, 'index.html'), html);
const kb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log(`single-file build: ${path.join(OUT, 'index.html')} ${kb(Buffer.byteLength(html))} (data ${Object.keys(data).length} files, app ${kb(app.length)}, ambient ${kb(amb.length)}, d3 ${kb(d3.length)})`);
