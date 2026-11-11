CREATE TABLE "companies" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "companies_slug_key" ON "companies"("slug");

CREATE TABLE "user_companies" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "companyId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_companies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_companies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "user_companies_userId_companyId_key" ON "user_companies"("userId", "companyId");
CREATE INDEX "user_companies_companyId_idx" ON "user_companies"("companyId");

ALTER TABLE "workspaces" ADD COLUMN "companyId" INTEGER REFERENCES "companies" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "workspaces_companyId_idx" ON "workspaces"("companyId");
ALTER TABLE "workspaces" ADD COLUMN "privateOwnerId" INTEGER;
CREATE INDEX "workspaces_privateOwnerId_idx" ON "workspaces"("privateOwnerId");

CREATE TABLE "google_drive_connections" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "scope" TEXT NOT NULL,
    "userId" INTEGER,
    "companyId" INTEGER,
    "googleEmail" TEXT,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "pageToken" TEXT,
    "syncRequested" BOOLEAN NOT NULL DEFAULT true,
    "channelId" TEXT,
    "channelTokenHash" TEXT,
    "channelResourceId" TEXT,
    "channelExpiration" DATETIME,
    "lastSyncAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "google_drive_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "google_drive_connections_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "google_drive_connections_userId_key" ON "google_drive_connections"("userId");
CREATE UNIQUE INDEX "google_drive_connections_companyId_key" ON "google_drive_connections"("companyId");
CREATE UNIQUE INDEX "google_drive_connections_channelId_key" ON "google_drive_connections"("channelId");
CREATE INDEX "google_drive_connections_scope_idx" ON "google_drive_connections"("scope");

CREATE TABLE "google_drive_oauth_config" (
    "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
    "clientId" TEXT NOT NULL,
    "clientSecretEncrypted" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "google_drive_oauth_states" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "stateHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "companyId" INTEGER,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "google_drive_oauth_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "google_drive_oauth_states_stateHash_key" ON "google_drive_oauth_states"("stateHash");
CREATE INDEX "google_drive_oauth_states_expiresAt_idx" ON "google_drive_oauth_states"("expiresAt");

CREATE TABLE "google_drive_folders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "connectionId" INTEGER NOT NULL,
    "driveFolderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "addedByUserId" INTEGER,
    "workspaceId" INTEGER,
    "lastSyncAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "google_drive_folders_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "google_drive_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "google_drive_folders_connectionId_driveFolderId_key" ON "google_drive_folders"("connectionId", "driveFolderId");
CREATE INDEX "google_drive_folders_status_scope_idx" ON "google_drive_folders"("status", "scope");
CREATE INDEX "google_drive_folders_workspaceId_idx" ON "google_drive_folders"("workspaceId");

CREATE TABLE "google_drive_files" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "folderId" INTEGER NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "modifiedTime" TEXT,
    "md5Checksum" TEXT,
    "localPath" TEXT,
    "docId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "google_drive_files_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "google_drive_folders" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "google_drive_files_folderId_driveFileId_key" ON "google_drive_files"("folderId", "driveFileId");
CREATE INDEX "google_drive_files_status_idx" ON "google_drive_files"("status");

CREATE TABLE "google_drive_file_indexes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "driveFileId" INTEGER NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "docpath" TEXT NOT NULL,
    "docId" TEXT,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "google_drive_file_indexes_driveFileId_fkey" FOREIGN KEY ("driveFileId") REFERENCES "google_drive_files" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "google_drive_file_indexes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "google_drive_file_indexes_driveFileId_workspaceId_docpath_key" ON "google_drive_file_indexes"("driveFileId", "workspaceId", "docpath");
CREATE INDEX "google_drive_file_indexes_workspaceId_idx" ON "google_drive_file_indexes"("workspaceId");
