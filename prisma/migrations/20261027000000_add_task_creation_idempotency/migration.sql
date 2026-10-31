CREATE TABLE "TaskCreationRequest" (
    "ownerId" INTEGER NOT NULL,
    "key" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "taskId" INTEGER NOT NULL,
    CONSTRAINT "TaskCreationRequest_pkey" PRIMARY KEY ("ownerId", "key")
);

ALTER TABLE "TaskCreationRequest" ADD CONSTRAINT "TaskCreationRequest_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
