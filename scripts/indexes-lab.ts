import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

// All DDL and data live in a fresh schema inside a rolled-back transaction.
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const url = new URL(connectionString);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Run this lab only on a local PostgreSQL instance');
  }

  const schema = `indexes_lab_${randomUUID().replaceAll('-', '')}`;
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);

    const migrationsPath = join(process.cwd(), 'prisma/migrations');
    const entries = await readdir(migrationsPath, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        await client.query(
          await readFile(
            join(migrationsPath, entry.name, 'migration.sql'),
            'utf8',
          ),
        );
      }
    }

    await client.query(`
      INSERT INTO "User" (id, name)
      SELECT n, 'Учебный пользователь ' || n FROM generate_series(1, 101) AS n;
      INSERT INTO "Task" (id, title, completed, "ownerId")
      SELECT n, 'Учебная задача ' || n, n % 1000 >= 10,
             CASE WHEN n <= 100000 THEN 1 ELSE 2 + n % 100 END
      FROM generate_series(1, 300000) AS n;
      ANALYZE "Task";
    `);

    async function explain(label: string, sql: string): Promise<void> {
      console.log(`\n--- ${label} ---\n${sql}`);
      const result = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
      );
      console.log(result.rows.map((row) => row['QUERY PLAN']).join('\n'));
    }

    const page = `SELECT * FROM "Task" WHERE "ownerId" = 1 ORDER BY id LIMIT 10`;
    const filteredPage = `SELECT * FROM "Task"
      WHERE "ownerId" = 1 AND completed = false ORDER BY id LIMIT 10`;
    const count = `SELECT count(*) FROM "Task"
      WHERE "ownerId" = 1 AND completed = false`;

    console.log(
      '300 000 задач; у автора 1 — 100 000, из них 1000 незавершённых.',
    );
    console.log(
      'Временная схема: %s. В конце вся транзакция откатывается.',
      schema,
    );
    console.log('Это планы SQL, а не измерение времени всего HTTP-запроса.');

    // The migration-created index is removed ONLY from the new lab schema.
    await client.query(`DROP INDEX "${schema}"."Task_ownerId_id_idx"`);
    await explain('1a. Без индекса автора: страница', page);
    await explain('1b. Без индекса автора: фильтр', filteredPage);
    await explain('1c. Без индекса автора: подсчёт', count);

    await client.query(
      'CREATE INDEX "Task_ownerId_id_idx" ON "Task" ("ownerId", id)',
    );
    await explain('2a. Текущий индекс (ownerId, id): страница', page);
    await explain('2b. Текущий индекс: фильтр', filteredPage);
    await explain('2c. Текущий индекс: подсчёт', count);

    await client.query(`CREATE INDEX "Task_ownerId_completed_id_idx"
      ON "Task" ("ownerId", completed, id)`);
    await explain(
      '3a. Дополнительный индекс (ownerId, completed, id): фильтр',
      filteredPage,
    );
    await explain('3b. Дополнительный индекс: подсчёт', count);

    await explain(
      '4a. Глубокий OFFSET: пропустить 90 000 задач',
      `
      SELECT * FROM "Task" WHERE "ownerId" = 1
      ORDER BY id OFFSET 90000 LIMIT 10`,
    );
    await explain(
      '4b. Курсор: продолжить после известного id = 90000',
      `
      SELECT * FROM "Task" WHERE "ownerId" = 1 AND id > 90000
      ORDER BY id LIMIT 10`,
    );
    await explain(
      '5. Большая доля таблицы: Seq Scan может быть разумным',
      `
      SELECT count(*) FROM "Task" WHERE completed = true`,
    );
  } finally {
    try {
      await client.query('ROLLBACK');
      console.log('\nROLLBACK: учебные данные и схема не сохранены.');
    } finally {
      await client.end();
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Index lab failed');
  process.exitCode = 1;
});
