// clients/msalClient.js

const msal = require('@azure/msal-node');
const { azure } = require('../config/env');

const cca = new msal.ConfidentialClientApplication({
  auth: {
    clientId: azure.clientId,
    clientSecret: azure.clientSecret,
    authority: `https://login.microsoftonline.com/${azure.tenantId}`
  }
});

async function getGraphToken() {
  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default']
  });
  return result.accessToken;
}

module.exports = { getGraphToken };
