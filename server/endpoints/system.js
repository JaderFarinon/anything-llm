process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();
const {
  normalizePath,
  isWithin,
  listFolders,
  getDocumentsByFolder,
  searchDocuments,
  getDocumentsByDocPaths,
} = require("../utils/files");
const { purgeDocument, purgeFolder } = require("../utils/files/purgeDocument");
const {
  getVectorDbClass,
  resolveProviderConnector,
} = require("../utils/helpers");
const { updateENV, dumpENV } = require("../utils/helpers/updateENV");
const {
  reqBody,
  makeJWT,
  userFromSession,
  multiUserMode,
  queryParams,
  safeJsonParse,
} = require("../utils/http");
const {
  handleAssetUpload,
  handlePfpUpload,
  handleAudioUpload,
} = require("../utils/files/multer");
const { v4 } = require("uuid");
const { SystemSettings } = require("../models/systemSettings");
const { User } = require("../models/user");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const fs = require("fs");
const path = require("path");
const {
  getDefaultFilename,
  determineLogoFilepath,
  fetchLogo,
  validFilename,
  renameLogoFile,
  removeCustomLogo,
  LOGO_FILENAME,
  isDefaultFilename,
} = require("../utils/files/logo");
const { Telemetry } = require("../models/telemetry");
const { ApiKey } = require("../models/apiKeys");
const { getCustomModels } = require("../utils/helpers/customModels");
const { WorkspaceChats } = require("../models/workspaceChats");
const { WorkspaceThread } = require("../models/workspaceThread");
const { WorkspaceParsedFiles } = require("../models/workspaceParsedFiles");
const { Workspace } = require("../models/workspace");
const {
  flexUserRoleValid,
  ROLES,
  isMultiUserSetup,
} = require("../utils/middleware/multiUserProtected");
const { fetchPfp, determinePfpFilepath } = require("../utils/files/pfp");
const { exportChatsAsType } = require("../utils/helpers/chat/convertTo");
const { EventLogs } = require("../models/eventLogs");
const { CollectorApi } = require("../utils/collectorApi");
const {
  recoverAccount,
  resetPassword,
  generateRecoveryCodes,
} = require("../utils/PasswordRecovery");
const { SlashCommandPresets } = require("../models/slashCommandsPresets");
const { EncryptionManager } = require("../utils/EncryptionManager");
const { BrowserExtensionApiKey } = require("../models/browserExtensionApiKey");
const { MobileDevice } = require("../models/mobileDevice");
const {
  chatHistoryViewable,
} = require("../utils/middleware/chatHistoryViewable");
const {
  simpleSSOEnabled,
  simpleSSOLoginDisabled,
} = require("../utils/middleware/simpleSSOEnabled");
const { TemporaryAuthToken } = require("../models/temporaryAuthToken");
const { SystemPromptVariables } = require("../models/systemPromptVariables");
const { isReservedCommand } = require("../utils/chats");
const { AgentSkillWhitelist } = require("../models/agentSkillWhitelist");
const { Memory } = require("../models/memory");
const { dummyHashCompare } = require("../utils/helpers/dummyHashCompare");

