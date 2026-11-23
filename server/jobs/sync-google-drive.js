const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const prisma = require("../utils/prisma");
const { GoogleDriveConnection } = require("../models/googleDriveConnection");
const { CollectorApi } = require("../utils/collectorApi");
const DriveApi = require("../utils/googleDriveApi");
const { Document } = require("../models/documents");
const {
  hotdirPath,
  documentsPath,
  isWithin,
  normalizePath,
  moveProcessedDocsToFolder,
} = require("../utils/files");

const RECOVERY_INTERVAL_MS = 15 * 60 * 1000;
const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const WATCH_EXPIRATION_MS = 6 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES =
  Number(process.env.GOOGLE_DRIVE_MAX_FILE_MB || 250) * 1024 * 1024;

function log(message, ...details) {
  console.log(`[GoogleDriveSync] ${message}`, ...details);
}

function deleteStoredDocumentFiles(paths = []) {
  for (const docpath of paths) {
    const fullPath = path.resolve(documentsPath, normalizePath(docpath));
    if (!isWithin(documentsPath, fullPath)) continue;
    if (fs.existsSync(fullPath)) fs.rmSync(fullPath, { force: true });
    const parent = path.dirname(fullPath);
    if (parent !== documentsPath && isWithin(documentsPath, parent)) {
      try {
        if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0)
          fs.rmdirSync(parent);
      } catch {
        // Another source may still have documents in this folder.
      }
    }
  }
}

async function removeIndexedDocuments(fileRecord) {
  const indexes = await prisma.google_drive_file_indexes.findMany({
    where: { driveFileId: fileRecord.id },
    include: { workspace: true },
  });
  const workspaceIds = [
    ...new Set(indexes.map(({ workspaceId }) => workspaceId)),
  ];
  for (const workspaceId of workspaceIds) {
    const workspace = indexes.find(
      (index) => index.workspaceId === workspaceId
    )?.workspace;
    if (!workspace) continue;
    const workspaceIndexes = indexes.filter(
      (index) => index.workspaceId === workspaceId
    );
    await Document.removeDocuments(
      workspace,
      workspaceIndexes.map(({ docpath }) => docpath)
    );
  }
  let storedPaths = [];
  try {
    storedPaths = JSON.parse(fileRecord.localPath || "[]");
  } catch {
    storedPaths = [];
  }
  const allPaths = new Set([
    ...indexes.map(({ docpath }) => docpath),
    ...(Array.isArray(storedPaths) ? storedPaths : []),
  ]);
  deleteStoredDocumentFiles([...allPaths]);
  await prisma.google_drive_file_indexes.deleteMany({
    where: { driveFileId: fileRecord.id },
  });
}

