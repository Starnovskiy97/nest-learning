import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestDatabase } from './test-database';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.reset();
    const moduleFixture: TestingModule = await Test.createTestingModule({
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
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('/tasks (GET)', () => {
    return request(app.getHttpServer()).get('/tasks').expect(200).expect([]);
  });

  it('creates tasks and returns them in the list', async () => {
    const firstTask = {
      id: 1,
      title: 'Разобраться с модулями NestJS',
      completed: false,
      assigneeId: null,
    };
    const secondTask = {
      id: 2,
      title: 'Изучить контроллеры',
      completed: false,
      assigneeId: null,
    };

    await request(app.getHttpServer())
      .post('/tasks')
      .send({ title: firstTask.title })
      .expect(201)
      .expect(firstTask);

    await request(app.getHttpServer())
      .post('/tasks')
      .send({ title: secondTask.title })
      .expect(201)
      .expect(secondTask);

    await request(app.getHttpServer())
      .get('/tasks')
      .expect(200)
      .expect([firstTask, secondTask]);
  });

  it('returns a task by id', async () => {
    const task = {
      id: 1,
      title: 'Изучить параметры URL',
      completed: false,
      assigneeId: null,
    };

    await request(app.getHttpServer())
      .post('/tasks')
      .send({ title: task.title })
      .expect(201);

    await request(app.getHttpServer()).get('/tasks/1').expect(200).expect(task);
  });

  it('returns 404 when a task does not exist', () => {
    return request(app.getHttpServer()).get('/tasks/999').expect(404).expect({
      message: 'Task with id 999 not found',
      error: 'Not Found',
      statusCode: 404,
    });
  });

  it('returns 400 when the task id is not an integer', () => {
    return request(app.getHttpServer()).get('/tasks/abc').expect(400);
  });

  it('partially updates a task and persists the changes', async () => {
    const title = 'Изучить PATCH';

    await request(app.getHttpServer())
      .post('/tasks')
      .send({ title })
      .expect(201);

    await request(app.getHttpServer())
      .patch('/tasks/1')
      .send({ completed: true })
      .expect(200)
      .expect({ id: 1, title, completed: true, assigneeId: null });

    await request(app.getHttpServer())
      .patch('/tasks/1')
      .send({ title: 'Новое название' })
      .expect(200)
      .expect({
        id: 1,
        title: 'Новое название',
        completed: true,
        assigneeId: null,
      });

    await request(app.getHttpServer())
      .patch('/tasks/1')
      .send({ completed: false })
      .expect(200)
      .expect({
        id: 1,
        title: 'Новое название',
        completed: false,
        assigneeId: null,
      });

    await request(app.getHttpServer()).get('/tasks/1').expect(200).expect({
      id: 1,
      title: 'Новое название',
      completed: false,
      assigneeId: null,
    });
  });

  it('keeps a task unchanged for an empty update', async () => {
    const task = {
      id: 1,
      title: 'Без изменений',
      completed: false,
      assigneeId: null,
    };

    await request(app.getHttpServer())
      .post('/tasks')
      .send({ title: task.title })
      .expect(201);

    await request(app.getHttpServer())
      .patch('/tasks/1')
      .send({})
      .expect(200)
      .expect(task);
  });

  it('returns 404 when updating a missing task', () => {
    return request(app.getHttpServer())
      .patch('/tasks/999')
      .send({ completed: true })
      .expect(404);
  });

  it('returns 400 when updating with a non-integer id', () => {
    return request(app.getHttpServer())
      .patch('/tasks/abc')
      .send({ completed: true })
      .expect(400);
  });

  it('deletes only the selected task and returns no content', async () => {
    await request(app.getHttpServer())
      .post('/tasks')
      .send({ title: 'Удалить эту задачу' })
      .expect(201);

    const remainingTask = {
      id: 2,
      title: 'Оставить',
      completed: false,
      assigneeId: null,
    };

    await request(app.getHttpServer())
      .post('/tasks')
      .send({ title: remainingTask.title })
      .expect(201);

    await request(app.getHttpServer())
      .delete('/tasks/1')
      .expect(204)
      .expect('');

    await request(app.getHttpServer()).get('/tasks/1').expect(404);
    await request(app.getHttpServer()).delete('/tasks/1').expect(404);

    await request(app.getHttpServer())
      .get('/tasks')
      .expect(200)
      .expect([remainingTask]);
  });

  it('returns 404 when deleting a missing task', () => {
    return request(app.getHttpServer()).delete('/tasks/999').expect(404);
  });

  it('returns 400 when deleting with a non-integer id', () => {
    return request(app.getHttpServer()).delete('/tasks/abc').expect(400);
  });

  it.each([
    {},
    { title: '' },
    { title: '   ' },
    { title: 123 },
    { title: null },
    { title: 'Задача', id: 100 },
    { title: 'Задача', completed: true },
  ])('rejects invalid task creation: %j', async (body) => {
    await request(app.getHttpServer()).post('/tasks').send(body).expect(400);

    await request(app.getHttpServer()).get('/tasks').expect(200).expect([]);
  });

  it.each([
    { title: '' },
    { title: '   ' },
    { title: 123 },
    { title: null },
    { completed: 'true' },
    { completed: 1 },
    { completed: null },
    { id: 100 },
    { unexpected: 'value' },
  ])('rejects invalid task updates: %j', async (body) => {
    const task = {
      id: 1,
      title: 'Без изменений',
      completed: false,
      assigneeId: null,
    };

    await request(app.getHttpServer())
      .post('/tasks')
      .send({ title: task.title })
      .expect(201);

    await request(app.getHttpServer()).patch('/tasks/1').send(body).expect(400);

    await request(app.getHttpServer()).get('/tasks/1').expect(200).expect(task);
  });

  it.each([
    { query: {}, ids: [1, 2, 3, 4] },
    { query: { completed: 'false' }, ids: [1, 3, 4] },
    { query: { completed: 'true' }, ids: [2] },
    { query: { assigneeId: '1' }, ids: [1, 2] },
    { query: { assigneeId: '2' }, ids: [3] },
    { query: { completed: 'false', assigneeId: '1' }, ids: [1] },
    { query: { completed: 'true', assigneeId: '2' }, ids: [] },
    { query: { assigneeId: '999' }, ids: [] },
  ])('filters tasks: $query', async ({ query, ids }) => {
    await database.prisma.user.createMany({
      data: [{ name: 'Анна' }, { name: 'Иван' }],
    });

    const tasks = [
      { id: 1, title: 'Первая', completed: false, assigneeId: 1 },
      { id: 2, title: 'Вторая', completed: true, assigneeId: 1 },
      { id: 3, title: 'Третья', completed: false, assigneeId: 2 },
      { id: 4, title: 'Без исполнителя', completed: false, assigneeId: null },
    ];

    await database.prisma.task.createMany({ data: tasks });

    await request(app.getHttpServer())
      .get('/tasks')
      .query(query)
      .expect(200)
      .expect(tasks.filter((task) => ids.includes(task.id)));
  });

  it.each([
    'completed=yes',
    'completed=1',
    'completed=',
    'completed=null',
    'completed=true&completed=false',
    'assigneeId=abc',
    'assigneeId=0',
    'assigneeId=-1',
    'assigneeId=1.5',
    'assigneeId=1e2',
    'assigneeId=',
    'assigneeId=2147483648',
    'assigneeId=999999999999999999999',
    'assigneeId=1&assigneeId=2',
    'unexpected=value',
  ])('rejects invalid task filters: %s', (query) => {
    return request(app.getHttpServer()).get(`/tasks?${query}`).expect(400);
  });

  afterEach(async () => {
    await app?.close();
  });
});
