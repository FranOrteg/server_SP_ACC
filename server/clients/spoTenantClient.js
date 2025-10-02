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
  _token = token;
  _expMs = now + (result.expiresIn || 3000) * 1000;
  return token;
}

async function spoTenantGet(absUrl, extraHeaders = {}) {
  const token = await getSpoTenantToken();
  return axios.get(absUrl, {
    timeout: 20000,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json;odata=verbose', ...extraHeaders }
  });
}

async function spoTenantPost(absUrl, body, extraHeaders = {}) {
  const token = await getSpoTenantToken();
  return axios.post(absUrl, body, {
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json;odata=verbose',
      'Content-Type': 'application/json;odata=verbose',
      ...extraHeaders
    }
  });
}

module.exports = { spoTenantGet, spoTenantPost };