async function saveDriveFile(
  connection,
  folder,
  workspace,
  driveFile,
  accessToken
) {
  const existing = await prisma.google_drive_files.findUnique({
    where: {
      folderId_driveFileId: { folderId: folder.id, driveFileId: driveFile.id },
    },
  });
  if (existing?.blocked) {
    await removeIndexedDocuments(existing);
    await prisma.google_drive_files.update({
      where: { id: existing.id },
      data: { status: "blocked", localPath: null, lastError: null },
    });
    return;
  }
  const existingIndexCount = existing
    ? await prisma.google_drive_file_indexes.count({
        where: { driveFileId: existing.id, workspaceId: workspace.id },
      })
    : 0;
  const sameVersion =
    existing?.status === "indexed" &&
    existingIndexCount > 0 &&
    existing.modifiedTime === (driveFile.modifiedTime || null) &&
    existing.md5Checksum === (driveFile.md5Checksum || null);
  if (sameVersion) return;

  const currentFolder = await prisma.google_drive_folders.findUnique({
    where: { id: folder.id },
    select: { status: true },
  });
  if (currentFolder?.status !== "approved") return;

  if (driveFile.size && Number(driveFile.size) > MAX_FILE_BYTES) {
    const message = `Arquivo excede o limite configurado de ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB.`;
    if (existing) {
      await removeIndexedDocuments(existing);
      await prisma.google_drive_files.update({
        where: { id: existing.id },
        data: {
          name: driveFile.name,
          mimeType: driveFile.mimeType,
          modifiedTime: driveFile.modifiedTime || null,
          md5Checksum: driveFile.md5Checksum || null,
          status: "failed",
          lastError: message,
          lastSyncedAt: new Date(),
        },
      });
    } else {
      await prisma.google_drive_files.create({
        data: {
          folderId: folder.id,
          driveFileId: driveFile.id,
          name: driveFile.name,
          mimeType: driveFile.mimeType,
          modifiedTime: driveFile.modifiedTime || null,
          md5Checksum: driveFile.md5Checksum || null,
          status: "failed",
          lastError: message,
        },
      });
    }
    throw new Error(message);
  }

  const record = await prisma.google_drive_files.upsert({
    where: {
      folderId_driveFileId: { folderId: folder.id, driveFileId: driveFile.id },
    },
    update: {
      name: driveFile.name,
      mimeType: driveFile.mimeType,
      modifiedTime: driveFile.modifiedTime || null,
      md5Checksum: driveFile.md5Checksum || null,
      lastUpdatedAt: new Date(),
    },
    create: {
      folderId: folder.id,
      driveFileId: driveFile.id,
      name: driveFile.name,
      mimeType: driveFile.mimeType,
      modifiedTime: driveFile.modifiedTime || null,
      md5Checksum: driveFile.md5Checksum || null,
    },
  });

  await prisma.google_drive_files.update({
    where: { id: record.id },
    data: { status: "syncing", lastError: null },
  });
  await removeIndexedDocuments(record);

  const collector = new CollectorApi();
  if (!(await collector.online()))
    throw new Error("O processador de documentos está indisponível.");

  let temporaryFile = null;
  try {
    const downloaded = await DriveApi.downloadFile(accessToken, driveFile);
    const extension =
      downloaded.extension || path.extname(driveFile.name || "");
    const safeExtension = /^\.[a-z0-9]{1,12}$/i.test(extension)
      ? extension
      : "";
    const temporaryName = `gdrive-${connection.id}-${driveFile.id}${safeExtension}`;
    temporaryFile = path.join(hotdirPath, temporaryName);
    fs.mkdirSync(hotdirPath, { recursive: true });
    fs.writeFileSync(temporaryFile, downloaded.buffer, { flag: "w" });

    const result = await collector.processDocument(temporaryName, {
      title: driveFile.name,
      source: "google-drive",
      sourceUrl: `https://drive.google.com/open?id=${encodeURIComponent(driveFile.id)}`,
      driveFileId: driveFile.id,
      driveFolderName: folder.name,
    });
    if (!result?.success || !result.documents?.length)
      throw new Error(
        result?.reason || "O Google Drive não retornou conteúdo indexável."
      );

    const outputFolder = `google-drive-${connection.id}-${folder.id}`;
    moveProcessedDocsToFolder(result.documents, outputFolder);
    const locations = result.documents.map(({ location }) => location);
    const embedding = await Document.addDocuments(
      workspace,
      locations,
      folder.addedByUserId
    );
    const embeddedPaths = embedding.embedded || [];
    if (!embeddedPaths.length)
      throw new Error(
        (embedding.errors || []).join("; ") ||
          "Não foi possível gerar os vetores do arquivo."
      );

    const [currentRecord, currentFolder] = await Promise.all([
      prisma.google_drive_files.findUnique({
        where: { id: record.id },
        select: { blocked: true },
      }),
      prisma.google_drive_folders.findUnique({
        where: { id: folder.id },
        select: { status: true },
      }),
    ]);
    if (currentRecord?.blocked || currentFolder?.status !== "approved") {
      await Document.removeDocuments(workspace, embeddedPaths);
      deleteStoredDocumentFiles(locations);
      await prisma.google_drive_files.update({
        where: { id: record.id },
        data: {
          status: currentRecord?.blocked ? "blocked" : "pending",
          localPath: null,
          lastError: null,
        },
      });
      return;
    }

    const savedIndexes = [];
    for (const docpath of embeddedPaths) {
      const document = await prisma.workspace_documents.findFirst({
        where: { workspaceId: workspace.id, docpath },
        select: { docId: true },
      });
      savedIndexes.push({
        driveFileId: record.id,
        workspaceId: workspace.id,
        docpath,
        docId: document?.docId || null,
      });
    }
    for (const index of savedIndexes)
      await prisma.google_drive_file_indexes.create({ data: index });
    await prisma.google_drive_files.update({
      where: { id: record.id },
      data: {
        status:
          embeddedPaths.length === locations.length ? "indexed" : "partial",
        lastError: embedding.failedToEmbed?.length
          ? `Não foi possível indexar: ${embedding.failedToEmbed.join(", ")}`
          : null,
        lastSyncedAt: new Date(),
        localPath: JSON.stringify(locations),
      },
    });
  } finally {
    if (temporaryFile && fs.existsSync(temporaryFile))
      fs.rmSync(temporaryFile, { force: true });
  }
}

