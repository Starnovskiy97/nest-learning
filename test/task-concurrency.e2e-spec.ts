import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TasksService } from '../src/tasks/tasks.service';
import { createTestDatabase } from './test-database';

describe('Task optimistic concurrency (e2e)', () => {
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
    await database.prisma.task.create({
      data: { title: 'Исходная', ownerId: 1 },
    });
    app = await startApp();
    token = await app.get(JwtService).signAsync({ sub: 1 });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  function update(body: object, application = app, accessToken = token) {
    return request(application.getHttpServer())
      .patch('/tasks/1')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  function current() {
    return database.prisma.task.findUnique({ where: { id: 1 } });
  }

  it('rejects a stale update, then accepts an explicitly refreshed version', async () => {
    await update({ title: 'Первая правка', version: 1 }).expect(200);
    await update({ title: 'Старая форма', completed: true, version: 1 }).expect(
      409,
    );
    expect(await current()).toMatchObject({
      title: 'Первая правка',
      completed: false,
      version: 2,
    });
    await request(app.getHttpServer())
      .get('/tasks/1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await update({ completed: true, version: 2 }).expect(200);
    expect(await current()).toMatchObject({
      title: 'Первая правка',
      completed: true,
      version: 3,
    });
  });

  it.each([undefined, null, 0, -1, 1.5, '1', true, 2147483647, 2147483648])(
    'requires a valid integer version, got %j',
    async (version) => {
      await update({ title: 'Не сохранять', version }).expect(400);
      expect(await current()).toMatchObject({ title: 'Исходная', version: 1 });
    },
  );

  it('does not change any fields or version when the assignee is missing', async () => {
    await update({ title: 'Не сохранять', assigneeId: 999, version: 1 }).expect(
      404,
    );
    expect(await current()).toMatchObject({
      title: 'Исходная',
      assigneeId: null,
      version: 1,
    });
  });

  it("does not expose another author's task as a version conflict", async () => {
    const otherToken = await app.get(JwtService).signAsync({ sub: 2 });
    await update(
      { title: 'Не сохранять', version: 999 },
      app,
      otherToken,
    ).expect(404);
    expect(await current()).toMatchObject({ title: 'Исходная', version: 1 });
  });

  it('allows only one of twelve concurrent updates across two apps', async () => {
    const otherApp = await startApp();
    try {
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          update(
            { title: `Правка ${index}`, version: 1 },
            index % 2 ? app : otherApp,
          ),
        ),
      );
      const winners = responses.filter((response) => response.status === 200);
      expect(winners).toHaveLength(1);
      expect(
        responses.filter((response) => response.status === 409),
      ).toHaveLength(11);
      expect(await current()).toEqual(winners[0].body);
      expect(winners[0].body).toMatchObject({ version: 2 });
    } finally {
      await otherApp.close();
    }
  });

  it('checks the version in the UPDATE even if another writer wins after the read', async () => {
    const service = app.get(TasksService);
    const findOne = service.findOne.bind(service);
    jest
      .spyOn(service, 'findOne')
      .mockImplementationOnce(async (id, ownerId) => {
        const snapshot = await findOne(id, ownerId);
        await database.prisma.task.update({
          where: { id, ownerId },
          data: { title: 'Конкурент победил', version: { increment: 1 } },
        });
        return snapshot;
      });
    await update({ title: 'Не затирать', version: 1 }).expect(409);
    expect(await current()).toMatchObject({
      title: 'Конкурент победил',
      version: 2,
    });
  });

  it('returns 404 if the task is deleted between read and update', async () => {
    const service = app.get(TasksService);
    const findOne = service.findOne.bind(service);
    jest
      .spyOn(service, 'findOne')
      .mockImplementationOnce(async (id, ownerId) => {
        const snapshot = await findOne(id, ownerId);
        await database.prisma.task.delete({ where: { id, ownerId } });
        return snapshot;
      });
    await update({ title: 'Не воскрешать', version: 1 }).expect(404);
    expect(await database.prisma.task.count()).toBe(0);
  });

  it('does not allow setting the initial version through POST', async () => {
    await request(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Подмена', version: 10 })
      .expect(400);
    expect(await database.prisma.task.count()).toBe(1);
  });
});
