import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { LoginResponse } from '../src/auth/login-response.interface';
import { PasswordHasherService } from '../src/auth/password-hasher.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestDatabase } from './test-database';

describe('Login and JWT guard (e2e)', () => {
  let app: INestApplication<App>;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let passwordHash: string;

  const credentials = {
    email: 'anna@example.com',
    password: 'a-long-test-password',
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    passwordHash = await new PasswordHasherService().hash(credentials.password);
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
    return application;
  }

  beforeEach(async () => {
    await database.reset();
    app = await startApp();
  });

  afterEach(async () => {
    await app?.close();
  });

  async function createUser(): Promise<void> {
    await database.prisma.user.create({
      data: { name: 'Анна', email: credentials.email, passwordHash },
    });
  }

  it('registers, logs in, and accesses the current user after restart', async () => {
    const user = { id: 1, name: 'Анна', email: credentials.email };

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: user.name, ...credentials })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ ...credentials, email: '  ANNA@EXAMPLE.COM  ' })
      .expect(200);
    const body = response.body as LoginResponse;
    expect(body).toEqual({
      access_token: expect.any(String) as unknown,
      token_type: 'Bearer',
      expires_in: 900,
    });

    const payload = await app
      .get(JwtService)
      .verifyAsync<Record<string, unknown>>(body.access_token);
    expect(payload).toEqual({
      sub: 1,
      iat: expect.any(Number) as unknown,
      exp: expect.any(Number) as unknown,
      iss: 'nest-learning',
      aud: 'nest-learning-api',
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(900);

    await app.close();
    app = await startApp();

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.access_token}`)
      .expect(200)
      .expect(user);
  });

  it.each([
    { email: credentials.email, password: 'wrong' },
    { email: 'unknown@example.com', password: credentials.password },
  ])('returns the same 401 for incorrect credentials: $email', async (body) => {
    await createUser();

    await request(app.getHttpServer())
      .post('/auth/login')
      .send(body)
      .expect(401)
      .expect({
        message: 'Invalid email or password',
        error: 'Unauthorized',
        statusCode: 401,
      });
  });

  it('does not allow login for a user without a password hash', async () => {
    await database.prisma.user.create({
      data: { name: 'Без пароля', email: credentials.email },
    });

    await request(app.getHttpServer())
      .post('/auth/login')
      .send(credentials)
      .expect(401);
  });

  it.each([
    {},
    { email: credentials.email },
    { password: credentials.password },
    { ...credentials, email: 'not-an-email' },
    { ...credentials, password: '' },
    { ...credentials, password: 123 },
    { ...credentials, password: 'a'.repeat(129) },
    { ...credentials, unexpected: true },
  ])('rejects invalid login input: %j', async (body) => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send(body)
      .expect(400);
  });

  it.each([undefined, '', 'Basic token', 'Bearer', 'Bearer invalid-token'])(
    'rejects missing or malformed authorization: %j',
    async (authorization) => {
      const req = request(app.getHttpServer()).get('/auth/me');
      if (authorization !== undefined) req.set('Authorization', authorization);
      await req.expect(401);
    },
  );

  it.each<{
    description: string;
    payload: Record<string, unknown>;
    options: JwtSignOptions;
  }>([
    { description: 'expired', payload: { sub: 1 }, options: { expiresIn: -1 } },
    {
      description: 'wrong signature',
      payload: { sub: 1 },
      options: { secret: 'a-different-secret-for-an-invalid-token' },
    },
    {
      description: 'wrong algorithm',
      payload: { sub: 1 },
      options: { algorithm: 'HS384' },
    },
    {
      description: 'wrong issuer',
      payload: { sub: 1 },
      options: { issuer: 'another-app' },
    },
    {
      description: 'wrong audience',
      payload: { sub: 1 },
      options: { audience: 'another-api' },
    },
    {
      description: 'not active yet',
      payload: { sub: 1 },
      options: { notBefore: '1h' },
    },
    { description: 'missing sub', payload: {}, options: {} },
    { description: 'string sub', payload: { sub: '1' }, options: {} },
    { description: 'negative sub', payload: { sub: -1 }, options: {} },
    { description: 'fractional sub', payload: { sub: 1.5 }, options: {} },
    { description: 'missing user', payload: { sub: 999 }, options: {} },
  ])('rejects a token: $description', async ({ payload, options }) => {
    await createUser();
    const token = await app.get(JwtService).signAsync(payload, options);

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('rejects a correctly signed token without an expiration', async () => {
    await createUser();
    const jwtWithoutExpiry = new JwtService({
      secret: process.env.JWT_SECRET,
      signOptions: {
        algorithm: 'HS256',
        issuer: 'nest-learning',
        audience: 'nest-learning-api',
      },
    });
    const token = await jwtWithoutExpiry.signAsync({ sub: 1 });

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('rejects a token after its user has been deleted', async () => {
    await createUser();
    const token = await app.get(JwtService).signAsync({ sub: 1 });
    await database.prisma.user.delete({ where: { id: 1 } });

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('does not accept a token from a query parameter', async () => {
    await createUser();
    const token = await app.get(JwtService).signAsync({ sub: 1 });

    await request(app.getHttpServer())
      .get('/auth/me')
      .query({ access_token: token })
      .expect(401);
  });
});
