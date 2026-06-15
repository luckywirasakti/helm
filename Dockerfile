# syntax=docker/dockerfile:1.6
# ───────────────────────────────────────────────────────────────────────────
# HELM — minimalist mobile-first server command center
# Multi-stage build: install deps (with node-pty native build) once, then
# ship a slim runtime image. The container is designed to run as a non-root
# user; bind-mount the host's sudo binary if you need it (see README).
# ───────────────────────────────────────────────────────────────────────────

# ── 1. Build deps stage (cached separately from source) ───────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Build tools required to compile node-pty (pty.h, gcc, make, python).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── 2. Runtime stage ──────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Tini-style init + sudo for service/firewall/reboot controls.
# Sudo is REQUIRED by HELM: systemctl, ufw, kill, reboot all run as root.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        tini sudo ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system helm \
 && useradd  --system --gid helm --home /app --shell /sbin/nologin helm \
 && echo "helm ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/helm \
 && chmod 0440 /etc/sudoers.d/helm

# Copy only the prebuilt node_modules and project source — no devDeps.
COPY --from=deps --chown=helm:helm /app/node_modules ./node_modules
COPY --chown=helm:helm package.json package-lock.json ./
COPY --chown=helm:helm src ./src
COPY --chown=helm:helm public ./public
COPY --chown=helm:helm docs ./docs
COPY --chown=helm:helm README.md LICENSE .env.example ./

USER helm
ENV NODE_ENV=production \
    HELM_PORT=20131
EXPOSE 20131

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.HELM_PORT+'/healthz',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/app.js"]
