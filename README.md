# HELM 🚢
**The Minimalist, Mobile-First Server Command Center.**

HELM is a lightweight, high-performance web dashboard designed for developers who need to manage their infrastructure on the go. No bloat, no complex configurations—just pure control.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)

## ⚡ Why HELM?
Most server panels are too heavy or not designed for mobile. HELM is different. It's a Progressive Web App (PWA) that feels like a native app on your iPhone or Android, giving you a full-blown terminal and system controls right in your pocket.

## ✨ Features
- 📊 **Zero-Latency Monitoring**: Real-time CPU, RAM, Disk, and Load Average metrics.
- 📈 **Live Analytics**: Beautiful, dark-themed charts for resource tracking.
- ⚙️ **Service Orchestration**: Start, stop, and restart systemd services with a single tap.
- ⟩_ **Full Web Terminal**: High-performance xterm.js terminal with full keyboard support.
- 📜 **Live Journal**: Stream system logs directly to your device via WebSockets.
- ☰ **Quick Actions**: One-tap server reboots, cache clearing, and package updates.
- 🛡️ **Built-in Security**: Firewall (UFW) management and native authentication UI.
- 📱 **PWA Perfection**: Add to Home Screen for a fullscreen, standalone experience.

## 🛠 Tech Stack
- **Backend**: Node.js (High-concurrency event loop)
- **Communication**: WebSockets (Real-time duplex streaming)
- **Frontend**: Pure Vanilla JS & CSS Variables (Zero dependencies, ultra-fast)
- **Terminal**: node-pty & xterm.js

## 🚀 Quick Start
1. **Clone & Install**
   ```bash
   git clone https://github.com/yourusername/helm.git
   cd helm
   npm install
   ```
2. **Launch**
   ```bash
   node server.js
   ```
3. **Secure with Caddy (Recommended)**
   Add this to your `Caddyfile`:
   ```caddy
   control.yourdomain.com {
       # Protect API and WebSockets
       basic_auth /api/* /ws/* {
           YOUR_USER YOUR_HASHED_PASSWORD
       }
       reverse_proxy localhost:20131
   }
   ```

## 🔒 Security Note
HELM is designed to be used behind a reverse proxy (like Caddy or Nginx) with **Basic Authentication**. The native login UI provided in the app will securely handle these credentials for a seamless mobile experience.

---
*Take the helm of your infrastructure. Sikat! 🚀*
