// Generic bot framework: identities, skill profiles, roster fill/despawn helpers.
// Game-specific behaviour (what a bot actually does) is supplied by the game via a "brain".

const FIRST = ['Kestrel', 'Lucía', 'Øyvind', 'Tomasz', 'Aiko', 'Ravi', 'Bao', 'Amara', 'Mateo', 'Ingrid', 'Yusuf', 'Chloé', 'Kenji',
  'Zanele', 'Priya', 'Dmitri', 'Leilani', 'Farah', 'Sven', 'Mei', 'Tariq', 'Noa', 'Esme', 'Joaquín', 'Hana', 'Olu', 'Ana', 'Kai',
  'Rosa', 'Emil', 'Sami', 'Nadia', 'Theo', 'Ivy', 'Lars', 'Wren', 'Arjun', 'Zoe', 'Ilya', 'Talia', 'Gus', 'Minh', 'Selin', 'Ola'];
const HANDLES = ['mapnerd', 'geo_wizard', 'coastwatcher', 'deltaforce', 'riverrat', 'atlas', 'meridian', 'pinpoint', 'longitude',
  'driftwood', 'cartografa', 'nomad', 'compass', 'tidepool', 'isobar', 'fjordfan', 'dune', 'archipel', 'gridref', 'contour', 'latlong'];

export function botName(rng, taken = new Set()) {
  for (let i = 0; i < 50; i++) {
    const style = rng.int(5);
    let n;
    if (style === 0) n = rng.pick(FIRST);
    else if (style === 1) n = rng.pick(HANDLES) + '_' + (rng.int(98) + 2);
    else if (style === 2) n = rng.pick(FIRST) + '.' + String.fromCharCode(65 + rng.int(26));
    else if (style === 3) n = rng.pick(HANDLES);
    else n = rng.pick(FIRST).toLowerCase() + (1980 + rng.int(30));
    if (!taken.has(n)) return n;
  }
  return 'bot' + rng.int(9999);
}

/** Skill profile: skewed so most bots are average-or-worse, a few are sharp. */
export function botProfile(rng) {
  const skill = Math.pow(rng(), 1.35);
  return { skill, aggression: rng(), tilt: rng.range(-0.15, 0.15) };
}

export function makeBot(rng, id, taken) {
  return { id, name: botName(rng, taken), bot: true, profile: botProfile(rng) };
}
