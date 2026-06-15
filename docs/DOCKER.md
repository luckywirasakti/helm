# Docker deployment

The `Dockerfile` ships a working HELM image that **runs in a container**. What
that container can see and control depends entirely on the flags you pass at
`docker run` time — the image itself doesn't grant any special capabilities.

This document covers the three deployment shapes, from simplest to most
powerful. Pick the one that matches your threat model.

---

## TL;DR decision table

| Goal                                                | Run on host | `docker run` plain | `docker compose up` (this repo) | `docker run --privileged` |
| --------------------------------------------------- | :---------: | :----------------: | :-----------------------------: | :-----------------------: |
| `/healthz` works                                    | ✅          | ✅                 | ✅                              | ✅                        |
| Metrics: CPU, RAM, load, swap, network, processes   | ✅          | ❌ (container only) | ✅ (via `pid: host`)            | ✅                        |
| Disk usage of host's `/`                            | ✅          | ❌                  | ⚠️ opt-in (see below)           | ✅                        |
| `systemctl list/start/stop/restart` host services   | ✅          | ❌                  | ✅ (via `/run/systemd` mount)   | ✅                        |
| `journalctl -u <svc>` host logs                     | ✅          | ❌                  | ✅ (via `/var/log/journal`)     | ✅                        |
| `ufw` (iptables)                                    | ✅          | ❌                  | ✅ (via `NET_ADMIN`)            | ✅                        |
| `kill <pid>` of host processes                      | ✅          | ❌                  | ✅ (via `pid: host` + `SYS_PTRACE`) | ✅                    |
| `/ws/terminal` — interactive host shell             | ✅          | ❌ (container shell) | ✅ (via `pid: host`)            | ✅                        |
| Trigger a host restart from `/api/action`           | ✅          | ❌                  | ❌ (safety — see below)         | ✅                        |

If you just want HELM to do its job, **running it on the host is simplest**.
The container variants exist for "I want package isolation" or "I'm running
HELM as a sidecar inside a larger compose stack".

---

## Option A — Run on the host (recommended for most users)

What the README already says:

```bash
git clone https://github.com/luckywirasakti/helm.git
cd helm
npm ci --omit=dev
cp .env.example .env   # edit HELM_USER / HELM_PASS
npm start
```

Wire it up as a systemd unit (no Dockerfile needed):

```ini
# /etc/systemd/system/helm.service
[Unit]
Description=HELM — server command center
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/helm
EnvironmentFile=/opt/helm/.env
ExecStart=/usr/bin/node src/app.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Everything works out of the box. No namespace gymnastics, no caps, no surprises.

---

## Option B — Docker with `pid: host` (shipped `docker-compose.yml`)

The compose file in this repo uses the minimum set of flags that lets HELM
see and control the host **without** granting full root in the container:

```yaml
pid: host              # share host PID namespace
network_mode: host     # bind on host's network
cap_add:
  - SYS_PTRACE         # ps aux across host PIDs
  - NET_ADMIN          # ufw (iptables)
volumes:
  - /run/systemd:/run/systemd:ro
  - /var/log/journal:/var/log/journal:ro
