import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Agent, get } from 'node:http';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { createTestDatabase } from '../test/test-database';

const exec = promisify(execFile);
type Worker = {
  child: ChildProcess;
  port: number;
  token: string;
  name: string;
};
type Metrics = { user: number; system: number; rss: number };
let interrupted = false;

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function main(): Promise<void> {
  const quick = process.argv.includes('--quick');
  assert(
    process.argv.slice(2).every((arg) => arg === '--quick'),
    'Only --quick is supported',
  );
  const seconds = quick ? 2 : 4;
  const rounds = quick ? 1 : 2;
  const levels = quick ? [1, 8] : [1, 8, 32];
  const connectionString = process.env.DATABASE_URL;
  assert(connectionString, 'DATABASE_URL is required');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(
      new URL(connectionString).hostname,
    ),
    'Only a local teaching database is allowed',
  );
  const database = await createTestDatabase();
  const monitor = new Pool({ connectionString, max: 1 });
  const results: object[] = [];
  process.once('SIGINT', () => {
    interrupted = true;
  });
  process.once('SIGTERM', () => {
    interrupted = true;
  });

  try {
    await database.prisma.user.create({ data: { name: 'Нагрузочный автор' } });
    for (let batch = 0; batch < 10; batch++) {
      await database.prisma.task.createMany({
        data: Array.from({ length: 1000 }, (_, index) => ({
          ownerId: 1,
          title: `Учебная задача ${batch * 1000 + index}`,
        })),
      });
    }
    // This connection is no longer needed; keep only workers and the monitor active.
    await database.prisma.$disconnect();
    console.log(
      '10 000 задач; независимые процессы API, pool max=5 на процесс.',
    );
    console.log(
      'Closed-loop: C клиентов, каждый ждёт ответ перед следующим запросом.',
    );
    console.log(
      `Режим: ${quick ? 'короткий smoke-тест' : 'два раунда AB/BA'}, ${seconds}s на измерение.`,
    );

    for (let round = 0; round < rounds; round++) {
      for (const count of round % 2 ? [2, 1] : [1, 2]) {
        if (interrupted) throw new Error('Interrupted');
        const children: ChildProcess[] = [];
        const workers: Worker[] = [];
        const container = `nest-load-${randomUUID()}`;
        const metricsKey = randomUUID();
        let containerStarted = false;
        try {
          for (let index = 0; index < count; index++) {
            const name = `${database.schema}_${round}_${count}_${index}`;
            const child = fork(resolve('scripts/load-worker.ts'), [], {
              execArgv: ['-r', 'ts-node/register'],
              env: {
                ...process.env,
                REDIS_URL: '',
                JWT_SECRET: 'load-lab-only-secret-never-for-real-deployments',
                LOAD_SCHEMA: database.schema,
                LOAD_APPLICATION_NAME: name,
                LOAD_METRICS_KEY: metricsKey,
              },
              stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
            });
            children.push(child);
            const ready = await new Promise<{ port: number; token: string }>(
              (resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error('Worker startup timed out')),
                  45000,
                );
                child.once('error', reject);
                child.once('exit', () => {
                  clearTimeout(timer);
                  reject(new Error('Worker exited'));
                });
                child.once('message', (message: unknown) => {
                  clearTimeout(timer);
                  if (
                    typeof message !== 'object' ||
                    !message ||
                    !('port' in message) ||
                    typeof message.port !== 'number' ||
                    !('token' in message) ||
                    typeof message.token !== 'string'
                  ) {
                    reject(new Error('Invalid worker readiness message'));
                    return;
                  }
                  resolve({ port: message.port, token: message.token });
                });
              },
            );
            workers.push({ child, ...ready, name });
          }
          await exec(
            'docker',
            [
              'run',
              '--rm',
              '--detach',
              '--name',
              container,
              '--publish',
              '127.0.0.1::80',
              '--add-host',
              'host.docker.internal:host-gateway',
              '--env',
              `API_UPSTREAM=host.docker.internal:${workers[0].port}`,
              '--env',
              `API_EXTRA_SERVER=${workers[1] ? `server host.docker.internal:${workers[1].port};` : ''}`,
              '--env',
              'NGINX_ENVSUBST_FILTER=^API_(UPSTREAM|EXTRA_SERVER)$',
              '--volume',
              `${resolve('infra/nginx/default.conf.template')}:/etc/nginx/templates/default.conf.template:ro`,
              'nginx:1.28-alpine',
            ],
            { timeout: 120000 },
          );
          containerStarted = true;
          const { stdout } = await exec('docker', [
            'port',
            container,
            '80/tcp',
          ]);
          const base = `http://${stdout.trim()}`;
          let ready = false;
          for (let attempt = 0; attempt < 40; attempt++) {
            try {
              const response = await fetch(base, {
                signal: AbortSignal.timeout(1000),
              });
              await response.text();
              if (response.status === 200) {
                ready = true;
                break;
              }
            } catch {
              /* Wait for Nginx startup. */
            }
            await delay(250);
          }
          assert(ready, 'Nginx must reach API');

          async function metrics(): Promise<Metrics[]> {
            return Promise.all(
              workers.map(async (worker) => {
                const response = await fetch(
                  `http://127.0.0.1:${worker.port}/__load_metrics`,
                  {
                    headers: { 'X-Lab-Key': metricsKey },
                    signal: AbortSignal.timeout(3000),
                  },
                );
                assert.equal(response.status, 200);
                return (await response.json()) as Metrics;
              }),
            );
          }

          for (const path of ['/', '/tasks?limit=10']) {
            for (const concurrency of levels) {
              if (interrupted) throw new Error('Interrupted');
              const agent = new Agent({
                keepAlive: true,
                maxSockets: concurrency,
              });
              const errors: Record<string, number> = {};
              const latencies: number[] = [];
              const upstreams = new Set<string>();
              async function request(record: boolean): Promise<void> {
                const begin = performance.now();
                try {
                  await new Promise<void>((resolve, reject) => {
                    const req = get(
                      `${base}${path}`,
                      {
                        agent,
                        headers: {
                          Authorization: `Bearer ${workers[0].token}`,
                        },
                      },
                      (res) => {
                        let text = '';
                        res.setEncoding('utf8');
                        res.on('data', (chunk: string) => {
                          text += chunk;
                        });
                        res.on('error', reject);
                        res.on('end', () => {
                          try {
                            assert.equal(
                              res.statusCode,
                              200,
                              `HTTP ${res.statusCode}`,
                            );
                            if (path === '/')
                              assert.equal(text, 'Hello World!');
                            else {
                              const page = JSON.parse(text) as {
                                total: number;
                                items: unknown[];
                              };
                              assert.equal(page.total, 10000);
                              assert.equal(page.items.length, 10);
                            }
                            const address = res.headers['x-upstream-addr'];
                            if (record && typeof address === 'string')
                              upstreams.add(address);
                            resolve();
                          } catch (error) {
                            reject(
                              error instanceof Error
                                ? error
                                : new Error('Invalid response'),
                            );
                          }
                        });
                      },
                    );
                    req.setTimeout(5000, () =>
                      req.destroy(new Error('Request timeout')),
                    );
                    req.on('error', reject);
                  });
                  if (record) latencies.push(performance.now() - begin);
                } catch (error) {
                  if (record) {
                    const message =
                      error instanceof Error
                        ? error.message.split('\n')[0]
                        : 'Request failed';
                    errors[message] = (errors[message] ?? 0) + 1;
                  }
                }
              }
              async function load(ms: number, record: boolean) {
                const deadline = performance.now() + ms;
                await Promise.all(
                  Array.from({ length: concurrency }, async () => {
                    while (!interrupted && performance.now() < deadline)
                      await request(record);
                  }),
                );
              }
              try {
                await load(1000, false);
                const before = await metrics();
                const generatorBefore = process.cpuUsage();
                let peakRss = 0,
                  peakConnections = 0,
                  peakActive = 0;
                let sampling = true;
                let samplingError: Error | undefined;
                const sampler = (async () => {
                  while (sampling) {
                    const [api, connections] = await Promise.all([
                      metrics(),
                      monitor.query<{ total: number; active: number }>(
                        `SELECT count(*)::int AS total,
                          count(*) FILTER (WHERE state = 'active')::int AS active
                         FROM pg_stat_activity WHERE application_name = ANY($1::text[])`,
                        [workers.map((worker) => worker.name)],
                      ),
                    ]);
                    peakRss = Math.max(
                      peakRss,
                      api.reduce((sum, item) => sum + item.rss, 0),
                    );
                    peakConnections = Math.max(
                      peakConnections,
                      connections.rows[0].total,
                    );
                    peakActive = Math.max(
                      peakActive,
                      connections.rows[0].active,
                    );
                    await delay(300);
                  }
                })().catch((error: unknown) => {
                  samplingError =
                    error instanceof Error
                      ? error
                      : new Error('Sampling failed');
                });
                const begin = performance.now();
                let elapsedMs: number;
                let after: Metrics[];
                let generatorCpu: NodeJS.CpuUsage;
                try {
                  await load(seconds * 1000, true);
                  elapsedMs = performance.now() - begin;
                  after = await metrics();
                  generatorCpu = process.cpuUsage(generatorBefore);
                } finally {
                  sampling = false;
                  await sampler;
                }
                if (samplingError) throw samplingError;
                const cpuUs = after.reduce(
                  (sum, item, index) =>
                    sum +
                    item.user +
                    item.system -
                    before[index].user -
                    before[index].system,
                  0,
                );
                latencies.sort((a, b) => a - b);
                const percentile = (p: number) =>
                  latencies.length
                    ? Number(
                        latencies[Math.ceil(p * latencies.length) - 1].toFixed(
                          2,
                        ),
                      )
                    : null;
                const row = {
                  round: round + 1,
                  instances: count,
                  path,
                  concurrency,
                  successful: latencies.length,
                  errors: Object.values(errors).reduce((a, b) => a + b, 0),
                  rps: Number(
                    ((latencies.length * 1000) / elapsedMs).toFixed(1),
                  ),
                  p50Ms: percentile(0.5),
                  p95Ms: percentile(0.95),
                  p99Ms: percentile(0.99),
                  apiCpuPercent: Number((cpuUs / (elapsedMs * 10)).toFixed(1)),
                  apiRssMiB: Number((peakRss / 1024 / 1024).toFixed(1)),
                  dbConnections: peakConnections,
                  dbActive: peakActive,
                  generatorCpuPercent: Number(
                    (
                      (generatorCpu.user + generatorCpu.system) /
                      (elapsedMs * 10)
                    ).toFixed(1),
                  ),
                  upstreams: upstreams.size,
                  errorDetails: errors,
                };
                results.push(row);
                console.log(JSON.stringify(row));
                assert(
                  row.successful > 0 && row.errors === 0,
                  'Load generated errors; stop increasing pressure',
                );
                assert.equal(
                  upstreams.size,
                  count,
                  'Requests must reach all configured instances',
                );
              } finally {
                agent.destroy();
              }
            }
          }
        } catch (error) {
          if (containerStarted) {
            const logs = await exec('docker', [
              'logs',
              '--tail',
              '12',
              container,
            ]);
            console.error(logs.stdout, logs.stderr);
          }
          throw error;
        } finally {
          try {
            if (containerStarted)
              await exec('docker', ['stop', container], { timeout: 15000 });
          } finally {
            await Promise.all(children.map(stop));
          }
        }
      }
    }
    console.log(
      `Completed ${results.length} measurements. Compare matching route/concurrency, not different loads.`,
    );
  } finally {
    try {
      await monitor.end();
    } finally {
      await database.close();
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Load lab failed');
  process.exitCode = 1;
});
