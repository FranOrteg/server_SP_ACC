// clients/apsClient.js
const axios = require('axios');
const qs = require('querystring');
const http  = require('http');
const https = require('https');

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

// --- util: decodificar JWT (sin verificar, solo lectura) ---
function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (e) { return null; }
}

// ===== Infra HTTP (keep-alive + reintentos) =====
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60_000
});
const httpAgent  = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60_000
});

const ax = axios.create({
  baseURL: APS_BASE,
  httpAgent,
  httpsAgent,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  timeout: 60_000
});

// Reintentos con backoff para errores transitorios (ECONNRESET, 50x, etc.)
async function withRetry(label, fn, { tries = 5, base = 400, factor = 1.8, quiet = false } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      // Si no quedan reintentos, vuelve a lanzar
      if (i === tries) throw err;

      const code   = err.code || err?.cause?.code;
      const status = err.response?.status;
      const networkError = !err.response;
      const retryableCodes  = new Set(['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNABORTED','ENOTFOUND','EPIPE']);
      const retryableStatus = new Set([408,425,429,500,502,503,504]);
      const shouldRetry = networkError || retryableCodes.has(code) || retryableStatus.has(status);

      if (!shouldRetry) throw err;

      if (!quiet) {
        console.warn(`[HTTP][retry] ${label} intento ${i}/${tries} -> ${status || code || 'no-response'} ${err.message}`);
      }
      const wait = Math.floor(base * Math.pow(factor, i - 1) + Math.random() * 100);
      await sleep(wait);
      last = err;
    }
  }
  throw last;
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
  const scopesFromTok = typeof tok.scope === 'string' ? tok.scope.split(' ') : (tok.scope || []);
  const scopesFromJwt = Array.isArray(payload.scp) ? payload.scp : [];
  console.log('[APS 2LO] scopes(env):', getConfiguredScopes(), 'scopes(tok):', scopesFromTok, 'scopes(jwt):', scopesFromJwt, 'aud:', payload.aud, 'exp:', payload.exp);
  return tokenState.access_token;
}

// ---- API helpers (2LO) ----
function logApsError(prefix, err, meta) {
  try {
    const payload = err?.response?.data;
    const status  = err?.response?.status;
    const concise = `${prefix} HTTP ${status || 'ERR'}: ${err?.message || 'error'}`;

    // En aprovisionamiento reducimos ruido (sin payload)
    if (meta?.provisioning) {
      console.debug(concise);
      return;
    }

    if (payload) {
      console.error(`${prefix} APS error payload:`, JSON.stringify(payload, null, 2));
    } else {
      console.error(`${prefix} error:`, err?.message || err);
    }
  } catch (_) {}
}

function maxRetriesDefault() {
  const n = Number(process.env.APS_HTTP_MAX_RETRIES || '5');
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

async function apiGet(url, config = {}) {
  const access = await getAppAccessToken();
  const path = url.startsWith('http') ? url.replace(APS_BASE, '') : url;

  const isProv = config?.meta?.provisioning === true;
  const tries  = isProv ? 1 : maxRetriesDefault(); // 👈 sin reintentos para provisioning
  const quiet  = isProv || !!config?.meta?.quiet;

  try {
    return await withRetry(`GET ${path}`, async () => {
      const { data, status } = await ax.get(path, {
        ...config,
        headers: { ...(config.headers || {}), Authorization: `Bearer ${access}` }
      });
      if (status < 200 || status >= 300) throw new Error(`GET ${path} => ${status}`);
      return data;
    }, { tries, quiet });
  } catch (err) {
    logApsError(`GET ${path}`, err, config?.meta);
    throw err;
  }
}

async function apiPost(url, body, config = {}) {
  const access = await getAppAccessToken();
  const path = url.startsWith('http') ? url.replace(APS_BASE, '') : url;

  const isProv = config?.meta?.provisioning === true;
  const tries  = isProv ? 1 : maxRetriesDefault();
  const quiet  = isProv || !!config?.meta?.quiet;

  const headers = {
    'Content-Type': 'application/json',
    ...(config.headers || {}),
    Authorization: `Bearer ${access}`
  };
  try {
    return await withRetry(`POST ${path}`, async () => {
      const { data, status } = await ax.post(path, body, { ...config, headers });
      if (status < 200 || status >= 300) throw new Error(`POST ${path} => ${status}`);
      return data;
    }, { tries, quiet });
  } catch (err) {
    logApsError(`POST ${path}`, err, config?.meta);
    throw err;
  }
}

async function apiPut(url, body, config = {}) {
  const access = await getAppAccessToken();
  const path = url.startsWith('http') ? url.replace(APS_BASE, '') : url;

  const isProv = config?.meta?.provisioning === true;
  const tries  = isProv ? 1 : maxRetriesDefault();
  const quiet  = isProv || !!config?.meta?.quiet;

  try {
    return await withRetry(`PUT ${path}`, async () => {
      const { data, status } = await ax.put(path, body, {
        ...config,
        headers: { ...(config.headers || {}), Authorization: `Bearer ${access}` }
      });
      if (status < 200 || status >= 300) throw new Error(`PUT ${path} => ${status}`);
      return data;
    }, { tries, quiet });
  } catch (err) {
    logApsError(`PUT ${path}`, err, config?.meta);
    throw err;
  }
}

async function apiPatch(url, body, config = {}) {
  const access = await getAppAccessToken();
  const path = url.startsWith('http') ? url.replace(APS_BASE, '') : url;

  const isProv = config?.meta?.provisioning === true;
  const tries  = isProv ? 1 : maxRetriesDefault();
  const quiet  = isProv || !!config?.meta?.quiet;

  const headers = {
    'Content-Type': 'application/json',
    ...(config.headers || {}),
    Authorization: `Bearer ${access}`
  };
  try {
    return await withRetry(`PATCH ${path}`, async () => {
      const { data, status } = await ax.patch(path, body, { ...config, headers });
      if (status < 200 || status >= 300) throw new Error(`PATCH ${path} => ${status}`);
      return data;
    }, { tries, quiet });
  } catch (err) {
    logApsError(`PATCH ${path}`, err, config?.meta);
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
  apiPatch,
  getConfiguredScopes,
  sleep
};
