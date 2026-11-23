const { SystemSettings } = require("../../../models/systemSettings");
const { WorkspaceUser } = require("../../../models/workspaceUsers");

async function canAccessTelegramWorkspace(ctx, chatId, workspace) {
  if (!workspace) return false;
  if (!(await SystemSettings.isMultiUserMode())) return true;
  const user = await ctx.getUser?.(chatId);
  if (!user || user.suspended) return false;
  if (user.role === "admin") return true;
  return !!(await WorkspaceUser.get({
    user_id: user.id,
    workspace_id: workspace.id,
  }));
}

async function isTelegramAdmin(ctx, chatId) {
  if (!(await SystemSettings.isMultiUserMode())) return true;
  return (await ctx.getUser?.(chatId))?.role === "admin";
}

function telegramSessionId(user) {
  return user?.id ? "telegram:" + user.id : null;
}

module.exports = {
  canAccessTelegramWorkspace,
  isTelegramAdmin,
  telegramSessionId,
};
