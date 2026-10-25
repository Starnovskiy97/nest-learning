-- Existing users keep their data and have no login credentials yet.
ALTER TABLE "User"
ADD COLUMN "email" TEXT,
ADD COLUMN "passwordHash" TEXT;

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
