import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestDatabase } from './test-database';

describe('Task creation idempotency (e2e)', () => {
  let app: INestApplication<App>;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let token: string;

  async function startApp() {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(database.prisma)
      .compile();
    const application = module.createNestApplication<INestApplication<App>>();
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

  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });
  beforeEach(async () => {
    await database.reset();
    await database.prisma.user.createMany({
      data: [{ name: 'Автор' }, { name: 'Другой' }],
    });
    app = await startApp();
    token = await app.get(JwtService).signAsync({ sub: 1 });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  function create(
    key?: string,
    title = 'Купить молоко',
    accessToken = token,
    application = app,
  ) {
    const req = request(application.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${accessToken}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send({ title });
  }

  it('keeps ordinary creation without a key unchanged', async () => {
    await create().expect(201);
    await create().expect(201);
    expect(await database.prisma.task.count()).toBe(2);
    expect(await database.prisma.taskCreationRequest.count()).toBe(0);
  });

  it('replays a successful creation after application restart', async () => {
    const key = randomUUID();
    const first = await create(key).expect(201);
    await app.close();
    app = await startApp();
    const second = await create(key.toUpperCase()).expect(201);
    expect(second.body).toEqual(first.body);
    expect(await database.prisma.task.count()).toBe(1);
    expect(await database.prisma.taskCreationRequest.count()).toBe(1);
  });

  it('rejects a different body without changing the original result', async () => {
    const key = randomUUID();
    const first = await create(key).expect(201);
    await create(key, 'Другая задача').expect(409);
    await create(key)
      .expect(201)
      .expect(first.body as object);
    expect(await database.prisma.task.count()).toBe(1);
  });

  it('allows identical titles with different keys', async () => {
    await create(randomUUID()).expect(201);
    await create(randomUUID()).expect(201);
    expect(await database.prisma.task.count()).toBe(2);
  });

  it('scopes the key to the authenticated user', async () => {
    const key = randomUUID();
    const otherToken = await app.get(JwtService).signAsync({ sub: 2 });
    const first = await create(key).expect(201);
    const second = await create(key, 'Чужая задача', otherToken).expect(201);
    expect(first.body).toMatchObject({ ownerId: 1 });
    expect(second.body).toMatchObject({ ownerId: 2, title: 'Чужая задача' });
    expect(await database.prisma.task.count()).toBe(2);
  });

  it('replays the creation snapshot after update and deletion, without resurrection', async () => {
    const key = randomUUID();
    const first = await create(key).expect(201);
    const { id } = first.body as { id: number };
    await request(app.getHttpServer())
      .patch(`/tasks/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Изменено', completed: true })
      .expect(200);
    await create(key)
      .expect(201)
      .expect(first.body as object);
    expect(
      await database.prisma.task.findUnique({ where: { id } }),
    ).toMatchObject({ title: 'Изменено', completed: true });
    await request(app.getHttpServer())
      .delete(`/tasks/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    await create(key)
      .expect(201)
      .expect(first.body as object);
    expect(await database.prisma.task.count()).toBe(0);
    expect(await database.prisma.taskCreationRequest.count()).toBe(1);
  });

  it.each([
    '',
    'not-a-uuid',
    'a'.repeat(1000),
    `${randomUUID()}, ${randomUUID()}`,
  ])('rejects invalid keys: %s', async (key) => {
    await create(key).expect(400);
    expect(await database.prisma.task.count()).toBe(0);
    expect(await database.prisma.taskCreationRequest.count()).toBe(0);
  });

  it('does not consume a key on DTO validation failure', async () => {
    const key = randomUUID();
    await create(key, '   ').expect(400);
    expect(await database.prisma.taskCreationRequest.count()).toBe(0);
    await create(key).expect(201);
  });

  it('still requires authentication for a previously used key', async () => {
    const key = randomUUID();
    await create(key).expect(201);
    await request(app.getHttpServer())
      .post('/tasks')
      .set('Idempotency-Key', key)
      .send({ title: 'Купить молоко' })
      .expect(401);
  });

  it('creates one committed task for concurrent requests across two apps', async () => {
    const otherApp = await startApp();
    try {
      const key = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          create(key, 'Купить молоко', token, i % 2 ? app : otherApp).expect(
            201,
          ),
        ),
      );
      for (const response of responses)
        expect(response.body).toEqual(responses[0].body);
      expect(await database.prisma.task.count()).toBe(1);
      expect(await database.prisma.taskCreationRequest.count()).toBe(1);
    } finally {
      await otherApp.close();
    }
  });

  it('conflicts rather than double-creating for concurrent different bodies', async () => {
    const key = randomUUID();
    const responses = await Promise.all([
      create(key, 'Первая'),
      create(key, 'Вторая'),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(await database.prisma.task.count()).toBe(1);
    expect(await database.prisma.taskCreationRequest.count()).toBe(1);
  });

  it('rolls back the losing task when both initial lookups miss the key', async () => {
    // Force the race's initial observation; transactions and uniqueness are real.
    const lookup = jest
      .spyOn(database.prisma.taskCreationRequest, 'findUnique')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const key = randomUUID();
    const responses = await Promise.all([
      create(key).expect(201),
      create(key).expect(201),
    ]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await database.prisma.task.count()).toBe(1);
    expect(await database.prisma.taskCreationRequest.count()).toBe(1);
  });
});
