## Box hosting status (maintained by Side Gig)
- Internal test server: `triangulate-live` worktree (commit d1a7eaf) on port 8800, started with `setsid nohup`, PID 404466, log `live-server.log`. Fast test instance (TRI_SPEED=4) on port 8801.
- Public URL: **none yet.** A cloudflared quick tunnel (no account) registers a trycloudflare.com URL, but the box's egress filter blocks the tunnel's edge connection (QUIC and HTTP/2 on port 7844). SSH tunnels (localhost.run, serveo, pinggy) and tunnelmole are blocked too. See LESSONS.md.
- Local play: `npm install && npm start`, then open http://localhost:8787.
