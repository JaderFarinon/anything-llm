const { Workspace } = require("../../../../../models/workspace");
const { SystemSettings } = require("../../../../../models/systemSettings");

/**
 * Handle the creation of a new workspace.
 * @param {object} params - The parameters for the function
 * @param {import("../../commands/index").BotContext} params.ctx
 * @param {number} params.chatId
 * @param {{id: string}} params.query - Telegram callback query object
 */
async function handleWorkspaceCreate({ ctx, chatId, query } = {}) {
  const user = await ctx.getUser?.(chatId);
  if ((await SystemSettings.isMultiUserMode()) && user?.role !== "admin") {
    await ctx.bot.answerCallbackQuery(query.id, {
      text: "Somente administradores podem criar workspaces.",
    });
    return;
  }
  const botName = ctx.config.bot_username || "Bot";
  const wsName = `${botName} Workspace`;
  const { workspace, message: error } = await Workspace.new(wsName, null, {
    chatMode: "automatic",
  });
  if (error || !workspace) {
    await ctx.bot.answerCallbackQuery(query.id, {
      text: "Failed to create workspace.",
    });
    return;
  }

  ctx.setState(chatId, { workspaceSlug: workspace.slug, threadSlug: null });
  await ctx.bot.answerCallbackQuery(query.id, {
    text: "Workspace created!",
  });
  await ctx.bot.sendMessage(
    chatId,
    `Created and switched to "${workspace.name}". You can start chatting now!`
  );
}

module.exports = { handleWorkspaceCreate };
