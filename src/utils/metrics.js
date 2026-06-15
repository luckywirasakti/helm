const { execSync } = require('child_process');
const fs = require('fs');

/* ── Shell Helpers ── */
function exec(cmd) {
  try { return execSync(cmd, { timeout: 10000, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

/* ── System Metrics ── */
function getMetrics() {
  const uptimeRaw = exec('cat /proc/uptime');
  const uptimeSec = parseFloat(uptimeRaw.split(' ')[0]) || 0;
  const loadAvg = exec('cat /proc/loadavg').split(' ').slice(0, 3).map(Number);
  const cpuCount = parseInt(exec('nproc') || '1', 10);
  const cpuLine = exec("top -bn1 | grep '%Cpu' | head -1");
  const cpuIdle = parseFloat((cpuLine.match(/([\d.]+)\s*id/) || [])[1] || 0);
  const memInfo = fs.readFileSync('/proc/meminfo', 'utf8');
  const g = k => parseInt((memInfo.match(new RegExp(k + ':\\s+(\\d+)')) || [])[1] || 0, 10);
  const memTotal = g('MemTotal'), memAvail = g('MemAvailable'), memUsed = memTotal - memAvail;
  const swapTotal = g('SwapTotal'), swapFree = g('SwapFree'), swapUsed = swapTotal - swapFree;
  const dp = exec("df -B1 / | tail -1").split(/\s+/);
  const diskTotal = parseInt(dp[1] || '0', 10), diskUsed = parseInt(dp[2] || '0', 10);

  const netRaw = exec("cat /proc/net/dev | tail -n +3");
  const interfaces = {};
  netRaw.split('\n').forEach(line => {
    const p = line.trim().split(/\s+/);
    if (p.length > 9) {
      const n = p[0].replace(':', '');
      if (n !== 'lo') interfaces[n] = { rx: parseInt(p[1], 10), tx: parseInt(p[9], 10) };
    }
  });

  const psRaw = exec("ps aux --sort=-%mem | head -16 | tail -15");
  const processes = psRaw.split('\n').filter(Boolean).map(line => {
    const p = line.split(/\s+/);
    return {
      user: p[0], pid: parseInt(p[1], 10), cpu: p[2], mem: p[3],
      rss: Math.round(parseInt(p[5] || '0', 10) / 1024),
      command: p.slice(10).join(' ').split('/').pop().substring(0, 60),
    };
  });

  const svcRaw = exec("systemctl list-units --type=service --all --no-pager --plain 2>/dev/null | grep '.service'");
  const services = svcRaw.split('\n').filter(Boolean).map(l => {
    const p = l.split(/\s+/);
    return { name: p[0].replace('.service', ''), status: p[2], state: p[3], desc: p.slice(4).join(' ') };
  });

  const portsRaw = exec("ss -tlnp 2>/dev/null | tail -n +2");
  const ports = portsRaw.split('\n').filter(Boolean).map(line => {
    const p = line.split(/\s+/);
    const addr = p[4] || p[3] || '';
    const pm = addr.match(/:(\d+)$/);
    const proc = (p[p.length - 1] || '').match(/"([^"]+)"/);
    return { address: addr, port: pm ? parseInt(pm[1], 10) : 0, process: proc ? proc[1] : 'unknown' };
  });

  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  const swappiness = parseInt(exec('cat /proc/sys/vm/swappiness'), 10);

  return {
    timestamp: Date.now(),
    hostname: exec('hostname'),
    kernel: exec('uname -r'),
    uptime: `${days}d ${hours}h ${mins}m`,
    uptimeSec,
    load: loadAvg,
    cpu: { usage: parseFloat((100 - cpuIdle).toFixed(1)), cores: cpuCount },
    ram: { total: memTotal, used: memUsed, avail: memAvail, pct: ((memUsed / memTotal) * 100).toFixed(1) },
    swap: { total: swapTotal, used: swapUsed, free: swapFree, pct: swapTotal > 0 ? ((swapUsed / swapTotal) * 100).toFixed(1) : '0' },
    disk: { total: diskTotal, used: diskUsed, avail: diskTotal - diskUsed, pct: ((diskUsed / diskTotal) * 100).toFixed(1) },
    network: interfaces,
    processes,
    services,
    serviceCount: services.filter(s => s.state === 'running').length,
    ports,
    swappiness,
  };
}

module.exports = { getMetrics, exec };
