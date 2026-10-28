import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { FilterTasksDto } from '../src/tasks/dto/filter-tasks.dto';
import {
  TASK_CACHE_OPTIONS,
  TasksCacheService,
  type TaskCacheOptions,
} from '../src/tasks/tasks-cache.service';
import { createTestDatabase } from './test-database';

describe('Task page Redis cache (isolated integration)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: INestApplication<App>;
  let admin: ReturnType<typeof createClient>;
  let token: string;
  let options: TaskCacheOptions;
  const prefix = `test-task-cache:${randomUUID()}`;
  const filters = new FilterTasksDto();
  const apps: INestApplication<App>[] = [];

  async function startApp() {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(database.prisma)
      .overrideProvider(TASK_CACHE_OPTIONS)
      .useValue(options)
      .compile();
    const application = module.createNestApplication<INestApplication<App>>();
    apps.push(application);
    application.useLogger(false);
    application.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await application.init();
    return application;
  }

  async function waitForCache(application = app, seed = false) {
    const cache = application.get(TasksCacheService);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await cache.get(1, filters)) return;
      if (seed)
        await cache.set(1, filters, {
          items: [],
          total: 0,
          page: 1,
          limit: 10,
          totalPages: 0,
        });
      await delay(10);
    }
    throw new Error('Application Redis connection is not ready');
  }

  beforeAll(async () => {
    admin = createClient({
      url: 'redis://127.0.0.1:6380',
      socket: { reconnectStrategy: false, connectTimeout: 1000 },
    });
    admin.on('error', () => {});
    await admin.connect();
    database = await createTestDatabase();
  });
  afterAll(async () => {
    if (admin?.isReady) {
      for await (const keys of admin.scanIterator({
        MATCH: `${prefix}:*`,
        COUNT: 100,
      })) {
        if (keys.length) await admin.del(keys);
      }
    }
    if (admin?.isOpen) admin.destroy();
    await database?.close();
  });
  beforeEach(async () => {
    await database.reset();
    options = {
      url: 'redis://127.0.0.1:6380',
      namespace: `${prefix}:${randomUUID()}`,
      ttlSeconds: 2,
    };
    await database.prisma.user.createMany({
      data: [{ name: 'Автор' }, { name: 'Другой' }],
    });
    await database.prisma.task.createMany({
      data: [
        { title: 'Первая', ownerId: 1, completed: false },
        { title: 'Готовая', ownerId: 1, completed: true },
        { title: 'Чужая', ownerId: 2 },
      ],
    });
    app = await startApp();
    token = await app.get(JwtService).signAsync({ sub: 1 });
    await waitForCache(app, true);
    await admin.del(app.get(TasksCacheService).key(1, filters));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(apps.splice(0).map((application) => application.close()));
  });

  function get(
    query: Record<string, string | number> = {},
    accessToken = token,
    application = app,
  ) {
    return request(application.getHttpServer())
      .get('/tasks')
      .set('Authorization', `Bearer ${accessToken}`)
      .query(query);
  }

  it('skips the task transaction on a hit and normalizes defaults', async () => {
    const transaction = jest.spyOn(database.prisma, '$transaction');
    const first = await get().expect(200);
    const second = await get({ page: 1, limit: 10 }).expect(200);
    expect(second.body).toEqual(first.body);
    expect(transaction).toHaveBeenCalledTimes(1);
    const ttl = await admin.pTTL(app.get(TasksCacheService).key(1, filters));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2000);
  });

  it('separates users, filters and pagination', async () => {
    const all = await get().expect(200);
    expect(all.body).toMatchObject({ total: 2 });
    const pending = await get({ completed: 'false' }).expect(200);
    expect(pending.body).toMatchObject({
      total: 1,
      items: [{ title: 'Первая' }],
    });
    const done = await get({ completed: 'true' }).expect(200);
    expect(done.body).toMatchObject({
      total: 1,
      items: [{ title: 'Готовая' }],
    });
    const assigned = await get({ assigneeId: 2 }).expect(200);
    expect(assigned.body).toMatchObject({ total: 0, items: [] });
    const page = await get({ page: 2, limit: 1 }).expect(200);
    expect(page.body).toMatchObject({
      total: 2,
      page: 2,
      items: [{ title: 'Готовая' }],
    });
    const otherToken = await app.get(JwtService).signAsync({ sub: 2 });
    const other = await get({}, otherToken).expect(200);
    expect(other.body).toMatchObject({
      total: 1,
      items: [{ title: 'Чужая', ownerId: 2 }],
    });
  });

  it('shares cached pages between two app instances', async () => {
    const first = await get().expect(200);
    const secondApp = await startApp();
    await waitForCache(secondApp);
    const transaction = jest.spyOn(database.prisma, '$transaction');
    const replay = await get({}, token, secondApp).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('expires naturally without extending TTL on reads', async () => {
    await get().expect(200);
    const key = app.get(TasksCacheService).key(1, filters);
    await delay(1100);
    await get().expect(200);
    expect(await admin.pTTL(key)).toBeLessThan(1100);
    await delay(1050);
    const transaction = jest.spyOn(database.prisma, '$transaction');
    await get().expect(200);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('intentionally serves stale data after writes until expiry', async () => {
    const old = await get().expect(200);
    await request(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Новая' })
      .expect(201);
    await request(app.getHttpServer())
      .patch('/tasks/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Изменено', version: 1 })
      .expect(200);
    await request(app.getHttpServer())
      .delete('/tasks/2')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    const stale = await get().expect(200);
    expect(stale.body).toEqual(old.body);
    await admin.pExpire(app.get(TasksCacheService).key(1, filters), 20);
    await delay(40);
    const fresh = await get().expect(200);
    expect(fresh.body).toMatchObject({
      total: 2,
      items: [
        { title: 'Изменено', version: 2 },
        { title: 'Новая', version: 1 },
      ],
    });
  });

  it('authenticates every request even with a cached response', async () => {
    await get().expect(200);
    await request(app.getHttpServer()).get('/tasks').expect(401);
    await database.prisma.task.deleteMany({ where: { ownerId: 1 } });
    await database.prisma.user.delete({ where: { id: 1 } });
    await get().expect(401);
  });

  it.each(['{broken json', 'wrong owner', 'missing version'])(
    'treats corrupt cache as a miss: %s',
    async (variant) => {
      const first = await get().expect(200);
      const page = first.body as { items: Array<Record<string, unknown>> };
      if (variant === 'wrong owner') page.items[0].ownerId = 2;
      if (variant === 'missing version') delete page.items[0].version;
      const key = app.get(TasksCacheService).key(1, filters);
      await admin.set(
        key,
        variant === '{broken json' ? variant : JSON.stringify(page),
      );
      const transaction = jest.spyOn(database.prisma, '$transaction');
      const result = await get().expect(200);
      expect(result.body).toMatchObject({
        total: 2,
        items: [
          { title: 'Первая', ownerId: 1, version: 1 },
          { title: 'Готовая', ownerId: 1, version: 1 },
        ],
      });
      expect(transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('falls back to PostgreSQL with an unavailable Redis', async () => {
    options = { ...options, url: 'redis://127.0.0.1:1' };
    const offlineApp = await startApp();
    const transaction = jest.spyOn(database.prisma, '$transaction');
    await get({}, token, offlineApp).expect(200);
    await get({}, token, offlineApp).expect(200);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('does not expose extra fields injected into a cache entry', async () => {
    const first = await get().expect(200);
    const page = first.body as {
      items: Array<Record<string, unknown>>;
      internalNote?: string;
    };
    page.internalNote = 'must not be returned';
    page.items[0].passwordHash = 'must not be returned';
    await admin.set(
      app.get(TasksCacheService).key(1, filters),
      JSON.stringify(page),
    );
    const transaction = jest.spyOn(database.prisma, '$transaction');
    const result = await get().expect(200);
    expect(result.body).not.toHaveProperty('internalNote');
    expect((result.body as { items: object[] }).items[0]).not.toHaveProperty(
      'passwordHash',
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does not hide database errors on cache miss', async () => {
    const spy = jest
      .spyOn(database.prisma, '$transaction')
      .mockRejectedValueOnce(new Error('Test database failure'));
    await get().expect(500);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
