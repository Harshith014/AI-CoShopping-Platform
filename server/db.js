const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:0808@localhost:5432/smart_task_db' });
module.exports = pool;
