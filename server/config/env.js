
const required = (keys) => {
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length) console.warn('⚠️ Falta(n) env:', missing.join(', '));
};

required([
  'PORT',
  'AZURE_TENANT_ID', 'SP_CLIENT_ID', 'SP_CLIENT_SECRET',
  'APS_CLIENT_ID', 'APS_CLIENT_SECRET', 'APS_CALLBACK_URL'
]);

module.exports = {
  port: process.env.PORT || 3000,
  azure: {
    tenantId: process.env.AZURE_TENANT_ID,
    clientId: process.env.SP_CLIENT_ID,
    clientSecret: process.env.SP_CLIENT_SECRET
  },
  aps: {
    clientId: process.env.APS_CLIENT_ID,
    clientSecret: process.env.APS_CLIENT_SECRET,
    callbackUrl: process.env.APS_CALLBACK_URL 
  }
};
