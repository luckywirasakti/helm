const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, exec: execCb, spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const PORT = 20131;

// ── Helpers ──
function exec(cmd) {
  try { return execSync(cmd, { timeout: 10000, encoding: 'utf8' }).trim(); }
  catch { return ''; }
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

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

// ── Metrics ──
function getMetrics() {
  const uptimeRaw = exec('cat /proc/uptime');
  const uptimeSec = parseFloat(uptimeRaw.split(' ')[0]);
  const loadAvg = exec('cat /proc/loadavg').split(' ').slice(0, 3);
  const cpuCount = parseInt(exec('nproc') || '1');
  const cpuLine = exec("top -bn1 | grep '%Cpu' | head -1");
  const cpuIdle = parseFloat((cpuLine.match(/([\d.]+)\s*id/) || [])[1] || 0);
  const memInfo = fs.readFileSync('/proc/meminfo', 'utf8');
  const g = (k) => parseInt((memInfo.match(new RegExp(k + ':\\s+(\\d+)')) || [])[1] || 0);
  const memTotal = g('MemTotal'), memAvail = g('MemAvailable'), memUsed = memTotal - memAvail;
  const swapTotal = g('SwapTotal'), swapFree = g('SwapFree'), swapUsed = swapTotal - swapFree;
  const dp = exec("df -B1 / | tail -1").split(/\s+/);
  const diskTotal = parseInt(dp[1] || 0), diskUsed = parseInt(dp[2] || 0);
  const netRaw = exec("cat /proc/net/dev | tail -n +3");
  const interfaces = {};
  netRaw.split('\n').forEach(line => {
    const p = line.trim().split(/\s+/);
    if (p.length > 9) { const n = p[0].replace(':', ''); if (n !== 'lo') interfaces[n] = { rx: parseInt(p[1]), tx: parseInt(p[9]) }; }
  });
  const psRaw = exec("ps aux --sort=-%mem | head -16 | tail -15");
  const processes = psRaw.split('\n').map(line => {
    const p = line.split(/\s+/);
    return { user: p[0], pid: parseInt(p[1]), cpu: p[2], mem: p[3], rss: Math.round(parseInt(p[5] || 0) / 1024), command: p.slice(10).join(' ').split('/').pop().substring(0, 60) };
  });
  const svcRaw = exec("systemctl list-units --type=service --all --no-pager --plain 2>/dev/null | grep '.service'");
  const services = svcRaw.split('\n').filter(Boolean).map(l => {
    const p = l.split(/\s+/);
    return { name: p[0].replace('.service', ''), status: p[2], state: p[3], desc: p.slice(4).join(' ') };
  });
  const portsRaw = exec("ss -tlnp 2>/dev/null | tail -n +2");
  const ports = portsRaw.split('\n').filter(Boolean).map(line => {
    const p = line.split(/\s+/); const addr = p[4] || p[3] || '';
    const pm = addr.match(/:(\d+)$/); const proc = (p[p.length - 1] || '').match(/"([^"]+)"/);
    return { address: addr, port: pm ? parseInt(pm[1]) : 0, process: proc ? proc[1] : 'unknown' };
  });
  const days = Math.floor(uptimeSec / 86400), hours = Math.floor((uptimeSec % 86400) / 3600), mins = Math.floor((uptimeSec % 60) / 60);
  return {
    timestamp: Date.now(), hostname: exec('hostname'), kernel: exec('uname -r'),
    uptime: `${days}d ${hours}h ${mins}m`, uptimeSec, load: loadAvg.map(Number),
    cpu: { usage: parseFloat((100 - cpuIdle).toFixed(1)), cores: cpuCount },
    ram: { total: memTotal, used: memUsed, avail: memAvail, pct: ((memUsed / memTotal) * 100).toFixed(1) },
    swap: { total: swapTotal, used: swapUsed, free: swapFree, pct: swapTotal > 0 ? ((swapUsed / swapTotal) * 100).toFixed(1) : '0' },
    disk: { total: diskTotal, used: diskUsed, avail: diskTotal - diskUsed, pct: ((diskUsed / diskTotal) * 100).toFixed(1) },
    network: interfaces, processes, services, serviceCount: services.filter(s => s.state === 'running').length,
    ports, swappiness: parseInt(exec('cat /proc/sys/vm/swappiness'))
  };
}

