import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TASK_CACHE_OPTIONS, TasksCacheService } from './tasks-cache.service';

@Module({
  imports: [UsersModule, PrismaModule, AuthModule],
  controllers: [TasksController],
  providers: [
    TasksService,
    TasksCacheService,
    {
      provide: TASK_CACHE_OPTIONS,
      useFactory: () => ({
        url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
        namespace: process.env.TASK_CACHE_NAMESPACE ?? 'nest-learning:tasks:v1',
        ttlSeconds: 5,
      }),
    },
  ],
})
export class TasksModule {}
