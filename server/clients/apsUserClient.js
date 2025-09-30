// clients/apsUserClient.js
const axios = require('axios');
const qs = require('querystring');
const { mk } = require('../helpers/logger');

const log = mk('APS-USER');

const APS_BASE = 'https://developer.api.autodesk.com';
const AUTH_BASE = `${APS_BASE}/authentication/v2`;

// === Config mínima por entorno ===
// LOG se controla globalmente con LOG_LEVEL (helpers/logger).
// Aquí añadimos control fino del payload de error.
const HTTP_PAYLOAD_MODE = (process.env.APS_HTTP_PAYLOAD || 'errors').toLowerCase(); 
// 'none' | 'errors' | 'all'

// Sencillo almacén en memoria (cámbialo a DB en producción)
let userToken = null; // { access_token, refresh_token, expires_at }

function isValid(tok) {
  return tok && tok.access_token && Date.now() < (tok.expires_at - 30_000);
}

function peekToken(){ return userToken; }

// ---------- Helpers de logging ----------

function firstDetail(data) {
  if (!data) return null;
  if (Array.isArray(data.errors) && data.errors.length) {
    return data.errors[0]?.detail || data.errors[0]?.title || null;
  }
  return data.detail || data.title || null;
}

function shouldPrintPayload() {
  return HTTP_PAYLOAD_MODE === 'all';
}

function shouldPrintErrorPayload() {
  return HTTP_PAYLOAD_MODE === 'errors' || HTTP_PAYLOAD_MODE === 'all';
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function logHttpSuccess(method, url, status, startedMs, meta) {
  const took = Date.now() - startedMs;
  // Si es operación de aprovisionamiento, degrada a debug
  const isProv = meta?.provisioning === true;
  const msg = `${method.toUpperCase()} ${url} ${status} in ${took}ms`;
  if (isProv) log.debug(msg);
  else log.info(msg);
}

function logHttpError(method, url, err, startedMs, meta) {
  const took = Date.now() - startedMs;
  const status = err?.response?.status;
  const data = err?.response?.data;
  const detail = firstDetail(data) || err?.message || 'HTTP error';

  const isProv = meta?.provisioning === true;

  // Línea concisa
  const line = `${method.toUpperCase()} ${url} ERROR ${status} in ${took}ms -> ${detail}`;

  // Para provisión, degrada a debug y no adjuntes payload salvo modo 'all'
  if (isProv) {
    if (shouldPrintPayload()) log.debug(line + ` | payload=${safeJson(data)}`);
    else log.debug(line);
    return;
  }

  // Para resto de casos
  if (shouldPrintErrorPayload()) {
    log.warn(line);
    if (shouldPrintPayload() && data) {
      // Solo si estás en 'all' imprimimos el payload completo
      log.warn('payload:', safeJson(data));
    }
  } else {
    // 'none'
    log.warn(line);
  }
}

// ---------- Flujo OAuth 3LO ----------

async function exchangeCodeForToken(code) {
  const { APS_CLIENT_ID_3LO, APS_CLIENT_SECRET_3LO, APS_CALLBACK_URL } = process.env;
  const data = {
    grant_type: 'authorization_code',
    client_id: APS_CLIENT_ID_3LO,
    client_secret: APS_CLIENT_SECRET_3LO,
    code,
    redirect_uri: APS_CALLBACK_URL
  };
  const started = Date.now();
  const url = `${AUTH_BASE}/token`;
  try {
    const { data: tok } = await axios.post(url, qs.stringify(data), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
    userToken = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + (tok.expires_in * 1000)
    };
    log.info(`POST ${url} 200 in ${Date.now() - started}ms (token 3LO obtenido)`);
    return userToken;
  } catch (err) {
    logHttpError('post', url, err, started);
    throw err;
  }
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

  const started = Date.now();
  const url = `${AUTH_BASE}/token`;
  try {
    const { data: tok } = await axios.post(url, qs.stringify(data), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
    userToken = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || userToken.refresh_token,
      expires_at: Date.now() + (tok.expires_in * 1000)
    };
    log.debug(`POST ${url} 200 in ${Date.now() - started}ms (refresh ok)`);
    return userToken.access_token;
  } catch (err) {
    logHttpError('post', url, err, started);
    throw err;
  }
}

// ---------- HTTP helpers con Bearer ----------

async function apiGet(url, config = {}) {
  const access = await refreshIfNeeded();
  const path = url.startsWith('http') ? url : `${APS_BASE}${url}`;
  const started = Date.now();
  try {
    const { data, status } = await axios.get(path, {
      timeout: 5000,
      ...config,
      headers: { ...(config.headers || {}), Authorization: `Bearer ${access}` }
    });
    logHttpSuccess('get', url, status, started, config.meta);
    return data;
  } catch (err) {
    logHttpError('get', url, err, started, config.meta);
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
    logHttpSuccess('post', url, status, started, config.meta);
    return data;
  } catch (err) {
    logHttpError('post', url, err, started, config.meta);
    throw err;
  }
}

// Helpers para router OAuth
function hasUserToken() { return !!userToken?.access_token; }
function clearUserToken() { userToken = null; }

module.exports = { exchangeCodeForToken, apiGet, apiPost, hasUserToken, clearUserToken, peekToken };
