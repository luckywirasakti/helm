const { Telebun, MemoryStore } = require('@luckywirasakti/telebun');
const crypto = require('crypto');

// ─── Config ────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
const CALLBACK_BASE = process.env.TELEGRAM_CALLBACK_URL || '';

// ─── App session tokens (short-lived, for QR auth) ──────────────────────
const appTokens = new Map(); // token -> { expiresAt, user }

// Cleanup stale tokens every 30s (lightweight)
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of appTokens) {
    if (data.expiresAt < now) appTokens.delete(token);
  }
}, 30000).unref();

/**
 * Generate a short-lived app session token after Telegram QR auth succeeds.
 * @param {object} user - Telegram user info { id, first_name, username }
 * @returns {string} session token
 */
function generateAppToken(user) {
  const token = crypto.randomBytes(24).toString('base64url');
  appTokens.set(token, {
    expiresAt: Date.now() + 3_600_000, // 1 hour
    user,
    createdAt: Date.now(),
  });
  return token;
}

/**
 * Validate an app session token.
 * @returns {object|null} token data or null if invalid/expired
 */
function checkAppToken(token) {
  const data = appTokens.get(token);
  if (!data) return null;
  if (data.expiresAt < Date.now()) {
    appTokens.delete(token);
    return null;
  }
  return data;
}

// ─── Telebun instance ──────────────────────────────────────────────────────
let telebun = null;
const ENABLED = !!(BOT_TOKEN && BOT_USERNAME && CALLBACK_BASE);

if (ENABLED) {
  telebun = new Telebun({
    botToken: BOT_TOKEN,
    botUsername: BOT_USERNAME,
    callbackBaseUrl: CALLBACK_BASE,
    sessionStore: new MemoryStore(),
    sessionTTL: 300_000, // 5 min
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function json(res, data, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
  return true;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

// ─── Route handler ─────────────────────────────────────────────────────────
async function handleAuth(req, res, url) {
  const p = url.pathname;

  // POST /api/auth/tg/qr — Generate QR code for Telegram login
  if (p === '/api/auth/tg/qr' && req.method === 'POST') {
    if (!ENABLED) return json(res, { ok: false, error: 'Telegram auth not configured' }, 503);

    try {
      const session = await telebun.generate();
      return json(res, {
        ok: true,
        sessionId: session.sessionId,
        qrDataUrl: session.qrDataUrl,
        deepLink: session.deepLink,
        expiresAt: session.expiresAt,
      });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    }
  }

  // POST /api/auth/tg/callback — Telegram bot callback webhook
  if (p === '/api/auth/tg/callback' && req.method === 'POST') {
    if (!ENABLED) return json(res, { ok: false, error: 'Telegram auth not configured' }, 503);

    try {
      const body = await parseBody(req);
      const result = await telebun.handleCallback(body);
      if (result) {
        return json(res, { ok: true, session: result });
      }
      return json(res, { ok: false, error: 'Invalid callback' }, 400);
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    }
  }

  // GET /api/auth/tg/session/:id — Poll session status
  const sessionMatch = p.match(/^\/api\/auth\/tg\/session\/([a-zA-Z0-9_-]+)$/);
  if (sessionMatch && req.method === 'GET') {
    if (!ENABLED) return json(res, { ok: false, error: 'Telegram auth not configured' }, 503);

    try {
      const sessionId = sessionMatch[1];
      const session = await telebun.checkSession(sessionId);

      if (!session) {
        return json(res, { ok: false, error: 'Session not found or expired' }, 404);
      }

      if (session.status === 'verified') {
        // Generate app session token for the authenticated user
        const appToken = generateAppToken(session.user || {});
        return json(res, {
          ok: true,
          status: 'verified',
          user: session.user,
          token: appToken,
        });
      }

      return json(res, { ok: true, status: session.status || 'pending' });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    }
  }

  return false; // not handled
}

module.exports = { handleAuth, checkAppToken, ENABLED };
