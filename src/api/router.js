const fs = require('fs');
const path = require('path');
const { exec, getMetrics } = require('../utils/metrics');
const { requireAuth } = require('../middleware/auth');
const { exec: execCb } = require('child_process');

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function execAsync(cmd) {
  return new Promise((resolve) => {
    execCb(cmd, { timeout: 15000, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      resolve(err ? stderr.trim() : stdout.trim());
    });
  });
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

module.exports = async (req, res, url, next) => {
  const p = url.pathname;
  const PUBLIC = path.join(__dirname, '..', '..', 'public');

  // Static files handler
  if (!p.startsWith('/api/')) {
    let file = p === '/' ? 'index.html' : p.slice(1);
    const fullPath = path.join(PUBLIC, file);
    if (fs.existsSync(fullPath)) {
      const mime = { '.html': 'text/html', '.json': 'application/json', '.js': 'application/javascript', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain' });
      res.end(fs.readFileSync(fullPath));
      return next();
    }
    res.writeHead(404); res.end('Not found');
    return next();
  }

  // API Guard
  if (!requireAuth(req, res)) return next();

  try {
    if (p === '/api/metrics') return json(res, getMetrics());

    if (p === '/api/services') {
      const raw = exec("systemctl list-units --type=service --all --no-pager --plain 2>/dev/null | grep '.service'");
      const svcs = raw.split('\n').filter(Boolean).map(l => {
        const parts = l.split(/\s+/);
        return { name: parts[0].replace('.service', ''), load: parts[1], active: parts[2], state: parts[3], desc: parts.slice(4).join(' ') };
      });
      return json(res, svcs);
    }

    if (p.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/)) {
      const m = p.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/);
      const [_, name, action] = m;
      const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '');
      const out = exec(`sudo systemctl ${action} ${safe} 2>&1`);
      const active = exec(`systemctl is-active ${safe} 2>/dev/null`);
      return json(res, { ok: active === 'active', action, service: safe, status: active, output: out });
    }

    if (p.match(/^\/api\/logs\/([^/]+)/)) {
      const name = p.match(/^\/api\/logs\/([^/]+)/)[1].replace(/[^a-zA-Z0-9_.-]/g, '');
      const lines = exec(`journalctl -u ${name} --no-pager -n 100 --output=short-precise 2>&1`);
      return json(res, { service: name, lines: lines.split('\n') });
    }

    if (p.match(/^\/api\/kill\/(\d+)$/)) {
      const pid = parseInt(p.match(/^\/api\/kill\/(\d+)$/)[1], 10);
      if (pid < 2) return json(res, { ok: false, error: 'Cannot kill PID < 2' }, 400);
      const out = exec(`sudo kill -9 ${pid} 2>&1`);
      return json(res, { ok: true, pid, output: out || 'killed' });
    }

    if (p === '/api/firewall') {
      const out = exec('sudo ufw status numbered 2>&1');
      return json(res, { rules: out });
    }

    if (p === '/api/firewall/add') {
      const body = await parseBody(req);
      if (!body.port || !body.proto) return json(res, { ok: false, error: 'port and proto required' }, 400);
      const port = parseInt(body.port, 10);
      const proto = body.proto === 'udp' ? 'udp' : 'tcp';
      const comment = (body.comment || '').replace(/[^a-zA-Z0-9 _-]/g, '');
      const cmd = comment ? `sudo ufw allow ${port}/${proto} comment "${comment}"` : `sudo ufw allow ${port}/${proto}`;
      const out = exec(cmd + ' 2>&1');
      return json(res, { ok: true, output: out });
    }

    if (p === '/api/firewall/remove') {
      const body = await parseBody(req);
      if (!body.rule) return json(res, { ok: false, error: 'rule number required' }, 400);
      const num = parseInt(body.rule, 10);
      const out = exec(`echo y | sudo ufw delete ${num} 2>&1`);
      return json(res, { ok: true, output: out });
    }

    if (p === '/api/cron') {
      const root = exec('sudo crontab -l 2>/dev/null') || '';
      const user = exec('crontab -l 2>/dev/null') || '';
      return json(res, { root: root.split('\n').filter(Boolean), user: user.split('\n').filter(Boolean) });
    }

    if (p === '/api/disk/analyze') {
      const rawDir = (url.searchParams.get('dir')) || '/';
      const safe = rawDir.replace(/\.\./g, '').replace(/;/g, '');
      const out = exec(`du -sh ${safe}/* 2>/dev/null | sort -rh | head -20`);
      const items = out.split('\n').filter(Boolean).map(l => {
        const parts = l.split('\t');
        return { size: parts[0]?.trim() || '0', path: parts[1]?.trim() || '' };
      });
      return json(res, { dir: safe, items });
    }

    if (p === '/api/action') {
      const body = await parseBody(req);
      const actions = {
        'reboot': 'sudo reboot',
        'clear-cache': 'sudo sync && echo 3 | sudo tee /proc/sys/vm/drop_caches',
        'restart-caddy': 'sudo systemctl reload caddy',
        'restart-hermes': 'sudo systemctl restart hermes-agent 2>/dev/null || echo "hermes-agent service not found"',
        'clear-journal': 'sudo journalctl --vacuum-time=1d 2>&1',
        'update-packages': 'sudo apt update 2>&1 | tail -5',
      };
      const cmd = actions[body.action];
      if (!cmd) return json(res, { ok: false, error: 'Unknown action' }, 400);
      if (body.action === 'reboot') {
        exec('sudo reboot &');
        return json(res, { ok: true, output: 'Rebooting...' });
      }
      const out = await execAsync(cmd);
      return json(res, { ok: true, action: body.action, output: out });
    }

    if (p === '/api/speedtest') {
      const dl = await execAsync('curl -so /dev/null -w "%{speed_download}" https://speed.cloudflare.com/__down?bytes=10000000 2>/dev/null');
      const speed = (parseFloat(dl) / 125000).toFixed(2);
      return json(res, { download: speed + ' Mbps', raw: dl });
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
  next();
};
