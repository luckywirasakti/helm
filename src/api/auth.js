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

  // GET /api/auth/check — lightweight auth validation (no console noise)
  if (p === '/api/auth/check' && req.method === 'GET') {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return json(res, { ok: false }, 401);
    }
    // Check Basic Auth inline (no circular dep)
    if (authHeader.startsWith('Basic ')) {
      const expected = 'Basic ' + Buffer.from(`${process.env.HELM_USER || 'admin'}:${process.env.HELM_PASS || 'password'}`).toString('base64');
      const valid = authHeader === expected;
      return json(res, { ok: valid }, valid ? 200 : 401);
    }
    // Check Bearer token
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const data = checkAppToken(token);
      return json(res, { ok: !!data }, data ? 200 : 401);
    }
    return json(res, { ok: false }, 401);
  }

  // GET /api/auth/tg/status — Check if Telegram auth is configured (public, no auth needed)
  if (p === '/api/auth/tg/status' && req.method === 'GET') {
    return json(res, { enabled: ENABLED, botUsername: BOT_USERNAME });
  }

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
        botUsername: BOT_USERNAME,
        expiresAt: session.expiresAt,
      });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    }
  }

  // POST /api/auth/tg/callback — Telegram bot webhook
  if (p === '/api/auth/tg/callback' && req.method === 'POST') {
    if (!ENABLED) return json(res, { ok: false, error: 'Telegram auth not configured' }, 503);

    try {
      const body = await parseBody(req);
      const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}`;

      // ── User sent /start <sessionId> ────────────────────────────
      if (body.message && body.message.text && body.message.text.startsWith('/start')) {
        const parts = body.message.text.split(/\s+/);
        const sessionId = parts[1] && parts[1].trim();
        const chatId = body.message.chat.id;

        if (!sessionId) {
          // No session ID — send welcome message
          await fetch(`${apiUrl}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: '👋 Welcome! Scan a QR code from the HELM dashboard to sign in.',
            }),
          });
          return json(res, { ok: true });
        }

        // Check if session exists and is still pending
        const session = await telebun.checkSession(sessionId);
        if (!session || session.status !== 'pending') {
          await fetch(`${apiUrl}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: '⏰ This QR code has expired or is invalid. Please generate a new one from the dashboard.',
            }),
          });
          return json(res, { ok: true });
        }

        // Send confirmation button
        await fetch(`${apiUrl}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '🔐 **Confirm Login**\n\nTap the button below to sign in to HELM:',
            parse_mode: 'Markdown',
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                { text: '✅ Confirm Login', callback_data: `confirm:${sessionId}` }
              ]],
            }),
          }),
        });
        return json(res, { ok: true });
      }

      // ── User tapped inline button ───────────────────────────────
      if (body.callback_query) {
        const cb = body.callback_query;
        const chatId = cb.message.chat.id;
        const msgId = cb.message.message_id;
        const data = cb.data || '';
        const from = cb.from || {};

        if (!data.startsWith('confirm:')) {
          // Unknown callback
          await fetch(`${apiUrl}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              callback_query_id: cb.id,
              text: 'Unrecognized action',
            }),
          });
          return json(res, { ok: true });
        }

        const sessionId = data.split(':', 2)[1];
        const authenticatedAt = new Date().toISOString();

        // Build signed callback payload (matching Telebun's format)
        const signable = [sessionId, String(from.id), authenticatedAt].join('|');
        const signature = crypto.createHmac('sha256', BOT_TOKEN).update(signable, 'utf8').digest('hex');

        const signedPayload = {
          sessionId,
          user: {
            id: from.id,
            is_bot: from.is_bot || false,
            first_name: from.first_name || '',
            last_name: from.last_name || '',
            username: from.username || '',
            language_code: from.language_code || '',
          },
          authenticatedAt,
          signature,
        };

        await telebun.handleCallback(signedPayload);

        // Edit message to show success
        await fetch(`${apiUrl}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: '✅ **Login confirmed!**\n\nYou can close this chat and return to the dashboard.',
            parse_mode: 'Markdown',
            reply_markup: JSON.stringify({ inline_keyboard: [] }),
          }),
        });

        // Answer callback query
        await fetch(`${apiUrl}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: cb.id,
            text: '✅ Login successful!',
          }),
        });

        return json(res, { ok: true });
      }

      // Unknown update type — acknowledge
      return json(res, { ok: true });
    } catch (err) {
      console.error('Telegram callback error:', err);
      return json(res, { ok: true }); // Always 200 to Telegram
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
