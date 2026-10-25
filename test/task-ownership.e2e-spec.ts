import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestDatabase } from './test-database';

describe('Task ownership (e2e)', () => {
  let app: INestApplication<App>;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let ownerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.reset();
    await database.prisma.user.createMany({
      data: [{ name: 'Автор' }, { name: 'Другой пользователь' }],
    });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(database.prisma)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    ownerToken = await app.get(JwtService).signAsync({ sub: 1 });
    otherToken = await app.get(JwtService).signAsync({ sub: 2 });
  });

  afterEach(async () => {
    await app?.close();
  });

  it.each([
    { method: 'get', path: '/tasks' },
    { method: 'get', path: '/tasks/1' },
    { method: 'post', path: '/tasks' },
    { method: 'patch', path: '/tasks/1' },
    { method: 'delete', path: '/tasks/1' },
  ] as const)(
    'requires authentication: $method $path',
    async ({ method, path }) => {
      await request(app.getHttpServer())[method](path).expect(401);
    },
  );

  it('rejects an invalid token on the tasks controller', () => {
    return request(app.getHttpServer())
      .get('/tasks')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
  });

  it('takes the author from the authenticated request', async () => {
    await request(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Моя задача' })
      .expect(201)
      .expect({
        id: 1,
        title: 'Моя задача',
        completed: false,
        assigneeId: null,
        ownerId: 1,
      });

    await request(app.getHttpServer())
      .get('/tasks')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200)
      .expect({ items: [], total: 0, page: 1, limit: 10, totalPages: 0 });
  });

  it('scopes filtering, pagination and counts to the current author', async () => {
    const tasks = [
      {
        id: 1,
        title: 'Моя первая',
        ownerId: 1,
        assigneeId: 2,
        completed: false,
      },
      { id: 2, title: 'Чужая', ownerId: 2, assigneeId: 2, completed: false },
      {
        id: 3,
        title: 'Моя вторая',
        ownerId: 1,
        assigneeId: 2,
        completed: false,
      },
      {
        id: 4,
        title: 'Моя готовая',
        ownerId: 1,
        assigneeId: 2,
        completed: true,
      },
      {
        id: 5,
        title: 'Старая',
        ownerId: null,
        assigneeId: 2,
        completed: false,
      },
    ];
    await database.prisma.task.createMany({ data: tasks });

    await request(app.getHttpServer())
      .get('/tasks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .query({ completed: 'false', assigneeId: '2', page: '2', limit: '1' })
      .expect(200)
      .expect({
        items: [tasks[2]],
        total: 2,
        page: 2,
        limit: 1,
        totalPages: 2,
      });

    await request(app.getHttpServer())
      .get('/tasks')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200)
      .expect({
        items: [tasks[1]],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      });
  });

  it.each(['get', 'patch', 'delete'] as const)(
    "does not let an assignee access another author's task: %s",
    async (method) => {
      const task = await database.prisma.task.create({
        data: { title: 'Только автор', ownerId: 1, assigneeId: 2 },
      });

      const req = request(app.getHttpServer())
        [method](`/tasks/${task.id}`)
        .set('Authorization', `Bearer ${otherToken}`);
      if (method === 'patch')
        req.send({ title: 'Не сохранять', assigneeId: 1 });

      await req.expect(404).expect({
        message: `Task with id ${task.id} not found`,
        error: 'Not Found',
        statusCode: 404,
      });
      expect(
        await database.prisma.task.findUnique({ where: { id: task.id } }),
      ).toEqual(task);

      await request(app.getHttpServer())
        .get(`/tasks/${task.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
        .expect(task);
    },
  );

  it('keeps ownerless legacy tasks inaccessible and preserves them', async () => {
    const task = await database.prisma.task.create({
      data: { title: 'Автор неизвестен', assigneeId: 1 },
    });

    for (const method of ['get', 'patch', 'delete'] as const) {
      const req = request(app.getHttpServer())
        [method](`/tasks/${task.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      if (method === 'patch') req.send({ title: 'Не сохранять' });
      await req.expect(404);
    }

    await request(app.getHttpServer())
      .get('/tasks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200)
      .expect({ items: [], total: 0, page: 1, limit: 10, totalPages: 0 });
    expect(
      await database.prisma.task.findUnique({ where: { id: task.id } }),
    ).toEqual(task);
  });

  it('does not allow setting the author through the request body or query', async () => {
    await request(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Подмена автора', ownerId: 2 })
      .expect(400);
    expect(await database.prisma.task.count()).toBe(0);

    const task = await database.prisma.task.create({
      data: { title: 'Без смены автора', ownerId: 1 },
    });
    await request(app.getHttpServer())
      .patch(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ownerId: 2 })
      .expect(400);
    await request(app.getHttpServer())
      .get('/tasks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .query({ ownerId: 2 })
      .expect(400);
    expect(
      await database.prisma.task.findUnique({ where: { id: task.id } }),
    ).toEqual(task);
  });
});
