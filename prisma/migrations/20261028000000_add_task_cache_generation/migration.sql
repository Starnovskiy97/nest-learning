-- Generation changes commit atomically with task mutations; Redis stores only pages.
ALTER TABLE "User" ADD COLUMN "taskCacheGeneration" BIGINT NOT NULL DEFAULT 1;
