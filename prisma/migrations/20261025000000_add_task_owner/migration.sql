-- The author of existing tasks is unknown: preserve them without granting access.
ALTER TABLE "Task" ADD COLUMN "ownerId" INTEGER;

CREATE INDEX "Task_ownerId_id_idx" ON "Task"("ownerId", "id");

ALTER TABLE "Task" ADD CONSTRAINT "Task_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
