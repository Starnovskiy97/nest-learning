export interface Task {
  id: number;
  title: string;
  completed: boolean;
  assigneeId: number | null;
  ownerId: number | null;
}
