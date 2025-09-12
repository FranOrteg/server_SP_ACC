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

// ⚠️ demo: tokens en memoria (una sola sesión). Luego lo cambiamos a store por usuario.
let TOKENS = null;

// clients/apsClient.js
function defaultScopes() {
  return [
    'data:read',
    'data:write',
    'data:create',
    'account:read',
    'viewables:read',
    'openid',
    'offline_access',
  ];
}

function getAuthUrl(scopes) {
  const wanted = Array.isArray(scopes) && scopes.length ? scopes : defaultScopes();

  // Construimos el 'scope' manualmente:
  // - dejamos los ':' tal cual
  // - convertimos los espacios a %20
  const scopeStr = wanted.join(' ').replace(/ /g, '%20');

  // OJO: no usamos URLSearchParams para 'scope' para evitar %3A
  const base = `${APS_AUTH_BASE}/authorize`;
  const client = encodeURIComponent(APS_CLIENT_ID);
  const redirect = encodeURIComponent(APS_CALLBACK_URL);

  // response_type/client_id/redirect_uri pueden ir codificados normal
  // scope lo insertamos tal cual con los ':' sin codificar
  return `${base}?response_type=code&client_id=${client}&redirect_uri=${redirect}&scope=${scopeStr}`;
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

function stampExpiry(tokenResponse) {
  // añade campo expires_at (epoch seconds)
  const now = Math.floor(Date.now() / 1000);
  return { ...tokenResponse, expires_at: now + (tokenResponse.expires_in || 0) };
}

async function apiGet(path, opts = {}) {
  const { access_token } = await refreshIfNeeded();
  const { data } = await axios.get(`${APS_API_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${access_token}`, ...(opts.headers || {}) }
  });
  return data;
}

async function apiPost(path, body, opts = {}) {
  const { access_token } = await refreshIfNeeded();
  const { data } = await axios.post(`${APS_API_BASE}${path}`, body, {
    ...opts,
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return data;
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  apiGet,
  apiPost
};
