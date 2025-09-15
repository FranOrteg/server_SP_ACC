// clients/apsClient.js
const axios = require('axios');
const qs = require('querystring');

const {
  APS_CLIENT_ID,
  APS_CLIENT_SECRET,
  APS_CALLBACK_URL
} = process.env;

const APS_AUTH_BASE = 'https://developer.api.autodesk.com/authentication/v2';
const APS_API_BASE  = 'https://developer.api.autodesk.com';

// ⚠️ DEMO: tokens en memoria (una sesión). Para producción, persiste por usuario.
let TOKENS = null;

function defaultScopes() {
  // Quitamos account:read para evitar invalid_scope si la app no está provisionada en ACC.
  return [
    'data:read',
    'data:write',
    'data:create',
    'viewables:read',
    'openid',
    'offline_access',
  ];
}

function isAbs(u) { return /^https?:\/\//i.test(u); }

function getAuthUrl(scopes, prompt) {
  const wanted = Array.isArray(scopes) && scopes.length ? scopes : defaultScopes();

  const allowed = new Set([
    'openid', 'offline_access',
    'data:read', 'data:write', 'data:create',
    'account:read', // permitido si tu cuenta está provisionada; no lo metemos por defecto
    'viewables:read'
  ]);
  const clean = [...new Set(wanted.filter(s => allowed.has(s)))];

  const scopeStr = encodeURIComponent(clean.join(' '));
  const base = `${APS_AUTH_BASE}/authorize`;
  const client = encodeURIComponent(APS_CLIENT_ID);
  const redirect = encodeURIComponent(APS_CALLBACK_URL);
  const state = encodeURIComponent(
    Buffer.from(JSON.stringify({ ts: Date.now() })).toString('base64')
  );

  // prompt opcional: consent (re-consent), login, none
  const allowedPrompts = new Set(['consent', 'login', 'none']);
  const promptPart = allowedPrompts.has(prompt) ? `&prompt=${prompt}` : '';

  return `${base}?response_type=code&client_id=${client}` +
         `&redirect_uri=${redirect}&scope=${scopeStr}${promptPart}&state=${state}`;
}

function stampExpiry(tokenResponse) {
  const now = Math.floor(Date.now() / 1000);
  return { ...tokenResponse, expires_at: now + (tokenResponse.expires_in || 0) };
}

async function exchangeCodeForTokens(code) {
  const body = qs.stringify({
    grant_type: 'authorization_code',
    code,
    client_id: APS_CLIENT_ID,
    client_secret: APS_CLIENT_SECRET,
    redirect_uri: APS_CALLBACK_URL
  });
  const { data } = await axios.post(`${APS_AUTH_BASE}/token`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  TOKENS = stampExpiry(data);
  return TOKENS;
}

async function refreshIfNeeded() {
  if (!TOKENS) throw new Error('Not authenticated with APS');
  const now = Math.floor(Date.now() / 1000);
  if (TOKENS.expires_at && TOKENS.expires_at - now > 60) return TOKENS;

  const body = qs.stringify({
    grant_type: 'refresh_token',
    refresh_token: TOKENS.refresh_token,
    client_id: APS_CLIENT_ID,
    client_secret: APS_CLIENT_SECRET,
  });
  const { data } = await axios.post(`${APS_AUTH_BASE}/token`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  TOKENS = stampExpiry({ ...TOKENS, ...data });
  return TOKENS;
}

function getAccessToken() {
  return TOKENS?.access_token || null;
}

async function ensureAccessToken() {
  await refreshIfNeeded();
  return TOKENS?.access_token || null;
}

function getTokenInfo() {
  if (!TOKENS) return null;
  // scope llega como string con espacios
  const scopes = typeof TOKENS.scope === 'string' ? TOKENS.scope.split(' ') : [];
  return {
    scopes,
    expires_at: TOKENS.expires_at,
    token_type: TOKENS.token_type || 'Bearer'
  };
}

async function apiGet(path, opts = {}) {
  const { access_token } = await refreshIfNeeded();
  const url = isAbs(path) ? path : `${APS_API_BASE}${path}`;
  const { data } = await axios.get(url, {
    ...opts,
    headers: { Authorization: `Bearer ${access_token}`, ...(opts.headers || {}) }
  });
  return data;
}

async function apiPost(path, body, opts = {}) {
  const { access_token } = await refreshIfNeeded();
  const url = isAbs(path) ? path : `${APS_API_BASE}${path}`;
  const { data } = await axios.post(url, body, {
    ...opts,
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return data;
}

async function apiPut(path, bodyOrBuffer, opts = {}) {
  const { access_token } = await refreshIfNeeded();
  const url = isAbs(path) ? path : `${APS_API_BASE}${path}`;
  const headers = { Authorization: `Bearer ${access_token}`, ...(opts.headers || {}) };
  const { data } = await axios.put(url, bodyOrBuffer, { ...opts, headers });
  return data;
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  refreshIfNeeded,
  getAccessToken,
  ensureAccessToken,
  getTokenInfo,
  apiGet,
  apiPost,
  apiPut
};