// ── API Handlers ──
async function handleAPI(req, res, url) {
  const p = url.pathname;

  if (p === '/api/metrics') return json(res, getMetrics());

  // Service Manager
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

  // Logs
  if (p.match(/^\/api\/logs\/([^/]+)/)) {
    const name = p.match(/^\/api\/logs\/([^/]+)/)[1].replace(/[^a-zA-Z0-9_.-]/g, '');
    const lines = exec(`journalctl -u ${name} --no-pager -n 100 --output=short-precise 2>&1`);
    return json(res, { service: name, lines: lines.split('\n') });
  }

  // Process Kill
  if (p.match(/^\/api\/kill\/(\d+)$/)) {
    const pid = parseInt(p.match(/^\/api\/kill\/(\d+)$/)[1]);
    if (pid < 2) return json(res, { ok: false, error: 'Cannot kill PID < 2' }, 400);
    const out = exec(`sudo kill -9 ${pid} 2>&1`);
    return json(res, { ok: true, pid, output: out || 'killed' });
  }

  // Firewall
  if (p === '/api/firewall') {
    const out = exec('sudo ufw status numbered 2>&1');
    return json(res, { rules: out });
  }

  if (p === '/api/firewall/add') {
    const body = await parseBody(req);
    if (!body.port || !body.proto) return json(res, { ok: false, error: 'port and proto required' }, 400);
    const port = parseInt(body.port);
    const proto = body.proto === 'udp' ? 'udp' : 'tcp';
    const comment = (body.comment || '').replace(/[^a-zA-Z0-9 _-]/g, '');
    const cmd = comment ? `sudo ufw allow ${port}/${proto} comment "${comment}"` : `sudo ufw allow ${port}/${proto}`;
    const out = exec(cmd + ' 2>&1');
    return json(res, { ok: true, output: out });
  }

  if (p === '/api/firewall/remove') {
    const body = await parseBody(req);
    if (!body.rule) return json(res, { ok: false, error: 'rule number required' }, 400);
    const num = parseInt(body.rule);
    const out = exec(`echo y | sudo ufw delete ${num} 2>&1`);
    return json(res, { ok: true, output: out });
  }

  // Cron
  if (p === '/api/cron') {
    const root = exec('sudo crontab -l 2>/dev/null') || '';
    const user = exec('crontab -l 2>/dev/null') || '';
    return json(res, { root: root.split('\n').filter(Boolean), user: user.split('\n').filter(Boolean) });
  }

  // Disk Analyzer
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

  // Quick Actions
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

  // Speed Test (simple)
  if (p === '/api/speedtest') {
    const dl = await execAsync('curl -so /dev/null -w "%{speed_download}" https://speed.cloudflare.com/__down?bytes=10000000 2>/dev/null');
    const speed = (parseFloat(dl) / 125000).toFixed(2); // bytes to Mbps
    return json(res, { download: speed + ' Mbps', raw: dl });
  }

  // Alerts config
  if (p === '/api/alerts') {
    return json(res, { cpu: 85, ram: 85, disk: 90 });
  }

  res.writeHead(404); res.end('Not found');
}

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    try { await handleAPI(req, res, url); }
    catch (e) { json(res, { ok: false, error: e.message }, 500); }
    return;
  }

  if (url.pathname === '/manifest.json') {
    const jsonStr = fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(jsonStr);
  }

  if (url.pathname === '/sw.js') {
    const jsStr = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(jsStr);
  }

  if (url.pathname === '/icon.svg') {
    const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(svg);
  }

  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch { res.writeHead(500); res.end('Not found'); }
});

// ── WebSocket ──
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Basic Auth for WebSocket (via URL parameter ?auth=...)
  const authParam = url.searchParams.get('auth');
  const expectedAuth = Buffer.from('blindbox:ForMeTwentyThree').toString('base64');
  if (authParam !== expectedAuth) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  // Terminal WebSocket
  if (url.pathname === '/ws/terminal') {
    const shell = process.env.SHELL || '/bin/bash';
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color', cols: 80, rows: 24,
      cwd: process.env.HOME || '/root',
      env: { ...process.env, TERM: 'xterm-256color' }
    });
    proc.onData(data => { try { ws.send(JSON.stringify({ type: 'output', data })); } catch {} });
    proc.onExit(({ exitCode }) => { try { ws.send(JSON.stringify({ type: 'exit', exitCode })); ws.close(); } catch {} });
    ws.on('message', (msg) => {
      try { const { type, data, cols, rows } = JSON.parse(msg); if (type === 'input') proc.write(data); else if (type === 'resize') proc.resize(cols, rows); } catch {}
    });
    ws.on('close', () => proc.kill());
  }

  // Log streaming WebSocket
  if (url.pathname.startsWith('/ws/logs/')) {
    const service = url.pathname.split('/').pop().replace(/[^a-zA-Z0-9_.-]/g, '');
    const proc = spawn('journalctl', ['-u', service, '-f', '--no-pager', '--output=short-precise'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', data => { try { ws.send(JSON.stringify({ type: 'log', data: data.toString() })); } catch {} });
    proc.stderr.on('data', data => { try { ws.send(JSON.stringify({ type: 'log', data: data.toString() })); } catch {} });
    ws.on('close', () => proc.kill());
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚢 HELM Command Center on http://0.0.0.0:${PORT}`);
});
