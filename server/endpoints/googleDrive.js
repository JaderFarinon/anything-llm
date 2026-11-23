const crypto = require("crypto");
const prisma = require("../utils/prisma");
const { GoogleDriveConnection } = require("../models/googleDriveConnection");
const DriveApi = require("../utils/googleDriveApi");
const { Workspace } = require("../models/workspace");
const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");

const authenticated = [validatedRequest];
const adminOnly = [validatedRequest, flexUserRoleValid([ROLES.admin])];

function googleDriveEndpoints(app) {
  if (!app) return;

  app.get(
    "/admin/google-drive/config",
    adminOnly,
    async (_request, response) => {
      try {
        response
          .status(200)
          .json({ config: await GoogleDriveConnection.safeConfig() });
      } catch (error) {
        console.error("Google Drive config read failed:", error.message);
        response
          .status(500)
          .json({ error: "Não foi possível carregar a configuração." });
      }
    }
  );

  app.put(
    "/admin/google-drive/config",
    adminOnly,
    async (request, response) => {
      try {
        await GoogleDriveConnection.saveConfig(reqBody(request));
        response.status(200).json({
          success: true,
          config: await GoogleDriveConnection.safeConfig(),
        });
      } catch (error) {
        response.status(400).json({ error: error.message });
      }
    }
  );

  app.get(
    "/google-drive/connections",
    authenticated,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const connections = await GoogleDriveConnection.userConnections(
          user.id,
          user.role === ROLES.admin
        );
        response.status(200).json({ connections });
      } catch (error) {
        console.error("Google Drive connections read failed:", error.message);
        response
          .status(500)
          .json({ error: "Não foi possível carregar as conexões." });
      }
    }
  );

  app.post("/google-drive/webhook", async (request, response) => {
    const channelId = request.get("x-goog-channel-id");
    const token = request.get("x-goog-channel-token");
    const resourceId = request.get("x-goog-resource-id");
    const resourceState = request.get("x-goog-resource-state");
    if (!channelId || !token) return response.sendStatus(404).end();

    try {
      const connection = await prisma.google_drive_connections.findUnique({
        where: { channelId },
        select: { id: true, channelTokenHash: true, channelResourceId: true },
      });
      if (!connection?.channelTokenHash) return response.sendStatus(404).end();
      const receivedHash = crypto.createHash("sha256").update(token).digest();
      const expectedHash = Buffer.from(connection.channelTokenHash, "hex");
      if (
        expectedHash.length !== receivedHash.length ||
        !crypto.timingSafeEqual(expectedHash, receivedHash) ||
        (connection.channelResourceId &&
          connection.channelResourceId !== resourceId)
      )
        return response.sendStatus(404).end();

      if (resourceState !== "sync")
        await prisma.google_drive_connections.update({
          where: { id: connection.id },
          data: { syncRequested: true, lastUpdatedAt: new Date() },
        });
      response.sendStatus(200).end();
    } catch (error) {
      console.error("Google Drive webhook failed:", error.message);
      response.sendStatus(500).end();
    }
  });

  app.post(
    "/google-drive/oauth/start",
    authenticated,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { scope = "personal", companyId = null } = reqBody(request);
        if (scope === "company") {
          if (user.role !== ROLES.admin)
            return response
              .status(403)
              .json({ error: "Somente admins conectam o Drive da empresa." });
          const company = await prisma.companies.findUnique({
            where: { id: Number(companyId) },
            select: { id: true },
          });
          if (!company)
            return response
              .status(404)
              .json({ error: "Empresa não encontrada." });
        }
        const authorizationUrl = await GoogleDriveConnection.createOAuthUrl({
          userId: user.id,
          scope,
          companyId,
        });
        response.status(200).json({ authorizationUrl });
      } catch (error) {
        response.status(400).json({ error: error.message });
      }
    }
  );

  // Google redirects here with a short-lived, one-use state created by the authenticated start route.
  app.get("/google-drive/oauth/callback", async (request, response) => {
    const config = await GoogleDriveConnection.getConfig().catch(() => null);
    const fallback =
      config?.baseUrl ||
      process.env.PUBLIC_URL ||
      `http://localhost:${process.env.SERVER_PORT || 3001}`;
    try {
      if (request.query.error)
        throw new Error("A autorização do Google Drive foi cancelada.");
      const { connection, baseUrl } = await GoogleDriveConnection.completeOAuth(
        {
          state: request.query.state,
          code: request.query.code,
        }
      );
      const target = new URL("/settings/google-drive", baseUrl);
      target.searchParams.set("connected", connection.scope);
      response.redirect(302, target.toString());
    } catch (error) {
      console.error("Google Drive OAuth callback failed:", error.message);
      const target = new URL("/settings/google-drive", fallback);
      target.searchParams.set("driveError", "connection_failed");
      response.redirect(302, target.toString());
    }
  });

  app.get(
    "/google-drive/connections/:id/folders",
    authenticated,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const connection = await prisma.google_drive_connections.findUnique({
          where: { id: Number(request.params.id) },
          include: { company: { select: { id: true, name: true } } },
        });
        if (!connection)
          return response
            .status(404)
            .json({ error: "Conexão não encontrada." });
        const isAdmin = user.role === ROLES.admin;
        const isOwner = connection.userId === user.id;
        const isCompanyMember = connection.companyId
          ? !!(await prisma.user_companies.findFirst({
              where: { userId: user.id, companyId: connection.companyId },
              select: { id: true },
            }))
          : false;
        if (!isAdmin && !isOwner && !isCompanyMember)
          return response.sendStatus(403).end();
        if (connection.scope === "company" && !isAdmin)
          return response.status(403).json({
            error: "A seleção das pastas da empresa é restrita ao admin.",
          });

        const accessToken = await GoogleDriveConnection.accessToken(connection);
        const folders = await DriveApi.listFolders(accessToken, {
          pageToken: request.query.pageToken || null,
          query: String(request.query.query || "").slice(0, 100),
        });
        response.status(200).json(folders);
      } catch (error) {
        response.status(400).json({ error: error.message });
      }
    }
  );

  app.post(
    "/google-drive/connections/:id/folders",
    authenticated,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { folderId, name, workspaceId = null } = reqBody(request);
        if (
          typeof folderId !== "string" ||
          !folderId.trim() ||
          typeof name !== "string" ||
          !name.trim()
        )
          return response
            .status(400)
            .json({ error: "Selecione uma pasta válida." });
        const connection = await prisma.google_drive_connections.findUnique({
          where: { id: Number(request.params.id) },
        });
        if (!connection)
          return response
            .status(404)
            .json({ error: "Conexão não encontrada." });
        const isAdmin = user.role === ROLES.admin;
        if (connection.scope === "company" && !isAdmin)
          return response.sendStatus(403).end();
        if (
          connection.scope === "personal" &&
          connection.userId !== user.id &&
          !isAdmin
        )
          return response.sendStatus(403).end();

        const existingFolder = await prisma.google_drive_folders.findUnique({
          where: {
            connectionId_driveFolderId: {
              connectionId: connection.id,
              driveFolderId: folderId.trim(),
            },
          },
          select: { id: true, status: true, workspaceId: true },
        });
        if (existingFolder?.status === "blocked")
          return response
            .status(409)
            .json({ error: "Esta pasta foi bloqueada pelo admin." });
        if (existingFolder?.status === "rejected") {
          const indexedContent = await prisma.google_drive_files.count({
            where: {
              folderId: existingFolder.id,
              indexes: { some: {} },
            },
          });
          if (indexedContent)
            return response.status(409).json({
              error:
                "A remoção desta pasta ainda está limpando o conteúdo indexado. Tente novamente em instantes.",
            });
        }

        let targetWorkspaceId = workspaceId ? Number(workspaceId) : null;
        if (connection.scope === "company") {
          if (!targetWorkspaceId)
            return response.status(400).json({
              error: "Escolha o workspace da empresa para esta pasta.",
            });
          const workspace = await prisma.workspaces.findUnique({
            where: { id: targetWorkspaceId },
            select: { id: true, companyId: true },
          });
          if (!workspace || workspace.companyId !== connection.companyId)
            return response
              .status(400)
              .json({ error: "O workspace precisa pertencer a esta empresa." });
        } else {
          const existingPersonalWorkspace =
            await prisma.google_drive_folders.findFirst({
              where: {
                connectionId: connection.id,
                workspaceId: { not: null },
              },
              select: { workspaceId: true },
            });
          targetWorkspaceId = existingPersonalWorkspace?.workspaceId || null;
          if (!targetWorkspaceId) {
            const { workspace, message } = await Workspace.new(
              `Drive pessoal - ${user.username || `usuário ${user.id}`}`,
              user.id
            );
            if (!workspace)
              return response.status(500).json({
                error: message || "Não foi possível criar o workspace pessoal.",
              });
            targetWorkspaceId = workspace.id;
            await prisma.workspaces.update({
              where: { id: targetWorkspaceId },
              data: { privateOwnerId: user.id },
            });
          }
        }

        const folder = await prisma.google_drive_folders.upsert({
          where: {
            connectionId_driveFolderId: {
              connectionId: connection.id,
              driveFolderId: folderId.trim(),
            },
          },
          update: {
            name: name.trim().slice(0, 255),
            workspaceId: targetWorkspaceId,
            status:
              connection.scope === "company"
                ? "approved"
                : existingFolder?.status === "rejected"
                  ? "pending"
                  : existingFolder?.status || "pending",
            ...(connection.scope === "company" ? { lastSyncAt: null } : {}),
            lastUpdatedAt: new Date(),
          },
          create: {
            connectionId: connection.id,
            driveFolderId: folderId.trim(),
            name: name.trim().slice(0, 255),
            scope: connection.scope,
            status: connection.scope === "company" ? "approved" : "pending",
            addedByUserId: user.id,
            workspaceId: targetWorkspaceId,
          },
        });
        if (folder.status === "approved")
          await prisma.google_drive_connections.update({
            where: { id: connection.id },
            data: { syncRequested: true, lastUpdatedAt: new Date() },
          });
        response.status(200).json({ folder });
      } catch (error) {
        console.error("Failed to add Google Drive folder:", error.message);
        response.status(400).json({ error: error.message });
      }
    }
  );

  app.delete(
    "/google-drive/folders/:id",
    authenticated,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const folder = await prisma.google_drive_folders.findUnique({
          where: { id: Number(request.params.id) },
          include: {
            connection: { select: { id: true, scope: true, userId: true } },
          },
        });
        if (!folder)
          return response.status(404).json({ error: "Pasta não encontrada." });
        const isAdmin = user.role === ROLES.admin;
        const isOwner = folder.connection.userId === user.id;
        if (!isAdmin && (folder.connection.scope === "company" || !isOwner))
          return response.sendStatus(403).end();
        await prisma.google_drive_folders.update({
          where: { id: folder.id },
          data: { status: "rejected", lastUpdatedAt: new Date() },
        });
        await prisma.google_drive_connections.update({
          where: { id: folder.connectionId },
          data: { syncRequested: true, lastUpdatedAt: new Date() },
        });
        response.status(200).json({ success: true });
      } catch (error) {
        console.error("Failed to remove Google Drive folder:", error.message);
        response
          .status(400)
          .json({ error: "Não foi possível remover a pasta." });
      }
    }
  );

  app.get(
    "/admin/google-drive/folders/pending",
    adminOnly,
    async (_request, response) => {
      try {
        const folders = await prisma.google_drive_folders.findMany({
          where: { scope: "personal", status: "pending" },
          include: {
            connection: {
              select: {
                googleEmail: true,
                user: { select: { id: true, username: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        });
        response.status(200).json({ folders });
      } catch (error) {
        console.error(
          "Failed to list pending Google Drive folders:",
          error.message
        );
        response
          .status(500)
          .json({ error: "Não foi possível carregar a moderação." });
      }
    }
  );

  app.get(
    "/admin/google-drive/folders",
    adminOnly,
    async (_request, response) => {
      try {
        const folders = await prisma.google_drive_folders.findMany({
          where: { status: { in: ["approved", "pending"] } },
          include: {
            connection: {
              select: {
                scope: true,
                googleEmail: true,
                user: { select: { id: true, username: true } },
                company: { select: { id: true, name: true } },
              },
            },
            _count: { select: { files: true } },
          },
          orderBy: { createdAt: "asc" },
        });
        response.status(200).json({ folders });
      } catch (error) {
        console.error("Failed to list Google Drive folders:", error.message);
        response
          .status(500)
          .json({ error: "Não foi possível carregar as pastas do Drive." });
      }
    }
  );

  app.get(
    "/admin/google-drive/folders/:id/files",
    adminOnly,
    async (request, response) => {
      try {
        const folderId = Number(request.params.id);
        const folder = await prisma.google_drive_folders.findUnique({
          where: { id: folderId },
          select: { id: true },
        });
        if (!folder)
          return response.status(404).json({ error: "Pasta não encontrada." });
        const files = await prisma.google_drive_files.findMany({
          where: { folderId },
          select: {
            id: true,
            folderId: true,
            name: true,
            mimeType: true,
            modifiedTime: true,
            status: true,
            blocked: true,
            lastError: true,
            lastSyncedAt: true,
          },
          orderBy: { name: "asc" },
        });
        response.status(200).json({ files });
      } catch (error) {
        console.error("Failed to list Google Drive files:", error.message);
        response
          .status(500)
          .json({ error: "Não foi possível carregar os documentos." });
      }
    }
  );

  app.post(
    "/admin/google-drive/files/:id/block",
    adminOnly,
    async (request, response) => {
      try {
        const { blocked } = reqBody(request);
        if (typeof blocked !== "boolean")
          return response
            .status(400)
            .json({ error: "Informe se o documento deve ser bloqueado." });
        const file = await prisma.google_drive_files.findUnique({
          where: { id: Number(request.params.id) },
          select: {
            id: true,
            folderId: true,
            folder: { select: { connectionId: true } },
          },
        });
        if (!file)
          return response
            .status(404)
            .json({ error: "Documento não encontrado." });
        await prisma.google_drive_files.update({
          where: { id: file.id },
          data: {
            blocked,
            status: blocked ? "blocked" : "pending",
            lastError: null,
            ...(blocked ? {} : { lastSyncedAt: null }),
          },
        });
        await prisma.google_drive_connections.update({
          where: { id: file.folder.connectionId },
          data: { syncRequested: true, lastUpdatedAt: new Date() },
        });
        response.status(200).json({ success: true, queued: true });
      } catch (error) {
        console.error(
          "Failed to update Google Drive file moderation:",
          error.message
        );
        response.status(400).json({
          error: "Não foi possível atualizar o bloqueio do documento.",
        });
      }
    }
  );

  app.post(
    "/admin/google-drive/folders/:id/moderate",
    adminOnly,
    async (request, response) => {
      try {
        const { status } = reqBody(request);
        if (!["approved", "rejected", "blocked"].includes(status))
          return response
            .status(400)
            .json({ error: "Status de moderação inválido." });
        const currentFolder = await prisma.google_drive_folders.findUnique({
          where: { id: Number(request.params.id) },
          select: { id: true, connectionId: true },
        });
        if (!currentFolder)
          return response.status(404).json({ error: "Pasta não encontrada." });
        const folder = await prisma.google_drive_folders.update({
          where: { id: currentFolder.id },
          data: {
            status,
            lastUpdatedAt: new Date(),
            ...(status === "approved" ? { lastSyncAt: null } : {}),
          },
        });
        await prisma.google_drive_connections.update({
          where: { id: currentFolder.connectionId },
          data: { syncRequested: true, lastUpdatedAt: new Date() },
        });
        response.status(200).json({ folder });
      } catch {
        response
          .status(400)
          .json({ error: "Não foi possível atualizar a pasta." });
      }
    }
  );
}

module.exports = { googleDriveEndpoints };
