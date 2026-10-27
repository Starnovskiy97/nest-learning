import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { FilterTasksDto } from './dto/filter-tasks.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import type { TaskPage } from './task-page.interface';
import type { Task } from './task.interface';

@Injectable()
export class TasksService {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
  ) {}

  async findAll(
    ownerId: number,
    filters: FilterTasksDto = new FilterTasksDto(),
  ): Promise<TaskPage> {
    const { page, limit } = filters;
    const skip = (page - 1) * limit;

    if (skip > 2147483647) {
      throw new BadRequestException('Pagination offset is too large');
    }

    const where: Prisma.TaskWhereInput = {
      ownerId,
      completed: filters.completed,
      assigneeId: filters.assigneeId,
    };

    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.task.findMany({
          where,
          orderBy: { id: 'asc' },
          skip,
          take: limit,
        }),
        this.prisma.task.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: number, ownerId: number): Promise<Task> {
    const task = await this.prisma.task.findUnique({ where: { id, ownerId } });

    if (!task) {
      throw new NotFoundException(`Task with id ${id} not found`);
    }

    return task;
  }

  async remove(id: number, ownerId: number): Promise<void> {
    try {
      await this.prisma.task.delete({ where: { id, ownerId } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException(`Task with id ${id} not found`);
      }

      throw error;
    }
  }

  async update(
    id: number,
    updateTaskDto: UpdateTaskDto,
    ownerId: number,
  ): Promise<Task> {
    const current = await this.findOne(id, ownerId);
    if (current.version !== updateTaskDto.version) {
      throw new ConflictException(
        'Task has changed; reload it before updating',
      );
    }

    if (updateTaskDto.assigneeId !== undefined) {
      await this.usersService.findOne(updateTaskDto.assigneeId);
    }

    try {
      return await this.prisma.task.update({
        where: { id, ownerId, version: updateTaskDto.version },
        data: {
          title: updateTaskDto.title,
          completed: updateTaskDto.completed,
          assigneeId: updateTaskDto.assigneeId,
          version: { increment: 1 },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025') {
          // The initial read is not a lock: a concurrent PATCH may have won.
          // Keep missing/foreign tasks as 404; otherwise report a stale version.
          await this.findOne(id, ownerId);
          throw new ConflictException(
            'Task has changed; reload it before updating',
          );
        }

        if (error.code === 'P2003' && updateTaskDto.assigneeId !== undefined) {
          throw new NotFoundException(
            `User with id ${updateTaskDto.assigneeId} not found`,
          );
        }
      }

      throw error;
    }
  }

  async create(
    createTaskDto: CreateTaskDto,
    ownerId: number,
    idempotencyKey?: string,
  ): Promise<Task> {
    const data = { title: createTaskDto.title, ownerId };
    if (idempotencyKey === undefined) {
      return this.prisma.task.create({ data });
    }
    if (!isUUID(idempotencyKey, '4')) {
      throw new BadRequestException('Idempotency-Key must be a UUID v4');
    }

    const key = idempotencyKey.toLowerCase();
    const where = { ownerId_key: { ownerId, key } };
    const existing = await this.prisma.taskCreationRequest.findUnique({
      where,
    });
    if (existing) return this.replayCreation(existing, createTaskDto);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const task = await tx.task.create({ data });
        await tx.taskCreationRequest.create({
          data: { ownerId, key, title: task.title, taskId: task.id },
        });
        return task;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // A concurrent winner committed this key. Our task was rolled back.
        // Read OUTSIDE the failed transaction, which PostgreSQL has aborted.
        const winner = await this.prisma.taskCreationRequest.findUnique({
          where,
        });
        if (winner) return this.replayCreation(winner, createTaskDto);
      }
      throw error;
    }
  }

  private replayCreation(
    snapshot: { ownerId: number; title: string; taskId: number },
    dto: CreateTaskDto,
  ): Task {
    if (snapshot.title !== dto.title) {
      throw new ConflictException(
        'Idempotency key was already used with a different request body',
      );
    }

    // POST /tasks always starts with these defaults. Replay the original result,
    // not the task's current state (it may have been updated or deleted).
    return {
      id: snapshot.taskId,
      title: snapshot.title,
      ownerId: snapshot.ownerId,
      completed: false,
      version: 1,
      assigneeId: null,
    };
  }
}
