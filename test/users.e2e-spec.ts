import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import supertest from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestDatabase } from './test-database';
import { createTaskOwner, TEST_OWNER_ID } from './task-owner.fixture';

describe('Users (e2e)', () => {
  let app: INestApplication<App>;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let ownerToken: string;

  function request(server: App) {
    return supertest.agent(server).set('Authorization', `Bearer ${ownerToken}`);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.close();
  });

  async function startApp(): Promise<INestApplication<App>> {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(database.prisma)
      .compile();

    const application =
      moduleFixture.createNestApplication<INestApplication<App>>();
    application.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await application.init();
    ownerToken = await application
      .get(JwtService)
      .signAsync({ sub: TEST_OWNER_ID });
    return application;
  }

  beforeEach(async () => {
    await database.reset();
    app = await startApp();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('starts with an empty list', () => {
    return request(app.getHttpServer()).get('/users').expect(200).expect([]);
  });

  it('keeps users after restarting the application', async () => {
    const user = { id: 1, name: 'Сохранённый пользователь', email: null };

    await request(app.getHttpServer())
      .post('/users')
      .send({ name: user.name })
      .expect(201)
      .expect(user);

    await app.close();
    app = await startApp();

    await request(app.getHttpServer()).get('/users/1').expect(200).expect(user);
  });

  it('persists task updates, assignment and deletion across restarts', async () => {
    await createTaskOwner(database.prisma);
    await request(app.getHttpServer())
      .post('/users')
      .send({ name: 'Анна' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/tasks')
      .send({ title: 'Сохранить задачу' })
      .expect(201);

    const task = {
      id: 1,
      title: 'Задача сохранена',
      completed: true,
      assigneeId: 1,
      ownerId: TEST_OWNER_ID,
    };

    await request(app.getHttpServer())
      .patch('/tasks/1')
      .send({ title: task.title, completed: true, assigneeId: 1 })
      .expect(200)
      .expect(task);

    await app.close();
    app = await startApp();

    await request(app.getHttpServer()).get('/tasks/1').expect(200).expect(task);
    await request(app.getHttpServer())
      .get('/tasks')
      .expect(200)
      .expect({
        items: [task],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      });
    await request(app.getHttpServer())
      .delete('/tasks/1')
      .expect(204)
      .expect('');

    await app.close();
    app = await startApp();

    await request(app.getHttpServer()).get('/tasks/1').expect(404);
    await request(app.getHttpServer()).get('/tasks').expect(200).expect({
      items: [],
      total: 0,
      page: 1,
      limit: 10,
      totalPages: 0,
    });
    await request(app.getHttpServer())
      .get('/users/1')
      .expect(200)
      .expect({ id: 1, name: 'Анна', email: null });
  });

  it('enforces the assignee foreign key in PostgreSQL', async () => {
    await createTaskOwner(database.prisma);
    await expect(
      database.prisma.task.create({
        data: { title: 'Несуществующий исполнитель', assigneeId: 999 },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });

    await request(app.getHttpServer()).get('/tasks').expect(200).expect({
      items: [],
      total: 0,
      page: 1,
      limit: 10,
      totalPages: 0,
    });
  });

  it('creates users with distinct ids and retrieves them', async () => {
    const firstUser = { id: 1, name: 'Анна', email: null };
    const secondUser = { id: 2, name: 'Иван', email: null };

    await request(app.getHttpServer())
      .post('/users')
      .send({ name: firstUser.name })
      .expect(201)
      .expect(firstUser);

    await request(app.getHttpServer())
      .post('/users')
      .send({ name: secondUser.name })
      .expect(201)
      .expect(secondUser);

    await request(app.getHttpServer())
      .get('/users/1')
      .expect(200)
      .expect(firstUser);

    await request(app.getHttpServer())
      .get('/users')
      .expect(200)
      .expect([firstUser, secondUser]);
  });

  it('returns 404 for a missing user', () => {
    return request(app.getHttpServer()).get('/users/999').expect(404).expect({
      message: 'User with id 999 not found',
      error: 'Not Found',
      statusCode: 404,
    });
  });

  it('returns 400 for a non-integer id', () => {
    return request(app.getHttpServer()).get('/users/abc').expect(400);
  });

  it('assigns and reassigns a task using the shared users service', async () => {
    await createTaskOwner(database.prisma);
    for (const name of ['Анна', 'Иван']) {
      await request(app.getHttpServer())
        .post('/users')
        .send({ name })
        .expect(201);
    }

    const task = {
      id: 1,
      title: 'Назначить исполнителя',
      completed: false,
      assigneeId: null,
      ownerId: TEST_OWNER_ID,
    };

    await request(app.getHttpServer())
      .post('/tasks')
      .send({ title: task.title })
      .expect(201);

    for (const assigneeId of [1, 2]) {
      await request(app.getHttpServer())
        .patch('/tasks/1')
        .send({ assigneeId })
        .expect(200)
        .expect({ ...task, assigneeId });
    }

    await request(app.getHttpServer())
      .patch('/tasks/1')
      .send({ completed: true })
      .expect(200)
      .expect({ ...task, assigneeId: 2, completed: true });

    await request(app.getHttpServer())
      .get('/tasks/1')
      .expect(200)
      .expect({ ...task, assigneeId: 2, completed: true });
  });

  it('rejects a missing assignee without partially changing the task', async () => {
    await createTaskOwner(database.prisma);
    const task = {
      id: 1,
      title: 'Без изменений',
      completed: false,
      assigneeId: null,
      ownerId: TEST_OWNER_ID,
    };

    await request(app.getHttpServer())
      .post('/tasks')
      .send({ title: task.title })
      .expect(201);

    await request(app.getHttpServer())
      .patch('/tasks/1')
      .send({ title: 'Не сохранять', completed: true, assigneeId: 999 })
      .expect(404)
      .expect({
        message: 'User with id 999 not found',
        error: 'Not Found',
        statusCode: 404,
      });

    await request(app.getHttpServer()).get('/tasks/1').expect(200).expect(task);
  });

  it.each([0, -1, 1.5, '1', null, true])(
    'rejects invalid assignee id: %j',
    async (assigneeId) => {
      await createTaskOwner(database.prisma);
      await request(app.getHttpServer())
        .patch('/tasks/1')
        .send({ assigneeId })
        .expect(400);
    },
  );

  it('returns 404 when assigning a missing task', async () => {
    await createTaskOwner(database.prisma);
    await request(app.getHttpServer())
      .patch('/tasks/999')
      .send({ assigneeId: 1 })
      .expect(404);
  });

  it.each([
    {},
    { name: '' },
    { name: '   ' },
    { name: 123 },
    { name: null },
    { name: 'Анна', id: 100 },
  ])('rejects invalid creation without saving a user: %j', async (body) => {
    await request(app.getHttpServer()).post('/users').send(body).expect(400);
    await request(app.getHttpServer()).get('/users').expect(200).expect([]);
  });
});
