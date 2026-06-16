# API Reference

Base URL: `http://<host>:<HELM_PORT>` (default port `20131`).

All `/api/*` endpoints require authentication via one of:
- **Basic Auth**: `Authorization: Basic base64(HELM_USER:HELM_PASS)`
- **Bearer Token**: `Authorization: Bearer <token>` (from Telegram QR login)

Unauthorized requests receive `401 { "ok": false, "error": "Unauthorized" }`.
Unhandled errors return `500 { "ok": false, "error": "<message>" }`. Responses are
JSON and include `Access-Control-Allow-Origin: *`.

---

## REST endpoints

### `POST /api/auth/tg/qr`
Generate a QR code for Telegram login. Returns a session ID, QR data URL, and
deep link.

```jsonc
{
  "ok": true,
  "sessionId": "abc123...",
  "qrDataUrl": "data:image/png;base64,...",
  "deepLink": "tg://msg?text=..."
}
```

The QR code must be scanned with the **Telegram app** (Settings → Devices → Scan QR)
within 60 seconds.

### `GET /api/auth/tg/session/<sessionId>`
Poll for the QR session status. Once the user scans and confirms via Telegram,
the status becomes `verified` and a Bearer token is returned.

```jsonc
// Pending
{ "status": "pending" }

// Verified — token valid for 1 hour
{ "status": "verified", "token": "helm_tg_<sha256>" }

// Expired
{ "status": "expired" }
```

### `POST /api/auth/tg/callback`
**Webhook endpoint** called by Telegram's Bot API when a user taps the
"Confirm Login" button. The bot must be configured with this URL via
`setWebhook`. Internal — not for client use.

---

### `GET /api/metrics`
Returns a full system snapshot.

```jsonc
{
  "timestamp": 1718000000000,
  "hostname": "myserver",
  "kernel": "6.1.0-21-amd64",
  "uptime": "3d 7h 12m",
  "uptimeSec": 285120,
  "load": [0.12, 0.20, 0.18],
  "cpu":  { "usage": 4.3, "cores": 8 },
  "ram":  { "total": 16384000, "used": 8200000, "avail": 8184000, "pct": "50.0" },
  "swap": { "total": 2097152, "used": 0, "free": 2097152, "pct": "0" },
  "disk": { "total": 500000000, "used": 120000000, "avail": 380000000, "pct": "24.0" },
  "network": { "eth0": { "rx": 12345678, "tx": 8765432 } },
  "processes": [ { "user": "root", "pid": 1234, "cpu": "0.5", "mem": "2.1", "rss": 128, "command": "node" } ],
  "services":  [ { "name": "ssh", "status": "active", "state": "running", "desc": "OpenSSH server" } ],
  "serviceCount": 42,
  "ports": [ { "address": "0.0.0.0:22", "port": 22, "process": "sshd" } ],
  "swappiness": 60
}
```
RAM/swap/disk sizes are in bytes (the frontend formats them).

---

### `GET /api/services`
Lists all systemd units of type `service`.

```json
[
  { "name": "ssh", "load": "loaded", "active": "active", "state": "running", "desc": "OpenSSH server daemon" }
]
```

### `GET /api/services/<name>/<action>`
`action` is one of `start` | `stop` | `restart`. The service name is sanitized to
`[a-zA-Z0-9_.-]`. Runs `sudo systemctl <action> <name>`.

```json
{ "ok": true, "action": "restart", "service": "nginx", "status": "active", "output": "" }
```

### `GET /api/logs/<service>`
Returns the last 100 journal lines for a service (`journalctl -u <service> -n 100`).

```json
{ "service": "nginx", "lines": ["Jun 15 12:00:00 host nginx[123]: ...", "..."] }
```
For a **live** stream use the `/ws/logs/<service>` WebSocket instead.

---

### `GET /api/kill/<pid>`
Sends `SIGKILL` (`kill -9`) to a PID. PIDs `< 2` are rejected.

```json
{ "ok": true, "pid": 4321, "output": "killed" }
```

---

### `GET /api/firewall`
Returns UFW status (`ufw status numbered`).

```json
{ "rules": "Status: active\n\n     To    Action  From\n[ 1] 22/tcp  ALLOW   Anywhere" }
```

### `POST /api/firewall/add`
Body: `{ "port": 8080, "proto": "tcp" | "udp", "comment": "optional" }`. `proto`
defaults to `tcp` for any non-`udp` value; `comment` is sanitized. `port` and
`proto` are required.

```json
{ "ok": true, "output": "Rule added" }
```

### `POST /api/firewall/remove`
Body: `{ "rule": <number> }` — the numbered rule from `GET /api/firewall`. Runs
`ufw delete <number>`.

```json
{ "ok": true, "output": "Rule deleted" }
```

---

### `GET /api/cron`
Returns root and current-user crontabs.

```json
{ "root": ["0 3 * * * /backup.sh"], "user": ["*/5 * * * * /ping.sh"] }
```

---

### `GET /api/disk/analyze?dir=<path>`
Top 20 largest entries under `dir` (default `/`). The path is sanitized (`..` and
`;` stripped). Runs `du -sh <dir>/* | sort -rh | head -20`.

```json
{ "dir": "/var", "items": [ { "size": "4.2G", "path": "/var/log" } ] }
```

---

### `POST /api/action`
Body: `{ "action": "<name>" }`. Supported actions:

| Action            | Command                                             |
|-------------------|-----------------------------------------------------|
| `reboot`          | `sudo reboot` (fire-and-forget)                     |
| `clear-cache`     | `sync && echo 3 > /proc/sys/vm/drop_caches`         |
| `restart-caddy`   | `sudo systemctl reload caddy`                       |
| `restart-hermes`  | `sudo systemctl restart hermes-agent`               |
| `clear-journal`   | `sudo journalctl --vacuum-time=1d`                  |
| `update-packages` | `sudo apt update` (last 5 lines)                    |

Unknown actions return `400 { "ok": false, "error": "Unknown action" }`.

```json
{ "ok": true, "action": "clear-cache", "output": "..." }
```

---

### `GET /api/speedtest`
Measures download throughput via Cloudflare's speed endpoint.

```json
{ "download": "94.32 Mbps", "raw": "11790000" }
```

---

## WebSocket endpoints

WebSocket connections authenticate with a query parameter (browsers can't set
headers on WS upgrades):

```
?auth=base64(HELM_USER:HELM_PASS)
```

Unauthorized sockets are closed with code `4001`. All frames are JSON.

### `/ws/terminal`
A full interactive shell backed by a PTY running `$SHELL` (default `/bin/bash`).

**Client → server**
```jsonc
{ "type": "input",  "data": "ls -la\n" }       // keystrokes
{ "type": "resize", "cols": 120, "rows": 40 }  // terminal resize
```

**Server → client**
```jsonc
{ "type": "output", "data": "<raw terminal bytes>" }
{ "type": "exit",   "exitCode": 0 }            // shell exited; socket then closes
```

The PTY is killed when the socket closes.

### `/ws/logs/<service>`
Live `journalctl -u <service> -f` stream. The service name is sanitized to
`[a-zA-Z0-9_.-]`.

**Server → client**
```jsonc
{ "type": "log", "data": "Jun 15 12:00:00 host service[123]: ...\n" }
```

The underlying `journalctl` process is killed when the socket closes.
