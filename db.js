const mysql = require("mysql2/promise");
require("dotenv").config();
console.log("[DB ENV]", {
  MYSQLHOST: process.env.MYSQLHOST,
  MYSQLPORT: process.env.MYSQLPORT,
  MYSQLUSER: process.env.MYSQLUSER,
  MYSQLDATABASE: process.env.MYSQLDATABASE,
  hasPass: !!process.env.MYSQLPASSWORD,
  MYSQL_URL: !!process.env.MYSQL_URL,
  MYSQL_PUBLIC_URL: !!process.env.MYSQL_PUBLIC_URL,
});
const pool = mysql.createPool({
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASS || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || process.env.DB_NAME,
  port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;