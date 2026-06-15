# Architecture

HELM is a single Node.js process that serves a static PWA, exposes a REST API for
system control, and streams a terminal and live logs over WebSockets. It uses only
Node's built-in `http` module — there is no Express or other web framework.

## High-level flow

```
                  ┌─────────────────────────────────────────────┐
   Browser (PWA)  │                  HELM process                │
  ┌────────────┐  │  ┌──────────────┐                            │
  │ index.html │──┼─▶│  http server │  src/app.js                │
  │  xterm.js  │  │  │              │                            │
  └────────────┘  │  │   ┌──────────┴──────────┐                 │
       │  ▲        │  │   ▼                     ▼                 │
  HTTP │  │ WS     │  │ router()           WebSocketServer        │
       │  │        │  │ src/api/router.js  src/ws/handler.js      │
       ▼  │        │  │   │                     │                 │
  ┌────────────┐   │  │   ├─ static files       ├─ /ws/terminal   │
  │   /api/*   │   │  │   ├─ /api/metrics        │   (node-pty)    │
  │  /ws/*     │   │  │   ├─ /api/services/*     └─ /ws/logs/*     │
  └────────────┘   │  │   ├─ /api/firewall/*         (journalctl) │
                   │  │   └─ ...              auth via ?auth=      │
                   │  └──────────────────────────────────────────┘
                   │            │ execSync / spawn                │
                   │            ▼                                 │
                   │   systemctl · ufw · journalctl · ps · df · … │
                   └─────────────────────────────────────────────┘
```

## Components

### `src/app.js` — bootstrap
- Loads `.env` (via `dotenv`) and reads `HELM_PORT` (default `20131`).
- Creates the HTTP server. Handles CORS preflight (`OPTIONS`) globally, then
  delegates every request to `router()`.
- Attaches a `WebSocketServer` (sharing the same HTTP server). On each WS
  connection it validates `?auth=` via `checkAuthFromURL`; unauthorized sockets are
  closed with code `4001`. Authorized sockets are passed to the WS handler.
- Wires `SIGINT`/`SIGTERM` to a graceful shutdown.

### `src/api/router.js` — HTTP routing
A single async function `(req, res, url, next)`:
- **Static files**: any path not starting with `/api/` is served from `public/`
  (defaulting `/` → `index.html`), with a small extension→MIME map.
- **API guard**: every `/api/*` route requires Basic Auth (`requireAuth`). On
  failure it returns `401` and the route short-circuits.
- **Routes**: metrics, systemd service control, log retrieval, process kill, UFW
  firewall, cron listing, disk analysis, server actions, and a speedtest. See
  [API.md](API.md) for the full list.
- Errors are caught and returned as `500 { ok: false, error }`. `next()` triggers
  request logging.

### `src/ws/handler.js` — WebSocket streams
- **`/ws/terminal`**: spawns a PTY (`node-pty`) running `$SHELL` (default
  `/bin/bash`). Bridges `input`/`resize` messages from the client to the PTY and
  streams `output`/`exit` back as JSON. The PTY is killed when the socket closes.
- **`/ws/logs/<service>`**: spawns `journalctl -u <service> -f` and streams each
  line as a `log` message. The service name is sanitized to
  `[a-zA-Z0-9_.-]`. The child process is killed on socket close.
- Also exports `createWSS(server)` which builds the `WebSocketServer`.

### `src/utils/metrics.js` — system metrics
`getMetrics()` reads from `/proc`, `df`, `top`, `ps`, `ss`, and `systemctl` to
produce a single JSON snapshot: hostname, kernel, uptime, load average, CPU, RAM,
swap, disk, per-interface network counters, top processes by memory, services,
listening ports, and `vm.swappiness`. Also exports a hardened `exec()` helper that
returns `''` on failure instead of throwing.

### `src/middleware/auth.js` — authentication
- `requireAuth(req, res)` — checks the HTTP `Authorization: Basic …` header against
  `HELM_USER`/`HELM_PASS`; writes `401` and returns `false` on mismatch.
- `checkAuthFromURL(url)` — checks `?auth=<base64(user:pass)>` for WebSocket
  upgrades (browsers can't set custom headers on WS connections).

### `src/middleware/logger.js` — logging
A one-line console logger: `HH:MM:SS METHOD /path STATUS Nms`.

## Request lifecycle

1. **HTTP** → `app.js` handles CORS, calls `router()` → static or `/api/*` (auth
   guard) → handler runs a shell command → JSON response → `logger()` records it.
2. **WebSocket** → `app.js` validates `?auth=` → `handler()` routes by pathname →
   PTY or `journalctl` child process streams JSON frames until the socket closes.

## Design notes & trade-offs

- **No framework**: keeps the dependency tree tiny (`ws`, `node-pty`, `dotenv`) and
  startup instant, at the cost of manual routing.
- **Shell-command driven**: HELM shells out to standard Linux tools rather than
  parsing `/proc` exhaustively or using bindings. This makes it Linux/systemd
  specific and means many actions need `sudo` (see [CONFIGURATION.md](CONFIGURATION.md#sudo)).
- **Input sanitization**: service names, PIDs, ports, and directory paths are
  validated/sanitized before being interpolated into shell commands. The terminal
  endpoint, by design, grants full shell access — so authentication and TLS are
  mandatory.
