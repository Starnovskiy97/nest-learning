import { ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Request, Response } from 'express';
import { AppModule } from '../src/app.module';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';

async function main(): Promise<void> {
  const schema = process.env.LOAD_SCHEMA;
  const connectionString = process.env.DATABASE_URL;
  const applicationName = process.env.LOAD_APPLICATION_NAME;
  if (
    !process.send ||
    !schema ||
    !/^test_[a-f0-9]{32}$/.test(schema) ||
    !connectionString ||
    !applicationName ||
    !process.env.LOAD_METRICS_KEY
  ) {
    throw new Error('This worker must be started by pnpm lab:load');
  }
  // Each child is an independent Node process with its own five-connection pool.
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString,
        max: 5,
        application_name: applicationName,
      },
      { schema },
    ),
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  const app = module.createNestApplication();
  app.useLogger(false);
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  // Only the isolated worker has this endpoint; the real application is unchanged.
  app.use('/__load_metrics', (req: Request, res: Response) => {
    if (req.get('X-Lab-Key') !== process.env.LOAD_METRICS_KEY) {
      res.sendStatus(404);
      return;
    }
    res.json({ ...process.cpuUsage(), rss: process.memoryUsage().rss });
  });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await app.close();
    await prisma.$disconnect();
    if (process.connected) process.disconnect();
  }
  process.once('SIGTERM', () => {
    void close();
  });
  process.once('disconnect', () => {
    void close();
  });
  try {
    await app.listen(0, '0.0.0.0');
    const port = Number(new URL(await app.getUrl()).port);
    const token = await app.get(JwtService).signAsync({ sub: 1 });
    process.send({ port, token });
  } catch (error) {
    await close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Load worker failed');
  process.exitCode = 1;
});
