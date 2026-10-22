import type { Task } from './task.interface';

export interface TaskPage {
  items: Task[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
