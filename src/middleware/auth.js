const fs = require('fs');
const path = require('path');
const { checkAppToken } = require('../api/auth');

const AUTH_USER = process.env.HELM_USER || 'admin';
const AUTH_PASS = process.env.HELM_PASS || 'password';

function checkBasicAuth(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return false;
  const expected = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
  return authHeader === expected;
}

function checkBearerAuth(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  const data = checkAppToken(token);
  return !!data;
}

function checkAuth(req) {
  return checkBasicAuth(req) || checkBearerAuth(req);
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
  if (!authParam) return false;

  // Check Basic Auth via URL param (existing behavior for WebSocket)
  const expectedBasic = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
  if (authParam === expectedBasic) return true;

  // Check Bearer token via ?auth=token (for WebSocket)
  const tokenData = checkAppToken(authParam);
  return !!tokenData;
}

module.exports = { requireAuth, checkAuthFromURL, checkBasicAuth, checkBearerAuth };
