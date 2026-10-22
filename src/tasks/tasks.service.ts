import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import type { Task } from './task.interface';

@Injectable()
export class TasksService {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
  ) {}

  findAll(): Promise<Task[]> {
    return this.prisma.task.findMany({ orderBy: { id: 'asc' } });
  }

  async findOne(id: number): Promise<Task> {
    const task = await this.prisma.task.findUnique({ where: { id } });

    if (!task) {
      throw new NotFoundException(`Task with id ${id} not found`);
    }

    return task;
  }

  async remove(id: number): Promise<void> {
    try {
      await this.prisma.task.delete({ where: { id } });
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

  async update(id: number, updateTaskDto: UpdateTaskDto): Promise<Task> {
    await this.findOne(id);

    if (updateTaskDto.assigneeId !== undefined) {
      await this.usersService.findOne(updateTaskDto.assigneeId);
    }

    try {
      return await this.prisma.task.update({
        where: { id },
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

  create(createTaskDto: CreateTaskDto): Promise<Task> {
    return this.prisma.task.create({
      data: { title: createTaskDto.title },
    });
  }
}
