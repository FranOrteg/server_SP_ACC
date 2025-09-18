// clients/apsClient.js
const axios = require('axios');
const qs = require('querystring');

const APS_BASE = 'https://developer.api.autodesk.com';
const AUTH_BASE = `${APS_BASE}/authentication/v2`;

// Cache simple en memoria para el token de aplicación (2LO)
let tokenState = {
  access_token: null,
  expires_at: 0, // epoch ms
  scope: []
};

function getConfiguredScopes() {
  // Para subir a ACC necesitas como mínimo data:read data:write data:create (+ account:read si listas proyectos)
  const raw = process.env.APS_2LO_SCOPES || 'data:read data:write data:create account:read';
  return raw.trim().split(/[,\s]+/).filter(Boolean);
}

function setToken(tok) {
  tokenState.access_token = tok.access_token || null;
  tokenState.scope = typeof tok.scope === 'string' ? tok.scope.split(' ') : (tok.scope || []);
  tokenState.expires_at = Date.now() + ((tok.expires_in || 0) * 1000); // s → ms
}

function clearToken() {
  tokenState = { access_token: null, expires_at: 0, scope: [] };
}

function isTokenValid() {
  return tokenState.access_token && Date.now() < (tokenState.expires_at - 30_000);
}

// === 2LO: client_credentials ===
async function getAppAccessToken() {
  if (isTokenValid()) return tokenState.access_token;

  const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
  if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    throw new Error('Faltan APS_CLIENT_ID o APS_CLIENT_SECRET en .env');
  }

  const scopes = getConfiguredScopes().join(' ');
  const url = `${AUTH_BASE}/token`;
  const data = {
    grant_type: 'client_credentials',
    client_id: APS_CLIENT_ID,
    client_secret: APS_CLIENT_SECRET,
    scope: scopes
  };

  const { data: tok } = await axios.post(url, qs.stringify(data), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000
  });
  setToken(tok);
  const payload = decodeJwt(tokenState.access_token) || {};
  // Autodesk suele devolver "scope" como string con espacios; también puedes ver "scp" en el JWT
  const scopesFromTok = typeof tok.scope === 'string' ? tok.scope.split(' ') : (tok.scope || []);
  const scopesFromJwt = Array.isArray(payload.scp) ? payload.scp : [];
  console.log('[APS 2LO] scopes(env):', getConfiguredScopes(), 'scopes(tok):', scopesFromTok, 'scopes(jwt):', scopesFromJwt, 'aud:', payload.aud, 'exp:', payload.exp);
  return tokenState.access_token;
}

// --- util: decodificar JWT (sin verificar, solo lectura) ---

function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (e) { return null; }
}

// ---- API helpers (2LO) ----

function logApsError(prefix, err) {
  try {
    const payload = err?.response?.data;
    if (payload) {
      console.error(`${prefix} APS error payload:`, JSON.stringify(payload, null, 2));
    } else {
      console.error(`${prefix} error:`, err?.message || err);
    }
  } catch (_) {}
}

async function apiGet(url, config = {}) {
  const access = await getAppAccessToken();
  const full = url.startsWith('http') ? url : `${APS_BASE}${url}`;
  try {
    const { data, status } = await axios.get(full, {
      ...config,
      headers: { ...(config.headers || {}), Authorization: `Bearer ${access}` }
    });
    if (status < 200 || status >= 300) throw new Error(`GET ${url} => ${status}`);
    return data;
  } catch (err) {
    logApsError(`GET ${url}`, err);
    throw err;
  }
}

async function apiPost(url, body, config = {}) {
  const access = await getAppAccessToken();
  const full = url.startsWith('http') ? url : `${APS_BASE}${url}`;
  try {
    const { data, status } = await axios.post(full, body, {
      ...config,
      headers: { 'Content-Type': 'application/json', ...(config.headers || {}), Authorization: `Bearer ${access}` }
    });
    if (status < 200 || status >= 300) throw new Error(`POST ${url} => ${status}`);
    return data;
  } catch (err) {
    logApsError(`POST ${url}`, err);
    throw err;
  }
}

async function apiPut(url, body, config = {}) {
  const access = await getAppAccessToken();
  const full = url.startsWith('http') ? url : `${APS_BASE}${url}`;
  try {
    const { data, status } = await axios.put(full, body, {
      ...config,
      headers: { ...(config.headers || {}), Authorization: `Bearer ${access}` }
    });
    if (status < 200 || status >= 300) throw new Error(`PUT ${url} => ${status}`);
    return data;
  } catch (err) {
    logApsError(`PUT ${url}`, err);
    throw err;
  }
}


module.exports = {
  // 2LO only
  getAppAccessToken,
  clearToken,
  decodeJwt,
  apiGet,
  apiPost,
  apiPut,
  getConfiguredScopes
};
