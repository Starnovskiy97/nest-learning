import { Logger } from '@nestjs/common';
import { createClient } from 'redis';
import { FilterTasksDto } from './dto/filter-tasks.dto';
import { TasksCacheService } from './tasks-cache.service';

jest.mock('redis', () => ({ createClient: jest.fn() }));

describe('TasksCacheService failure boundaries', () => {
  const options = {
    url: 'redis://localhost:6380',
    namespace: 'unit:tasks',
    ttlSeconds: 5,
  };
  const filters = new FilterTasksDto();
  const page = { items: [], total: 0, page: 1, limit: 10, totalPages: 0 };
  let service: TasksCacheService;
  let get: jest.Mock;
  let set: jest.Mock;
  let client: {
    isReady: boolean;
    isOpen: boolean;
    on: jest.Mock;
    connect: jest.Mock;
    destroy: jest.Mock;
    withCommandOptions: jest.Mock;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    get = jest.fn().mockResolvedValue(null);
    set = jest.fn().mockResolvedValue('OK');
    client = {
      isReady: true,
      isOpen: true,
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
      withCommandOptions: jest.fn().mockReturnValue({ get, set }),
    };
    jest
      .mocked(createClient)
      .mockReturnValue(client as unknown as ReturnType<typeof createClient>);
    service = new TasksCacheService(options);
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('does not create a Redis connection when explicitly disabled', async () => {
    service = new TasksCacheService({ ...options, url: '' });
    service.onModuleInit();
    expect(createClient).not.toHaveBeenCalled();
    expect(await service.get(1, filters, 1n)).toBeNull();
  });

  it('does not enqueue reads or writes while not ready', async () => {
    service.onModuleInit();
    client.isReady = false;
    expect(await service.get(1, filters, 1n)).toBeNull();
    await service.set(1, filters, page, 1n);
    expect(client.withCommandOptions).not.toHaveBeenCalled();
  });

  it('turns a GET error into a cache miss and bounds command waiting', async () => {
    service.onModuleInit();
    get.mockRejectedValueOnce(new Error('Command timeout'));
    expect(await service.get(1, filters, 1n)).toBeNull();
    expect(client.withCommandOptions).toHaveBeenCalledWith({ timeout: 100 });
  });

  it('does not fail a successful database read when SET fails', async () => {
    service.onModuleInit();
    set.mockRejectedValueOnce(new Error('Redis out of memory'));
    await expect(service.set(1, filters, page, 1n)).resolves.toBeUndefined();
    expect(set).toHaveBeenCalledWith(
      service.key(1, filters, 1n),
      JSON.stringify(page),
      { EX: 5 },
    );
  });

  it('closes the connection on module destruction', () => {
    service.onModuleInit();
    service.onModuleDestroy();
    expect(client.destroy).toHaveBeenCalled();
  });

  it('separates generations without converting bigint to a lossy number', () => {
    expect(service.key(1, filters, 1n)).not.toBe(service.key(1, filters, 2n));
    expect(service.key(1, filters, 9007199254740993n)).toContain(
      ':g9007199254740993:',
    );
  });
});
