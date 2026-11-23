const crypto = require("crypto");
const prisma = require("../utils/prisma");
const { EncryptionManager } = require("../utils/EncryptionManager");
const DriveApi = require("../utils/googleDriveApi");

const encryption = new EncryptionManager();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function hashState(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function cleanBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Informe uma URL pública válida para o sistema.");
  }
  const isLocal = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:"))
    throw new Error("A URL pública deve usar HTTPS.");
  if (url.pathname !== "/" || url.search || url.hash)
    throw new Error("Informe somente a URL base, sem caminho ou parâmetros.");
  return url.origin;
}

const GoogleDriveConnection = {
  async getConfig() {
    const config = await prisma.google_drive_oauth_config.findUnique({
      where: { id: 1 },
    });
    if (!config) return null;
    return {
      clientId: config.clientId,
      clientSecret: encryption.decrypt(config.clientSecretEncrypted),
      baseUrl: config.baseUrl,
      callbackUrl: `${config.baseUrl}/api/google-drive/oauth/callback`,
    };
  },

  async safeConfig() {
    const config = await prisma.google_drive_oauth_config.findUnique({
      where: { id: 1 },
    });
    return {
      configured: !!config?.clientId && !!config?.clientSecretEncrypted,
      clientId: config?.clientId || "",
      hasClientSecret: !!config?.clientSecretEncrypted,
      baseUrl: config?.baseUrl || "",
      callbackUrl: config
        ? `${config.baseUrl}/api/google-drive/oauth/callback`
        : "",
    };
  },

  async saveConfig({ clientId, clientSecret, baseUrl }) {
    const normalizedClientId = String(clientId || "").trim();
    const normalizedSecret = String(clientSecret || "").trim();
    if (!normalizedClientId.endsWith(".apps.googleusercontent.com"))
      throw new Error(
        "O Client ID não parece ser de um cliente OAuth do Google."
      );
    const origin = cleanBaseUrl(baseUrl);
    const current = await prisma.google_drive_oauth_config.findUnique({
      where: { id: 1 },
    });
    let encryptedSecret = current?.clientSecretEncrypted || "";
    if (normalizedSecret) {
      encryptedSecret = encryption.encrypt(normalizedSecret);
      if (!encryptedSecret)
        throw new Error("Não foi possível proteger o Client Secret.");
    }
    if (!encryptedSecret) throw new Error("Informe o Client Secret do Google.");

    return await prisma.google_drive_oauth_config.upsert({
      where: { id: 1 },
      update: {
        clientId: normalizedClientId,
        clientSecretEncrypted: encryptedSecret,
        baseUrl: origin,
        lastUpdatedAt: new Date(),
      },
      create: {
        id: 1,
        clientId: normalizedClientId,
        clientSecretEncrypted: encryptedSecret,
        baseUrl: origin,
      },
    });
  },

  async createOAuthUrl({ userId, scope, companyId = null }) {
    if (!new Set(["personal", "company"]).has(scope))
      throw new Error("Escopo de conexão inválido.");
    const config = await this.getConfig();
    if (!config?.clientId || !config?.clientSecret)
      throw new Error(
        "O administrador ainda não configurou o acesso ao Google Drive."
      );
    await prisma.google_drive_oauth_states.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    const state = crypto.randomBytes(32).toString("base64url");
    await prisma.google_drive_oauth_states.create({
      data: {
        stateHash: hashState(state),
        userId: Number(userId),
        scope,
        companyId: scope === "company" ? Number(companyId) : null,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    });
    return DriveApi.createAuthorizationUrl({
      clientId: config.clientId,
      redirectUri: config.callbackUrl,
      state,
    });
  },

  async completeOAuth({ state, code }) {
    const stateHash = hashState(state);
    const oauthState = await prisma.google_drive_oauth_states.findUnique({
      where: { stateHash },
    });
    await prisma.google_drive_oauth_states.deleteMany({ where: { stateHash } });
    if (!oauthState || oauthState.expiresAt < new Date())
      throw new Error("O link expirou. Inicie a conexão novamente.");
    const config = await this.getConfig();
    if (!config)
      throw new Error("A integração do Google Drive não está configurada.");
    const tokens = await DriveApi.exchangeAuthorizationCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.callbackUrl,
      code,
    });
    const identity = tokens.access_token
      ? await DriveApi.getAccount(tokens.access_token)
      : {};
    const unique =
      oauthState.scope === "company"
        ? { companyId: oauthState.companyId }
        : { userId: oauthState.userId };
    const existing = await prisma.google_drive_connections.findUnique({
      where: unique,
    });
    const refreshToken = tokens.refresh_token
      ? encryption.encrypt(tokens.refresh_token)
      : existing?.refreshTokenEncrypted;
    if (!refreshToken)
      throw new Error(
        "O Google não retornou um token de atualização. Remova o acesso anterior à aplicação na conta Google e tente conectar novamente."
      );

    const data = {
      scope: oauthState.scope,
      userId: oauthState.scope === "personal" ? oauthState.userId : null,
      companyId: oauthState.scope === "company" ? oauthState.companyId : null,
      googleEmail: identity.emailAddress || null,
      refreshTokenEncrypted: refreshToken,
      lastError: null,
      lastUpdatedAt: new Date(),
    };
    const connection = existing
      ? await prisma.google_drive_connections.update({
          where: { id: existing.id },
          data,
        })
      : await prisma.google_drive_connections.create({ data });
    return { connection, baseUrl: config.baseUrl };
  },

  async userConnections(userId, isAdmin = false) {
    const companies = isAdmin
      ? await prisma.companies.findMany({ select: { id: true } })
      : await prisma.user_companies.findMany({
          where: { userId: Number(userId) },
          select: { companyId: true },
        });
    const companyIds = companies.map(({ companyId, id }) => companyId || id);
    const connections = await prisma.google_drive_connections.findMany({
      where: {
        OR: [
          { userId: Number(userId) },
          ...(companyIds.length ? [{ companyId: { in: companyIds } }] : []),
        ],
      },
      include: {
        company: { select: { id: true, name: true } },
        folders: {
          select: {
            id: true,
            driveFolderId: true,
            name: true,
            status: true,
            workspaceId: true,
            lastSyncAt: true,
            lastError: true,
          },
          orderBy: { name: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return connections.map((connection) => ({
      id: connection.id,
      scope: connection.scope,
      googleEmail: connection.googleEmail,
      company: connection.company,
      lastSyncAt: connection.lastSyncAt,
      lastError: connection.lastError,
      folders:
        isAdmin || connection.userId === Number(userId)
          ? connection.folders
          : connection.folders.filter(({ status }) => status === "approved"),
    }));
  },

  async accessToken(connection) {
    const config = await this.getConfig();
    if (!config)
      throw new Error("A integração do Google Drive não está configurada.");
    const refreshToken = encryption.decrypt(connection.refreshTokenEncrypted);
    if (!refreshToken)
      throw new Error("Não foi possível ler o token do Google Drive.");
    const token = await DriveApi.refreshAccessToken({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken,
    });
    return token.access_token;
  },
};

module.exports = { GoogleDriveConnection };