async function removeDriveFile(folder, driveFileId) {
  const record = await prisma.google_drive_files.findUnique({
    where: {
      folderId_driveFileId: { folderId: folder.id, driveFileId },
    },
  });
  if (!record) return;
  await removeIndexedDocuments(record);
  await prisma.google_drive_files.update({
    where: { id: record.id },
    data: { status: "deleted", lastError: null, lastSyncedAt: new Date() },
  });
}

async function scanFolder(connection, folder, accessToken) {
  const workspace = await prisma.workspaces.findUnique({
    where: { id: folder.workspaceId },
  });
  if (!workspace)
    throw new Error(`Workspace da pasta ${folder.name} não existe.`);
  const pending = [folder.driveFolderId];
  const seenFolders = new Set();
  while (pending.length) {
    const parentId = pending.shift();
    if (seenFolders.has(parentId)) continue;
    seenFolders.add(parentId);
    let pageToken = null;
    do {
      const page = await DriveApi.listChildren(
        accessToken,
        parentId,
        pageToken
      );
      for (const file of page.files || []) {
        if (file.mimeType === "application/vnd.google-apps.folder") {
          pending.push(file.id);
          continue;
        }
        try {
          await saveDriveFile(connection, folder, workspace, file, accessToken);
        } catch (error) {
          log(`Indexação do arquivo ${file.name} falhou:`, error.message);
          await prisma.google_drive_files.updateMany({
            where: { folderId: folder.id, driveFileId: file.id },
            data: {
              status: "failed",
              lastError: error.message.slice(0, 1000),
              lastSyncedAt: new Date(),
            },
          });
        }
      }
      pageToken = page.nextPageToken || null;
    } while (pageToken);
  }
  await prisma.google_drive_folders.update({
    where: { id: folder.id },
    data: { lastSyncAt: new Date(), lastError: null },
  });
}

async function isWithinSelectedFolder(accessToken, file, selectedFolderId) {
  const pending = [...(file.parents || [])];
  const seen = new Set();
  while (pending.length) {
    const parentId = pending.pop();
    if (parentId === selectedFolderId) return true;
    if (seen.has(parentId)) continue;
    seen.add(parentId);
    try {
      const parent = await DriveApi.getFile(accessToken, parentId);
      pending.push(...(parent.parents || []));
    } catch {
      // A folder may have been deleted or access revoked during this sync.
    }
  }
  return false;
}

async function applyChange(connection, folders, accessToken, change) {
  const driveFileId = change.fileId || change.file?.id;
  if (!driveFileId) return;
  const current =
    change.file ||
    (!change.removed ? await DriveApi.getFile(accessToken, driveFileId) : null);
  for (const folder of folders) {
    const wasTracked = await prisma.google_drive_files.findUnique({
      where: {
        folderId_driveFileId: { folderId: folder.id, driveFileId },
      },
      select: { id: true },
    });
    if (change.removed || !current || current.trashed) {
      await removeDriveFile(folder, driveFileId);
      continue;
    }
    const belongs = await isWithinSelectedFolder(
      accessToken,
      current,
      folder.driveFolderId
    );
    if (!belongs) {
      if (wasTracked) await removeDriveFile(folder, driveFileId);
      continue;
    }
    const workspace = await prisma.workspaces.findUnique({
      where: { id: folder.workspaceId },
    });
    if (workspace)
      await saveDriveFile(connection, folder, workspace, current, accessToken);
  }
}

