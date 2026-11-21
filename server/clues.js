// Server-side clue source: answers + geometry live in data/build (never served statically).
import fs from 'node:fs';
import path from 'node:path';

export function loadClueSource(root) {
  const dir = path.join(root, 'data/build');
  const file = path.join(dir, 'answers.json');
  if (!fs.existsSync(file)) {
    throw new Error('Clue packs not built. Run: npm run build:data');
  }
  const metas = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cache = new Map();
  return {
    list: () => metas,
    async load(id) {
      if (cache.has(id)) return cache.get(id);
      if (!/^[0-9a-f]{6,16}$/.test(id)) throw new Error('bad id');
      const data = JSON.parse(await fs.promises.readFile(path.join(dir, 'clues', id + '.json'), 'utf8'));
      cache.set(id, data);
      return data;
    },
  };
}
