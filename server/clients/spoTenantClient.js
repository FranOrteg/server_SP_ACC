// clients/spoTenantClient.js

const axios = require('axios');
const { buildCcaWithCert } = require('./msalClient');

const SPO_TENANT_HOST = process.env.SPO_TENANT_HOST;

let _token = null, _expMs = 0;
async function getSpoTenantToken() {
  const now = Date.now();
  if (_token && now < _expMs - 60_000) return _token;

  const cca = buildCcaWithCert();
  const result = await cca.acquireTokenByClientCredential({
    scopes: [`https://${SPO_TENANT_HOST}/.default`]
  });

  const token = result?.accessToken;
  if (!token) throw new Error('No token SPO tenant');

  // 🔎 auditoría opcional
  if (process.env.DEBUG_SPO_TENANT_TOKEN === 'true') {
    try {
      const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
      console.log('[SPO TENANT TOKEN AUD]', decoded.aud, 'appid:', decoded.appid || decoded.appidacr || '', 'tid:', decoded.tid);
    } catch {}
  }

  _token = token;
  _expMs = now + (result.expiresIn || 3000) * 1000;
  return token;
}

async function spoTenantGet(absUrl, extraHeaders = {}) {
  const token = await getSpoTenantToken();
  return axios.get(absUrl, {
    timeout: 20000,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json;odata=nometadata', ...extraHeaders }
  });
}

async function spoTenantPost(absUrl, body, extraHeaders = {}) {
  const token = await getSpoTenantToken();
  return axios.post(absUrl, body, {
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json;odata=nometadata',
      'Content-Type': 'application/json;odata=verbose',
      ...extraHeaders
    }
  });
}

/**
 * MERGE (update) vía SharePoint REST API.
 * SP no soporta PATCH nativo; usa POST + X-HTTP-Method: MERGE.
 */
async function spoTenantMerge(absUrl, body, extraHeaders = {}) {
  const token = await getSpoTenantToken();
  return axios.post(absUrl, body, {
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json;odata=nometadata',
      'Content-Type': 'application/json;odata=verbose',
      'X-HTTP-Method': 'MERGE',
      'IF-MATCH': '*',
      ...extraHeaders
    }
  });
}

module.exports = { spoTenantGet, spoTenantPost, spoTenantMerge };

