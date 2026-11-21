// Builds a server-free static site into docs/ (for GitHub Pages):
// public/ + shared/ + ALL clue packs (live + solo) obfuscated like the solo pack; PLAY runs a
// full 20-player match against in-browser bots via LocalConnection. Run: npm run build:static
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'docs');
const cp = (a, b) => fs.cpSync(a, b, { recursive: true });
fs.rmSync(OUT, { recursive: true, force: true });
cp(path.join(ROOT, 'public'), OUT);
cp(path.join(ROOT, 'shared'), path.join(OUT, 'shared'));
// merge clues
const dec = (j) => { const b = Buffer.from(j.p, 'base64').map((x, i) => x ^ (0x5a + (i % 13))); return JSON.parse(b.toString()); };
const solo = dec(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/solo-pack.json'))));
const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/build/answers.json')));
for (const m of live) cp(path.join(ROOT, 'data/build/clues', m.id + '.json'), path.join(OUT, 'data/solo', m.id + '.json'));
const all = [...solo, ...live.filter((m) => !solo.some((s) => s.id === m.id))];
const enc = Buffer.from(JSON.stringify(all)).map((b, i) => b ^ (0x5a + (i % 13))).toString('base64');
fs.writeFileSync(path.join(OUT, 'data/solo-pack.json'), JSON.stringify({ v: 1, n: all.length, p: enc }));
// flag static mode
const idx = path.join(OUT, 'index.html');
fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('<head>', '<head>\n  <script>window.TRI_STATIC = true;</script>'));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`static build: ${all.length} clues -> docs/`);
