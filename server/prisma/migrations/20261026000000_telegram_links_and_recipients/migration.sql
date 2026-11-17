ALTER TABLE "users" ADD COLUMN "telegramChatId" TEXT;

CREATE UNIQUE INDEX "users_telegramChatId_key" ON "users"("telegramChatId");

ALTER TABLE "scheduled_jobs" ADD COLUMN "telegramRecipientIds" TEXT;

CREATE TABLE "telegram_link_tokens" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tokenHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "telegram_link_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "telegram_link_tokens_tokenHash_key" ON "telegram_link_tokens"("tokenHash");
CREATE INDEX "telegram_link_tokens_userId_idx" ON "telegram_link_tokens"("userId");
CREATE INDEX "telegram_link_tokens_expiresAt_idx" ON "telegram_link_tokens"("expiresAt");
