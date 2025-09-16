// clients/apsClient.js
const axios = require('axios');
const qs = require('querystring');

const APS_BASE = 'https://developer.api.autodesk.com';
const AUTH_BASE = `${APS_BASE}/authentication/v2`;

// Cache muy simple en memoria
let tokenState = {
  access_token: null,
  refresh_token: null,
  expires_at: 0,
  scope: []
};

// --- helpers de scopes ---
function ensureArrayScopes(scopesParam) {
  if (!scopesParam) return ['data:read'];
  if (Array.isArray(scopesParam)) return scopesParam;
  return String(scopesParam).trim().split(/[,\s]+/).filter(Boolean);
}

// solo lo que APS Data Management acepta en 3LO
const ALLOWED_SCOPES = new Set([
  'data:read', 'data:write', 'data:create',
  'viewables:read',
  'account:read',
  'offline_access'
]);
function sanitizeScopes(list) {
  return ensureArrayScopes(list).filter(s => ALLOWED_SCOPES.has(s));
}

// --- auth urls ---
/**
 * Devuelve la URL de autorización 3LO.
 * @param {string[]|string} scopes p.ej ['data:read','data:write','data:create','offline_access']
 * @param {string} prompt 'login' | 'none' | 'create'
 */
function buildAuthUrl(scopes = [], prompt = 'login') {
  const { APS_CLIENT_ID, APS_CALLBACK_URL } = process.env;
  if (!APS_CLIENT_ID || !APS_CALLBACK_URL)
    throw new Error('Faltan APS_CLIENT_ID o APS_CALLBACK_URL en .env');

  const scopeList = sanitizeScopes(scopes);
  if (!scopeList.length) scopeList.push('data:read'); // mínimo

  const allowedPrompts = new Set(['login', 'none', 'create']);
  const promptSafe = allowedPrompts.has(String(prompt)) ? String(prompt) : 'login';

  const params = {
    response_type: 'code',
    client_id: APS_CLIENT_ID,
    redirect_uri: APS_CALLBACK_URL,
    scope: scopeList.join(' '),
    prompt: promptSafe
  };
  return `${AUTH_BASE}/authorize?${qs.stringify(params)}`;
}

async function exchangeCodeForToken(code) {
  const { APS_CLIENT_ID, APS_CLIENT_SECRET, APS_CALLBACK_URL } = process.env;
  const url = `${AUTH_BASE}/token`;
  const data = {
    grant_type: 'authorization_code',
    code,
    client_id: APS_CLIENT_ID,
    client_secret: APS_CLIENT_SECRET,
    redirect_uri: APS_CALLBACK_URL
  };
  const { data: tok } = await axios.post(url, qs.stringify(data), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  setToken(tok);
  return tok;
}

async function refreshTokenIfNeeded() {
  const now = Date.now();
  if (tokenState.access_token && now < tokenState.expires_at - 30_000) {
    return tokenState.access_token;
  }
  if (!tokenState.refresh_token) {
    throw new Error('No hay refresh_token. Inicia sesión con /api/acc/auth/login.');
  }
  const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
  const url = `${AUTH_BASE}/token`;
  const data = {
    grant_type: 'refresh_token',
    refresh_token: tokenState.refresh_token,
    client_id: APS_CLIENT_ID,
    client_secret: APS_CLIENT_SECRET
  };
  const { data: tok } = await axios.post(url, qs.stringify(data), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  setToken(tok);
  return tokenState.access_token;
}

function setToken(tok) {
  tokenState.access_token = tok.access_token || null;
  tokenState.refresh_token = tok.refresh_token || tokenState.refresh_token || null;
  tokenState.scope = typeof tok.scope === 'string' ? tok.scope.split(' ') : (tok.scope || []);
  tokenState.expires_at = Date.now() + ((tok.expires_in || 0) * 1000); // s → ms
}

function clearToken() {
  tokenState = { access_token: null, refresh_token: null, expires_at: 0, scope: [] };
}

async function getAccessToken() {
  return await refreshTokenIfNeeded();
}

// --- util: decodificar JWT (sin verificar, solo lectura) ---
function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (e) { return null; }
}

// ---- API helpers 3LO ----
async function apiGet(url, config = {}) {
  const access = await getAccessToken();
  const full = url.startsWith('http') ? url : `${APS_BASE}${url}`;
  const { data, status } = await axios.get(full, {
    ...config,
    headers: { ...(config.headers || {}), Authorization: `Bearer ${access}` }
  });
  if (status < 200 || status >= 300) throw new Error(`GET ${url} => ${status}`);
  return data;
}

async function apiPost(url, body, config = {}) {
  const access = await getAccessToken();
  const full = url.startsWith('http') ? url : `${APS_BASE}${url}`;
  const { data, status } = await axios.post(full, body, {
    ...config,
    headers: { 'Content-Type': 'application/json', ...(config.headers || {}), Authorization: `Bearer ${access}` }
  });
  if (status < 200 || status >= 300) throw new Error(`POST ${url} => ${status}`);
  return data;
}

async function apiPut(url, body, config = {}) {
  const access = await getAccessToken();
  const full = url.startsWith('http') ? url : `${APS_BASE}${url}`;
  const { data, status } = await axios.put(full, body, {
    ...config,
    headers: { ...(config.headers || {}), Authorization: `Bearer ${access}` }
  });
  if (status < 200 || status >= 300) throw new Error(`PUT ${url} => ${status}`);
  return data;
}

module.exports = {
  buildAuthUrl,
  exchangeCodeForToken,
  setToken,
  clearToken,
  getAccessToken,
  apiGet,
  apiPost,
  apiPut,
  // extras
  sanitizeScopes,
  ensureArrayScopes,
  decodeJwt
};
