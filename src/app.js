require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const { createWSS } = require('./ws/handler');
const router = require('./api/router');
const { handleAuth } = require('./api/auth');
const { requireAuth, checkAuthFromURL } = require('./middleware/auth');
const logger = require('./middleware/logger');

const PORT = parseInt(process.env.HELM_PORT, 10) || 20131;

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const start = Date.now();

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // ── Telegram Auth routes (no auth required) ──
  const authHandled = await handleAuth(req, res, url);
  if (authHandled) {
    logger(req.method, url.pathname, res.statusCode, Date.now() - start);
    return;
  }

  // ── Main router (with auth guard) ──
  router(req, res, url, (err) => {
    const ms = Date.now() - start;
    logger(req.method, url.pathname, res.statusCode, ms);
    if (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
});

// ── WebSocket ──
const wss = createWSS(server);
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!checkAuthFromURL(url)) return ws.close(4001, 'Unauthorized');
  require('./ws/handler')(ws, url);
});

server.listen(PORT, () => {
  console.log(`  🚢  HELM — http://0.0.0.0:${PORT}`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
