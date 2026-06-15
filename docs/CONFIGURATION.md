# Configuration & Deployment

## Environment variables

HELM reads configuration from a `.env` file in the project root (loaded via
`dotenv`) or from the process environment.

| Variable    | Default     | Description                                       |
|-------------|-------------|---------------------------------------------------|
| `HELM_PORT` | `20131`     | Port for HTTP and WebSocket traffic.              |
| `HELM_USER` | `admin`     | Basic-auth username.                              |
| `HELM_PASS` | `password`  | Basic-auth password. **Change before deploying.** |
| `SHELL`     | `/bin/bash` | Shell launched for the web terminal.              |
| `HOME`      | `/root`     | Working directory for terminal sessions.          |

Example `.env`:

```bash
HELM_PORT=20131
HELM_USER=admin
HELM_PASS=a-long-random-secret
```

## Running

```bash
npm install
npm start        # node src/app.js
npm run dev      # nodemon src/app.js (auto-reload)
```

On start HELM logs:

```
  🚢  HELM — http://0.0.0.0:20131
```

## Security

HELM is a **privileged control panel**. It can run arbitrary shell commands,
restart/stop systemd services, manage the firewall, kill processes, and reboot the
host. Treat access to it as equivalent to root SSH access.

### Authentication
- **REST API** — every `/api/*` request must send an HTTP Basic-Auth header:
  `Authorization: Basic base64(HELM_USER:HELM_PASS)`.
- **WebSockets** — browsers cannot set custom headers on WS connections, so the
  terminal and log streams authenticate with a query parameter:
  `wss://host/ws/terminal?auth=base64(HELM_USER:HELM_PASS)`. Unauthorized sockets
  are closed with code `4001`.

> ⚠️ Static files (the PWA shell) are served **without** authentication — only the
> API and WebSocket endpoints are guarded. Keep `index.html` itself behind your
> reverse proxy if you want the UI gated too.

### Always run behind TLS
Never expose port `20131` directly to the internet. Put HELM behind a reverse proxy
that terminates HTTPS. The `auth` query parameter and Basic-Auth credentials are
only safe over an encrypted connection.

#### Caddy
```caddy
control.yourdomain.com {
    reverse_proxy localhost:20131
}
```

#### Nginx
```nginx
server {
    listen 443 ssl;
    server_name control.yourdomain.com;

    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://localhost:20131;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;       # WebSocket support
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### sudo
Many actions require elevated privileges (`systemctl start/stop/restart`, `ufw`,
`kill -9`, `reboot`, `tee /proc/sys/vm/drop_caches`, `apt update`,
`journalctl --vacuum-time`). The HELM process must run as a user permitted to run
these via `sudo` without an interactive password prompt. Configure a scoped
`sudoers` entry rather than running HELM as root, e.g.:

```sudoers
helm ALL=(root) NOPASSWD: /usr/bin/systemctl, /usr/sbin/ufw, /bin/kill, /sbin/reboot, /usr/bin/journalctl, /usr/bin/apt, /usr/bin/tee
```

Adjust binary paths for your distribution.

## Running as a service

Run HELM itself under systemd so it survives reboots:

```ini
# /etc/systemd/system/helm.service
[Unit]
Description=HELM Control Panel
After=network.target

[Service]
WorkingDirectory=/opt/helm
ExecStart=/usr/bin/node src/app.js
EnvironmentFile=/opt/helm/.env
Restart=on-failure
User=helm

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now helm
```

## Platform requirements

HELM targets **Linux with systemd**. It depends on `/proc`, `systemctl`,
`journalctl`, `ufw`, `ss`, `df`, `top`, `ps`, and `nproc`. It will not function on
macOS or Windows.
