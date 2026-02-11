// const { Pool } = require('pg');
// const dotenv = require('dotenv');

// dotenv.config();

// const connectionString = process.env.DATABASE_URL;

// const pool = new Pool(
//   connectionString
//     ? {
//         connectionString,
//         ssl:
//           process.env.PGSSLMODE === 'require'
//             ? { rejectUnauthorized: false }
//             : undefined,
//       }
//     : undefined,
// );

// module.exports = pool;

const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

console.log('Loaded DATABASE_URL:', process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, // keep false for local PostgreSQL
});

pool.connect()
  .then(() => console.log('✅ Database connected successfully'))
  .catch(err => console.error('❌ Database connection failed:', err));

module.exports = pool;


