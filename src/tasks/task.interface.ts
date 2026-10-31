export interface Task {
  id: number;
  title: string;
  completed: boolean;
  version: number;
  assigneeId: number | null;
  ownerId: number | null;
}
