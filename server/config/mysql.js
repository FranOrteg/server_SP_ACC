// config/mysql.js
const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
  if (!pool && process.env.MYSQL_HOST) {
    try {
      pool = mysql.createPool({
        host: process.env.MYSQL_HOST,
        port: process.env.MYSQL_PORT || 3306,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE || 'labit_skylabdb1',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
      });
      console.log('✅ MySQL pool creado');
    } catch (e) {
      console.warn('⚠️ No se pudo crear pool MySQL:', e.message);
    }
  }
  return pool;
}

async function query(sql, params = []) {
  const p = getPool();
  if (!p) return null;
  try {
    const [rows] = await p.query(sql, params);
    return rows;
  } catch (e) {
    console.warn('⚠️ MySQL query error:', e.message);
    return null;
  }
}

module.exports = { query, getPool };
