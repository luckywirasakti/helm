const fs = require('fs');
const path = require('path');

const AUTH_USER = process.env.HELM_USER || 'admin';
const AUTH_PASS = process.env.HELM_PASS || 'password';

function checkAuth(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return false;
  const expected = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
  return authHeader === expected;
}

function requireAuth(req, res) {
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function checkAuthFromURL(url) {
  const authParam = url.searchParams.get('auth');
  const expectedAuth = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
  return authParam === expectedAuth;
}

module.exports = { requireAuth, checkAuthFromURL };
