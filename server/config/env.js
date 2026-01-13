
const required = (keys) => {
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length) console.warn('⚠️ Falta(n) env:', missing.join(', '));
};

required([
  'PORT',
  'AZURE_TENANT_ID', 'SP_CLIENT_ID', 'SP_CLIENT_SECRET',
  'APS_CLIENT_ID', 'APS_CLIENT_SECRET', 'APS_CALLBACK_URL'
]);

// MySQL es opcional - si no está configurado, se usarán URLs generadas
const mysqlOptional = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD'];
const missingMySQL = mysqlOptional.filter(k => !process.env[k]);
if (missingMySQL.length > 0 && missingMySQL.length < mysqlOptional.length) {
  console.warn('⚠️ MySQL parcialmente configurado. Faltan:', missingMySQL.join(', '));
}

// Slack es opcional - si no está configurado, se omitirá la creación de canales
if (!process.env.SLACK_BOT_TOKEN) {
  console.warn('⚠️ SLACK_BOT_TOKEN no configurado. Los canales de Slack no se crearán automáticamente.');
}

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
  },
  mysql: {
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'skylab'
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN
  }
};
