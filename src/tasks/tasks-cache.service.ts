import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createClient } from 'redis';
import type { FilterTasksDto } from './dto/filter-tasks.dto';
import type { TaskPage } from './task-page.interface';

export const TASK_CACHE_OPTIONS = Symbol('TASK_CACHE_OPTIONS');
export interface TaskCacheOptions {
  url: string;
  namespace: string;
  ttlSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

@Injectable()
export class TasksCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TasksCacheService.name);
  private client?: ReturnType<typeof createClient>;
  private warned = false;

  constructor(
    @Inject(TASK_CACHE_OPTIONS) private readonly options: TaskCacheOptions,
  ) {}

  onModuleInit(): void {
    if (!this.options.url) return;
    this.client = createClient({
      url: this.options.url,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 100,
      socket: { connectTimeout: 300, reconnectStrategy: () => 1000 },
    });
    this.client.on('error', () => this.warn());
    this.client.on('ready', () => {
      this.warned = false;
    });
    // Cache availability must not block application startup.
    void this.client.connect().catch(() => this.warn());
  }

  onModuleDestroy(): void {
    if (this.client?.isOpen) this.client.destroy();
  }

  get isReady(): boolean {
    return this.client?.isReady ?? false;
  }

  key(ownerId: number, filters: FilterTasksDto, generation: bigint): string {
    return `${this.options.namespace}:${ownerId}:g${generation}:${filters.completed ?? 'any'}:${filters.assigneeId ?? 'any'}:${filters.page}:${filters.limit}`;
  }

  async get(
    ownerId: number,
    filters: FilterTasksDto,
    generation: bigint,
  ): Promise<TaskPage | null> {
    if (!this.client?.isReady) return null;
    let value: string | null;
    try {
      value = await this.client
        .withCommandOptions({ timeout: 100 })
        .get(this.key(ownerId, filters, generation));
    } catch {
      this.warn();
      return null;
    }
    if (value === null) return null;
    try {
      return this.decode(value, ownerId, filters);
    } catch {
      // Invalid JSON is a cache miss, not a reason to fail the request.
      return null;
    }
  }

  async set(
    ownerId: number,
    filters: FilterTasksDto,
    page: TaskPage,
    generation: bigint,
  ): Promise<void> {
    if (!this.client?.isReady) return;
    try {
      await this.client
        .withCommandOptions({ timeout: 100 })
        .set(this.key(ownerId, filters, generation), JSON.stringify(page), {
          EX: this.options.ttlSeconds,
        });
    } catch {
      this.warn();
    }
  }

  private warn(): void {
    if (this.warned) return;
    this.warned = true;
    // Do not log the URL (it may contain credentials), keys or cached task data.
    this.logger.warn('Redis cache unavailable; using PostgreSQL');
  }

  private decode(
    raw: string,
    ownerId: number,
    filters: FilterTasksDto,
  ): TaskPage | null {
    const page: unknown = JSON.parse(raw);
    if (
      !isRecord(page) ||
      !Array.isArray(page.items) ||
      page.items.length > filters.limit ||
      page.page !== filters.page ||
      page.limit !== filters.limit ||
      typeof page.total !== 'number' ||
      !Number.isSafeInteger(page.total) ||
      page.total < page.items.length ||
      page.totalPages !== Math.ceil(page.total / filters.limit)
    )
      return null;

    const items: TaskPage['items'] = [];
    for (const item of page.items as unknown[]) {
      if (
        !isRecord(item) ||
        !isPositiveInt(item.id) ||
        typeof item.title !== 'string' ||
        typeof item.completed !== 'boolean' ||
        item.ownerId !== ownerId ||
        !isPositiveInt(item.version) ||
        (item.assigneeId !== null && !isPositiveInt(item.assigneeId)) ||
        (filters.completed !== undefined &&
          item.completed !== filters.completed) ||
        (filters.assigneeId !== undefined &&
          item.assigneeId !== filters.assigneeId)
      )
        return null;
      // Return only public fields, even if a corrupt cache entry has extra fields.
      items.push({
        id: item.id,
        title: item.title,
        completed: item.completed,
        ownerId,
        version: item.version,
        assigneeId: item.assigneeId,
      });
    }
    return {
      items,
      total: page.total,
      page: filters.page,
      limit: filters.limit,
      totalPages: page.totalPages,
    };
  }
}
