const prisma = require("../prisma");
const { Workspace } = require("../../models/workspace");
const { GoogleDriveConnection } = require("../../models/googleDriveConnection");
const { ROLES } = require("../middleware/multiUserProtected");

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function isGoogleDriveFolderListRequest(prompt = "") {
  const text = normalizeText(prompt);
  const asksToList = /\b(quais|liste|listar|list|mostre|mostrar|me mostra|me liste|me listar|exiba)\b/.test(
    text
  );
  const mentionsFolders = /\b(pastas?|diretorios?)\b/.test(text);
  const mentionsDriveOrConnection =
    /\b(google\s*drive|drive|conectad[oa]s?|sincronizad[oa]s?)\b/.test(text);
  return asksToList && mentionsFolders && mentionsDriveOrConnection;
}

function isGoogleDriveDocumentLookup(prompt = "") {
  return /\b(google\s*drive|drive|pastas?|arquivos?|documentos?|contratos?|convenios?|aditivos?|clausulas?|vigencia|faturamento|armazenad[oa]s?|assinad[oa]s?)\b/i.test(
    normalizeText(prompt)
  );
}

function workspaceIsVisible(workspace, user) {
  return Boolean(
    workspace &&
      (!workspace.privateOwnerId || workspace.privateOwnerId === user?.id)
  );
}

async function visibleWorkspacesFor(user) {
  if (!user?.id) return [];
  const workspaces = await Workspace.whereWithUser(user);
  return workspaces.filter((workspace) => workspaceIsVisible(workspace, user));
}

async function listConnectedFolders(user) {
  if (!user?.id) return [];
  const isAdmin = user.role === ROLES.admin;
  const allWorkspaces = await Workspace.whereWithUser(user);
  const workspaces = isAdmin
    ? allWorkspaces
    : allWorkspaces.filter((workspace) => workspaceIsVisible(workspace, user));
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

  if (isAdmin) {
    const folders = await prisma.google_drive_folders.findMany({
      include: {
        connection: {
          select: {
            scope: true,
            googleEmail: true,
            user: { select: { id: true, username: true } },
            company: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return folders.map((folder) => ({
      ...folder,
      workspace: workspaceById.get(folder.workspaceId) || null,
      company: folder.connection?.company || null,
      googleEmail: folder.connection?.googleEmail || null,
      owner: folder.connection?.user?.username || null,
      scope: folder.connection?.scope || folder.scope,
    }));
  }

  const connections = await GoogleDriveConnection.userConnections(user.id, false);
  return connections.flatMap((connection) =>
    connection.folders
      .filter((folder) => {
        if (!folder.workspaceId) return false;
        return workspaceById.has(folder.workspaceId);
      })
      .map((folder) => ({
        ...folder,
        workspace: workspaceById.get(folder.workspaceId) || null,
        company: connection.company || null,
        googleEmail: connection.googleEmail || null,
        owner: null,
        scope: connection.scope,
      }))
  );
}

function formatConnectedFolders(folders = []) {
  if (!folders.length)
    return "Não encontrei pastas do Google Drive conectadas e visíveis para sua conta.";

  const statusLabels = {
    approved: "aprovada e disponível para pesquisa",
    pending: "aguardando aprovação",
    blocked: "bloqueada",
    rejected: "removida ou rejeitada",
  };
  const lines = folders.map((folder) => {
    const details = [];
    if (folder.workspace?.name) details.push(`workspace: ${folder.workspace.name}`);
    if (folder.company?.name) details.push(`empresa: ${folder.company.name}`);
    if (folder.owner) details.push(`usuário: ${folder.owner}`);
    if (folder.googleEmail) details.push(`conta Google: ${folder.googleEmail}`);
    details.push(statusLabels[folder.status] || `status: ${folder.status}`);
    return `- ${folder.name} (${details.join("; ")})`;
  });

  return `Estas são as pastas do Google Drive registradas no sistema e visíveis para sua conta:\n${lines.join(
    "\n"
  )}\n\nAs pastas aprovadas e indexadas podem ser pesquisadas diretamente nas conversas.`;
}

async function searchConnectedDriveWorkspaces({
  user,
  currentWorkspace,
  prompt,
  LLMConnector,
  VectorDb,
}) {
  const empty = { contextTexts: [], sources: [], folders: [], searched: false };
  if (!user?.id || !isGoogleDriveDocumentLookup(prompt)) return empty;

  try {
    const [connections, workspaces] = await Promise.all([
      GoogleDriveConnection.userConnections(
        user.id,
        user.role === ROLES.admin
      ),
      visibleWorkspacesFor(user),
    ]);
    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const folders = connections.flatMap((connection) =>
      connection.folders
        .filter(
          (folder) =>
            folder.status === "approved" &&
            folder.workspaceId &&
            workspaceById.has(folder.workspaceId)
        )
        .map((folder) => ({ ...folder, company: connection.company || null }))
    );

    const searchableWorkspaceIds = [
      ...new Set(folders.map((folder) => Number(folder.workspaceId))),
    ].filter((id) => id !== Number(currentWorkspace?.id));
    if (!searchableWorkspaceIds.length)
      return { ...empty, folders, searched: true };

    const indexedWorkspaces = await prisma.google_drive_file_indexes.findMany({
      where: {
        workspaceId: { in: searchableWorkspaceIds },
        driveFile: {
          blocked: false,
          status: { in: ["indexed", "partial"] },
          folder: { status: "approved" },
        },
      },
      select: { workspaceId: true },
      distinct: ["workspaceId"],
    });
    const candidateWorkspaces = indexedWorkspaces
      .map(({ workspaceId }) => workspaceById.get(workspaceId))
      .filter(Boolean);

    const result = { contextTexts: [], sources: [], folders, searched: true };
    const maxSources = Math.max(4, Math.min(Number(currentWorkspace?.topN) || 4, 8));
    for (const driveWorkspace of candidateWorkspaces) {
      if (!(await VectorDb.hasNamespace(driveWorkspace.slug))) continue;

      const search = await VectorDb.performSimilaritySearch({
        namespace: driveWorkspace.slug,
        input: prompt,
        LLMConnector,
        similarityThreshold: currentWorkspace?.similarityThreshold ?? 0.25,
        topN: 2,
        rerank: driveWorkspace.vectorSearchMode === "rerank",
      });
      if (search?.message) continue;

      for (const source of search?.sources || []) {
        const text = `[Google Drive · workspace ${driveWorkspace.name}]\n${source.text || ""}`;
        result.contextTexts.push(text);
        result.sources.push({
          ...source,
          workspaceName: driveWorkspace.name,
          driveSource: true,
          text,
        });
      }
    }
    if (result.sources.length > maxSources) {
      const ranked = result.sources
        .map((source, index) => ({ source, index }))
        .sort((a, b) => {
          const scoreDifference =
            (Number(b.source.score) || 0) - (Number(a.source.score) || 0);
          return scoreDifference || a.index - b.index;
        })
        .slice(0, maxSources)
        .sort((a, b) => a.index - b.index)
        .map(({ source }) => source);
      result.sources = ranked;
      result.contextTexts = ranked.map(({ text }) => text);
    }
    return result;
  } catch (error) {
    console.error("Google Drive chat retrieval failed:", error.message);
    return empty;
  }
}

module.exports = {
  isGoogleDriveFolderListRequest,
  isGoogleDriveDocumentLookup,
  listConnectedFolders,
  formatConnectedFolders,
  searchConnectedDriveWorkspaces,
};
