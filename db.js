const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "logistics",
  password: "Oloratomachola20",
  port: 5432
});

module.exports = pool;