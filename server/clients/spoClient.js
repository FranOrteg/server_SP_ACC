// clients/spoClient.js

const axios = require('axios');
const { buildCcaWithCert } = require('./msalClient');

const SPO_TENANT_HOST = process.env.SPO_TENANT_HOST;   // ej: labitgroup.sharepoint.com
const SPO_ADMIN_HOST  = process.env.SPO_ADMIN_HOST;    // ej: labitgroup-admin.sharepoint.com

if (!SPO_TENANT_HOST) console.warn('⚠️ Falta SPO_TENANT_HOST en .env');
if (!SPO_ADMIN_HOST)  console.warn('⚠️ Falta SPO_ADMIN_HOST en .env');

let _token = null;
let _expMs = 0;

/**
 * Obtiene token app-only con CERTIFICADO para el host admin
 */
async function getSharePointToken() {
  const now = Date.now();
  if (_token && now < _expMs - 60_000) return _token;

  const cca = buildCcaWithCert();
  const result = await cca.acquireTokenByClientCredential({
    scopes: [`https://${SPO_ADMIN_HOST}/.default`]
  });

  const token = result?.accessToken;
  if (!token) {
    throw new Error(`No se pudo obtener token para SharePoint admin host (${SPO_ADMIN_HOST})`);
  }

  const expiresInSec = result.expiresIn || 3000;
  _token = token;
  _expMs = now + expiresInSec * 1000;

  if (process.env.DEBUG_SPO_TOKEN === 'true') {
    try {
      const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
      console.log('[SPO TOKEN AUD]', decoded.aud, 'roles:', decoded.roles || decoded.scp, 'appid:', decoded.appid);
    } catch {}
  }

  return token;
}

/**
 * Helper para reintentar requests con backoff exponencial
 */
async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelay ?? 2000;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status;
      const isLastAttempt = attempt === maxRetries;
      
      // Determinar si es reintentable
      const isRetryable = 
        !status || // errores de red/timeout
        status === 429 || // rate limit
        status >= 500; // errores de servidor
      
      if (!isRetryable || isLastAttempt) {
        throw err;
      }

      // Calcular delay con backoff exponencial + jitter
      const retryAfter = err?.response?.headers?.['retry-after'];
      const delay = retryAfter 
        ? parseInt(retryAfter) * 1000
        : Math.min(
            60000, // max 60s
            baseDelay * Math.pow(2, attempt - 1) + Math.random() * 2000
          );

      console.warn(
        `[SPO] Reintentando (${attempt}/${maxRetries}) después de ${delay}ms - ` +
        `Status: ${status || 'network error'}`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * POST a SharePoint Admin API
 * Timeout más largo para operaciones de creación (30s por defecto)
 */
async function spoAdminPost(path, data, extraHeaders = {}) {
  return withRetry(async () => {
    const token = await getSharePointToken();
    return axios.post(`https://${SPO_ADMIN_HOST}${path}`, data, {
      timeout: extraHeaders.timeout ?? 30000, // 30s para operaciones admin
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json;odata=nometadata',
        'Content-Type': 'application/json;odata=verbose',
        ...extraHeaders
      }
    });
  }, {
    maxRetries: 2, // menos reintentos para POST (no son idempotentes)
    baseDelay: 3000
  });
}

/**
 * GET a SharePoint Admin API
 * Timeout normal (20s) con reintentos automáticos
 */
async function spoAdminGet(path, extraHeaders = {}) {
  return withRetry(async () => {
    const token = await getSharePointToken();
    return axios.get(`https://${SPO_ADMIN_HOST}${path}`, {
      timeout: extraHeaders.timeout ?? 20000,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json;odata=nometadata',
        ...extraHeaders
      }
    });
  }, {
    maxRetries: 3,
    baseDelay: 2000
  });
}

/**
 * PATCH a SharePoint Admin API
 */
async function spoAdminPatch(path, data, extraHeaders = {}) {
  return withRetry(async () => {
    const token = await getSharePointToken();
    return axios.patch(`https://${SPO_ADMIN_HOST}${path}`, data, {
      timeout: extraHeaders.timeout ?? 20000,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json;odata=nometadata',
        'Content-Type': 'application/json;odata=verbose',
        ...extraHeaders
      }
    });
  }, {
    maxRetries: 2,
    baseDelay: 2000
  });
}

/** 
  * Elimina un sitio de SharePoint dado su siteId (GUID)
  * Usa POST /_api/SPSiteManager/delete según la documentación oficial
  * @param {string} siteId - UUID del sitio a eliminar
  * @returns {Promise<Object>} Respuesta de SharePoint
  */
async function deleteSpSite(siteId) {
  return withRetry(async () => {
    const token = await getSharePointToken();
    
    console.log('[SPO] Eliminando sitio:', siteId);
    
    return axios({
      method: 'POST',
      url: `https://${SPO_ADMIN_HOST}/_api/SPSiteManager/delete`,
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      data: {
        siteId: siteId
      },
      validateStatus: (status) => status < 600
    });
  }, {
    maxRetries: 2,
    baseDelay: 3000
  });
}

module.exports = {
  spoAdminPost,
  spoAdminGet,
  spoAdminPatch,
  deleteSpSite
};
