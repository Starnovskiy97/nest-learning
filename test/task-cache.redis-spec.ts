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
      if (await cache.get(1, filters, 1n)) return;
      if (seed)
        await cache.set(
          1,
          filters,
          {
            items: [],
            total: 0,
            page: 1,
            limit: 10,
            totalPages: 0,
          },
          1n,
        );
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
    await admin.del(app.get(TasksCacheService).key(1, filters, 1n));
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
    const ttl = await admin.pTTL(
      app.get(TasksCacheService).key(1, filters, 1n),
    );
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
    const key = app.get(TasksCacheService).key(1, filters, 1n);
    await delay(1100);
    await get().expect(200);
    expect(await admin.pTTL(key)).toBeLessThan(1100);
    await delay(1050);
    const transaction = jest.spyOn(database.prisma, '$transaction');
    await get().expect(200);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('invalidates immediately after create, update and delete', async () => {
    await get().expect(200);
    await request(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Новая' })
      .expect(201);
    const created = await get().expect(200);
    expect(created.body).toMatchObject({ total: 3 });
    await request(app.getHttpServer())
      .patch('/tasks/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Изменено', version: 1 })
      .expect(200);
    const updated = await get().expect(200);
    expect(updated.body).toMatchObject({
      items: [
        { title: 'Изменено', version: 2 },
        { title: 'Готовая' },
        { title: 'Новая' },
      ],
    });
    await request(app.getHttpServer())
      .delete('/tasks/2')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
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
      const key = app.get(TasksCacheService).key(1, filters, 1n);
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
      app.get(TasksCacheService).key(1, filters, 1n),
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

  async function generation(ownerId = 1): Promise<bigint> {
    const user = await database.prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { taskCacheGeneration: true },
    });
    return user.taskCacheGeneration;
  }

  it('invalidates all filter/page variants but not another author', async () => {
    await get({ completed: 'false' }).expect(200);
    await get({ completed: 'true' }).expect(200);
    await get({ page: 2, limit: 1 }).expect(200);
    await get({ assigneeId: 2 }).expect(200);
    const otherToken = await app.get(JwtService).signAsync({ sub: 2 });
    await get({}, otherToken).expect(200);
    await request(app.getHttpServer())
      .patch('/tasks/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ completed: true, assigneeId: 2, version: 1 })
      .expect(200);
    expect(await generation()).toBe(2n);
    expect(await generation(2)).toBe(1n);
    const transaction = jest.spyOn(database.prisma, '$transaction');
    await get({}, otherToken).expect(200);
    expect(transaction).not.toHaveBeenCalled();
    const pending = await get({ completed: 'false' }).expect(200);
    expect(pending.body).toMatchObject({ total: 0 });
    const done = await get({ completed: 'true' }).expect(200);
    expect(done.body).toMatchObject({ total: 2 });
    await get({ page: 2, limit: 1 }).expect(200);
    const assigned = await get({ assigneeId: 2 }).expect(200);
    expect(assigned.body).toMatchObject({
      total: 1,
      items: [{ title: 'Первая' }],
    });
    expect(transaction).toHaveBeenCalledTimes(4);
  });

  it('invalidates across instances without updating Redis generation metadata', async () => {
    await get().expect(200);
    const secondApp = await startApp();
    await waitForCache(secondApp);
    await request(secondApp.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Из другого API' })
      .expect(201);
    const fresh = await get().expect(200);
    expect(fresh.body).toMatchObject({ total: 3 });
    expect(await generation()).toBe(2n);
    // Old pages may still physically exist, but no new read selects their key.
    expect(
      await admin.exists(app.get(TasksCacheService).key(1, filters, 1n)),
    ).toBe(1);
  });

  it('does not let a late cache SET resurrect an invalidated page', async () => {
    const cache = app.get(TasksCacheService);
    const originalSet = cache.set.bind(cache);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(cache, 'set').mockImplementationOnce(async (...args) => {
      entered();
      await releasePromise;
      await originalSet(...args);
    });
    const oldRead = get()
      .expect(200)
      .then((response) => response);
    try {
      await enteredPromise;
      await request(app.getHttpServer())
        .post('/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'После чтения' })
        .expect(201);
    } finally {
      release();
    }
    const old = await oldRead;
    expect(old.body).toMatchObject({ total: 2 });
    const late = await admin.get(cache.key(1, filters, 1n));
    expect(late).not.toBeNull();
    const fresh = await get().expect(200);
    expect(fresh.body).toMatchObject({ total: 3 });
    expect(await admin.exists(cache.key(1, filters, 2n))).toBe(1);
  });

  it('does not advance generation on failed mutations', async () => {
    await get().expect(200);
    await request(app.getHttpServer())
      .patch('/tasks/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Нет', version: 999 })
      .expect(409);
    await request(app.getHttpServer())
      .patch('/tasks/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ assigneeId: 999, version: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .delete('/tasks/999')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(await generation()).toBe(1n);
    const transaction = jest.spyOn(database.prisma, '$transaction');
    await get().expect(200);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('advances once for concurrent idempotent creation, never for replay', async () => {
    const key = randomUUID();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app.getHttpServer())
          .post('/tasks')
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send({ title: 'Одна операция' })
          .expect(201),
      ),
    );
    expect(await generation()).toBe(2n);
    expect(await database.prisma.task.count()).toBe(4);
    await get().expect(200);
    const transaction = jest.spyOn(database.prisma, '$transaction');
    await request(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ title: 'Одна операция' })
      .expect(201);
    await get().expect(200);
    expect(transaction).not.toHaveBeenCalled();
    expect(await generation()).toBe(2n);
  });

  it('keeps generation current while Redis is offline, then ignores old pages', async () => {
    await get().expect(200);
    options = { ...options, url: 'redis://127.0.0.1:1' };
    const offlineApp = await startApp();
    await request(offlineApp.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Без Redis' })
      .expect(201);
    expect(await generation()).toBe(2n);
    const fresh = await get().expect(200);
    expect(fresh.body).toMatchObject({ total: 3 });
  });

  it('does not lose generation increments on independent concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        request(app.getHttpServer())
          .post('/tasks')
          .set('Authorization', `Bearer ${token}`)
          .send({ title: `Новая ${index}` })
          .expect(201),
      ),
    );
    expect(await generation()).toBe(9n);
    expect(await generation(2)).toBe(1n);
    const result = await get().expect(200);
    expect(result.body).toMatchObject({ total: 10 });
  });

  it('rolls back task writes and idempotency records if generation update fails', async () => {
    // The constraint exists ONLY in this randomly named test schema.
    await database.prisma
      .$executeRawUnsafe(`ALTER TABLE "${database.schema}"."User"
      ADD CONSTRAINT "test_generation_ceiling" CHECK ("taskCacheGeneration" <= 1)`);
    const key = randomUUID();
    try {
      await request(app.getHttpServer())
        .post('/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Без ключа, не фиксировать' })
        .expect(500);
      await request(app.getHttpServer())
        .post('/tasks')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({ title: 'Не фиксировать' })
        .expect(500);
      await request(app.getHttpServer())
        .patch('/tasks/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Не фиксировать', version: 1 })
        .expect(500);
      await request(app.getHttpServer())
        .delete('/tasks/1')
        .set('Authorization', `Bearer ${token}`)
        .expect(500);
      expect(await generation()).toBe(1n);
      expect(await database.prisma.task.count()).toBe(3);
      expect(await database.prisma.taskCreationRequest.count()).toBe(0);
      expect(
        await database.prisma.task.findUnique({ where: { id: 1 } }),
      ).toMatchObject({ title: 'Первая', version: 1 });
    } finally {
      await database.prisma
        .$executeRawUnsafe(`ALTER TABLE "${database.schema}"."User"
        DROP CONSTRAINT "test_generation_ceiling"`);
    }
    await request(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ title: 'Не фиксировать' })
      .expect(201);
    expect(await generation()).toBe(2n);
  });
});