async function ensureWatch(connection, accessToken, pageToken, config) {
  const renewAt = Date.now() + WATCH_RENEWAL_WINDOW_MS;
  if (
    connection.channelId &&
    connection.channelResourceId &&
    connection.channelExpiration &&
    connection.channelExpiration.getTime() > renewAt
  )
    return connection;

  const previousChannel =
    connection.channelId && connection.channelResourceId
      ? { id: connection.channelId, resourceId: connection.channelResourceId }
      : null;
  const channelId = uuidv4();
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.google_drive_connections.update({
    where: { id: connection.id },
    data: {
      channelId,
      channelTokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      channelResourceId: null,
      channelExpiration: null,
    },
  });

  try {
    const channel = await DriveApi.watchChanges(accessToken, {
      pageToken,
      address: `${config.baseUrl}/api/google-drive/webhook`,
      id: channelId,
      token,
      expiration: String(Date.now() + WATCH_EXPIRATION_MS),
    });
    const updated = await prisma.google_drive_connections.update({
      where: { id: connection.id },
      data: {
        channelResourceId: channel.resourceId,
        channelExpiration: channel.expiration
          ? new Date(Number(channel.expiration))
          : new Date(Date.now() + WATCH_EXPIRATION_MS),
      },
    });
    if (previousChannel) {
      DriveApi.stopChannel(accessToken, previousChannel).catch((error) =>
        log("Não foi possível encerrar o canal anterior:", error.message)
      );
    }
    return updated;
  } catch (error) {
    await prisma.google_drive_connections.update({
      where: { id: connection.id },
      data: {
        channelId: null,
        channelTokenHash: null,
        channelResourceId: null,
      },
    });
    throw error;
  }
}

async function syncConnection(connection) {
  let accessToken;
  try {
    accessToken = await GoogleDriveConnection.accessToken(connection);
    let pageToken = connection.pageToken;
    if (!pageToken) {
      const start = await DriveApi.getStartPageToken(accessToken);
      pageToken = start.startPageToken;
      connection = await prisma.google_drive_connections.update({
        where: { id: connection.id },
        data: { pageToken, syncRequested: true },
      });
    }

    const config = await GoogleDriveConnection.getConfig();
    connection = await ensureWatch(connection, accessToken, pageToken, config);

    const folders = await prisma.google_drive_folders.findMany({
      where: { connectionId: connection.id, status: "approved" },
      orderBy: { id: "asc" },
    });
    for (const folder of folders) {
      if (!folder.lastSyncAt) {
        try {
          await scanFolder(connection, folder, accessToken);
        } catch (error) {
          await prisma.google_drive_folders.update({
            where: { id: folder.id },
            data: { lastError: error.message.slice(0, 1000) },
          });
          log(`Varredura da pasta ${folder.name} falhou:`, error.message);
        }
      }
    }

    const retryBefore = new Date(Date.now() - RECOVERY_INTERVAL_MS);
    const retryFiles = await prisma.google_drive_files.findMany({
      where: {
        status: { in: ["failed", "partial", "pending"] },
        folder: {
          connectionId: connection.id,
          status: "approved",
        },
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lte: retryBefore } }],
      },
      include: { folder: true },
      orderBy: { lastSyncedAt: "asc" },
      take: 25,
    });
    for (const trackedFile of retryFiles) {
      try {
        const currentFile = await DriveApi.getFile(
          accessToken,
          trackedFile.driveFileId
        );
        const workspace = await prisma.workspaces.findUnique({
          where: { id: trackedFile.folder.workspaceId },
        });
        if (currentFile.trashed) {
          await removeDriveFile(trackedFile.folder, trackedFile.driveFileId);
        } else if (workspace) {
          await saveDriveFile(
            connection,
            trackedFile.folder,
            workspace,
            currentFile,
            accessToken
          );
        }
      } catch (error) {
        await prisma.google_drive_files.update({
          where: { id: trackedFile.id },
          data: {
            status: "failed",
            lastError: error.message.slice(0, 1000),
            lastSyncedAt: new Date(),
          },
        });
      }
    }

    let cursor = connection.pageToken || pageToken;
    for (let pages = 0; pages < 100; pages++) {
      const page = await DriveApi.listChanges(accessToken, cursor);
      for (const change of page.changes || []) {
        await applyChange(connection, folders, accessToken, change).catch(
          async (error) => {
            log("Falha ao aplicar alteração do Drive:", error.message);
            const fileId = change.fileId || change.file?.id;
            if (fileId)
              await prisma.google_drive_files.updateMany({
                where: {
                  driveFileId: fileId,
                  folder: { connectionId: connection.id },
                },
                data: {
                  status: "failed",
                  lastError: error.message.slice(0, 1000),
                  lastSyncedAt: new Date(),
                },
              });
          }
        );
      }
      if (!page.nextPageToken) {
        cursor = page.newStartPageToken || cursor;
        break;
      }
      cursor = page.nextPageToken;
    }

    await prisma.google_drive_connections.update({
      where: { id: connection.id },
      data: {
        pageToken: cursor,
        syncRequested: false,
        lastSyncAt: new Date(),
        lastError: null,
        lastUpdatedAt: new Date(),
      },
    });
  } catch (error) {
    log(`Sincronização da conexão ${connection.id} falhou:`, error.message);
    await prisma.google_drive_connections.update({
      where: { id: connection.id },
      data: {
        syncRequested: false,
        lastSyncAt: new Date(),
        lastError: error.message.slice(0, 1000),
        lastUpdatedAt: new Date(),
      },
    });
  }
}

