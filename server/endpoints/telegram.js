const {
  ExternalCommunicationConnector,
} = require("../models/externalCommunicationConnector");
const { Telemetry } = require("../models/telemetry");
const { TelegramBotService } = require("../utils/telegramBot");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { flexUserRoleValid, ROLES } = require("../utils/middleware/multiUserProtected");
const { reqBody } = require("../utils/http");
const { EventLogs } = require("../models/eventLogs");
const { Workspace } = require("../models/workspace");
const { WorkspaceThread } = require("../models/workspaceThread");
const { encryptToken } = require("../utils/telegramBot/utils");
const { User } = require("../models/user");
const prisma = require("../utils/prisma");
const crypto = require("crypto");

function telegramEndpoints(app) {
  if (!app) return;

  app.get(
    "/telegram/config",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        const connector = await ExternalCommunicationConnector.get("telegram");
        if (!connector) {
          return response.status(200).json({ config: null });
        }

        const service = new TelegramBotService();

        // Resolve workspace, thread, and model from the first approved user's
        // active state, falling back to the default workspace config.
        const approvedUsers = connector.config.approved_users || [];
        const activeUser = approvedUsers[0];
        const workspaceSlug =
          activeUser?.active_workspace ||
          connector.config.default_workspace ||
          null;
        const threadSlug = activeUser?.active_thread || null;

        let thread = null;
        let workspace = await Workspace.get({ slug: workspaceSlug });
        if (!workspace) {
          const available = await Workspace.where({}, 1);
          if (available.length) workspace = available[0];
        }

        if (!threadSlug) {
          const availableThreads = await WorkspaceThread.where({
            workspace_id: workspace.id,
          });
          if (availableThreads.length) thread = availableThreads[0];
        }

        return response.status(200).json({
          config: {
            active: connector.active,
            connected: service.isRunning,
            bot_username: connector.config.bot_username || null,
            default_workspace: workspace?.name || workspaceSlug || "—",
            active_thread_name: thread?.name || "Default",
            chat_model: workspace?.chatModel || "System default",
            voice_response_mode:
              connector.config.voice_response_mode || "text_only",
          },
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  /**
   * Verify token, save config, and start the Telegram bot.
   */
  app.post(
    "/telegram/connect",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { bot_token, default_workspace = null } = reqBody(request);
        if (!bot_token) {
          return response.status(400).json({
            success: false,
            error: "Bot token is required.",
          });
        }

        // Verify the token with Telegram API
        const verification = await TelegramBotService.verifyToken(
          String(bot_token)
        );
        if (!verification.valid) {
          return response.status(400).json({
            success: false,
            error: `Invalid bot token: ${verification.error}`,
          });
        }

        let workspaceSlug = null;
        if (default_workspace) workspaceSlug = String(default_workspace);
        else {
          const workspaces = await Workspace.where({}, 1);
          if (workspaces.length) workspaceSlug = workspaces[0].slug;
          else {
            const { workspace } = await Workspace.new(
              `${verification.username} Workspace`,
              null,
              { chatMode: "automatic" }
            );
            if (workspace) workspaceSlug = workspace.slug;
          }
        }

        if (!workspaceSlug) {
          return response.status(400).json({
            success: false,
            error: "No workspace found or could be created.",
          });
        }

        // Preserve approved users when reconnecting with a new token
        const existing = await ExternalCommunicationConnector.get("telegram");
        const storedConfig = {
          bot_username: verification.username,
          default_workspace: workspaceSlug,
          approved_users: existing?.config?.approved_users || [],
          linked_user_states: existing?.config?.linked_user_states || {},
          voice_response_mode:
            existing?.config?.voice_response_mode || "text_only",
        };

        // Save config with encrypted token
        const { error } = await ExternalCommunicationConnector.upsert(
          "telegram",
          {
            ...storedConfig,
            bot_token: encryptToken(String(bot_token)),
            active: true,
          }
        );
        if (error) return response.status(500).json({ success: false, error });

        // Start the bot with the plaintext token
        const service = new TelegramBotService();
        await service.start({ ...storedConfig, bot_token: String(bot_token) });

        await EventLogs.logEvent("telegram_bot_connected", {
          bot_username: verification.username,
        });
        await Telemetry.sendTelemetry("telegram_bot_connected");
        return response.status(200).json({
          success: true,
          bot_username: verification.username,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  app.post(
    "/telegram/disconnect",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        const service = new TelegramBotService();
        await service.stop();
        await ExternalCommunicationConnector.delete("telegram");
        await EventLogs.logEvent("telegram_bot_disconnected");
        return response.status(200).json({ success: true });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  app.get(
    "/telegram/status",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        const connector = await ExternalCommunicationConnector.get("telegram");
        const service = new TelegramBotService();
        return response.status(200).json({
          active: connector?.active && service.isRunning,
          bot_username: connector?.config?.bot_username || null,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  app.get(
    "/telegram/pending-users",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        const service = new TelegramBotService();
        return response
          .status(200)
          .json({ users: service.pendingPairings || [] });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  app.get(
    "/telegram/approved-users",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        const connector = await ExternalCommunicationConnector.get("telegram");
        const approved = connector?.config?.approved_users || [];
        return response.status(200).json({ users: approved });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  app.post(
    "/telegram/approve-user",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { chatId } = reqBody(request);
        if (!chatId)
          return response
            .status(400)
            .json({ success: false, error: "chatId is required." });

        const service = new TelegramBotService();
        await service.approvePendingUser(chatId);
        await EventLogs.logEvent("telegram_user_approved", { chatId });
        return response.status(200).json({ success: true });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  app.post(
    "/telegram/deny-user",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { chatId } = reqBody(request);
        if (!chatId)
          return response
            .status(400)
            .json({ success: false, error: "chatId is required." });

        const service = new TelegramBotService();
        await service.denyPendingUser(chatId);
        await EventLogs.logEvent("telegram_user_denied", { chatId });
        return response.status(200).json({ success: true });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  app.post(
    "/telegram/revoke-user",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { chatId } = reqBody(request);
        if (!chatId)
          return response
            .status(400)
            .json({ success: false, error: "chatId is required." });

        const service = new TelegramBotService();
        await service.revokeExistingUser(chatId);
        await EventLogs.logEvent("telegram_user_revoked", { chatId });
        return response.status(200).json({ success: true });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  app.post(
    "/telegram/update-config",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { voice_response_mode } = reqBody(request);
        const updates = {};

        if (
          voice_response_mode &&
          ["text_only", "mirror", "always_voice"].includes(voice_response_mode)
        ) {
          updates.voice_response_mode = voice_response_mode;
        }

        if (Object.keys(updates).length === 0) {
          return response
            .status(400)
            .json({ success: false, error: "No valid updates provided." });
        }

        const { error } = await ExternalCommunicationConnector.updateConfig(
          "telegram",
          updates
        );
        if (error) {
          return response.status(500).json({ success: false, error });
        }

        // Update the running bot's config so changes take effect immediately
        const service = new TelegramBotService();
        if (service.isRunning) service.updateConfig(updates);

        return response.status(200).json({ success: true });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  app.get(
    "/telegram/linked-users",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        const users = (await User.where()).filter((user) => !!user.telegramChatId).map(({ id, username }) => ({ id, username }));
        return response.status(200).json({ users });
      } catch (e) { console.error(e.message, e); return response.sendStatus(500); }
    }
  );

  app.post(
    "/telegram/unlink-user",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const userId = Number(reqBody(request).userId);
        if (!Number.isInteger(userId) || userId < 1) return response.status(400).json({ success: false, error: "Invalid user id." });
        await prisma.users.update({ where: { id: userId }, data: { telegramChatId: null } });
        await prisma.telegram_link_tokens.deleteMany({ where: { userId } });
        return response.status(200).json({ success: true });
      } catch (e) { console.error(e.message, e); return response.status(500).json({ success: false, error: e.message }); }
    }
  );

  app.get(
    "/telegram/link-status",
    [validatedRequest],
    async (_request, response) => {
      try {
        if (!response.locals.multiUserMode) return response.status(400).json({ error: "Telegram linking is available in multi-user mode." });
        const user = response.locals.user;
        if (!user) return response.sendStatus(401);
        return response.status(200).json({ linked: !!user.telegramChatId });
      } catch (e) { console.error(e.message, e); return response.sendStatus(500); }
    }
  );

  app.post(
    "/telegram/link-token",
    [validatedRequest],
    async (_request, response) => {
      try {
        if (!response.locals.multiUserMode) return response.status(400).json({ error: "Telegram linking is available in multi-user mode." });
        const user = response.locals.user;
        if (!user) return response.sendStatus(401);
        if (user.telegramChatId)
          return response.status(409).json({ error: "A Telegram account is already linked to this user." });
        const connector = await ExternalCommunicationConnector.get("telegram");
        if (!connector?.active || !connector.config?.bot_username) return response.status(400).json({ error: "The Telegram bot is not configured." });
        const token = crypto.randomBytes(32).toString("base64url");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        await prisma.telegram_link_tokens.deleteMany({ where: { OR: [{ userId: user.id }, { expiresAt: { lt: new Date() } }] } });
        await prisma.telegram_link_tokens.create({ data: { tokenHash, userId: user.id, expiresAt: new Date(Date.now() + 10 * 60 * 1000) } });
        return response.status(200).json({
          token,
          botUrl: "https://t.me/" + connector.config.bot_username,
          expiresInSeconds: 600,
        });
      } catch (e) { console.error(e.message, e); return response.sendStatus(500); }
    }
  );

  app.delete(
    "/telegram/link",
    [validatedRequest],
    async (_request, response) => {
      try {
        if (!response.locals.multiUserMode) return response.status(400).json({ error: "Telegram linking is available in multi-user mode." });
        const user = response.locals.user;
        if (!user) return response.sendStatus(401);
        await prisma.users.update({ where: { id: user.id }, data: { telegramChatId: null } });
        await prisma.telegram_link_tokens.deleteMany({ where: { userId: user.id } });
        return response.status(200).json({ success: true });
      } catch (e) { console.error(e.message, e); return response.sendStatus(500); }
    }
  );

}

module.exports = { telegramEndpoints };
