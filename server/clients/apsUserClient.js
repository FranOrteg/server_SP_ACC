// clients/apsUserClient.js
const axios = require('axios');
const qs = require('querystring');

const APS_BASE = 'https://developer.api.autodesk.com';
const AUTH_BASE = `${APS_BASE}/authentication/v2`;

// Sencillo almacén en memoria (cámbialo a DB en producción)
let userToken = null; // { access_token, refresh_token, expires_at }

function isValid(tok) {
  return tok && tok.access_token && Date.now() < (tok.expires_at - 30_000);
}

function peekToken(){ return userToken; }

async function exchangeCodeForToken(code) {
  const { APS_CLIENT_ID_3LO, APS_CLIENT_SECRET_3LO, APS_CALLBACK_URL } = process.env;
  const data = {
    grant_type: 'authorization_code',
    client_id: APS_CLIENT_ID_3LO,
    client_secret: APS_CLIENT_SECRET_3LO,
    code,
    redirect_uri: APS_CALLBACK_URL
  };
  const { data: tok } = await axios.post(`${AUTH_BASE}/token`, qs.stringify(data), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  userToken = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in * 1000)
  };
  return userToken;
}

async function refreshIfNeeded() {
  if (isValid(userToken)) return userToken.access_token;
  if (!userToken?.refresh_token) throw new Error('No hay token de usuario; inicia sesión 3LO');
  const { APS_CLIENT_ID_3LO, APS_CLIENT_SECRET_3LO } = process.env;
  const data = {
    grant_type: 'refresh_token',
    client_id: APS_CLIENT_ID_3LO,
    client_secret: APS_CLIENT_SECRET_3LO,
    refresh_token: userToken.refresh_token
  };
  const { data: tok } = await axios.post(`${AUTH_BASE}/token`, qs.stringify(data), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  userToken = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || userToken.refresh_token,
    expires_at: Date.now() + (tok.expires_in * 1000)
  };
  return userToken.access_token;
}

async function apiGet(url, config = {}) {
  const access = await refreshIfNeeded();
  const path = url.startsWith('http') ? url : `${APS_BASE}${url}`;
  const started = Date.now();
  try {
    const { data, status, headers } = await axios.get(path, {
      timeout: 5000,
      ...config,
      headers: { ...(config.headers || {}), Authorization: `Bearer ${access}` }
    });
    console.log(`[APS GET ${url}] ${status} in ${Date.now()-started}ms`);
    return data;
  } catch (err) {
    const status = err?.response?.status;
    const payload = err?.response?.data;
    console.error(`[APS GET ${url}] ERROR ${status} in ${Date.now()-started}ms ->`, payload || err.message);
    throw err;
  }
}

async function apiPost(url, body, config = {}) {
  const access = await refreshIfNeeded();
  const path = url.startsWith('http') ? url : `${APS_BASE}${url}`;
  const started = Date.now();
  try {
    const { data, status } = await axios.post(path, body, {
      timeout: 10000,
      ...config,
      headers: { 'Content-Type': 'application/json', ...(config.headers || {}), Authorization: `Bearer ${access}` }
    });
    console.log(`[APS POST ${url}] ${status} in ${Date.now()-started}ms`);
    return data;
  } catch (err) {
    const status = err?.response?.status;
    const payload = err?.response?.data;
    console.error(`[APS POST ${url}] ERROR ${status} in ${Date.now()-started}ms ->`, payload || err.message);
    throw err;
  }
}

// Helpers para router OAuth
function hasUserToken() { return !!userToken?.access_token; }
function clearUserToken() { userToken = null; }

module.exports = { exchangeCodeForToken, apiGet, apiPost, hasUserToken, clearUserToken, peekToken };
