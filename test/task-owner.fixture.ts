import type { PrismaClient } from '../src/generated/prisma/client';

// Explicit ID keeps the existing user fixtures (IDs 1, 2, ...) unchanged.
export const TEST_OWNER_ID = 2147483647;

export async function createTaskOwner(prisma: PrismaClient): Promise<void> {
  await prisma.user.create({
    data: { id: TEST_OWNER_ID, name: 'Тестовый автор' },
  });
}
