// clients/msalClient.js
const fs = require('fs');
const msal = require('@azure/msal-node');
const { azure } = require('../config/env');

/**
 * PARA GRAPH (aplicar plantillas, listar drives, etc.)
 * -> Usa clientSecret como ya tenías (si prefieres, luego lo migramos a cert también).
 */
const ccaSecret = new msal.ConfidentialClientApplication({
  auth: {
    clientId: azure.clientId,
    clientSecret: azure.clientSecret,
    authority: `https://login.microsoftonline.com/${azure.tenantId}`
  }
});

async function getGraphToken() {
  const result = await ccaSecret.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default']
  });
  if (!result?.accessToken) throw new Error('No Graph token');
  return result.accessToken;
}

/**
 * PARA SHAREPOINT ADMIN (-admin.sharepoint.com)
 * -> Usa certificado (recomendado para evitar “Unsupported app only token”).
 * Requiere:
 *   - process.env.SP_CERT_THUMBPRINT
 *   - process.env.SP_CERT_PRIVATE_KEY_PATH
 */
function buildCcaWithCert() {
  const thumbprint = process.env.SP_CERT_THUMBPRINT;
  const keyPath = process.env.SP_CERT_PRIVATE_KEY_PATH;

  if (!thumbprint) throw new Error('SP_CERT_THUMBPRINT is required');
  if (!keyPath) throw new Error('SP_CERT_PRIVATE_KEY_PATH is required');

  const privateKey = fs.readFileSync(keyPath, 'utf8');

  return new msal.ConfidentialClientApplication({
    auth: {
      clientId: azure.clientId,
      authority: `https://login.microsoftonline.com/${azure.tenantId}`,
      clientCertificate: { thumbprint, privateKey }
      // Si quieres incluir cadena x5c:
      // clientCertificate: { thumbprint, privateKey, x5c: fs.readFileSync(process.env.SP_CERT_PUBLIC_CERT_PATH, 'utf8') }
    }
  });
}

module.exports = { getGraphToken, buildCcaWithCert };
