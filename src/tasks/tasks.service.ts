import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
    await this.findOne(id, ownerId);

    if (updateTaskDto.assigneeId !== undefined) {
      await this.usersService.findOne(updateTaskDto.assigneeId);
    }

    try {
      return await this.prisma.task.update({
        where: { id, ownerId },
        data: {
          title: updateTaskDto.title,
          completed: updateTaskDto.completed,
          assigneeId: updateTaskDto.assigneeId,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025') {
          throw new NotFoundException(`Task with id ${id} not found`);
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

  create(createTaskDto: CreateTaskDto, ownerId: number): Promise<Task> {
    return this.prisma.task.create({
      data: { title: createTaskDto.title, ownerId },
    });
  }
}
