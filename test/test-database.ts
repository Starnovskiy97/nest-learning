import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client';

export async function createTestDatabase() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is required for database tests');
  }

  // Each suite owns a fresh schema. Never clear the application's public schema.
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }, { schema }),
  });

  async function close(): Promise<void> {
    await prisma.$disconnect();
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  }

  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const connection = await pool.connect();

    try {
      await connection.query('BEGIN');
      await connection.query(`SET LOCAL search_path TO "${schema}"`);
      const migrationsPath = join(process.cwd(), 'prisma/migrations');
      const entries = await readdir(migrationsPath, { withFileTypes: true });

      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.isDirectory()) {
          const sql = await readFile(
            join(migrationsPath, entry.name, 'migration.sql'),
            'utf8',
          );
          await connection.query(sql);
        }
      }

      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }

    await prisma.$connect();
  } catch (error) {
    await close();
    throw error;
  }

  return {
    prisma,
    async reset(): Promise<void> {
      await pool.query(
        `TRUNCATE TABLE "${schema}"."Task", "${schema}"."User" RESTART IDENTITY`,
      );
    },
    close,
  };
}