function systemEndpoints(app) {
  if (!app) return;

  app.get("/ping", (_, response) => {
    response.status(200).json({ online: true });
  });

  app.get("/migrate", async (_, response) => {
    response.sendStatus(200);
  });

  app.get("/env-dump", async (_, response) => {
    if (process.env.NODE_ENV !== "production")
      return response.sendStatus(200).end();
    dumpENV();
    response.sendStatus(200).end();
  });

  app.get("/onboarding", async (_, response) => {
    try {
      const results = await SystemSettings.isOnboardingComplete();
      response.status(200).json({ onboardingComplete: results });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.post("/onboarding", [validatedRequest], async (_, response) => {
    try {
      await SystemSettings.markOnboardingComplete();
      response.sendStatus(200).end();
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/setup-complete", async (_, response) => {
    try {
      const results = await SystemSettings.currentSettings();
      response.status(200).json({ results });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/system/check-token",
    [validatedRequest],
    async (request, response) => {
      try {
        if (multiUserMode(response)) {
          const user = await userFromSession(request, response);
          if (!user || user.suspended) {
            response.sendStatus(403).end();
            return;
          }

          response.sendStatus(200).end();
          return;
        }

        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  /**
   * Refreshes the user object from the session from a provided token.
   * This does not refresh the token itself - if that is expired or invalid, the user will be logged out.
   * This simply keeps the user object in sync with the database over the course of the session.
   * @returns {Promise<{success: boolean, user: Object | null, message: string | null}>}
   */
  app.get(
    "/system/refresh-user",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!multiUserMode(response))
          return response
            .status(200)
            .json({ success: true, user: null, message: null });

        const user = await userFromSession(request, response);
        if (!user)
          return response.status(200).json({
            success: false,
            user: null,
            message: "Session expired or invalid.",
          });

        if (user.suspended)
          return response.status(200).json({
            success: false,
            user: null,
            message: "User is suspended.",
          });

        return response.status(200).json({
          success: true,
          user: User.filterFields(user),
          message: null,
        });
      } catch (e) {
        return response.status(500).json({
          success: false,
          user: null,
          message: e.message,
        });
      }
    }
  );

  app.post("/request-token", async (request, response) => {
    try {
      const bcrypt = require("bcryptjs");

      if (await SystemSettings.isMultiUserMode()) {
        if (simpleSSOLoginDisabled()) {
          response.status(403).json({
            user: null,
            valid: false,
            token: null,
            message:
              "[005] Login via credentials has been disabled by the administrator.",
          });
          return;
        }

        const { username, password } = reqBody(request);
        const existingUser = await User._get({ username: String(username) });

        if (!existingUser) {
          // Compare anyway so an unknown username takes as long as a wrong password.
          dummyHashCompare(password);
          await EventLogs.logEvent(
            "failed_login_invalid_username",
            {
              ip: request.ip || "Unknown IP",
              username: username || "Unknown user",
            },
            existingUser?.id
          );
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: "[001] Invalid login credentials.",
          });
          return;
        }

        if (!bcrypt.compareSync(String(password), existingUser.password)) {
          await EventLogs.logEvent(
            "failed_login_invalid_password",
            {
              ip: request.ip || "Unknown IP",
              username: username || "Unknown user",
            },
            existingUser?.id
          );
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: "[001] Invalid login credentials.",
          });
          return;
        }

        if (existingUser.suspended) {
          await EventLogs.logEvent(
            "failed_login_account_suspended",
            {
              ip: request.ip || "Unknown IP",
              username: username || "Unknown user",
            },
            existingUser?.id
          );
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: "[004] Account suspended by admin.",
          });
          return;
        }

        await Telemetry.sendTelemetry(
          "login_event",
          { multiUserMode: false },
          existingUser?.id
        );

        await EventLogs.logEvent(
          "login_event",
          {
            ip: request.ip || "Unknown IP",
            username: existingUser.username || "Unknown user",
          },
          existingUser?.id
        );

        // Generate a session token for the user then check if they have seen the recovery codes
        // and if not, generate recovery codes and return them to the frontend.
        const sessionToken = makeJWT(
          { id: existingUser.id, username: existingUser.username },
          process.env.JWT_EXPIRY
        );
        if (!existingUser.seen_recovery_codes) {
          const plainTextCodes = await generateRecoveryCodes(existingUser.id);
          response.status(200).json({
            valid: true,
            user: User.filterFields(existingUser),
            token: sessionToken,
            message: null,
            recoveryCodes: plainTextCodes,
          });
          return;
        }

        response.status(200).json({
          valid: true,
          user: User.filterFields(existingUser),
          token: sessionToken,
          message: null,
        });
        return;
      } else {
        const { password } = reqBody(request);
        if (
          !bcrypt.compareSync(
            password,
            bcrypt.hashSync(process.env.AUTH_TOKEN, 10)
          )
        ) {
          await EventLogs.logEvent("failed_login_invalid_password", {
            ip: request.ip || "Unknown IP",
            multiUserMode: false,
          });
          response.status(401).json({
            valid: false,
            token: null,
            message: "[003] Invalid password provided",
          });
          return;
        }

        await Telemetry.sendTelemetry("login_event", { multiUserMode: false });
        await EventLogs.logEvent("login_event", {
          ip: request.ip || "Unknown IP",
          multiUserMode: false,
        });
        response.status(200).json({
          valid: true,
          token: makeJWT(
            { p: new EncryptionManager().encrypt(password) },
            process.env.JWT_EXPIRY
          ),
          message: null,
        });
      }
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/request-token/sso/simple",
    [simpleSSOEnabled],
    async (request, response) => {
      const { token: tempAuthToken } = request.query;
      const { sessionToken, token, error } =
        await TemporaryAuthToken.validate(tempAuthToken);

      if (error) {
        await EventLogs.logEvent("failed_login_invalid_temporary_auth_token", {
          ip: request.ip || "Unknown IP",
          multiUserMode: true,
        });
        return response.status(401).json({
          valid: false,
          token: null,
          message: `[001] An error occurred while validating the token: ${error}`,
        });
      }

      await Telemetry.sendTelemetry(
        "login_event",
        { multiUserMode: true },
        token.user.id
      );
      await EventLogs.logEvent(
        "login_event",
        {
          ip: request.ip || "Unknown IP",
          username: token.user.username || "Unknown user",
        },
        token.user.id
      );

      response.status(200).json({
        valid: true,
        user: User.filterFields(token.user),
        token: sessionToken,
        message: null,
      });
    }
  );

  app.post(
    "/system/recover-account",
    [isMultiUserSetup],
    async (request, response) => {
      try {
        const { username, recoveryCodes } = reqBody(request);
        const { success, resetToken, error } = await recoverAccount(
          username,
          recoveryCodes
        );

        if (success) {
          response.status(200).json({ success, resetToken });
        } else {
          response.status(400).json({ success, message: error });
        }
      } catch (error) {
        console.error("Error recovering account:", error);
        response
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/reset-password",
    [isMultiUserSetup],
    async (request, response) => {
      try {
        const { token, newPassword, confirmPassword } = reqBody(request);
        const { success, message, error } = await resetPassword(
          token,
          newPassword,
          confirmPassword
        );

        if (success) {
          response.status(200).json({ success, message });
        } else {
          response.status(400).json({ success, error });
        }
      } catch (error) {
        console.error("Error resetting password:", error);
        response.status(500).json({ success: false, message: error.message });
      }
    }
  );

  app.get(
    "/system/system-vectors",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const query = queryParams(request);
        const VectorDb = getVectorDbClass();
        const vectorCount = !!query.slug
          ? await VectorDb.namespaceCount(query.slug)
          : await VectorDb.totalVectors();
        response.status(200).json({ vectorCount });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/remove-document",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        await purgeDocument(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/remove-documents",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { names } = reqBody(request);
        for await (const name of names) await purgeDocument(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/remove-folder",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        await purgeFolder(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/local-files",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { folder, offset, limit } = queryParams(request);
        if (folder) {
          // Passed through as-is: getDocumentsByFolder clamps the window and
          // understands `limit=all`.
          const result = await getDocumentsByFolder(folder, { offset, limit });
          response.status(result.code).json(result);
        } else {
          const localFiles = listFolders();
          response.status(200).json({ localFiles });
        }
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/local-files/search",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { q } = queryParams(request);
        const results = await searchDocuments(q);
        response.status(200).json({ results });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/local-files/by-docpaths",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { docpaths = [] } = reqBody(request);
        const documents = await getDocumentsByDocPaths(docpaths);
        response.status(200).json({ documents });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/document-processing-status",
    [validatedRequest],
    async (_, response) => {
      try {
        const online = await new CollectorApi().online();
        response.sendStatus(online ? 200 : 503);
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/accepted-document-types",
    [validatedRequest],
    async (_, response) => {
      try {
        const types = await new CollectorApi().acceptedFileTypes();
        if (!types) {
          response.sendStatus(404).end();
          return;
        }

        response.status(200).json({ types });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/update-env",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const body = reqBody(request);
        const { newValues, error } = await updateENV(
          body,
          false,
          response?.locals?.user?.id
        );
        response.status(200).json({ newValues, error });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/update-password",
    [validatedRequest],
    async (request, response) => {
      try {
        // Cannot update password in multi - user mode.
        if (multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        let error = null;
        const { usePassword, newPassword } = reqBody(request);
        if (!usePassword) {
          // Password is being disabled so directly unset everything to bypass validation.
          process.env.AUTH_TOKEN = "";
          process.env.JWT_SECRET = "";
          if (process.env.NODE_ENV === "production") dumpENV();
        } else {
          // An all-asterisk value is indistinguishable from the UI's masked
          // placeholder, so updateENV would silently drop it while JWT_SECRET
          // still rotates - reject it before mutating anything.
          if (/^\*+$/.test(String(newPassword))) {
            response.status(200).json({
              success: false,
              error: "Password cannot consist of only asterisks (*).",
            });
            return;
          }
          const update = await updateENV(
            {
              AuthToken: newPassword,
              JWTSecret: v4(),
            },
            true
          );
          error = update?.error;
        }
        response.status(200).json({ success: !error, error });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/enable-multi-user",
    [validatedRequest],
    async (request, response) => {
      try {
        if (response.locals.multiUserMode) {
          response.status(200).json({
            success: false,
            error: "Multi-user mode is already enabled.",
          });
          return;
        }

        const { username, password } = reqBody(request);
        const { user, error } = await User.create({
          username,
          password,
          role: ROLES.admin,
        });

        if (error || !user) {
          response.status(400).json({
            success: false,
            error: error || "Failed to enable multi-user mode.",
          });
          return;
        }

        await SystemSettings._updateSettings({
          multi_user_mode: true,
        });
        await BrowserExtensionApiKey.migrateApiKeysToMultiUser(user.id);
        await Memory.migrateToMultiUser(user.id);
        await WorkspaceChats.migrateToMultiUser(user.id);
        await WorkspaceThread.migrateToMultiUser(user.id);
        await WorkspaceParsedFiles.migrateToMultiUser(user.id);
        await MobileDevice.migrateDevicesToMultiUser(user.id);
        await SlashCommandPresets.migrateToMultiUser(user.id);
        await AgentSkillWhitelist.clearSingleUserWhitelist();
        await updateENV(
          {
            JWTSecret: process.env.JWT_SECRET || v4(),
          },
          true
        );
        await Telemetry.sendTelemetry("enabled_multi_user_mode", {
          multiUserMode: true,
        });
        await EventLogs.logEvent("multi_user_mode_enabled", {}, user?.id);
        response.status(200).json({ success: !!user, error });
      } catch (e) {
        await User.delete({});
        await SystemSettings._updateSettings({
          multi_user_mode: false,
        });

        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get("/system/multi-user-mode", async (_, response) => {
    try {
      const multiUserMode = await SystemSettings.isMultiUserMode();
      response.status(200).json({ multiUserMode });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/system/logo", async function (request, response) {
    try {
      const darkMode = request?.query?.theme !== "light";
      const defaultFilename = getDefaultFilename(darkMode);
      const logoPath = await determineLogoFilepath(defaultFilename);
      const { found, buffer, size, mime } = fetchLogo(logoPath);

      if (!found) {
        response.sendStatus(204).end();
        return;
      }

      const currentLogoFilename = await SystemSettings.currentLogoFilename();
      response.writeHead(200, {
        "Access-Control-Expose-Headers":
          "Content-Disposition,X-Is-Custom-Logo,Content-Type,Content-Length",
        "Content-Type": mime || "image/png",
        "Content-Disposition": `attachment; filename=${path.basename(
          logoPath
        )}`,
        "Content-Length": size,
        "X-Is-Custom-Logo":
          currentLogoFilename !== null &&
          currentLogoFilename !== defaultFilename &&
          !isDefaultFilename(currentLogoFilename),
      });
      response.end(Buffer.from(buffer, "base64"));
      return;
    } catch (error) {
      console.error("Error processing the logo request:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/system/footer-data", [validatedRequest], async (_, response) => {
    try {
      const footerData =
        (await SystemSettings.get({ label: "footer_data" }))?.value ??
        JSON.stringify([]);
      response.status(200).json({ footerData: footerData });
    } catch (error) {
      console.error("Error fetching footer data:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/system/support-email", [validatedRequest], async (_, response) => {
    try {
      const supportEmail =
        (
          await SystemSettings.get({
            label: "support_email",
          })
        )?.value ?? null;
      response.status(200).json({ supportEmail: supportEmail });
    } catch (error) {
      console.error("Error fetching support email:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  // No middleware protection in order to get this on the login page
  app.get("/system/custom-app-name", async (_, response) => {
    try {
      const customAppName =
        (
          await SystemSettings.get({
            label: "custom_app_name",
          })
        )?.value ?? null;
      const normalizedAppName =
        typeof customAppName === "string" && /nexo|anything\s?llm/i.test(customAppName)
          ? "AnyHealth"
          : customAppName;
      response.status(200).json({ customAppName: normalizedAppName });
    } catch (error) {
      console.error("Error fetching custom app name:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get(
    "/system/pfp/:id",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async function (request, response) {
      try {
        const { id } = request.params;
        if (response.locals?.user?.id !== Number(id))
          return response.sendStatus(204).end();

        const pfpPath = await determinePfpFilepath(id);
        if (!pfpPath) return response.sendStatus(204).end();

        const { found, buffer, size, mime } = fetchPfp(pfpPath);
        if (!found) return response.sendStatus(204).end();

        response.writeHead(200, {
          "Content-Type": mime || "image/png",
          "Content-Disposition": `attachment; filename=${path.basename(pfpPath)}`,
          "Content-Length": size,
        });
        response.end(Buffer.from(buffer, "base64"));
        return;
      } catch (error) {
        console.error("Error processing the logo request:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/upload-pfp",
    [validatedRequest, flexUserRoleValid([ROLES.all]), handlePfpUpload],
    async function (request, response) {
      try {
        const user = await userFromSession(request, response);
        const uploadedFileName = request.randomFileName;
        if (!uploadedFileName) {
          return response.status(400).json({ message: "File upload failed." });
        }

        const userRecord = await User.get({ id: user.id });
        const oldPfpFilename = userRecord.pfpFilename;
        if (oldPfpFilename) {
          const storagePath = path.join(__dirname, "../storage/assets/pfp");
          const oldPfpPath = path.join(
            storagePath,
            normalizePath(userRecord.pfpFilename)
          );
          if (!isWithin(path.resolve(storagePath), path.resolve(oldPfpPath)))
            throw new Error("Invalid path name");
          if (fs.existsSync(oldPfpPath)) fs.unlinkSync(oldPfpPath);
        }

        const { success, error } = await User.update(user.id, {
          pfpFilename: uploadedFileName,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Profile picture uploaded successfully."
            : error || "Failed to update with new profile picture.",
        });
      } catch (error) {
        console.error("Error processing the profile picture upload:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );
  app.get(
    "/system/default-system-prompt",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (_, response) => {
      try {
        const defaultSystemPrompt = await SystemSettings.get({
          label: "default_system_prompt",
        });

        response.status(200).json({
          success: true,
          defaultSystemPrompt:
            defaultSystemPrompt?.value ||
            SystemSettings.saneDefaultSystemPrompt,
          saneDefaultSystemPrompt: SystemSettings.saneDefaultSystemPrompt,
        });
      } catch (error) {
        console.error("Error fetching default system prompt:", error);
        response
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/default-system-prompt",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { defaultSystemPrompt } = reqBody(request);
        const { success, error } = await SystemSettings.updateSettings({
          default_system_prompt: defaultSystemPrompt,
        });
        if (!success)
          throw new Error(
            error.message || "Failed to update default system prompt."
          );
        response.status(200).json({
          success: true,
          message: "Default system prompt updated successfully.",
        });
      } catch (error) {
        console.error("Error updating default system prompt:", error);
        response.status(500).json({
          success: false,
          message: error.message || "Internal server error",
        });
      }
    }
  );

  app.delete(
    "/system/remove-pfp",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async function (request, response) {
      try {
        const user = await userFromSession(request, response);
        const userRecord = await User.get({ id: user.id });
        const oldPfpFilename = userRecord.pfpFilename;

        if (oldPfpFilename) {
          const storagePath = path.join(__dirname, "../storage/assets/pfp");
          const oldPfpPath = path.join(
            storagePath,
            normalizePath(oldPfpFilename)
          );
          if (!isWithin(path.resolve(storagePath), path.resolve(oldPfpPath)))
            throw new Error("Invalid path name");
          if (fs.existsSync(oldPfpPath)) fs.unlinkSync(oldPfpPath);
        }

        const { success, error } = await User.update(user.id, {
          pfpFilename: null,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Profile picture removed successfully."
            : error || "Failed to remove profile picture.",
        });
      } catch (error) {
        console.error("Error processing the profile picture removal:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/upload-logo",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      handleAssetUpload,
    ],
    async (request, response) => {
      if (!request?.file || !request?.file.originalname) {
        return response.status(400).json({ message: "No logo file provided." });
      }

      if (!validFilename(request.file.originalname)) {
        return response.status(400).json({
          message: "Invalid file name. Please choose a different file.",
        });
      }

      try {
        const newFilename = await renameLogoFile(request.file.originalname);
        const existingLogoFilename = await SystemSettings.currentLogoFilename();
        await removeCustomLogo(existingLogoFilename);

        const { success, error } = await SystemSettings._updateSettings({
          logo_filename: newFilename,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Logo uploaded successfully."
            : error || "Failed to update with new logo.",
        });
      } catch (error) {
        console.error("Error processing the logo upload:", error);
        response.status(500).json({ message: "Error uploading the logo." });
      }
    }
  );

  app.get("/system/is-default-logo", async (_, response) => {
    try {
      const currentLogoFilename = await SystemSettings.currentLogoFilename();
      const isDefaultLogo = !currentLogoFilename || isDefaultFilename(currentLogoFilename);
      response.status(200).json({ isDefaultLogo });
    } catch (error) {
      console.error("Error processing the logo request:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get(
    "/system/remove-logo",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (_request, response) => {
      try {
        const currentLogoFilename = await SystemSettings.currentLogoFilename();
        await removeCustomLogo(currentLogoFilename);
        const { success, error } = await SystemSettings._updateSettings({
          logo_filename: LOGO_FILENAME,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Logo removed successfully."
            : error || "Failed to update with new logo.",
        });
      } catch (error) {
        console.error("Error processing the logo removal:", error);
        response.status(500).json({ message: "Error removing the logo." });
      }
    }
  );

  app.get("/system/api-keys", [validatedRequest], async (_, response) => {
    try {
      if (response.locals.multiUserMode) {
        return response.sendStatus(401).end();
      }

      const apiKeys = await ApiKey.where({});
      return response.status(200).json({
        apiKeys,
        error: null,
      });
    } catch (error) {
      console.error(error);
      response.status(500).json({
        apiKey: null,
        error: "Could not find an API Key.",
      });
    }
  });

  app.post(
    "/system/generate-api-key",
    [validatedRequest],
    async (request, response) => {
      try {
        if (response.locals.multiUserMode) {
          return response.sendStatus(401).end();
        }

        const { name = null } = reqBody(request);
        const { apiKey, error } = await ApiKey.create(null, name);
        await EventLogs.logEvent(
          "api_key_created",
          { name: apiKey?.name },
          response?.locals?.user?.id
        );
        return response.status(200).json({
          apiKey,
          error,
        });
      } catch (error) {
        console.error(error);
        response.status(500).json({
          apiKey: null,
          error: "Error generating api key.",
        });
      }
    }
  );

  // TODO: This endpoint is replicated in the admin endpoints file.
  // and should be consolidated to be a single endpoint with flexible role protection.
  app.delete(
    "/system/api-key/:id",
    [validatedRequest],
    async (request, response) => {
      try {
        if (response.locals.multiUserMode)
          return response.sendStatus(401).end();
        const { id } = request.params;
        if (!id || isNaN(Number(id))) return response.sendStatus(400).end();

        await ApiKey.delete({ id: Number(id) });
        await EventLogs.logEvent(
          "api_key_deleted",
          { deletedBy: response.locals?.user?.username },
          response?.locals?.user?.id
        );
        return response.status(200).end();
      } catch (error) {
        console.error(error);
        response.status(500).end();
      }
    }
  );

  app.post(
    "/system/custom-models",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const {
          provider,
          apiKey = null,
          basePath = null,
          options = {},
        } = reqBody(request);
        const { models, error } = await getCustomModels(
          provider,
          apiKey,
          basePath,
          options
        );
        return response.status(200).json({
          models,
          error,
        });
      } catch (error) {
        console.error(error);
        response.status(500).end();
      }
    }
  );

  app.post(
    "/system/event-logs",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { offset = 0, limit = 10 } = reqBody(request);
        const logs = await EventLogs.whereWithData({}, limit, offset * limit, {
          id: "desc",
        });
        const totalLogs = await EventLogs.count();
        const hasPages = totalLogs > (offset + 1) * limit;

        response.status(200).json({ logs: logs, hasPages, totalLogs });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/event-logs",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_, response) => {
      try {
        await EventLogs.delete();
        await EventLogs.logEvent(
          "event_logs_cleared",
          {},
          response?.locals?.user?.id
        );
        response.json({ success: true });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/agent-review/candidates",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        const chats = await WorkspaceChats.whereWithData(
          { feedbackScore: false, include: true },
          50,
          0,
          { id: "desc" }
        );
        response.json({
          candidates: chats.map((chat) => ({
            id: chat.id,
            prompt: chat.prompt,
            response: safeJsonParse(chat.response, {})?.text || "",
            workspace: chat.workspace?.name || "",
            username: chat.user?.username || "",
            createdAt: chat.createdAt,
          })),
        });
      } catch (error) {
        console.error("Could not load agent review candidates:", error);
        response.sendStatus(500);
      }
    }
  );

  app.get(
    "/system/agent-review/suggestions",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        const [created, decisions] = await Promise.all([
          EventLogs.where(
            { event: "agent_sql_suggestion_created" },
            100,
            { id: "desc" }
          ),
          EventLogs.where(
            { event: "agent_sql_suggestion_decided" },
            500,
            { id: "desc" }
          ),
        ]);
        const decidedIds = new Set(
          decisions
            .map((event) => safeJsonParse(event.metadata, {})?.suggestionId)
            .filter(Boolean)
        );
        const pending = [];
        for (const event of created) {
          const metadata = safeJsonParse(event.metadata, {});
          if (!metadata.suggestionId || decidedIds.has(metadata.suggestionId))
            continue;
          const chat = await WorkspaceChats.get({ id: Number(metadata.chatId) });
          const responseText = safeJsonParse(chat?.response, {})?.text || "";
          pending.push({
            id: event.id,
            suggestionId: metadata.suggestionId,
            chatId: metadata.chatId,
            workspace: metadata.workspace || "",
            prompt: chat?.prompt || "",
            response: responseText,
            suggestion: metadata.suggestion,
            createdAt: event.occurredAt,
          });
        }
        response.json({ suggestions: pending });
      } catch (error) {
        console.error("Could not load agent suggestions:", error);
        response.sendStatus(500);
      }
    }
  );

  app.post(
    "/system/agent-review/suggestions",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { chatId } = reqBody(request);
        const chat = await WorkspaceChats.get({
          id: Number(chatId),
          include: true,
          feedbackScore: false,
        });
        if (!chat)
          return response.status(404).json({
            success: false,
            error: "Only a negatively rated saved answer can be reviewed.",
          });

        const workspace = await Workspace.get({ id: chat.workspaceId });
        if (!workspace)
          return response.status(404).json({ success: false, error: "Workspace not found." });

        const settingsValue = await SystemSettings.getValueOrFallback(
          { label: "agent_sql_connections" },
          "[]"
        );
        const connections = safeJsonParse(settingsValue, []);
        const catalog = (Array.isArray(connections) ? connections : []).flatMap(
          (connection) =>
            (Array.isArray(connection.queries) ? connection.queries : []).map(
              ({ id, title, description, examples = [], parameters = [] }) => ({
                database_id: connection.database_id,
                id,
                title,
                description,
                examples: Array.isArray(examples) ? examples : [],
                parameters: (Array.isArray(parameters) ? parameters : []).map(
                  ({ name, type, description, required }) => ({
                    name,
                    type,
                    description,
                    required,
                  })
                ),
              })
            )
        );
        if (!catalog.length)
          return response.status(400).json({
            success: false,
            error: "Add approved SQL queries before generating query-matching suggestions.",
          });

        const user = chat.user_id ? await User.get({ id: chat.user_id }) : null;
        const thread = chat.thread_id
          ? await WorkspaceThread.get({ id: chat.thread_id })
          : null;
        const { connector } = await resolveProviderConnector({
          workspace,
          prompt: chat.prompt,
          user,
          thread,
          attachments: [],
        });
        if (!connector?.getChatCompletion)
          return response.status(400).json({
            success: false,
            error: "The workspace does not have a usable language model configured.",
          });

        const savedResponse = safeJsonParse(chat.response, {})?.text || "";
        const completion = await connector.getChatCompletion(
          [
            {
              role: "system",
              content:
                "You review a user question and a negatively rated AI answer to improve routing to existing, administrator-approved SQL queries. Never propose or write SQL. Do not claim that the answer is wrong for certain; infer only a likely query-selection or wording improvement. Return one JSON object with keys: database_id, query_id, rationale, suggestedDescription, exampleQuestions. Choose database_id and query_id exactly from the supplied catalog. suggestedDescription must be a short usage description (or an empty string if unchanged); exampleQuestions must be 1 to 8 short natural-language phrases that users could ask. Do not include SQL results or credentials.",
            },
            {
              role: "user",
              content: JSON.stringify({
                question: String(chat.prompt || "").slice(0, 4000),
                answerMarkedIncorrect: String(savedResponse).slice(0, 6000),
                approvedQueryCatalog: catalog,
              }),
            },
          ],
          { user }
        );
        const rawText = String(completion?.textResponse || "");
        const jsonText = rawText.match(/\{[\s\S]*\}/)?.[0];
        const proposal = jsonText ? safeJsonParse(jsonText, null) : null;
        if (!proposal)
          return response.status(502).json({
            success: false,
            error: "The model did not return a usable suggestion. Try again or edit the query manually.",
          });

        const matchedQuery = catalog.find(
          (query) =>
            query.database_id === proposal.database_id &&
            query.id === proposal.query_id
        );
        const suggestedDescription = String(
          proposal.suggestedDescription || ""
        )
          .trim()
          .slice(0, 2000);
        const exampleQuestions = Array.isArray(proposal.exampleQuestions)
          ? [
              ...new Set(
                proposal.exampleQuestions
                  .map((example) => String(example).trim().slice(0, 240))
                  .filter(Boolean)
              ),
            ].slice(0, 8)
          : [];
        if (
          !matchedQuery ||
          (!suggestedDescription && !exampleQuestions.length)
        )
          return response.status(502).json({
            success: false,
            error: "The model returned a suggestion that does not match an approved query.",
          });

        const suggestion = {
          databaseId: matchedQuery.database_id,
          queryId: matchedQuery.id,
          queryTitle: matchedQuery.title,
          rationale: String(proposal.rationale || "").slice(0, 1000),
          previousDescription: matchedQuery.description,
          suggestedDescription,
          previousExamples: matchedQuery.examples,
          exampleQuestions,
        };
        const suggestionId = v4();
        const logged = await EventLogs.logEvent(
          "agent_sql_suggestion_created",
          {
            suggestionId,
            chatId: chat.id,
            workspace: workspace.name,
            suggestion,
          },
          (await userFromSession(request, response))?.id
        );
        if (!logged.eventLog)
          return response.status(500).json({
            success: false,
            error: "Could not save the suggestion for review.",
          });
        response.json({ success: true, suggestionId });
      } catch (error) {
        console.error("Could not generate agent suggestion:", error);
        response.status(500).json({
          success: false,
          error: "Could not generate a suggestion from this answer.",
        });
      }
    }
  );

  app.post(
    "/system/agent-review/suggestions/:eventId/decision",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const eventId = Number(request.params.eventId);
        const { decision } = reqBody(request);
        if (!Number.isInteger(eventId) || !["approve", "reject"].includes(decision))
          return response.status(400).json({ success: false, error: "Invalid review decision." });

        const [sourceEvent] = await EventLogs.where(
          { id: eventId, event: "agent_sql_suggestion_created" },
          1
        );
        if (!sourceEvent)
          return response.status(404).json({ success: false, error: "Suggestion not found." });
        const source = safeJsonParse(sourceEvent.metadata, {});
        if (!source.suggestionId || !source.suggestion)
          return response.status(400).json({ success: false, error: "Suggestion data is invalid." });
        const decisions = await EventLogs.where(
          { event: "agent_sql_suggestion_decided" },
          500
        );
        if (
          decisions.some(
            (event) =>
              safeJsonParse(event.metadata, {})?.suggestionId ===
              source.suggestionId
          )
        )
          return response.status(409).json({ success: false, error: "Suggestion was already reviewed." });

        if (decision === "approve") {
          const suggestion = source.suggestion;
          const connections = await SystemSettings.getSQLConnections();
          const connection = connections.find(
            (item) => item.database_id === suggestion.databaseId
          );
          const query = connection?.queries?.find(
            (item) => item.id === suggestion.queryId
          );
          if (!connection || !query)
            return response.status(409).json({ success: false, error: "The approved query no longer exists." });

          const examples = Array.isArray(query.examples) ? query.examples : [];
          const updatedQuery = {
            ...query,
            description:
              String(suggestion.suggestedDescription || "").trim() ||
              query.description,
            examples: [
              ...new Set([
                ...examples,
                ...(Array.isArray(suggestion.exampleQuestions)
                  ? suggestion.exampleQuestions
                  : []),
              ]),
            ].slice(0, 20),
          };
          const saveResult = await SystemSettings.updateSettings({
            agent_sql_connections: JSON.stringify([
              {
                action: "queries",
                database_id: connection.database_id,
                queries: connection.queries.map((item) =>
                  item.id === query.id ? updatedQuery : item
                ),
              },
            ]),
          });
          if (!saveResult.success)
            return response.status(500).json({
              success: false,
              error: saveResult.error || "Could not apply the suggestion.",
            });
        }

        const reviewer = await userFromSession(request, response);
        await EventLogs.logEvent(
          "agent_sql_suggestion_decided",
          {
            suggestionId: source.suggestionId,
            sourceEventId: sourceEvent.id,
            decision,
            databaseId: source.suggestion.databaseId,
            queryId: source.suggestion.queryId,
          },
          reviewer?.id
        );
        response.json({ success: true, decision });
      } catch (error) {
        console.error("Could not apply agent suggestion:", error);
        response.status(500).json({ success: false, error: "Could not save the review decision." });
      }
    }
  );

  app.post(
    "/system/workspace-chats",
    [
      chatHistoryViewable,
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
    ],
    async (request, response) => {
      try {
        const { offset = 0, limit = 20 } = reqBody(request);
        const chats = await WorkspaceChats.whereWithData(
          {},
          limit,
          offset * limit,
          { id: "desc" }
        );
        const totalChats = await WorkspaceChats.count();
        const hasPages = totalChats > (offset + 1) * limit;

        response.status(200).json({ chats: chats, hasPages, totalChats });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/workspace-chats/:id",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { id } = request.params;
        Number(id) === -1
          ? await WorkspaceChats.delete({}, true)
          : await WorkspaceChats.delete({ id: Number(id) });
        response.json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/export-chats",
    [
      chatHistoryViewable,
      validatedRequest,
      flexUserRoleValid([ROLES.manager, ROLES.admin]),
    ],
    async (request, response) => {
      try {
        const { type = "jsonl", chatType = "workspace" } = request.query;
        const { contentType, data } = await exportChatsAsType(type, chatType);
        await EventLogs.logEvent(
          "exported_chats",
          {
            type,
            chatType,
          },
          response.locals.user?.id
        );
        response.setHeader("Content-Type", contentType);
        response.status(200).send(data);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Used for when a user in multi-user updates their own profile
  // from the UI.
  app.post("/system/user", [validatedRequest], async (request, response) => {
    try {
      const sessionUser = await userFromSession(request, response);
      const { username, password, bio } = reqBody(request);
      const id = Number(sessionUser.id);

      if (!id) {
        response.status(400).json({ success: false, error: "Invalid user ID" });
        return;
      }

      const updates = {};
      // If the username is being changed, validate it.
      // Otherwise, do not attempt to validate it to allow existing users to keep their username if not changing it.
      if (username !== sessionUser.username)
        updates.username = User.validations.username(String(username));
      if (password) updates.password = String(password);
      if (bio || bio === "") updates.bio = String(bio);

      if (Object.keys(updates).length === 0) {
        response
          .status(400)
          .json({ success: false, error: "No updates provided" });
        return;
      }

      const { success, error } = await User.update(id, updates);
      response.status(200).json({ success, error });
    } catch (e) {
      console.error(e);
      response
        .status(500)
        .json({ success: false, error: e.message || "Internal server error" });
    }
  });

  app.get(
    "/system/slash-command-presets",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const userPresets = await SlashCommandPresets.getUserPresets(user?.id);
        response.status(200).json({ presets: userPresets });
      } catch (error) {
        console.error("Error fetching slash command presets:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/slash-command-presets",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { command, prompt, description } = reqBody(request);
        const formattedCommand = SlashCommandPresets.formatCommand(
          String(command)
        );

        if (isReservedCommand(formattedCommand)) {
          return response.status(400).json({
            message:
              "Cannot create a preset with a command that matches a system command",
          });
        }

        const presetData = {
          command: formattedCommand,
          prompt: String(prompt),
          description: String(description),
        };

        const preset = await SlashCommandPresets.create(user?.id, presetData);
        if (!preset) {
          return response
            .status(500)
            .json({ message: "Failed to create preset" });
        }
        response.status(201).json({ preset });
      } catch (error) {
        console.error("Error creating slash command preset:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/slash-command-presets/:slashCommandId",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { slashCommandId } = request.params;
        const { command, prompt, description } = reqBody(request);
        const formattedCommand = SlashCommandPresets.formatCommand(
          String(command)
        );

        if (isReservedCommand(formattedCommand)) {
          return response.status(400).json({
            message:
              "Cannot update a preset to use a command that matches a system command",
          });
        }

        // Valid user running owns the preset if user session is valid.
        const ownsPreset = await SlashCommandPresets.get({
          userId: user?.id ?? null,
          id: Number(slashCommandId),
        });
        if (!ownsPreset)
          return response.status(404).json({ message: "Preset not found" });

        const updates = {
          command: formattedCommand,
          prompt: String(prompt),
          description: String(description),
        };

        const preset = await SlashCommandPresets.update(
          Number(slashCommandId),
          updates
        );
        if (!preset) return response.sendStatus(422);
        response.status(200).json({ preset: { ...ownsPreset, ...updates } });
      } catch (error) {
        console.error("Error updating slash command preset:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.delete(
    "/system/slash-command-presets/:slashCommandId",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { slashCommandId } = request.params;
        const user = await userFromSession(request, response);

        // Valid user running owns the preset if user session is valid.
        const ownsPreset = await SlashCommandPresets.get({
          userId: user?.id ?? null,
          id: Number(slashCommandId),
        });
        if (!ownsPreset)
          return response
            .status(403)
            .json({ message: "Failed to delete preset" });

        await SlashCommandPresets.delete(Number(slashCommandId));
        response.sendStatus(204);
      } catch (error) {
        console.error("Error deleting slash command preset:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.get(
    "/system/prompt-variables",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const variables = await SystemPromptVariables.getAll(user?.id);
        response.status(200).json({ variables });
      } catch (error) {
        console.error("Error fetching system prompt variables:", error);
        response.status(500).json({
          success: false,
          error: `Failed to fetch system prompt variables: ${error.message}`,
        });
      }
    }
  );

  app.post(
    "/system/prompt-variables",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { key, value, description = null } = reqBody(request);

        if (!key || !value) {
          return response.status(400).json({
            success: false,
            error: "Key and value are required",
          });
        }

        const variable = await SystemPromptVariables.create({
          key,
          value,
          description,
          userId: user?.id || null,
        });

        response.status(200).json({
          success: true,
          variable,
        });
      } catch (error) {
        console.error("Error creating system prompt variable:", error);
        response.status(500).json({
          success: false,
          error: `Failed to create system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.put(
    "/system/prompt-variables/:id",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { id } = request.params;
        const { key, value, description = null } = reqBody(request);

        if (!key || !value) {
          return response.status(400).json({
            success: false,
            error: "Key and value are required",
          });
        }

        const variable = await SystemPromptVariables.update(Number(id), {
          key,
          value,
          description,
        });

        if (!variable) {
          return response.status(404).json({
            success: false,
            error: "Variable not found",
          });
        }

        response.status(200).json({
          success: true,
          variable,
        });
      } catch (error) {
        console.error("Error updating system prompt variable:", error);
        response.status(500).json({
          success: false,
          error: `Failed to update system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.delete(
    "/system/prompt-variables/:id",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { id } = request.params;
        const success = await SystemPromptVariables.delete(Number(id));

        if (!success) {
          return response.status(404).json({
            success: false,
            error: "System prompt variable not found or could not be deleted",
          });
        }

        response.status(200).json({
          success: true,
        });
      } catch (error) {
        console.error("Error deleting system prompt variable:", error);
        response.status(500).json({
          success: false,
          error: `Failed to delete system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.post(
    "/system/transcribe-audio",
    [validatedRequest, flexUserRoleValid([ROLES.all]), handleAudioUpload],
    async (request, response) => {
      try {
        if (!request.file?.buffer) {
          return response
            .status(400)
            .json({ success: false, error: "No audio file provided." });
        }

        const provider = process.env.STT_PROVIDER || "native";
        if (provider === "native") {
          return response.status(400).json({
            success: false,
            error:
              "Server-side transcription is disabled. Set STT_PROVIDER to a supported provider.",
          });
        }

        const { getSTTProvider } = require("../utils/SpeechToText");
        const stt = getSTTProvider();
        const text = await stt.transcribe(
          request.file.buffer,
          request.file.originalname || "audio.webm"
        );
        return response.status(200).json({ success: true, text });
      } catch (error) {
        console.error("STT transcription error:", error);
        return response.status(500).json({
          success: false,
          error: error.message || "Transcription failed",
        });
      }
    }
  );

  app.post(
    "/system/validate-sql-connection",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      const { engine, connectionString } = reqBody(request);
      try {
        if (!engine || !connectionString) {
          return response.status(400).json({
            success: false,
            error: "Both engine and connection details are required.",
          });
        }

        const {
          validateConnection,
        } = require("../utils/agents/aibitat/plugins/sql-agent/SQLConnectors");
        const result = await validateConnection(engine, { connectionString });

        if (!result.success) {
          return response.status(200).json({
            success: false,
            error: `Unable to connect to ${engine}. Please verify your connection details.`,
          });
        }

        response.status(200).json(result);
      } catch (error) {
        console.error("SQL validation error:", error);
        response.status(500).json({
          success: false,
          error: `Unable to connect to ${engine}. Please verify your connection details.`,
        });
      }
    }
  );

  app.post(
    "/system/test-sql-query",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      const { database_id, sql, parameters = [], values = {} } = reqBody(request);
      try {
        if (!database_id || !sql) {
          return response.status(400).json({
            success: false,
            error: "A database and SELECT query are required.",
          });
        }

        const connections = await SystemSettings.getSQLConnections();
        const connection = connections.find(
          (item) => item.database_id === database_id
        );
        if (!connection) {
          return response.status(404).json({
            success: false,
            error: "The SQL connection was not found.",
          });
        }

        const { prepareSavedQuery } = require(
          "../utils/agents/aibitat/plugins/sql-agent/query-template"
        );
        const { getDBClient } = require(
          "../utils/agents/aibitat/plugins/sql-agent/SQLConnectors"
        );
        const prepared = prepareSavedQuery({
          engine: connection.engine,
          sql,
          parameters,
          values,
        });
        const result = await getDBClient(connection.engine, connection).runQuery(
          prepared.query,
          prepared.params
        );
        if (result.error) {
          return response.status(400).json({
            success: false,
            error: result.error,
          });
        }

        const rows = Array.isArray(result.rows) ? result.rows : [];
        const columns = Array.isArray(result.columns) && result.columns.length
          ? result.columns
          : Object.keys(rows[0] || {}).map((name) => ({
              name,
              type:
                rows.find((row) => row?.[name] !== null && row?.[name] !== undefined)?.[name]?.constructor?.name ||
                typeof rows.find((row) => row?.[name] !== null && row?.[name] !== undefined)?.[name] ||
                "unknown",
            }));
        return response.status(200).json({
          success: true,
          columns,
          rows: rows.slice(0, 20),
          count: rows.length,
          truncated: rows.length > 20 || result.truncated === true,
        });
      } catch (error) {
        return response.status(400).json({
          success: false,
          error: error.message || "Unable to test this SQL query.",
        });
      }
    }
  );
}

module.exports = { systemEndpoints };
