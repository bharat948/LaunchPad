import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './postgres.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '../../../migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  try {
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      await client.query(sql);
    }
  } finally {
    client.release();
  }
}

if (process.argv[1] && process.argv[1].endsWith('runMigrations.ts')) {
  runMigrations()
    .then(() => {
      console.log('Migrations executed successfully.');
      process.exit(0);
    })
    .catch(err => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
