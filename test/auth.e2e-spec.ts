import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestDatabase } from './test-database';

describe('Registration (e2e)', () => {
  let app: INestApplication<App>;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  const credentials = {
    name: 'Анна',
    email: 'anna@example.com',
    password: 'a-long-test-password',
  };

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.reset();
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
  });

  afterEach(async () => {
    await app?.close();
  });

  it('normalizes email, saves a hash and never exposes credentials', async () => {
    const user = { id: 1, name: credentials.name, email: credentials.email };

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...credentials, email: '  ANNA@EXAMPLE.COM  ' })
      .expect(201)
      .expect(user);

    const stored = await database.prisma.user.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(stored.email).toBe(credentials.email);
    expect(stored.passwordHash).not.toBe(credentials.password);
    expect(stored.passwordHash).toMatch(
      /^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/,
    );

    await request(app.getHttpServer()).get('/users/1').expect(200).expect(user);
    await request(app.getHttpServer()).get('/users').expect(200).expect([user]);
  });

  it('returns 409 for an email registered with different casing', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(credentials)
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...credentials, email: 'ANNA@EXAMPLE.COM' })
      .expect(409)
      .expect({
        message: 'Email already registered',
        error: 'Conflict',
        statusCode: 409,
      });

    expect(await database.prisma.user.count()).toBe(1);
  });

  it('handles concurrent registrations of the same email', async () => {
    const responses = await Promise.all([
      request(app.getHttpServer()).post('/auth/register').send(credentials),
      request(app.getHttpServer()).post('/auth/register').send(credentials),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(await database.prisma.user.count()).toBe(1);
  });

  it('still creates legacy users without login credentials', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ name: 'Без учётной записи' })
      .expect(201)
      .expect({ id: 1, name: 'Без учётной записи', email: null });

    const stored = await database.prisma.user.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(stored.passwordHash).toBeNull();
  });

  it.each([
    {},
    { name: '' },
    { name: '   ' },
    { name: 'a'.repeat(101) },
    { email: 'not-an-email' },
    { email: null },
    { email: 123 },
    { password: 'short' },
    { password: ' '.repeat(12) },
    { password: 'a'.repeat(129) },
    { password: null },
    { password: 123456789012 },
    { passwordHash: 'must-not-be-accepted' },
    { id: 100 },
  ])('rejects invalid registration fields: %j', async (fields) => {
    const body =
      Object.keys(fields).length === 0 ? {} : { ...credentials, ...fields };

    await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(400);

    expect(await database.prisma.user.count()).toBe(0);
  });
});