async function purgeDisallowedFolders() {
  const folders = await prisma.google_drive_folders.findMany({
    where: { status: { in: ["rejected", "blocked"] } },
    include: { files: true },
  });
  for (const folder of folders) {
    for (const file of folder.files) {
      try {
        await removeIndexedDocuments(file);
        await prisma.google_drive_files.update({
          where: { id: file.id },
          data: {
            status: folder.status,
            lastError: null,
            lastSyncedAt: new Date(),
          },
        });
      } catch (error) {
        await prisma.google_drive_files.update({
          where: { id: file.id },
          data: { status: "failed", lastError: error.message.slice(0, 1000) },
        });
        log(
          `Não foi possível retirar o arquivo bloqueado ${file.name}:`,
          error.message
        );
      }
    }
  }
}

async function purgeBlockedFiles() {
  const files = await prisma.google_drive_files.findMany({
    where: {
      blocked: true,
      OR: [{ localPath: { not: null } }, { indexes: { some: {} } }],
    },
    take: 100,
  });
  for (const file of files) {
    try {
      await removeIndexedDocuments(file);
      await prisma.google_drive_files.update({
        where: { id: file.id },
        data: { status: "blocked", localPath: null, lastError: null },
      });
    } catch (error) {
      await prisma.google_drive_files.update({
        where: { id: file.id },
        data: { status: "failed", lastError: error.message.slice(0, 1000) },
      });
      log(
        `Não foi possível remover o conteúdo bloqueado ${file.name}:`,
        error.message
      );
    }
  }
}

(async () => {
  try {
    await purgeDisallowedFolders();
    await purgeBlockedFiles();
    const now = new Date();
    const recoveryBefore = new Date(now.getTime() - RECOVERY_INTERVAL_MS);
    const connections = await prisma.google_drive_connections.findMany({
      where: {
        OR: [
          { syncRequested: true },
          { lastSyncAt: null },
          { lastSyncAt: { lte: recoveryBefore } },
        ],
      },
      orderBy: { lastSyncAt: "asc" },
      take: 20,
    });
    for (const connection of connections) await syncConnection(connection);
    log(
      `Sincronização concluída; ${connections.length} conexão(ões) processada(s).`
    );
  } catch (error) {
    log("Falha no ciclo de sincronização:", error.message);
    process.exitCode = 1;
  }
  process.exit(0);
})();
