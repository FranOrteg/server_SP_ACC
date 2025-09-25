// clients/spoClient.js

const axios = require('axios');
const msal = require('@azure/msal-node');
const { azure } = require('../config/env');

const SPO_TENANT_HOST = process.env.SPO_TENANT_HOST;     // ej: labitgroup.sharepoint.com
const SPO_ADMIN_HOST  = process.env.SPO_ADMIN_HOST;      // ej: labitgroup-admin.sharepoint.com

if (!SPO_TENANT_HOST) console.warn('⚠️ Falta SPO_TENANT_HOST en .env');
if (!SPO_ADMIN_HOST)  console.warn('⚠️ Falta SPO_ADMIN_HOST en .env');

const cca = new msal.ConfidentialClientApplication({
  auth: {
    clientId: azure.clientId,         // ya configurado en tu msalClient
    clientSecret: azure.clientSecret,
    authority: `https://login.microsoftonline.com/${azure.tenantId}`
  }
});

// Token para SharePoint (no Graph)
async function getSharePointToken() {
  const scopes = [`https://${SPO_TENANT_HOST}/.default`];
  const r = await cca.acquireTokenByClientCredential({ scopes });
  return r.accessToken;
}

// POST a SharePoint ADMIN host
async function spoAdminPost(path, data, extraHeaders = {}) {
  const token = await getSharePointToken();
  return axios.post(`https://${SPO_ADMIN_HOST}${path}`, data, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json;odata=nometadata',
      'Content-Type': 'application/json;odata=verbose',
      ...extraHeaders
    }
  });
}

module.exports = { spoAdminPost };
