import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PasswordHasherService } from '../src/auth/password-hasher.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { Task } from '../src/tasks/task.interface';
import { createTestDatabase } from '../test/test-database';

const exec = promisify(execFile);

async function main(): Promise<void> {
  // Never use the local application's secret for this isolated experiment.
  process.env.JWT_SECRET =
    'balancing-test-only-secret-not-for-real-deployments';
  const database = await createTestDatabase();
  const apps: INestApplication[] = [];
  const container = `nest-balancing-test-${randomUUID()}`;
  let started = false;

  async function startApp(): Promise<INestApplication> {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(database.prisma)
      .compile();
    const app = module.createNestApplication();
    apps.push(app);
    app.useLogger(false);
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.listen(0, '0.0.0.0');
    return app;
  }

  try {
    const credentials = {
      email: 'balancing@example.com',
      password: 'balancing-test-password',
    };
    await database.prisma.user.create({
      data: {
        name: 'Учебный пользователь',
        email: credentials.email,
        passwordHash: await new PasswordHasherService().hash(
          credentials.password,
        ),
      },
    });
    const first = await startApp();
    const second = await startApp();
    const firstPort = new URL(await first.getUrl()).port;
    const secondPort = new URL(await second.getUrl()).port;

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
        `API_UPSTREAM=host.docker.internal:${firstPort}`,
        '--env',
        `API_EXTRA_SERVER=server host.docker.internal:${secondPort};`,
        '--env',
        'NGINX_ENVSUBST_FILTER=^API_(UPSTREAM|EXTRA_SERVER)$',
        '--volume',
        `${resolve('infra/nginx/default.conf.template')}:/etc/nginx/templates/default.conf.template:ro`,
        'nginx:1.28-alpine',
      ],
      { timeout: 120000 },
    );
    started = true;
    const { stdout } = await exec('docker', ['port', container, '80/tcp']);
    const base = `http://${stdout.trim()}`;

    async function send(
      path: string,
      method = 'GET',
      body?: object,
      headers: Record<string, string> = {},
    ) {
      return fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    }

    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await send('/');
        await response.text();
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // Wait for Docker's entrypoint to render the configuration.
      }
      await delay(250);
    }
    assert(ready, 'Nginx must reach NestJS');
    await exec('docker', ['exec', container, 'nginx', '-t']);

    const login = await send('/auth/login', 'POST', credentials);
    assert.equal(login.status, 200);
    const { access_token } = (await login.json()) as { access_token: string };
    const auth = { Authorization: `Bearer ${access_token}` };
    const addresses = new Set<string>();
    for (let index = 0; index < 12; index++) {
      const response = await send('/auth/me', 'GET', undefined, auth);
      assert.equal(response.status, 200);
      const address = response.headers.get('x-upstream-addr');
      assert(address);
      addresses.add(address);
      const user = (await response.json()) as { email: string };
      assert.equal(user.email, credentials.email);
    }
    assert.equal(addresses.size, 2, 'The same JWT must work on both upstreams');

    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const response = await send(
          '/tasks',
          'POST',
          { title: 'Одна задача' },
          {
            ...auth,
            'Idempotency-Key': key,
          },
        );
        assert.equal(response.status, 201);
        return {
          task: (await response.json()) as Task,
          upstream: response.headers.get('x-upstream-addr'),
        };
      }),
    );
    const task = responses[0].task;
    for (const response of responses) assert.deepEqual(response.task, task);
    assert.equal(
      new Set(responses.map((response) => response.upstream)).size,
      2,
    );
    assert.equal(await database.prisma.task.count(), 1);
    assert.equal(await database.prisma.taskCreationRequest.count(), 1);

    const updates = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const response = await send(
          `/tasks/${task.id}`,
          'PATCH',
          {
            title: `Правка ${index}`,
            version: task.version,
          },
          auth,
        );
        await response.text();
        return response.status;
      }),
    );
    assert.equal(updates.filter((status) => status === 200).length, 1);
    assert.equal(updates.filter((status) => status === 409).length, 11);

    // Both upstreams share ONE limiter at the single proxy, not two limits.
    const attempts = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const response = await send('/auth/login', 'POST', {});
        await response.text();
        return response.status;
      }),
    );
    assert(attempts.every((status) => status === 400 || status === 429));
    assert(attempts.includes(400) && attempts.includes(429));
    assert(attempts.filter((status) => status === 400).length <= 6);

    console.log(
      `PASS: requests reached both upstreams: ${[...addresses].join(', ')}`,
    );
    console.log(
      'PASS: JWT across instances; one task for 12 POSTs; one successful PATCH and 11 conflicts; shared login limit.',
    );
  } finally {
    try {
      if (started)
        await exec('docker', ['stop', container], { timeout: 15000 });
    } finally {
      try {
        await Promise.all(apps.map((app) => app.close()));
      } finally {
        await database.close();
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
