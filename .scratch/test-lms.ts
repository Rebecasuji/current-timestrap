import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

async function run() {
  const tsPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const empRes = await tsPool.query(SELECT * FROM employees WHERE name ILIKE '%Zameela%');
  if (empRes.rows.length === 0) { console.log('Emp not found'); process.exit(1); }
  const empCode = empRes.rows[0].employee_code;
  console.log('Employee Code:', empCode);
  
  const lmsPool = new Pool({ connectionString: process.env.LMS_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  
  const lmsRes = await lmsPool.query(SELECT * FROM leaves WHERE user_id = , [empCode]);
  console.log('Leaves:', lmsRes.rows);
  
  process.exit(0);
}
run().catch(console.error);
