const { showThreadMenu } = require("../../commands/handlers/showThreadMenu");
const { Workspace } = require("../../../../../models/workspace");
const { WorkspaceUser } = require("../../../../../models/workspaceUsers");
const { SystemSettings } = require("../../../../../models/systemSettings");

/**
 * Handle workspace selection - shows thread menu for selected workspace.
 * @param {object} params
 * @param {import("../../commands/index").BotContext} params.ctx
 * @param {number} params.chatId
 * @param {{id: string}} params.query
 * @param {number} params.messageId
 * @param {string} params.data
 */
async function handleWorkspaceSelect({
  ctx,
  chatId,
  query,
  messageId,
  data,
} = {}) {
  const workspaceId = parseInt(data.slice(3), 10);
  const user = await ctx.getUser?.(chatId);
  const workspace = await Workspace.get({ id: workspaceId });
  if (!workspace) return ctx.bot.answerCallbackQuery(query.id, { text: "Workspace indisponível." });
  if ((await SystemSettings.isMultiUserMode()) && user?.role !== "admin" && !(await WorkspaceUser.get({ user_id: user?.id || -1, workspace_id: workspace.id }))) {
    return ctx.bot.answerCallbackQuery(query.id, { text: "Você não tem acesso a este workspace." });
  }
  await showThreadMenu(ctx, chatId, workspaceId, 0, messageId);
  await ctx.bot.answerCallbackQuery(query.id);
}

module.exports = { handleWorkspaceSelect };
