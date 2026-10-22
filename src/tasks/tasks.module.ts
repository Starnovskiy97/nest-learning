import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [UsersModule, PrismaModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
