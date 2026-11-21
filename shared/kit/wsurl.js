// WebSocket URL relative to the page: works on plain http, behind https reverse proxies/tunnels (wss) and
// under a path prefix (https://host/games/tri/ -> wss://host/games/tri/ws). Reusable for any game.
export function wsUrl(loc, path = 'ws') {
  const u = new URL(path, loc.href);
  u.protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  u.hash = ''; u.search = '';
  return u.href;
}
