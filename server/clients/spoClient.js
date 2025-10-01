// clients/spoClient.js
const axios = require('axios');
const { buildCcaWithCert } = require('./msalClient');

const SPO_TENANT_HOST = process.env.SPO_TENANT_HOST;   // ej: labitgroup.sharepoint.com
const SPO_ADMIN_HOST  = process.env.SPO_ADMIN_HOST;    // ej: labitgroup-admin.sharepoint.com

if (!SPO_TENANT_HOST) console.warn('⚠️ Falta SPO_TENANT_HOST en .env');
if (!SPO_ADMIN_HOST)  console.warn('⚠️ Falta SPO_ADMIN_HOST en .env');

let _token = null;
let _expMs = 0;

// Obtiene token app-only con CERTIFICADO para el host admin
async function getSharePointToken() {
  const now = Date.now();
  if (_token && now < _expMs - 60_000) return _token;

  const cca = buildCcaWithCert();
  const result = await cca.acquireTokenByClientCredential({
    scopes: [`https://${SPO_ADMIN_HOST}/.default`]
  });

  const token = result?.accessToken;
  if (!token) throw new Error(`No se pudo obtener token para SharePoint admin host (${SPO_ADMIN_HOST})`);

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

async function spoAdminPost(path, data, extraHeaders = {}) {
  const token = await getSharePointToken();
  return axios.post(`https://${SPO_ADMIN_HOST}${path}`, data, {
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json;odata=nometadata',
      'Content-Type': 'application/json;odata=verbose',
      ...extraHeaders
    }
  });
}

async function spoAdminGet(path, extraHeaders = {}) {
  const token = await getSharePointToken();
  return axios.get(`https://${SPO_ADMIN_HOST}${path}`, {
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json;odata=nometadata',
      ...extraHeaders
    }
  });
}

module.exports = { 
  spoAdminPost, 
  spoAdminGet   
};
