const { execSync, exec: execCb, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function exec(cmd) {
  try { return execSync(cmd, { timeout: 10000, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

async function handleApi(req, res, url, src) {
  const p = url.pathname;
  if (p === '/api/metrics') return json(res, getMetrics());
  // ... (rest of the API logic extracted from server.js)
  res.writeHead(404); res.end('Not found');
}

async function handleStatic(req, res, url, publicPath) {
  let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const ext = path.extname(file);
  const mime = { '.html': 'text/html', '.json': 'application/json', '.js': 'application/javascript', '.svg': 'image/svg+xml' };
  
  const fullPath = path.join(publicPath, file);
  if (fs.existsSync(fullPath)) {
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    return res.end(fs.readFileSync(fullPath));
  }
  res.writeHead(404); res.end('Not found');
}

function getMetrics() {
  // ... (extraction of the metrics logic)
  return { ok: true }; // Placeholder
}

module.exports = { handleApi, handleStatic };