```

Start it:

```bash
cp .env.example .env   # set HELM_USER / HELM_PASS
docker compose up -d
docker compose ps      # → "healthy" within ~10s
```

### Disk metric (optional, adds host root visibility)

By default `df /` inside the container reports the container's overlay
filesystem, not the host's. To get the host's real disk usage:

1. Edit `docker-compose.yml` and uncomment the two `HELM_DISK_ROOT` /
   `volumes: - /:/hostfs:ro` lines.
2. Restart: `docker compose up -d`.

The `HELM_DISK_ROOT` env var is read by `src/utils/metrics.js` and sanitized
to `[A-Za-z0-9_./-]` so it's safe to interpolate into the `df` command.

### What the compose deliberately does **not** do

- **`reboot` from `/api/action` is blocked.** The compose does not grant
  `--privileged`, so a stray tap on the "reboot" button inside the PWA
  only restarts the HELM container, not the host. Operators must still
  SSH in to restart the box. This is a safety feature, not a bug.
- **No read-write mounts of the host.** The only host paths mounted are
  `ro`. HELM cannot write to `/etc`, drop files in `/root`, etc.
- **No new privileges escalation.** The container runs as the unprivileged
  `helm` user (defined in the `Dockerfile`) and only gets `SYS_PTRACE` +
  `NET_ADMIN` on top.

---

## Option C — `--privileged` (NOT recommended)

```bash
docker run -d --name helm \
  --pid=host --network=host --privileged \
  -v /run/systemd:/run/systemd \
  -v /var/log/journal:/var/log/journal \
  -v /:/hostfs:ro \
  -e HELM_DISK_ROOT=/hostfs \
  -e HELM_USER=admin -e HELM_PASS=change-me \
  helm:local
```

This is "run HELM as full root over the host". It works, but it means any
vulnerability in HELM, node-pty, or the basic-auth layer is a host-root
RCE. Don't use this in production unless you understand the risk and have
no other option.

---

## How the `/healthz` endpoint fits in

The Docker `HEALTHCHECK` (and the compose `healthcheck:` block) hits
`GET /healthz`. The endpoint is **unauthenticated** and returns
`{ ok: true, service: 'helm', uptime: <seconds> }` with
`Cache-Control: no-store`.

Use it from:

- `docker ps` → `STATUS` column
- `docker compose ps` → `health` field
- Any reverse proxy (`proxy_next_upstream http_500 http_502 http_503 http_504`)
- Uptime monitors (Uptime Kuma, Healthchecks.io, etc.)
- Kubernetes liveness/readiness probes (`httpGet: /healthz`)

It is intentionally a "process is up" check, not a "all subsystems healthy"
check — those would couple the panel's availability to systemd / disk /
network state, which is the wrong coupling for a self-monitoring tool.

---

## Network exposure

HELM exposes a full root shell over WebSocket and a full REST control plane
over HTTP. **Never** publish port 20131 directly to the public internet.
Always put it behind a reverse proxy (Caddy/Nginx) with TLS, and ideally
restrict the source IPs.

A minimal Caddy snippet:

```caddy
control.example.com {
    basicauth {
        admin $2a$14$<bcrypt-hash-of-HELM_PASS>
    }
    reverse_proxy 127.0.0.1:20131
}
```

Note that Caddy's `basicauth` is **additional** to the panel's own
Basic-Auth — defense in depth. The panel still sees the upstream's
`Authorization` header, but if Caddy's layer fails open the panel is
still gated.

---

## Troubleshooting

| Symptom                                              | Likely cause                                       | Fix                                                              |
| ---------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `STATUS` says `unhealthy`                            | Port collision, or app didn't bind in 10s          | `docker compose logs helm` — look for `EADDRINUSE`               |
| `systemctl list-units` returns empty                 | `/run/systemd` mount missing or wrong host distro  | Check the volume mount + that the host uses systemd              |
| `ps aux` only shows container PIDs                   | Forgot `pid: host`                                 | Add `pid: host` to compose                                       |
| Disk metric is tiny (container overlay size)         | `HELM_DISK_ROOT` not set or host not mounted       | Add `- /:/hostfs:ro` + `HELM_DISK_ROOT=/hostfs`                  |
| `journalctl -u nginx` returns `No journal files`     | `/var/log/journal` mount missing                   | Add the volume, or run HELM on the host                          |
| `ufw status` errors with `Permission denied`         | Forgot `NET_ADMIN`                                 | Add `cap_add: [NET_ADMIN]`                                       |
| `reboot` from UI silently does nothing               | Deliberately disabled (no `--privileged`)          | SSH in and `sudo reboot` manually                                |
