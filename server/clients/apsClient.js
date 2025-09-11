const ForgeSDK = require('forge-apis');
const { aps } = require('../config/env');

/**
 * Para ACC normalmente se usa 3-legged (usuario concede acceso).
 * Guardaremos tokens por usuario en DB; aquí solo dejamos el cliente OAuth.
 */
const scopes = ['data:read', 'data:create', 'data:write', 'bucket:create', 'bucket:read']; // ampliaremos si hace falta

function getThreeLeggedClient() {
  return new ForgeSDK.AuthClientThreeLegged(
    aps.clientId,
    aps.clientSecret,
    aps.callbackUrl,
    scopes,
    true
  );
}

module.exports = { getThreeLeggedClient, ForgeSDK };
